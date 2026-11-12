# Pi Harness 验收记录

## 0.2.2 Pi 版本兼容检查

- Windows 11 x64、Node.js 24.15.0、VS Code Stable 1.145.1，当前全局 Pi 为 1.5.2。
- 五项真实运行环境测试通过：全局定位、指定安装目录、开发依赖中的 Pi 1.5.0，以及两个安装目录的 MCP 接口。
- 安装 0.2.2 VSIX 后，九项真实扩展宿主测试全部通过，覆盖 Chat 回复、目录查询、重新加载、模型默认设置、模型范围解析、刷新、多目录和模型轮换。
- 类型检查、构建与安装包内容检查通过。运行时直接加载当前选定的 Pi 安装目录，不限制 Pi 版本号。

运行环境测试：`node --test dist/test/runtime/*.test.js`。

安装测试结果：`.test-work/installed-runtime-2026-11-11T14-21-12-442Z/results.json`。

安装与包内容记录：`.test-work/pi-version/installed-verification.json`、`.test-work/pi-version/package-verification.json`。

## 0.2.1 模型范围检查

- 源码类型检查、构建及十一项相关集成与回归测试通过，覆盖已保存范围、默认模型、思考级别、通配符、无匹配、刷新、多目录、实际 Chat 请求和会话恢复。
- 在 VS Code Stable 1.145.1 中安装 0.2.1 VSIX，确认扩展从安装目录加载；七项 scoped-models 集成测试全部通过，实际模型为 `cpa/gpt-6-astra` 和 `cpa/gpt-6-luna`。
- VSIX 的版本、必需文件和本机路径检查通过。

源码测试结果：`.test-work/run-2026-11-06T02-59-59-337Z/results.json`。

安装测试结果：`.test-work/installed-scoped-2026-11-06T03-16-43-198Z/results.json`。

## 0.2.0 环境与证据

本次检查在 Windows 11 x64 中执行，使用 Pi 1.5.0、Node.js 24.15.0，以及独立 VS Code 1.144.0 和 1.144.1 配置。模型请求连接本机已配置的真实服务，主要模型为 `cliproxyapi/gpt-6-astra`，模型切换使用 `cliproxyapi/gpt-6-luna`。

测试目录位于 `./.test-work/`。每次 VS Code 运行分别保存用户目录、扩展目录、工作目录、Pi 会话和子任务资料。日常 VS Code 的扩展文件及用户设置保留原内容；当前日常 `chat.requestQueuing.defaultAction` 已为 `queue`。

以下证据路径均相对于项目根目录。各结果文件保存实际测试环境、操作、断言或进程身份。独立 SDK 检查、真实后台集成和界面操作分别记录。

## 已完成的检查

