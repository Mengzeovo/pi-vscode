# 工单 PIH-MEM-001：Pi Harness 共享后台内存泄漏与高占用治理

| 字段 | 内容 |
| --- | --- |
| **工单编号** | `PIH-MEM-001` |
| **状态** | 已完成 |
| **优先级** | `P0` |
| **基线版本** | `0.2.3` |
| **目标版本** | `0.2.4` |
| **创建日期** | `2026-11-25` |

## 问题现象与采证数据

2026-11-25 对运行约 2 天的共享后台实例（单工作区，已加载 2 个会话，历史文件总计仅 2.13 MiB）采证：

- 状态栏显示 `RSS = 2600.9 MiB`（16:47），6 分钟后工作集达 `3195.2 MiB`、Private Commit 达 `3867.0 MiB`（线程数 `14`、句柄数 `327`，排除线程/句柄泄漏）。
- `pi-lens` `latency.log` 内存采样（turn 80）显示：84 次 Major GC 后存活堆 `heapSettledBytes = 2318.2 MiB`、`arrayBuffersBytes = 525.6 MiB`、`externalBytes = 660.3 MiB`。
- 进程内共发生 12 次 `pi-lens` 激活，其中 9 次来自用完即毁的 `BackendRegistry.catalog()` 临时会话。单次已销毁的 `catalog()` 在 35 分钟、18 次 Major GC 后仍永久净增 `+204.4 MiB` 堆与 `+37.3 MiB` ArrayBuffer。

## 根因

1. **`compat/pi-lens` 沙箱闭包永久泄漏**：`compat/pi-lens/index.js` 每次激活都会用 `vm.compileFunction` 执行整份 15.8 万行 `runtime.cjs`，但未拦截 `node:perf_hooks` / `node:async_hooks`；`runtime-source.js` 模块顶层创建的 `PerformanceObserver({ entryTypes: ["gc"] })` 与 `monitorEventLoopDelay()` 在 `session_shutdown` 时从未 `disconnect()` / `disable()`，其回调从 C++ 全局根永久钉住整份模块闭包与 `runtime.wordIndex`（单份 ~200 MiB 堆 + ~40 MiB `Int32Array`）；同时关闭阶段未显式释放 `wordIndex` / `reviewGraph` / `TreeSitterClient` WASM 缓存。
2. **`BackendRegistry.catalog()` 重复新建临时目录会话**：会话 `load()` 完成后会删除 `catalogs` 缓存并通知刷新，扩展宿主再次调用 `catalog()` 时未传 `sessionId` 且后端不复用同 `cwd` 已加载的健康会话，导致反复创建并销毁全量加载 `pi-lens` 的临时会话。
3. **流式高频全量 `messages` 快照 IPC 广播**：`BackendRegistry.bind()` 在每个 `message_update` 增量块都调用 `publish(entry)` 发送包含完整 `messages` 数组的 `BackendSessionSnapshot`，`publishProcess()` 每 2 秒也全量广播所有会话的 `messages`，而 `src/` 中没有任何业务代码读取 `snapshot.messages`。
4. **`runtime.cjs` 内联 SourceMap 膨胀**：`compat/pi-lens/build.mjs` 使用 `sourcemap: "inline"` 使 `5.76 MiB` 脚本膨胀至 `18.08 MiB`。

## 实施清单

- [x] **阶段 1**：`compat/pi-lens/index.js` 拦截托管 `node:perf_hooks`（`PerformanceObserver`、`monitorEventLoopDelay`）与 `node:async_hooks`（`createHook`、`AsyncLocalStorage`），在 `session_shutdown` 及异常初始化失败路径统一释放全部沙箱资源；支持 `scope.catalogOnly` 轻模式。
- [x] **阶段 1**：`compat/pi-lens/runtime-source.js` 在 `__harness.setFinalizer` 尾部显式释放 `wordIndex`、`callGraph`、`cachedExports`、`reviewGraph` 缓存、`TreeSitterClient` WASM 缓存，并断开 `gcObserver` / `histogram`；同步更新 `compat/SOURCES.md`。
- [x] **阶段 1**：`compat/pi-lens/build.mjs` 去除 `sourcemap: "inline"`，将 `runtime.cjs` 缩减至 `5.76 MiB`（`6,040,139` bytes）。
- [x] **阶段 2**：`src/backend/resources.ts` 为目录查询会话标记 `scope.catalogOnly = true`；`src/backend/registry.ts` 规范化 `cwd` 缓存键，`refresh !== true` 时优先复用同目录健康常驻会话并按工作区配置独立计算默认模型与思考级别。
- [x] **阶段 3**：`src/backend/protocol.ts` 与 `src/backend/registry.ts` 从 `BackendSessionSnapshot` 移除 `messages` 及 `Resident.partial`，停止在 `message_update` 时触发 `publish(entry)`；同步更新 `test/suite/04-steer.test.ts` 与 `test/suite/14-history-recovery.test.ts`。
- [x] **阶段 4**：保持 `piHarness.sessionResidencyLimit` 默认值 `10` 不变。
- [x] **验证与发布**：补充 `test/runtime/memoryLeak.test.ts` 回归测试，执行类型检查、全量运行时测试与便携 VS Code 共享后台集成测试，升版本至 `0.2.4`、更新 `CHANGELOG.md` 并打包 `pi-harness-0.2.4.vsix`。

## 验证与交付记录

- **构建产物瘦身**：`dist/compat/pi-lens/dist/runtime.cjs` 由 `18.08 MiB` 缩减至 `5.76 MiB`（`6,040,139` bytes），确认不含 `sourceMappingURL=data:`。
- **类型检查**：`npm run typecheck`（`tsconfig.json`、`pi-extension/tsconfig.json`、`test/tsconfig.json`）全部通过。
- **运行时回归测试**：`npm run test:runtime` **14 / 14 通过**，其中 `test/runtime/memoryLeak.test.ts` 验证：
  - `pi-lens` 激活抛错路径及 6 轮完整 `session_start -> session_shutdown -> dispose` 闭环后，所有沙箱闭包 `WeakRef` 与 `HarnessScope` 均 100% 被 V8 GC 回收（`survivingRefs = 0`、`survivingScopes = 0`），`heapUsed` 与 `arrayBuffers` 无持续增长；
  - `catalogOnly: true` 跳过 `pi-lens` 重型初始化且仍能通过 `DefaultResourceLoader` 发现全部 `pi-lens` skills；
  - `BackendRegistry.catalog()` 在 Windows 不同大小写 `cwd` 下复用同目录常驻会话，工作区默认模型/思考级别不受会话临时切换污染，`refresh: true` 正确重新加载磁盘配置；
  - `BackendSessionSnapshot` 不含 `messages`，200 次 `message_update` 发送 200 次 `BackendEvent` 且触发 0 次 `BackendSessionChanged`，`tool_execution_update` 保持触发快照更新。
- **VS Code 宿主集成测试**（便携版 `.test-work/vscode/Code.exe`）：
  - `12 个真实会话共用进程，保留订阅并释放最早空闲会话` — 通过（49.3s）
  - `真实运行期间请求重新加载，其他会话保持可用` — 通过（11.2s）
  - `真实扩展资源读取失败完成清理，配置修复后可以重新加载` — 通过（2.1s）
  - 未执行项说明：依赖外部默认模型名（`cliproxyapi/gpt-6-astra` / `cliproxyapi/gpt-6-luna`）或依赖全局未设 `enabledModels` 的测试受当前本机 `~/.pi/agent/settings.json` 与外部模型配置限制，未纳入本次无网验证。
- **发布产物**：`pi-harness-0.2.4.vsix`。
