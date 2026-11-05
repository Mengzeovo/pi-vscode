# Pi Harness 0.2.0 开发说明

## 运行结构

`PiHub` 为窗口提供唯一 `SharedBackendClient`。后台通过 Pi 1.5.0 SDK 为每个 Chat 创建 `AgentSessionRuntime`，使用独立的 `SessionManager`、模型资源、资源加载器、编辑器连接和交互状态。

`GuardianClient` 与独立辅助程序共同持有 Windows Job 句柄。后台完成受控启动授权后才加载 SDK。辅助程序持有会话写入权限，记录 PID、进程创建时间、后台代次和归属。后台或宿主异常结束时，仍存活的管理方清理所属进程，核对退出证明后更新 SQLite 记录。

扩展停用使用从入口计算的 4 秒统一期限。没有完成清理证明的旧归属继续保持保护。主动终端交接通过 VS Code Terminal API 创建可见终端。

## 通信与状态

- 后台控制协议：`src/backend/protocol.ts`。
- 宿主与共享后台：`src/pi/sharedBackend.ts`。
- 会话注册和资源序列：`src/backend/registry.ts`、`resources.ts`。
- 编辑器连接与 Pi 扩展：`src/ipc/ipcServer.ts`、`pi-extension/index.ts`。
- 文件提交和恢复：`src/edits/fileGate.ts`、`src/backend/operationStore.ts`、`recoveryCoordinator.ts`。

事件包含会话 ID、后台代次、运行时代次、请求 ID、运行 ID 和顺序号。主会话及所属子任务的写入还包含 `ownershipId` 和 `operationEpoch`。宿主在实际提交前向后台检查身份；每个文件的比较和写入按顺序执行。

输入引用按实际 Chat URI 保存。关闭一个视图只释放对应引用。会话释放需要确认执行、排队、子任务、交互、文件提交、恢复、reload 和交接均满足条件。超过默认 10 个保留目标时按最近使用顺序释放，归档会话优先检查，重试间隔为 30 秒。

## reload 与恢复

`/reload`、会话菜单及 `ctx.reload()` 使用同一会话控制序列。全局资源加载操作按顺序执行。完成条件包含生命周期监听错误、资源诊断、扩展发现结果及 MCP 真实连接状态。调用方超时后，实际 Promise 和资源归属继续保留，直到清理得到确认。

历史恢复使用 `sourceMarker` 和 `navigationMarker` 保存分支选择。操作记录包含目标条目、请求身份、保留输入、附件、逐文件内容和恢复进度。文件写入前保存修改意图，防止工具已写文件而历史记录尚未完成时失去恢复依据。重新打开恢复操作时核查旧归属，文件操作和导航按已提交进度继续；模型请求由用户明确发送。

SQLite 使用 WAL、FULL 同步、完整性检查和事务。恢复数据位于会话目录的 `.pi-harness`。快照清理同时读取历史和操作数据库的引用。

## 界面

`PiCustomizationProvider` 从实际 Pi 资源取得技能，并按草稿 URI 和工作目录隔离缓存。提交时将技能选择转换为 Pi 技能调用，保留参数与附件。文件变化和 reload 触发菜单刷新。

`SessionList` 复用条目和创建时间，不设置原始路径 tooltip。`StatusController` 维护窗口唯一 Pi 按钮，分别显示后台及辅助程序的 CPU、内存和会话状态。

`chat.requestQueuing.defaultAction` 由安装配置设置为 `queue`；扩展激活不会持续改写用户配置。

## 构建与兼容来源

Pi SDK 固定为 1.5.0。运行最低 Node.js 版本为 24.15.0。VS Code 使用本仓库保存的实验接口声明。

`compat/pi-subagents` 基于 0.84.0，`compat/pi-cliproxyapi-provider` 基于 1.4.24，`compat/pi-mcp` 基于 Pi 1.5.0，`compat/pi-lens` 基于 4.4.8，`compat/pi-token-usage` 基于 0.2.1。兼容代码保存于仓库，按原资源配置映射，并随 VSIX 分发。依赖版本在 `package-lock.json` 固定，许可证保存在对应兼容目录及生产依赖中。来源文件及 SHA-256 记录在 `compat/SOURCES.md`，安装包中的对应位置为 `dist/compat/SOURCES.md`。

`pi-lens` 使用 `vm.compileFunction` 加载完整模块，为每个会话提供独立的模块变量、全局属性和进程监听器，并跟踪实际 child process、Worker 和定时器。语言服务及编辑检查使用所属会话的工作目录。兼容入口通过所属 SDK 创建真实资源。

`pi-token-usage` 构建采用上游命令、界面和统计模块，将扫描入口替换为按文件身份及修改时间检查的缓存。JSONL 读取使用 Pi 公开的 `parseSessionEntries`。刷新重新枚举全部文件，读取新增或变化内容，删除已不存在文件的缓存；统计范围、去重方式及全部字段与上游一致。

`scripts/build.mjs` 使用 esbuild 分别构建 extension、bridge、backend 和 guardian，生成 pi-lens 与 token 统计兼容入口，将兼容目录与生产依赖复制到 `dist`。Pi SDK 由用户安装目录加载；Koffi、Jiti 及兼容包所需生产依赖随包提供。

## 验收入口

```powershell
npm run typecheck
npm test
npm run test:ui
npm run test:reopen
npm run test:no-proposed
npm run test:acceptance
```

扩展宿主测试覆盖真实模型、文件工具、附件、停止、排队、引导、并发、权限、历史及 reload。UI 测试通过实际 VS Code DOM 发送请求和执行菜单操作。Windows 启动检查使用 WinEventHook、进程创建时间和进程关系，并通过实际可见窗口验证记录器。

测试资料统一保存在 `.test-work`，使用独立用户配置及会话目录。最终版本、通过结果、外部阻碍和安装包 SHA-256 写入 `ACCEPTANCE.md`。