| 范围 | 实际检查 | 证据 |
| --- | --- | --- |
| SDK 与存储恢复 | 21 项通过；公开 SDK 导航、当前用户叶子、根用户、连续用户、导航取消、扩展事件错误、SQLite 写入锁与损坏数据库、真实文件冲突及退出后续接 | `.test-work/implementation/history/results.json` |
| 实际文件提交授权 | 6 项通过；真实 Hub、PiSession、guardian 和模型 write 生成提交身份，FileGate 调用真实后台校验身份并持久保存意图；包括独立 bundle bridge、并发提交、未保存文档、过期身份、停止与释放、空文件和快照保护 | `.test-work/implementation/history/vscode-file-results.json` |
| 授权记录检查 | 六份实际 SQLite 数据库检查通过；宿主、后台及 guardian 的 PID、创建时间、ownershipId 和全部文件提交身份一致，最终归属为 released | `.test-work/implementation/history/authorized-ownership-results.json` |
| 执行期间恢复 | 真实主请求执行期间恢复，以及停止后立即恢复；原文件恢复、后续文件保持不存在、旧身份拒绝、受保护操作拒绝、修改保留输入后发送并保存 completed | `.test-work/implementation/history/active-root-test-results.json`、`.test-work/implementation/history/active-root-results.json`、`.test-work/implementation/history/active-root-persistence-results.json` |
| 未加载会话保护 | 读取持久恢复记录后拒绝归档；后台异常退出后旧归属保存 cleaned，明确发送后恢复事务完成，新归属正常释放 | `.test-work/implementation/history/unloaded-archive-test-results.json`、`.test-work/implementation/history/unloaded-archive-persistence-results.json` |
| 实际 UI 记录续接 | 复制真实 UI JSONL 与 SQLite 后使用 SDK 续接，恢复操作为 completed，待恢复记录为空 | `.test-work/implementation/history/system-update-results.json` |
| 双会话资源 | 两份真实 SDK 会话分别持有模型与资源对象；关闭 A 后 B 的 MCP 继续连接 | `.test-work/implementation/runtime/resource-results.json` |
| 资源诊断 | 十一项真实诊断通过；显式资源缺失、解析失败、resources_discover 返回的缺失模板及主题、正常重名选择均有检查 | `.test-work/implementation/runtime/diagnostics/1793787359641/results.json` |
| 资源重新读取 | 同一 SessionManager 在两代运行时中读取修改后的技能、模板、AGENTS.md、扩展及模型；默认设置和扩展参数保留，启动与关闭各执行一次 | `.test-work/implementation/runtime/reload-resources/1793786413001/results.json` |
| MCP 配置与连接 | 八项通过；无效配置、连接程序不存在、真实连接握手超时、实际服务 needs-auth，以及修正配置后的重新加载 | `.test-work/implementation/runtime/mcp-failure/1793786225369/results.json` |
| child 关闭错误 | 真正 SDK child 的扩展关闭操作读取失效文件；所属关闭接口报告原因并保留保护状态 | `.test-work/implementation/runtime/child-shutdown/1793784546322/results.json` |
| 兼容来源 | Node Inspector 记录实际执行的工厂；主会话和 child 加载包内兼容来源，原安装来源没有执行，child 没有重复初始化父 subagents factory | `.test-work/implementation/runtime/compat-sources/1793785776125/results.json` |
| 进程生命周期 | 两个真实管理实例争用同一会话、所属权限释放、后台根进程退出后的后代清理、辅助程序退出后提交清理证明；正常清理样本为 218 毫秒 | `.test-work/implementation/windows/lifecycle-results.json` |
| 所有者异常退出 | 宿主退出后辅助程序独立完成清理、两个所有者结束后的命名 Job 接管、缺少退出证明时拒绝接管 | `.test-work/implementation/windows/owner-exit-results.json` |
| 启动取消 | 实际辅助程序启动在 0、1、5、10、25 毫秒取消，及握手完成后关闭；每次等待真实进程退出，均在四秒内结束 | `.test-work/implementation/windows/startup-cancel-results.json` |
| 原生模块 | VS Code 1.144.0 的真实 Extension Host 加载 Koffi 3.3.6，执行 Job 与进程管理检查 | `.test-work/implementation/windows/vscode-host-results.json` |
| 文件监视 | 四十次真实检查通过；已有目录和尚未创建的目录交替运行，ready 后立即创建多层目录及 SKILL.md，并同时监视相邻设置文件 | `.test-work/implementation/windows/watcher-results.json` |
| 两个宿主版本的界面 | 多目录选择与技能更新、全局资源监视、技能正文一次展开、文件附件、列表悬停、唯一状态按钮、独立进程 CPU/RSS、Enter 排队及 Alt+Enter 引导通过 | `.test-work/implementation/windows/ui-host/1793786367376/checks.json`、`.test-work/implementation/windows/ui-host/1793787054297/checks.json` |
| 模型与终端 | 两个真实模型切换、所属会话关闭后交给终端、模型目录读取时后台退出并在清理后重新取得模型通过 | `.test-work/implementation/model-regression.log` |
| 模型认证失败 | 实际模型服务对无效凭据返回 401，错误显示且共享后台继续运行 | `.test-work/implementation/auth-native-regression.log` |
| 子任务与请求身份 | 五项通过；同文跨队列、steer 文件归属、前台 child 与后台 runner 并行、第三会话 reload、多层子任务恢复，以及关闭错误保护 | `.test-work/run-2026-11-04T11-30-14-089Z/results.json`、`.test-work/implementation/npm-test-release.log` |
| Chat reload 入口 | 真实空白草稿 `/reload`、会话列表菜单、模型列表为空时的命令面板均通过；目录正确，ID、文件、后台 PID 保留，没有模型消息 | `.test-work/implementation/windows/reload-ui-host/1793788379720/checks.json` |
| 正常关闭与重开 | 两次窗口均以退出码 0 结束；继续同一会话，两代写入归属均为 released，宿主、后台与辅助程序全部退出 | `.test-work/implementation/reopen-confirmed-close.log`、`.test-work/implementation/windows/reopen-confirmed-ownership.json` |
| 实际扩展工具 | Codemode 读取真实文件，Tool Search 加载工具后调用实际 MCP；两个会话的 edit 和 TypeScript 主语言服务检查通过 | `.test-work/implementation/history/tools/results.md` |
| pi-lens 会话隔离 | 三项真实 Host 检查通过；A 和 B 的自动编辑检查使用各自目录，A 关闭后 B 继续编辑并获得实际 LSP 诊断；两份最终归属释放，十三个记录进程全部退出 | `.test-work/implementation/history/tools/run-2026-11-04T10-55-28-552Z/results.json`、`.test-work/implementation/history/tools/run-2026-11-04T10-55-28-552Z/automatic-isolation-results.json`、`.test-work/implementation/history/tools/run-2026-11-04T10-55-28-552Z/observed-process-exit-verification.json` |
| token 统计缓存 | 十二项真实文件变化检查通过；实际 63,638 条历史记录与原实现逐字段一致，重复刷新约 93 毫秒 | `.test-work/implementation/windows/token-cache/1793789889835/results.json`、`.test-work/implementation/windows/token-cache-real/1793789973754/results.json` |
| 关闭期限 | 实际 BackendReload 在 10,356 毫秒报告超时，立即重试被拒绝；真实关闭完成后重试成功，最终归属释放及进程退出 | `.test-work/implementation/windows/close-timeout-host/1793790257834/close-timeout/verification.json` |
| 同步关闭期限 | 真实扩展同步等待 11 秒，BackendReload 在 11,034.5 毫秒报告十秒期限；实际操作结束后重新加载至第二代 | `.test-work/implementation/runtime/sync-close/1793790962145/results.json` |
| 同目录语言服务 | 两个真实 SDK 会话分别获得 TypeScript 诊断；关闭 A 后 B 继续，重新创建 A 后两者继续；目录登记与所属 LSP 子进程正确释放 | `.test-work/implementation/runtime/lens-same-directory/1793790892779/results.json` |
| checkpoint 保存 | 实际 checkpoint 写入期间关闭，3,738 毫秒完成；完整 graph 保存 96 个文件、5,183 个节点和 11,765 条边，独立校验与进程退出检查通过 | `.test-work/implementation/history/tools/checkpoint/1793791001664/results.json` |
| 目录刷新与分叉 | 连续二十次实际目录刷新均取得 29 个模型；独立 Host 七次刷新、真实分叉及后续模型请求通过，源历史保留、后台身份保持、最终归属释放 | `.test-work/implementation/runtime/catalog-reload/1793791412353/results.json`、`.test-work/implementation/history/tools/run-2026-11-04T11-26-19-967Z/results.json` |
| 跨窗口菜单权限 | 第二个真实窗口通过会话右键菜单 reload，被第一窗口的写入权限阻止；第一窗口正常释放后，同一菜单重新加载相同会话成功，两笔归属最终 released | `.test-work/implementation/windows/ownership-menu-host/1793791694610/contender/checks.json`、`.test-work/implementation/windows/ownership-menu-host/1793791694610/ownership-exit.json` |

