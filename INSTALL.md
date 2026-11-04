# Pi Harness 安装说明

Pi Harness 把 Pi 编码代理接入 VS Code 侧边栏的 Chat，作为一种聊天会话类型使用。

## 版本要求

- Windows。
- VS Code Stable 1.144.0（提交 `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`）或 1.144.1（提交 `261c84cb1eddf11235f9e2c921425e9663fbe556`）。两个版本中扩展使用的实验接口声明完全相同。其他版本的实验接口可能变化，需要重新测试。
- Pi 1.5.x：全局安装的 npm 包 `@earendil-works/pi-coding-agent`。
- PATH 中的 `node` 满足 Pi 要求的版本（Pi 1.5.0 要求 `>=22.19.0`）。

## 安装 Pi

1. 安装 Pi：

   ```powershell
   npm install -g @earendil-works/pi-coding-agent@1.5.0
   ```

2. 在终端中运行一次 `pi`，完成登录或模型配置，确认 Pi 可以正常回复。
3. Pi 在 VS Code 中以 RPC 模式运行，不显示项目信任提示。需要加载项目目录 `.pi` 中的扩展、技能和提示模板时，在该项目目录的终端中运行 `pi`，执行 `/trust` 保存信任决定。

## 安装扩展

1. 安装 VSIX：

   ```powershell
   code --install-extension pi-harness-0.1.0.vsix
   ```

   也可以在扩展视图右上角的菜单中选择 Install from VSIX...。

2. 授权实验接口。在命令面板中执行 Preferences: Configure Runtime Arguments，在打开的 `argv.json` 中加入：

   ```json
   "enable-proposed-api": ["local.pi-harness"]
   ```

   保存后完全退出 VS Code（关闭所有窗口），再重新启动。只重新加载窗口不会读取 `argv.json`。

3. 检查授权。打开 Chat 视图，在新建聊天的会话类型中选择 Pi。出现 Pi 即表示授权生效。没有出现时，在命令面板中执行 Developer: Show Running Extensions 或查看 Output 面板的 Extension Host 日志：出现 `Extension 'local.pi-harness' CANNOT use API proposal` 说明 `argv.json` 没有生效。

## 使用

- **新建会话。** 在 Chat 视图新建聊天时选择 Pi。工作区有多个文件夹时，输入区的“工作目录”选项决定 Pi 的工作目录。
- **模型和思考级别。** 模型选择器中列出 Pi 已配置的模型，只在 Pi 会话中出现；支持思考的模型在模型选择器中显示思考级别。选择随每条消息生效。
- **历史会话。** 会话列表显示当前工作区文件夹的 Pi 会话，包括在终端中创建的会话。打开历史不会启动 Pi。
- **附件。** 可以附加文件、选区、符号、Problems 中的诊断和图片。VS Code 默认在发送前保存已修改的编辑器（设置 `chat.saveBeforeSend`）。
- **运行中引导。** Pi 运行时输入消息，选择 Steer with Message，消息在 Pi 下一次调用模型之前送达。
- **停止。** 点击停止按钮会清空 Pi 的消息队列并中止当前运行。
- **修改与差异。** Pi 的 `edit` 和 `write` 修改显示在 Chat 的文件变更中；工具调用中的“打开差异”显示本次修改前后的内容。Pi 运行期间你在编辑器中修改且尚未保存的文件，Pi 不会覆盖。
- **编辑请求。** 在一条请求上按 Enter（或点击请求文字）修改后提交。VS Code 确认后撤销该请求及之后请求中 Pi 的文件修改，扩展把 Pi 会话退回到这条请求之前，再发送修改后的文字。原来的对话作为分支保留在 Pi 会话文件中。撤销范围是 Pi 在这些请求的响应中用 `edit` 和 `write` 做的修改；`bash` 命令改动的文件，以及会话被重新打开后接回显示的那一轮中的修改，不会撤销。
- **分叉。** 在请求上方的工具条中点击 Fork Conversation，可以选择同时把 Pi 用 `edit` 和 `write` 修改过的文件恢复到这条请求之前（`bash` 命令改动的文件不在恢复范围内）；之后通知中的“把原请求填入输入框”会把原请求和附件放回输入框。`/fork` 复制整个会话。
- **引用回复。** 在回复中选中文字后按 `Ctrl+Alt+Q`，选中的文字以 Markdown 引用格式插入输入框。该命令通过剪贴板取得选中的文字，执行后恢复剪贴板中原来的文字；剪贴板中原有的图片和富文本不会保留。
- **会话列表菜单。** 右键会话可以重命名、删除（移到回收站）或在终端中继续此会话。在终端中继续之前，扩展先结束该会话在 VS Code 中的 Pi 进程。
- **Delete 键。** 在 Pi 会话的请求上按 Delete 只显示提示，不执行 VS Code 的还原检查点。

## 设置

- `piHarness.piPackagePath`：Pi 包的安装目录。留空时通过 `npm root -g` 查找。
- `piHarness.idleShutdownMinutes`：Pi 会话空闲多少分钟后结束其 Pi 进程，默认 10。下一次发送消息时自动重新启动。

## 同时在终端和 VS Code 中使用同一会话

同一个会话文件同时被两个 Pi 进程写入会损坏历史。VS Code 在继续一个已有会话之前会请你确认已关闭终端中打开的同一会话；多个 VS Code 窗口之间由扩展自动互斥，同一会话只能在一个窗口中运行。需要回到终端时，使用会话右键菜单中的“在终端中继续此会话”。

## 常见问题

- **新建聊天中没有 Pi。** 检查 `argv.json` 是否包含 `"enable-proposed-api": ["local.pi-harness"]`，并确认完全退出后重新启动了 VS Code。远程窗口中不提供 Pi。
- **模型选择器中没有 Pi 的模型，无法发送。** 打开 Output 面板，选择 Pi Harness 查看原因：工作区未受信任、Pi 没有可用模型、找不到 Pi 包、PATH 中的 `node` 版本不满足要求，或读取模型列表的 Pi 进程异常退出。处理之后点击提示中的“刷新 Pi 模型列表”，或在命令面板中执行同名命令。
- **发送后提示“Pi 进程在完成握手前退出”。** Pi 在启动过程中结束了，提示中给出退出码和 Pi 的标准错误输出。重新发送会启动新的 Pi 进程。反复出现时，在同一目录的终端中运行 `pi`，检查 Pi 及其扩展能否正常启动。
- **Copilot 工具。** Pi 可以调用 `copilot_searchWorkspaceSymbols`、`copilot_searchCodebase` 和 `copilot_getErrors`，前提是 VS Code 中存在这些工具（需要 GitHub Copilot 可用）。
