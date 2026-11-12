# Pi Harness 0.2.2 安装与使用

## 运行条件

- Windows 11 x64。
- VS Code Stable 1.145.1，启用 `local.pi-harness` 使用的实验接口。各版本的检查范围见 `ACCEPTANCE.md`。
- 已安装 Pi，npm 包为 `@earendil-works/pi-coding-agent`。插件直接加载当前安装的 Pi，不限制 Pi 版本号。
- PATH 中的 Node.js 至少为 `24.15.0`。后台的恢复记录使用 `node:sqlite`。
- 本地工作区已经获得 VS Code 信任；项目 `.pi` 资源按 Pi 的信任设置加载。

## 安装

安装 Pi，并在终端中完成模型配置或登录：

```powershell
npm install -g @earendil-works/pi-coding-agent
pi
```

需要使用项目 `.pi` 中的资源时，在项目目录运行 Pi，通过 `/trust` 保存信任选择。

安装交付的扩展包：

```powershell
code --install-extension pi-harness-0.2.2.vsix
```

在命令面板执行 **Preferences: Configure Runtime Arguments**，在 `argv.json` 的对象中加入：

```json
"enable-proposed-api": ["local.pi-harness"]
```

完全退出 VS Code 后重新启动。在 Chat 的新建会话类型中选择 **Pi**。如果列表中没有 Pi，检查 Extension Host 日志中的实验接口授权错误。远程窗口不提供 Pi 会话。

在用户设置中设置：

```json
"chat.requestQueuing.defaultAction": "queue"
```

这个设置影响该配置范围内的全部 Chat 会话类型。扩展激活时不会持续写入此设置。本次实施已核对当前日常 VS Code 用户配置为 `queue`。

## 会话与输入

- 在 Chat 中新建 Pi 会话。多个工作区文件夹同时打开时，输入区的“工作目录”决定该草稿使用的目录。
- 在模型选择器中选择 Pi 模型及思考级别。文件、选区、符号、Problems 和图片可以作为附件发送。
- 模型列表按照 Pi 已保存的 `enabledModels` 筛选。可以在终端的 `/scoped-models` 中选择模型并保存，再执行 **Pi: 刷新 Pi 模型列表**。项目 `.pi/settings.json` 中的设置优先；多个工作区目录的筛选结果合并显示并去除重复项。没有设置范围或范围为空时显示全部可用模型；设置的范围没有匹配到可用模型时显示错误提示。
- 当前请求执行期间，按 Enter 将下一条消息加入 VS Code 队列。选择 **Steer with Message** 或对应快捷键可以发送引导消息。
- 点击停止按钮会停止当前会话的执行及其所属任务。其他会话继续运行。
- 输入 `/` 可以选择该工作目录的有效 Pi 技能；技能参数和附件随请求提交。
- 会话列表显示当前工作区的 Pi 历史，包括终端创建的会话。浏览普通历史不会加载该会话的运行资源。
- 在回复中选择文字后按 `Ctrl+Alt+Q`，以 Markdown 引用格式加入输入框。该功能会恢复剪贴板原有文字，图片和富文本不在恢复范围内。

## 共享后台与状态

每个 VS Code 窗口使用一个 Pi 后台进程和一个进程管理辅助程序。每个 Chat 保存独立的工作目录、模型、历史和扩展资源。

状态栏固定显示一个 **Pi** 按钮。悬停可查看会话名称、执行状态、后台 PID、CPU、内存及辅助程序占用。统计对应各自进程，不包含全部后代进程占用。

`piHarness.sessionResidencyLimit` 默认值为 `10`。超过目标数量后，后台按最近使用顺序释放符合条件的会话。执行中、有界面引用、子任务、待答交互、文件提交或恢复操作的会话继续保留。再次使用已释放的会话时，后台从原会话文件恢复资源。`piHarness.idleShutdownMinutes` 已停用。

## 单会话 reload