## 完整集成与安装检查

构建使用 `npm run build`，VSIX 构建使用 `npm run package`。生产依赖包括 Koffi 3.3.6 的 Windows x64 原生模块、Jiti、chokidar 5.0.0 和兼容包所需依赖。最终安装包的安装结果、SHA-256、源码核对和进程退出证据记录于 `.test-work/implementation/verification-final.json`；包内文件核对记录于 `.test-work/implementation/vsix-verification.json`。

| 检查 | 当前状态 | 记录 |
| --- | --- | --- |
| TypeScript 类型检查 | 冻结源码通过 | `.test-work/implementation/typecheck-final.log` |
| 共享后台、十二个会话、reload、子任务 | 后台九项、子任务五项全部通过 | `.test-work/run-2026-11-04T11-30-14-089Z/results.json` |
| 真实模型服务认证拒绝 | 已通过 | `.test-work/implementation/auth-native-regression.log` |
| 全部扩展宿主测试 npm test | 47 项全部通过；窗口退出码 0，59 个数据库的归属记录及相关进程退出核对通过；停止操作耗时 4,521 毫秒 | `.test-work/implementation/npm-test-release.log`、`.test-work/run-2026-11-04T11-30-14-089Z/ownership-release-verification.json` |
| 界面操作 test:ui 测试组 | 九项全部通过；窗口退出码 0，五笔归属及进程退出核对通过 | `.test-work/ui-2026-11-04T11-33-00-266Z/ui-results.json`、`.test-work/ui-2026-11-04T11-33-00-266Z/ownership-release-verification.json` |
| 重开窗口 test:reopen 测试组 | 两阶段通过；同一会话，两笔归属及进程退出核对通过 | `.test-work/implementation/reopen-release.log`、`.test-work/reopen-2026-11-04T11-36-52-708Z/ownership-release-verification.json` |
| 无实验接口授权 test:no-proposed 测试组 | 已通过；缺少授权时显示明确的 chatSessionsProvider 错误 | `.test-work/implementation/no-proposed-release.log` |
| VS Code 1.144.1 安装预检 | 官方 CLI 安装，实际技能、模型附件、reload、列表与状态按钮通过；正常退出及归属核对通过 | `.test-work/implementation/windows/installed-host/1793792244393/checks.json`、`.test-work/implementation/windows/installed-host/1793792244393/ownership-exit.json` |
| 最终 VSIX 安装 npm run test:acceptance 与 1.144.1 独立安装 | 每项操作结果、未执行项目、安装路径与进程退出核对均保存于最终安装记录 | `.test-work/implementation/verification-final.json`、`.test-work/implementation/acceptance-release.log` |

