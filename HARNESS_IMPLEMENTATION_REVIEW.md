# Pi Harness 实施方案复审

日期：2026-11-04。

审查对象：[HARNESS_IMPLEMENTATION_PLAN.md](./HARNESS_IMPLEMENTATION_PLAN.md)。项目分支为 `main`。

三个独立子代理均配置 `reasoning_effort: ultra`，分别复核历史回退与持久恢复、运行时与 reload、Windows 进程管理与 Chat 接口。各自完整读取修订方案，依据项目代码、实际安装的 Pi 1.5.0 SDK、VS Code 源码及官方文档检查接口和时序；新增内容由相应子代理再次复核。主代理负责方案编辑、证据检查及文档验证。当前审查范围内没有尚待修订的确认问题。

## 1. 历史回退中的后台子任务

[方案流程](./HARNESS_IMPLEMENTATION_PLAN.md:262)要求暂停相关任务创建，使原请求及全部后代的文件提交身份失效，停止所属前台和后台子任务，等待 runner、命令进程及已开始的文件操作结束。主会话、进程内 child 和独立 runner 的 `edit`、`write` 均使用编辑器提交接口。

`stopAsyncRun()` 当前表示停止请求已经提交，见 [async-stop-action.js](compat/pi-subagents/src/runs/foreground/async-stop-action.js:187)。方案新增的等待接口明确要求确认实际结束；[child 接入](compat/pi-subagents/src/runs/shared/child-session.js:435)与 [runner 接入](compat/pi-subagents/src/runs/background/runner-child-launch.js:42)使用已有扩展绑定位置。无法确认结束时保留保护状态。

## 2. 持久恢复与重新打开

[持久恢复设计](./HARNESS_IMPLEMENTATION_PLAN.md:273)使用原会话文件旁的 SQLite 数据库，保存操作身份、原分支、目标父节点、文件原内容与目标内容、附件引用及逐文件进度。数据库采用事务、WAL 和 FULL 同步；修改分支或文件前提交操作意图。

导航通过原生控制记录保存目标分支，同步会话文件后使用 `SessionManager.open()` 核对，再进入文件恢复。重新打开须同时满足旧进程清理、会话权限、分支与文件一致性条件；已经写入的文件按实际内容补记进度。恢复过程不自动重发模型请求。该流程符合 [SessionManager 的分支选择与重新打开行为](node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:733)。

## 3. 扩展停用与进程退出

[窗口关闭设计](./HARNESS_IMPLEMENTATION_PLAN.md:178)采用统一 4 秒预算，前 3 秒正常关闭，剩余时间执行终止与退出确认。预算符合本机 VS Code [最多等待 5 秒的实现](./.review-tmp/vscode/src/vs/workbench/api/common/extHostExtensionService.ts:267)。

一个 Pi 后台配合一个管理辅助程序。辅助程序持有每会话 `WriteLock`，宿主与辅助程序分别持有 Job 句柄并监视对方进程。后台、宿主或辅助程序退出时，按所属代次停止接纳新进程，终止旧 Job，确认成员数量为零后保存清理结果。正常单会话关闭保存独立的 `released` 状态，保留其他会话运行。

跨窗口接管须核对持久归属记录；取得锁、PID 消失或命名 Job 不存在均不能单独授权恢复。旧清理结果只能更新对应代次和归属记录。真实扩展宿主、Koffi 加载及管理辅助程序的完整退出流程属于实施验收。

## 4. reload 的错误与完成条件

[reload 接入流程](./HARNESS_IMPLEMENTATION_PLAN.md:224)在旧 runner 关闭前及新运行时首次绑定时安装 `onError` 收集器，覆盖 `session_shutdown`、`session_start` 和 `resources_discover`。收集器保留其他扩展继续清理的执行顺序，完成检查后才报告结果。

资源错误同时检查扩展、服务、技能、prompt templates 和主题的独立诊断，并在资源发现后再次检查。MCP 兼容工厂公开本次连接尝试、认证、工具注册和实际关闭完成状态；已启用服务器满足条件后才允许继续发送。