可以在当前 Pi Chat 中执行 `/reload`，使用会话列表菜单的“重新加载会话”，或在命令面板执行 **Pi: 重新加载会话**。Pi 扩展中的 `ctx.reload()` 进入同一流程。

reload 重新读取当前会话的扩展、技能、提示模板、主题、模型资源和 MCP 配置，保留会话 ID、文件、历史及工作目录。当前执行、所属子任务和工具尚未完成时，reload 会等待；后续普通请求按顺序继续。其他会话使用自己的资源。

空白草稿首次执行 `/reload` 会按照输入区选定目录创建正式会话并加载资源，不发送模型请求。没有可用模型时，可以通过会话列表或命令面板的入口处理已有会话。

资源加载、生命周期事件、技能或模板读取、主题解析、MCP 连接及认证失败会显示原因。修正对应资源或完成该 MCP 服务的实际认证后，再执行 reload。加载超过 60 秒或关闭超过 10 秒时，会话保持保护，待实际加载和清理结束后才能重试。输出面板 **Pi Harness** 保存具体错误。

## 编辑历史与文件恢复

在请求上按 Enter 或点击请求文字，修改并提交。确认后，Harness 停止受影响请求及其子任务，检查文件提交状态，恢复目标请求之前的分支和文件，然后提交修改后的请求。

恢复范围包含通过 Harness 文件接口完成的 `edit`、`write`，以及使用该接口的所属子任务修改。`bash` 和直接写文件的第三方工具需要依靠其自身的恢复办法。目标文件有未保存文本或内容冲突时，操作会报告具体文件并保持保护。

恢复过程使用持久记录。后台或窗口在恢复中结束后，重新打开会话会读取记录并继续检查。历史和文件恢复完成后，保留的输入等待用户明确发送；普通发送、reload、删除和终端交接受恢复状态约束。

Fork Conversation 可以复制请求之前的历史，并提供文件恢复选择；`/fork` 复制整个会话。请求上的 Delete 键显示操作提示。

## 存储与终端交接

- Pi 历史继续保存在原会话目录中的 `.jsonl` 文件。
- 恢复和写入归属记录保存在该会话目录的 `.pi-harness/<会话完整路径的 SHA-256>.sqlite`，SQLite 使用 WAL 和 FULL 同步。
- 修改快照保存在 VS Code 扩展全局存储的 `local.pi-harness/snapshots`。清理命令保留历史、待恢复操作和文件提交记录引用的内容。
- 同一会话只能由一个 Harness 窗口持有写入权限。继续外部创建的会话前，需要确认终端中的相同会话已经关闭。
- 使用“在终端中继续此会话”时，扩展先关闭该会话的资源并释放权限，再打开可见终端。共享后台继续服务其他 Chat。

## 兼容包与设置

安装包包含 `pi-subagents`、`pi-cliproxyapi-provider`、Pi MCP、`pi-lens` 和 `pi-token-usage` 的兼容代码，以及 Koffi 的 Windows 原生文件。Harness 按用户原有资源配置映射到包内来源；终端使用的 Pi 安装目录保持原内容。兼容来源和构建说明见 `DEVELOPMENT_PLAN.md`。

`pi-lens` 为每个会话分别管理编辑检查和语言服务。`pi-token-usage` 缓存已读取的会话文件，每次刷新检查文件变化，继续统计完整历史中的 token 和费用。

- `piHarness.piPackagePath`：指定 Pi 包目录；留空时通过 `npm root -g` 查找。
- `piHarness.sessionResidencyLimit`：空闲会话的保留目标数量。
- Copilot 查询工具需要当前 VS Code 配置已登录且实际提供这些工具。

VS Code 1.144.0 和 1.144.1 在关闭未发送消息的 Editor 草稿，或将草稿提交为正式会话时，没有通知扩展释放原草稿输入状态。这些草稿的目录监视保留至扩展停用；正式会话按自身身份管理资源。两个版本的实际检查和接口依据记录在 `ACCEPTANCE.md`。

本次版本的实际验收结果、环境条件和证据路径见 `ACCEPTANCE.md`。