## 独立代码审查

主代理集成三个使用 ultra 思考强度的子代理工作。独立审查记录位于 `.test-work/implementation/history/review.md` 和 `.test-work/implementation/windows/review.md`；运行时检查记录位于 `.test-work/implementation/runtime/review.md`。冻结源码的独立复核没有剩余确认代码问题；后台、宿主、恢复及界面的组合检查已包含在完整集成测试中。

## 外部条件与验证范围

- 测试配置没有登录 GitHub Copilot。只有 vscode.lm.tools 实际提供相关工具后，才能执行 Copilot 查询工具验收；缺失项目单独记录为未执行。
- WinEventHook 正向探针已确认能记录可见顶层窗口。1.144.0 观察 314572 毫秒，1.144.1 观察 325225 毫秒，关联测试进程的顶层 SHOW 与无法确认归属的 SHOW 均为零；证据为 `.test-work/implementation/windows/chat-ui-windows-1.144.0.json` 和 `.test-work/implementation/windows/chat-ui-windows-1.144.1-final.json`。用户报告的短暂窗口尚未复现，原因仍未确认。
- VS Code 1.144.0 和 1.144.1 关闭未提交 Editor 草稿后没有发出输入状态释放事件；草稿提交后原 untitled 状态同样保留。公开接口没有提供准确的草稿 URI 释放通知，相关监视保留至扩展停用。这两项检查保持未通过，证据为 `.test-work/implementation/windows/ui-host/1793787054297/lifecycle-issues.json`；宿主源码依据见 `.test-work/implementation/windows/review.md`。
- 文件恢复覆盖通过 Harness 文件接口完成的 edit、write 及其子任务写入。直接由 shell 或第三方工具改动的文件不在该接口的恢复范围内。
- 当前版本使用 VS Code 的 proposed API，并依赖已核查版本的输入状态行为；升级 VS Code 后需要重新执行兼容检查。
- pi-lens 的 TypeScript 主语言服务和编辑后自动检查已经通过。两次包含全部辅助语言服务的查询在安装启动期间超时，辅助服务完整性未计为通过；具体调用及结果见 `.test-work/implementation/history/tools/results.md`。

## 交付路径

- 安装包：`./pi-harness-0.2.0.vsix`；SHA-256 和安装验证记录见 `.test-work/implementation/verification-final.json`。
- 安装与使用：`./INSTALL.md`。
- 开发说明：`./DEVELOPMENT_PLAN.md`。
- 兼容来源与许可：`./compat/SOURCES.md`。
- 本次实施记录：`./.test-work/implementation/`。
