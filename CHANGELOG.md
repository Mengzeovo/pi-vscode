# 更新记录

## 0.2.5 — 2026-11-25

- 消除 `compat/pi-token-usage` 启动期的全盘历史 `.jsonl` 同步扫描与瞬时内存尖峰：在 `catalogOnly` 目录轻模式下跳过激活；将 `session_start`、`turn_end` 与 `/usage footer` 页脚刷新的扫描窗口限定为当日修改的会话文件；`/usage` 各类统计命令仍保持全量历史扫描与准确汇总。
- 补全共享后台与进程管理辅助程序的异常退出诊断：
  - `SharedBackendClient` 不再因 Windows 下先触发 `disconnect` 而吞掉 `child.once("exit")` 的退出码与信号，记录近期 `stderrTail`，并在意外断开后短暂等待（最多 250ms）后端完成退出再执行 Job 清理，避免 `TerminateJobObject(..., 1)` 覆盖原生崩溃码（如 `0xC0000005` / `0xC0000409`）。
  - 正常 `BackendShutdown` 干净以退出码 `0` 结束，不再触发误报的断开/退出日志。
  - `backend/index.ts` 增加 `uncaughtExceptionMonitor`、非零/意外 `exit`（含 RSS/Heap 用量）与意外 `disconnect` 的同步 `stderr` 留证。
  - `guardian` 新增 `ProcessHandle.exitCode`（`GetExitCodeProcess`），在监测到后端退出或清理前同步输出带十六进制格式的 Win32 退出码，并修复辅助程序自身退出事件日志不被 `disconnect` 吞掉。
- 新增 `D1`/`D2` 运行时回归测试，覆盖 `ProcessHandle.exitCode`、原生异常退出码留证、正常关闭与 `pi-token-usage` 轻模式/当日窗口/全量统计闭环。

## 0.2.4 — 2026-11-25

- 修复共享后台中 `compat/pi-lens` 沙箱闭包永久泄漏问题：托管并清理 `node:perf_hooks`（`PerformanceObserver`、`monitorEventLoopDelay`）与 `node:async_hooks`（`createHook`、`AsyncLocalStorage`），在 `session_shutdown` 与激活失败路径统一回收全部沙箱资源，并显式释放 `wordIndex`、`callGraph`、`reviewGraph` 及 tree-sitter WASM 缓存。
- 为目录查询会话引入 `catalogOnly` 轻模式跳过 `pi-lens` 重型运行时初始化（仍保留 skills 发现），并在 `BackendRegistry.catalog()` 中规范化路径键、在非 `refresh` 场景复用同目录健康常驻会话（工作区默认模型/思考级别独立于会话临时切换）。
- 从 `BackendSessionSnapshot` 移除全量 `messages` 与 `Resident.partial`，并停止在高频 `message_update` 流式增量事件中广播全量会话快照。
- 移除 `compat/pi-lens/dist/runtime.cjs` 内联 SourceMap，产物体积由 `18.08 MiB` 缩减至 `5.76 MiB`。
- 新增内存回收、目录轻模式与快照瘦身运行时回归测试（工单 `PIH-MEM-001`）。

## 0.2.3 — 2026-11-22

- 留空 `piHarness.piPackagePath` 时优先定位 Pi 托管安装（依次检查 `PI_MANAGED_INSTALL_ROOT`、`PI_CODING_AGENT_DIR` 与默认 `~/.pi/agent/install` 下的 `managed-install.json` 和 `current-version`），未找到时回退到 `npm root -g`。
- 通过“在终端中继续此会话”交接托管安装的 Pi 时传递 `PI_MANAGED_INSTALL_ROOT`。
- 补充 Pi 包定位逻辑单元测试，并适配本机托管安装环境的运行环境检查。

## 0.2.2 — 2026-11-11

- 直接加载全局安装或 `piHarness.piPackagePath` 指定的 Pi，不限制 Pi 版本号。
- MCP 工具命名接口支持从 Pi 内部模块或 Pi 自带的独立 MCP 包加载。
- 新增真实安装的 Pi 加载测试，检查全局定位、指定目录以及开发依赖中的 Pi 模块。

## 0.2.1 — 2026-11-06

- 模型选择器按照 Pi 已保存的 `enabledModels` 筛选，支持模型名称、通配符和思考级别后缀。
- 项目设置优先于全局设置；多个工作区目录的筛选结果合并显示并去除重复项。
- 新会话和模型轮换使用相同的 scoped 范围，默认模型从有效范围中选择。
- 已配置范围没有匹配到可用模型时显示明确错误；刷新失败时更新模型选择器，清除旧选项。
- 新增七项真实集成测试，覆盖范围解析、默认模型、刷新、无匹配、多目录和实际 Chat 请求；本次共通过十一项相关集成与回归测试。
- 0.2.1 VSIX 在 VS Code Stable 1.145.1 中完成安装验证，七项 scoped-models 集成测试全部通过。

在 Pi 的 `/scoped-models` 中保存选择后，执行 **Pi: 刷新 Pi 模型列表**。未配置范围或范围为空时，显示全部可用模型。