新资源加载及连接使用 60 秒调用方期限，旧资源关闭使用 10 秒单会话期限。SDK 没有取消接口的加载操作持续持有真实 Promise 和资源序列，直到结束并清理完成；期间禁止重建另一份资源。窗口退出继续使用统一 4 秒预算。

## 5. 当前叶子就是目标用户条目

[导航控制记录](./HARNESS_IMPLEMENTATION_PLAN.md:283)通过公开的 `appendCustomEntry()` 追加 `sourceMarker`，刷新上下文后调用 `navigateTree(userEntryId, { summarize: false })`；目标父节点追加 `navigationMarker` 并持久保存。当前用户、根用户及连续用户条目沿用原生导航事件和父节点语义。

重新创建运行时可以产生初始化元数据后代，因此按标记的 `parentId`、所属分支及后代内容核对结果。真实 SDK 验证覆盖同叶子、根用户、连续用户、导航取消、扩展资源读取失败和控制记录保存失败六个场景。

## 6. 草稿首次执行 /reload

[草稿处理](./HARNESS_IMPLEMENTATION_PLAN.md:211)沿用 VS Code 正式会话创建流程，创建回调从 `context.inputState.groups` 保存目录和选项，participant 随后依据 `request.command` 执行资源加载。正式会话身份、选择项和控制请求的显示位置已有明确规定，Pi 历史不追加模型消息。

该顺序符合 [首次创建处理](./.review-tmp/vscode/src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts:1716)。无可用模型导致 Chat 无法发送时，会话菜单与命令面板提供同一控制入口。真实 Chat 操作仍须在实施中验证。

## 本轮补充检查

- 后台根进程退出后的后代清理、辅助程序退出、宿主退出、跨窗口争用与旧代次记录提交，均进入阶段 2 和阶段 7 的必需验收。新辅助程序、Koffi 原生文件、占用显示和 VSIX 包含规则同步进入方案。
- 独立资源诊断与 `resources_discover` 新增诊断均进入 reload 完成检查。正常重名选择等提示按来源和严重程度处理；加载超时之后的清理归属与重试互斥具有明确要求。

## 已执行的验证

| 验证 | 实际结果与证据 |
|---|---|
| 原生导航 | 真实 Pi 1.5.0 SDK、会话文件及重新创建运行时；六个场景通过。[程序](./.test-work/plan-review/revision-navigation/navigation-protocol-check.mjs)、[结果](./.test-work/plan-review/revision-navigation/results.json) |
| SQLite API | Node.js 24.15.0 真实数据库，参数化事务提交、WAL/FULL、关闭重开、BLOB 一致性与完整性检查通过。[程序](./.test-work/plan-review/revision-state/verify-sqlite.mjs)、[结果](./.test-work/plan-review/revision-state/result.json) |
| 资源诊断 | 真实 SDK 验证缺失 prompt 的 `error`、技能与主题的独立诊断，以及资源发现后的技能诊断；扩展错误与服务诊断可以同时为空。[程序](./.test-work/plan-review/rereview-runtime/resource-diagnostics-check.mjs)、[结果](./.test-work/plan-review/rereview-runtime/resource-diagnostics-results.json) |
| Windows Job | 真实 Node 根进程退出后，Job 中仍有两个进程；执行 `TerminateJobObject` 后成员归零，独立测试进程继续运行。[程序](./.test-work/plan-review/rereview-shutdown-ui/job-probe.ps1)、[结果](./.test-work/plan-review/rereview-shutdown-ui/job-results.json) |
| 文档 | 方案包含 8 个阶段、8 项需求，87 处链接和 65 个本地引用文件检查通过；复审报告引用与方案校验值另由检查程序核对。[方案检查](./.test-work/plan-review/verify-plan.mjs)、[报告检查](./.test-work/plan-review/verify-review.mjs) |

本次完成方案和审查记录修订。业务功能仍待实施；多 Chat 并发、实际文件恢复与中断续接、MCP 认证及完整 reload、管理辅助程序与 VS Code 的集成、真实启动窗口捕获、VSIX 构建安装，均保留为实施验收项目。上述 API 验证没有使用模型请求或替换 SDK 对象，也没有终止用户会话。
