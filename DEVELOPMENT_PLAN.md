# 在 VS Code Chat 中使用 Pi 的开发计划

## 交付目标

用户打开本地项目后，可以在 VS Code 侧边栏的 Chat 中选择 **Pi**，新建对话，或打开终端中已保存的 Pi 会话接着聊。用户可以把编辑器中选中的代码、文件、符号、图片或 Problems 面板中的错误加入上下文，也可以把 Pi 回复中选中的文字引用到输入框。Pi 可以查询定义和引用、调用启用的 Copilot 工具、直接修改文件，用户在 VS Code 中查看每次修改的差异。用户可以从一条请求分叉出新对话，分叉时可以把 Pi 修改过的文件恢复到该请求之前的内容，再把该请求的原文和附件填回输入框修改后重新发送。Pi 运行期间，用户可以追加引导消息、排队消息或停止任务。Pi 管理模型、工具执行和历史，用户未保存的编辑受到保护。退出 VS Code 后，用户可以在终端继续同一个会话。

交付物为可安装的 VSIX、与版本对应的安装说明，以及在 Windows 上使用真实 VS Code 和 Pi 完成的验收记录。扩展 ID 采用 `local.pi-harness`，会话类型采用 `pi-harness`。开发基准为本机 VS Code Stable 1.144.0（提交 `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`）、Pi 1.5.0 和 Node.js 24.15.0。

文中 VS Code 源码位置均指该提交，Copilot 相关位置指同一提交中的 `extensions/copilot`，Pi 源码位置指 Pi 1.5.0 安装包中的 `dist` 目录。

## 阶段 0 · 确认接口、能力边界和安装条件

用户应当能在自己的 VS Code 中启用 Pi，并知道需要哪些版本和启动参数。

- **VS Code 接口。** 类型声明固定到上述提交。会话列表、会话内容和分叉使用 `chatSessionsProvider`；请求 ID、`editedFileEvents`、`yieldRequested` 和历史轮次类型使用 `chatParticipantPrivate`；工具展示、`externalEdit`、`questionCarousel`、`thinkingProgress` 和 `usage` 使用 `chatParticipantAdditions`；诊断附件使用 `chatReferenceDiagnostic`；图片附件使用 `chatReferenceBinaryData`；模型选择器中的 Pi 模型（`targetChatSessionType`、`configurationSchema`、`isDefault`、`request.modelConfiguration`）使用 `chatProvider`。构建时检查类型，验收时检查实际运行的 VS Code。[会话接口](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts) · [请求和历史类型](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/src/vscode-dts/vscode.proposed.chatParticipantPrivate.d.ts) · [响应流和工具展示](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/src/vscode-dts/vscode.proposed.chatParticipantAdditions.d.ts) · [诊断附件](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/src/vscode-dts/vscode.proposed.chatReferenceDiagnostic.d.ts) · [图片附件](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/src/vscode-dts/vscode.proposed.chatReferenceBinaryData.d.ts) · [模型提供方](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/src/vscode-dts/vscode.proposed.chatProvider.d.ts)
- **能力边界。**
  - 扩展提供的会话类型在打开时被锁定为扩展会话（`src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:3223-3231` 调用 `lockToCodingAgent`）。
  - Restore Checkpoint、Start Over 和 Restore to Last Checkpoint 只在 `or(lockedToCodingAgent.negate(), isAgentHostSession)` 成立时显示（`chatEditing/chatEditingActions.ts:561` 及其后两个操作）。点击编辑之前的请求由 `supportsCheckpoints` 控制（`chatWidget.ts:3330-3331`），`chatSessions` 扩展点的 `capabilities` 没有这一项。Retry 只在未锁定时显示（`actions/chatTitleActions.ts:171-183`）。Pi 会话中不显示这些操作。
  - Restore Checkpoint 和 Undo Requests 的 Delete 快捷键条件没有排除扩展会话（`chatEditingActions.ts:494`、`549`）。触发后 VS Code 会回退变更记录中的文件，并在下一次发送时删除之后的请求（`chatWidget.ts:3929-3937`）。Edit Request 的 Enter 快捷键同样没有排除扩展会话（`chatEditingActions.ts:696-699`）：在请求上按 Enter 编辑并提交时，VS Code 弹出确认框，确认后撤销该请求及之后的请求通过 `externalEdit` 记录的文件修改、从列表中移除这些请求，再把编辑后的文字作为新请求发给 participant。
  - Ask in Side Chat 和 `/btw` 要求会话对象提供 `createSideChat`，主线程为扩展会话创建的会话对象只设置 `forkSession`（`src/vs/workbench/api/browser/mainThreadChatSessions.ts:279-284`）。`/fork <标题>` 中的标题不传给扩展。
  - 扩展可用的原生入口是 `ChatSessionItemController.forkHandler`：检查点工具条显示 Fork Conversation，`/fork` 复制整个会话（`actions/chatForkActions.ts:44-56`、`chatSlashCommands.ts:237-240`）。Fork Conversation 不在第一条请求、紧接上一条请求的请求和系统发起的请求上显示，并且需要 `chat.checkpoints.enabled`（默认开启，`widget/chatListRenderer.ts:1864-1873`）。
  - 回复的右键菜单 `ChatContext` 和消息上的检查点菜单都没有开放给扩展（`src/vs/workbench/services/actions/common/menusExtensionPoint.ts`）。
  - `window.activeChatPanelSessionResource` 只报告 Local 会话，Pi 会话显示时为 `undefined`（`src/vs/workbench/api/browser/mainThreadChatAgents2.ts:198-201`）。
  - `externalEdit` 只在 participant 请求的响应流中生效（`mainThreadChatAgents2.ts:495-498`）。`activeResponseCallback` 的响应流不处理 `externalEdit`，其中的 `questionCarousel` 也不会得到回答。
  - 还原检查点、编辑请求和引用会话内容的实现方式见阶段 6。
- **聊天附件。** 会话类型在 `capabilities` 中声明 `supportsFileAttachments`、`supportsImageAttachments`、`supportsSymbolAttachments`、`supportsProblemAttachments` 和 `supportsToolAttachments`。声明 `canDelegate: true`，VS Code 只在该值为真时为会话类型注册动态 participant（`chatSessions/chatSessions.contribution.ts:805-812`、`843-870`）；其他聊天把任务委托给 Pi 时，VS Code 以委托内容作为第一条消息新建 Pi 会话。由默认 participant 接收 `ChatRequest`，取得本轮引用、可用工具和调用凭据。
- **安装方式。** 使用 TypeScript、npm、esbuild、`@vscode/test-electron`、Playwright 和 `@vscode/vsce`，通过 VSIX 分发。Stable 1.144.0 按扩展 ID 开放实验接口（`src/vs/workbench/services/extensions/common/extensionsProposedApi.ts` 中的 `_envEnabledExtensions`）：测试实例传入 `--enable-proposed-api=local.pi-harness`；日常使用时，在 Preferences: Configure Runtime Arguments 打开的 `argv.json` 中加入 `"enable-proposed-api": ["local.pi-harness"]`，然后重新启动 VS Code。安装说明给出该版本的命令、重新启动要求及授权检查方法。会话类型的 `when` 为 `!remoteName`，远程窗口中不出现 Pi。[微软实验接口说明](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)
- **验收。** 在带授权的 VS Code 中成功注册会话类型。在独立的未授权实例中，扩展日志记录“不能使用这些实验接口”的错误，新建聊天中不出现 Pi。后续每次升级实验接口，都要重新执行阶段 7 的安装和会话测试。

## 阶段 1 · 接入原生会话列表和聊天页面

用户可以在“新建聊天”中选择 Pi，并在同一侧栏打开当前项目的历史对话。

- **注册。** 在 `contributes.chatSessions` 声明 `pi-harness`（name 为 `pi`，displayName 为 `Pi`），附带会话命令 `compact`。按 Copilot CLI 的实现，用相同类型注册 `createChatSessionItemController`、默认 `ChatParticipant` 和 `registerChatSessionContentProvider`（能力声明 `supportsInterruptions: true`），会话内容直接使用 VS Code 的聊天组件。参考实现位于 `extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts` 和 `copilotCLIChatSessions.ts`。
- **Pi 模块。** 通过 `npm root -g` 定位全局安装的 `@earendil-works/pi-coding-agent`，设置项 `piHarness.piPackagePath` 可以指定其他安装位置。扩展宿主只按文件路径导入 `core/session-manager.js`、`config.js` 和 `modes/rpc/jsonl.js`，这三个模块导入时不写文件。VS Code 1.144.0 扩展宿主的 Node.js 为 24.22.1，满足 Pi 1.5.0 要求的 `>=22.19.0`。
- **会话目录。** 按 Pi 的优先顺序确定：环境变量 `PI_CODING_AGENT_SESSION_DIR`，其次项目设置 `<工作目录>/.pi/settings.json` 的 `sessionDir`，再次全局设置 `<Pi 配置目录>/settings.json` 的 `sessionDir`，都没有时使用 Pi 文档规定的默认目录 `<Pi 配置目录>/sessions/--<编码后的工作目录>--`。设置文件按 JSON 读取，去掉开头的 BOM，项目设置覆盖全局设置，相对路径按工作目录解析。会话目录不存在时列表为空，扩展不创建目录。每个 Pi 子进程都传入 `--session-dir <绝对路径>`。为每个已打开的本地工作区文件夹调用 `SessionManager.list(cwd, sessionDir)`，按最近活动时间显示标题。[Pi 会话与存储](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/sessions.md)
- **会话 URI。** 采用 `pi-harness:/<会话 ID>`，扩展保存会话 ID 到工作目录、会话目录和会话文件的对应关系。VS Code 请求一个未知 ID 的会话内容时，扩展在已打开的工作区文件夹中查找。
- **新建与发送。** `newChatSessionItemHandler` 分配会话 ID 并返回条目。工作目录在第一条消息发送时确定：存在多个工作区文件夹时取输入区“工作目录”选项组的选择，否则取唯一的工作区文件夹。VS Code 1.144.0 按会话类型保存选项组的条目、按会话保存选中项（`chatSessions.contribution.ts` 的 `getOptionGroupsForSessionType` 和 `getSessionOption`），因此所有 Pi 会话使用同一组条目：新会话可以选择，已有会话的选中项为锁定的会话工作目录。participant 从 `ChatSessionContext.initialSessionOptions` 读取该会话的选择。第一条消息和后续消息都从默认 participant 的同一个处理函数送往 Pi，每条只提交一次。打开空白聊天和浏览历史均不启动会话进程，也不触发模型请求。
- **会话列表操作。** 标题为会话名称，没有名称时为第一条消息。会话条目右键菜单（`chat/chatSessions`）提供“重命名”“删除”和“在终端中继续此会话”。重命名和删除需要该会话的写入权限且会话空闲：重命名写入 `session_info` 条目，删除把会话文件移到回收站。归档状态由 VS Code 管理，扩展在 `onDidChangeChatSessionItemState` 中把它保存到扩展的全局状态。会话目录中的文件变化触发列表刷新。
- **信任。** 工作区未获 VS Code 信任时，不启动任何 Pi 进程。
- **验收。** 用 Pi CLI 在两个测试项目各创建会话。分别打开项目，核对列表、标题和会话 ID。重复刷新、打开历史、取消新建后，检查原会话文件内容不变，默认会话目录没有被创建。在未受信任的工作区中确认没有 Pi 进程启动。重命名、删除和归档后核对会话文件和列表。

## 阶段 2 · 读取 Pi 历史并在 VS Code 和终端之间转移会话写入权限

用户可以看到选中会话当前分支的历史，并在退出终端后继续原对话。

- **只读浏览。** 浏览历史时用 `fs.readFile` 读取会话文件，第一条记录缺少会话头时报告文件无效。用 Pi 的 `parseSessionEntries` 和 `SessionManager.inMemory(cwd, undefined, entries).getBranch()` 还原当前分支，旧版记录的迁移只在内存中进行。`SessionManager.open()` 会重写旧版本文件、补写末尾换行，只在持有写入权限时调用。[Pi 会话文件格式](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/session-format.md)
- **历史渲染。** 用户消息生成 `ChatRequestTurn2`，ID 使用该用户消息的会话条目 ID。会话中存在指向该条目的 `pi-harness.request` 记录时，请求显示记录中的用户原文，并还原记录中的附件；没有记录的用户消息（在终端中发送的消息）按消息原文显示。助手文本生成 markdown，思考内容生成 thinking 部分，工具调用和工具结果按 `toolCallId` 合并为 `ChatToolInvocationPart`，压缩和分支摘要显示为说明文字。按顺序展示，保留压缩前可见的对话。
- **写入权限。** 用户首次发送、分叉、重命名或删除时才取得该会话的写入权限。扩展在同一台机器的多个 VS Code 窗口间使用 Windows 命名管道互斥，管道名由规范化后的工作目录和会话 ID 的 SHA-256 生成。持有写入权限的窗口负责运行 Pi，其他窗口可以查看历史。写入权限在该会话的 Pi 进程退出后释放，进程的退出时机见阶段 7。
- **其他写入方。** Pi 1.5.0 不对会话文件加锁，也没有查询其他进程是否正在写入的接口。对于扩展当前未持有的已有会话，首次取得写入权限前用模态对话框要求用户确认已关闭其他写入方。用户取消时保留只读页面。
- **在终端中继续。** 会话空闲时执行“在终端中继续此会话”：关闭 Pi 标准输入，等待进程退出，释放写入权限，然后以会话工作目录为终端工作目录运行 `pi --session <会话文件路径> --session-dir <会话目录>`。
- **验收。** 在终端创建含分支的真实会话，退出终端后从 VS Code 继续，再在终端中继续同一会话。核对三次打开使用同一个 ID、同一条分支，打开历史不重复执行旧工具。第二个 VS Code 窗口不能同时写入。

## 阶段 3 · 运行 Pi 并显示工具操作

用户发送消息后可以看见 Pi 的逐步回复、思考过程、文件修改和命令执行结果，也可以回答 Pi 的提问、追加引导消息或停止任务。

- **启动进程。** 从包清单的 `bin.pi` 取得 CLI 的 JavaScript 入口，使用 PATH 中版本满足 Pi `engines.node` 的 `node`、参数数组和会话工作目录启动 `--mode rpc`。新会话传入已分配的 `--session-id`，已有会话传入 `--session <会话文件路径>`，两者都传入 `--session-dir`，并用 `--extension` 加载 VSIX 中附带的 Pi 扩展。启动后用 `get_state` 返回的 `sessionId` 和 `sessionFile` 核对会话身份，不一致时结束该进程并报告错误。沿用用户的 Pi 登录信息、模型提供方和扩展。[Pi CLI 参数](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/cli.md)
- **RPC 协议。** 使用 Pi 包自带的严格 JSONL 实现（`modes/rpc/jsonl.js` 的 `serializeJsonLine` 和 `attachJsonlLineReader`）读取标准输出、写入标准输入，写入按顺序排队并等待写入回调。按请求 ID 关联应答，先订阅事件，再发送 `prompt`。根据 `disposition` 的 `started`、`queued`、`handled` 处理提交结果，使用 `agent_settled` 判断 Pi 是否已经结束自动执行。RPC 应答 `success` 为 `false` 时，本轮显示 Pi 返回的错误。标准错误输出写入扩展的输出通道。[Pi RPC 协议](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/rpc.md) · [RPC 命令](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/rpc-commands.md) · [Pi 事件定义](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/json.md)
- **停止。** 用户点击“停止”时先发送 `clear_queue`，再发送 `abort`，`abort` 在 Pi 回到空闲后返回。
- **显示。**
  - `text_delta` 写入 markdown，`thinking_delta` 写入 `thinkingProgress`。
  - `tool_execution_start`、`tool_execution_update`、`tool_execution_end` 按 `toolCallId` 更新同一个 `ChatToolInvocationPart`（设置 `enablePartialUpdate`）。`bash` 使用 `ChatTerminalToolInvocationData` 显示命令行和输出；`read`、`edit`、`write` 显示文件链接，`edit` 和 `write` 附带“打开差异”命令链接；其他工具使用 `ChatSimpleToolResultData` 显示输入和输出。
  - 由 VS Code 执行并已在聊天中显示的 Copilot 工具调用只显示一份。
  - 助手消息的用量写入 `stream.usage`，压缩和自动重试事件显示为进度说明，提供方错误显示为本轮错误。
- **引导和排队。**
  - VS Code 的 Steer with Message 在运行中的请求上设置 `ChatContext.yieldRequested`，引导消息在当前请求结束后才发送（`src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts:1509`）。处理函数每 100 ms 检查一次 `yieldRequested`，置位后立即返回，Pi 继续运行，做法与 Copilot CLI 相同（`copilotCLIChatSessions.ts:663-700`）。Pi 正在通过聊天内提问等待用户回答时，处理函数等用户回答后再返回。
  - 随后到达的请求如果遇到 Pi 仍在运行，以 `prompt` 加 `streamingBehavior: "steer"` 发送，Pi 后续的输出写入新请求的响应流。
  - Add to Queue 的消息在上一请求结束后作为普通请求到达。
  - 没有正在处理的请求时，Pi 的事件暂存，由该会话的下一个请求或 `activeResponseCallback` 接回。
- **模型和思考级别。**
  - VS Code 把请求交给扩展会话的 participant 之前必须取得一个语言模型：请求没有携带用户选择的模型时使用 Copilot 的默认模型，未登录 Copilot 时请求无法送达（`src/vs/workbench/api/common/extHostLanguageModels.ts:415-476`）。扩展在 `languageModelChatProviders` 中声明 vendor `pi-harness`，用 `vscode.lm.registerLanguageModelChatProvider` 提供 Pi 的可用模型。模型的 `targetChatSessionType` 为 `pi-harness`，只在 Pi 会话的模型选择器中出现；会话类型声明 `requiresCustomModels: true`，模型选择器只列出这些模型。这些模型不直接处理 VS Code 的语言模型请求，`provideLanguageModelChatResponse` 返回错误，说明模型由 Pi 进程调用。
  - 模型列表来自为每个工作区文件夹启动的、只用于读取模型列表的 Pi 进程（`pi --mode rpc --no-session --no-mcp --no-skills --no-prompt-templates --no-context-files`），多个文件夹的列表合并。该进程不创建会话文件，其他启动行为与普通 Pi 相同（执行迁移、读取登录信息、加载扩展注册的模型提供方）。第一个工作区文件夹中 Pi 为新会话选择的模型标记为默认模型。没有可用模型或 Pi 不可用时不提供模型，VS Code 禁止在 Pi 会话中发送，扩展提示原因并写入输出通道，提示中的“刷新 Pi 模型列表”按钮让 VS Code 立即重新读取。读取失败的结果不保留：失败时结束这次启动的进程，VS Code 下一次读取模型时重新启动 Pi。
  - 思考级别：在该进程中对每个模型依次调用 `set_model` 和 `get_available_thinking_levels` 取得级别列表。支持思考的模型在 `configurationSchema` 中声明属性 `thinkingLevel`，取值为该模型的级别，默认值为 Pi 的默认级别按该模型支持范围调整后的结果，`group` 为 `navigation`，VS Code 在模型选择器中把它显示为思考强度选项（`widget/input/modelPicker/modelPickerModelConfig.ts:19`）。RPC 的 `set_model` 和 `set_thinking_level` 只修改当前会话，不改写全局默认值。
  - 每个请求携带用户在模型选择器中选择的模型（`request.model`）和思考级别（`request.modelConfiguration.thinkingLevel`）。扩展在发送提示前先 `set_model` 再 `set_thinking_level`，引导消息同样先应用其携带的选择，Pi 在下一次调用模型时使用新的模型。请求携带的模型不属于 Pi 时返回错误，提示在模型选择器中选择 Pi 的模型。
- **Pi 扩展交互。**
  - `select`、`confirm`、`input` 没有 `timeout`，并且存在正在处理的 participant 请求时，用 `stream.questionCarousel` 在聊天内显示（不允许自由输入的单选题、只有“是”和“否”两项的单选题、文本题），用户回答或跳过后按原请求 ID 回复。聊天内提问有说明文字时只显示说明，`confirm` 的说明和 `input` 的提示文字与标题合并显示。
  - `editor` 需要多行编辑，聊天内的文本题只有单行输入框，因此始终在新的无标题文档中打开预填内容，用户在通知中点击“完成”后回复文档内容。无论完成还是取消，该文档都不保存直接关闭（`workbench.action.revertAndCloseActiveEditor`）。
  - 带 `timeout` 的对话框、没有正在处理的请求时的对话框以及 `activeResponseCallback` 接回的轮次中的对话框，使用 VS Code 的 QuickPick 和 InputBox，到期时关闭并回复 `cancelled: true`。
  - 请求被取消时，对尚未回答的对话框回复 `cancelled: true`。
  - `notify` 显示为通知；`setStatus`、`setWidget` 显示在该会话的状态栏项及其提示中；`setTitle` 更新会话标题；`set_editor_text` 显示带“填入输入框”按钮的通知，用户点击后用 `workbench.action.chat.open` 的 `query` 和 `isPartialQuery: true` 填入侧边栏 Chat 的输入框。[Pi 扩展交互协议](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/rpc-extension-ui.md)
- **以 `/` 开头的输入。** `/compact` 转换为 RPC `compact`，Pi 运行时拒绝并提示，因为 Pi 的压缩会先中止当前任务。其余名称由 `get_commands` 列出的输入（Pi 扩展命令、`skill:<name>`、提示模板）按原文交给 Pi 的 `prompt`；其他以 `/` 开头的输入在 RPC 模式下由 Pi 作为普通文字发给模型。
- **项目信任。** RPC 模式不显示 Pi 的项目信任提示。终端中保存过的信任决定照常生效；没有保存决定时按 `defaultProjectTrust` 处理，默认值 `ask` 在 RPC 模式下等同于不信任，项目 `.pi` 目录中的扩展和技能不加载。安装说明给出在终端中执行 `/trust` 的方法。
- **验收。** 在专用测试目录中，让真实模型读取文件、修改指定内容、执行验证命令。核对实际文件差异和工具执行次数。运行中发送引导消息，核对 Pi 会话中引导消息的位置和后续输出所在的响应。使用 Pi 官方扩展示例验证四种对话框和带 `timeout` 的对话框，检查取消、附件、切换模型及思考级别。[Pi 交互示例](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/examples/extensions/rpc-demo.ts)

## 阶段 4 · 把编辑器上下文和 Copilot 工具交给 Pi

用户选中一段尚未保存的代码，或从 Problems 面板附加一条错误，就可以请 Pi 分析该处，并从回复直接返回对应的文件和行号。

- **输入。** 发送时处理 `ChatRequest.references`，按引用类型读取文件、选区（包括 VS Code 自动附加的当前选区）、符号位置、选中的诊断和图片。文件和选区从 `TextDocument.getText()` 读取，包含未保存内容，并记录 URI、行列范围及当时的文档版本。VS Code 的设置 `chat.saveBeforeSend` 默认开启，发送聊天消息前保存全部已修改的编辑器（`widget/chatWidget.ts:196-200`）；关闭该设置时，附件携带编辑器中尚未保存的文字。诊断附件只展开用户选择的项目，每条写为“路径:行:列 [严重程度 来源(代码)] 消息”，来源和代码的写法与 Problems 面板相同，例如 `error ts(2322)`。发送给 Pi 的文字为用户原文，后接一个空行和 `<vscode-context>` 块（附件内容、诊断和文件变更事件），作为同一条 user message 送达；图片作为 `prompt` 的 `images` 发送。普通请求和引导消息使用相同的格式。输入以 Pi 扩展命令开头时按原文发送，附带附件时返回错误，说明扩展命令不接收附件。
- **请求记录。** 扩展宿主根据 RPC 事件确定每个请求对应的用户消息：Pi 空闲时发送的提示对应本次运行的第一条用户消息；引导消息展开后的文字由 `queue_update` 事件给出，按文字对应送达时的用户消息。扩展宿主在收到该用户消息的 `message_end` 后，通过 IPC 请 Pi 扩展按文字在当前分支中查找该用户消息的条目 ID，Pi 扩展返回条目 ID，并在下一个 `turn_end` 中以 `custom` 条目写入 `pi-harness.request` 记录（VS Code 请求 ID、用户消息条目 ID、用户原文、附件元数据）。`disposition` 为 `handled` 的请求没有用户消息，也没有记录。
- **文件变更事件。** `ChatRequest.editedFileEvents` 记录上一请求以来用户对 Pi 修改的 Keep、Undo 和手动修改，写入本轮的 `<vscode-context>` 块，Pi 据此得知哪些修改已被撤销或改动。
- **定位。** 对编辑器工具返回的位置和附件位置使用 `ChatResponseStream.anchor(Location)`，点击后在编辑器中显示相应行。
- **Pi 与编辑器通信。** 每个 Pi 进程对应一个命名管道服务端，管道路径和随机令牌通过环境变量交给子进程，Pi 扩展读取后立即从 `process.env` 中删除这两个变量，`bash` 启动的命令因此无法取得它们。Pi 扩展在 `session_start` 时连接，先用令牌完成握手，再用 `vscode-jsonrpc` 收发请求；标准输入输出只用于 Pi RPC。扩展宿主按窗口、会话和当前轮次关联调用，校验工作区、请求参数及取消状态，结束该轮后令本轮调用失效。管道断开时，Pi 扩展中止当前运行并请求 Pi 退出。终端恢复同一会话时仍能阅读已保存的工具结果。
- **编辑器工具。** Pi 扩展用 `pi.registerTool()` 注册 `vscode_definition`、`vscode_references` 和 `vscode_diagnostics`，扩展宿主分别调用 `vscode.executeDefinitionProvider`、`vscode.executeReferenceProvider` 和 `vscode.languages.getDiagnostics`。
- **Copilot 工具。**
  - 支持 `copilot_searchWorkspaceSymbols`、`copilot_searchCodebase` 和 `copilot_getErrors`。握手时扩展宿主从 `vscode.lm.tools` 取得这三个工具实际存在的定义和 `inputSchema`，Pi 扩展以相同名称和参数定义注册。
  - Pi 会话的输入区没有 Configure Tools（`actions/chatToolActions.ts:139-146` 在锁定会话中隐藏），`request.tools` 来自按用户配置文件保存、各聊天共用的工具选择状态（`widget/input/chatSelectedTools.ts:122`），其中只包含当前可列出的工具。本轮启用规则：VS Code 实际提供该工具，并且它在 `request.tools` 中不为 `false`；在 `request.toolReferences` 中被 `#` 引用的工具总是启用。
  - 扩展宿主在发送提示前通过 IPC 把启用集合交给 Pi 扩展。Pi 扩展在每次运行的 `before_agent_start` 中，从 `event.systemPromptOptions.selectedTools` 去掉这三个工具，再加入本轮启用的工具。引导消息沿用所在运行的工具集合。
  - 没有正在处理的 participant 请求时，Copilot 工具调用向 Pi 返回错误，说明需要等待下一个请求。缺少工具、取消或服务明确报告索引不可用时显示相应状态。服务仅返回空内容时，如实告知用户此次未取得可用结果。
- **调用与结果。** 由扩展宿主使用 `vscode.lm.invokeTool`，带入本轮 `toolInvocationToken`、取消信号和 `tokenizationOptions`，关联原聊天的工具进度及确认。凭据仅保存在当前请求内。对于 Copilot 返回的 `LanguageModelPromptTsxPart`，用 `@vscode/prompt-tsx` 的 `renderPrompt` 和 `ToolResult` 渲染成文字，`ITokenizer` 由 `gpt-tokenizer` 实现。[prompt-tsx 工具结果渲染](https://github.com/microsoft/vscode-prompt-tsx/blob/main/README.md)
- **验收。**
  - 在真实 TypeScript 项目中分别通过编辑器右键菜单 Add Selection to Chat、拖入文件、`#selection` 和 VS Code 自动附加的当前选区附加一段与磁盘内容不同的选区，从会话文件中 `pi-harness.request` 指向的用户消息核对 Pi 收到的文字。
  - 附加一条实际诊断，点击回复中的位置，核对文件和行列。
  - 由 Pi 调用 Copilot 符号查询并返回项目中确实存在的符号。在 Local 聊天的 Configure Tools 中关闭该工具后，在 Pi 会话中重试，通过扩展导出的接口核对 VS Code 没有执行它；在同一请求中用 `#` 引用该工具，核对本轮可以使用。
  - 切换两个 Pi 会话并取消其中一个查询，检查结果和取消操作各自回到原会话。
  - 在 VS Code 中撤销 Pi 的一处修改后继续对话，核对 Pi 收到的文件变更事件。

## 阶段 5 · 在 VS Code 查看 Pi 的修改并保护未保存内容

用户沿用 Pi 的直接修改方式。编辑完成后，可以打开本次操作的差异。Pi 运行期间用户在编辑器中修改、尚未保存的文件保留在编辑器中，由用户决定何时处理。发送消息时 VS Code 按 `chat.saveBeforeSend` 先保存已修改的编辑器，关闭该设置后，发送前已有的未保存修改同样受到保护。

- **接入方式。** Pi 扩展用 `createEditToolDefinition(cwd, { operations })` 和 `createWriteToolDefinition(cwd, { operations })` 以同名方式覆盖 `edit` 和 `write`，参数处理、原文匹配、生成修改和结果格式保持 Pi 原样。`edit` 的 `access` 在 Pi 进程中检查磁盘文件，`readFile` 和 `writeFile` 通过 IPC 请求 VS Code；`write` 的 `mkdir` 在 Pi 进程中执行，`writeFile` 通过 IPC 请求 VS Code。文件内容以 base64 传输，`readFile` 返回 `Buffer`。内置工具已经使用 `withFileMutationQueue`，操作函数内不再嵌套使用。`execute` 中用 `AsyncLocalStorage` 传递 `toolCallId`。[Pi 工具操作替换示例](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/examples/extensions/ssh.ts)
- **读取基准。** `edit` 的 `readFile` 请求到达时，目标在当前窗口已打开且有未保存修改，则返回错误给 Pi，说明文件位置和原因；否则读取磁盘内容，记录内容哈希和文档版本。
- **提交写入。**
  - `writeFile` 请求到达时，先检查未保存修改、文档版本和磁盘哈希（`write` 只检查未保存修改，并以此时的磁盘内容或“不存在”作为修改前内容），发生变化时停止本次覆盖并返回文件位置，保留用户的编辑。
  - 检查通过后，在 `stream.externalEdit(target, callback)` 中把新内容写入磁盘，这一次实际操作纳入聊天的文件变更记录。VS Code 在 `externalEdit` 开始时保存该文件的文档，在结束时按磁盘内容重新加载；回调执行期间在该文件中的输入会被磁盘内容替换。
  - 没有正在处理的 participant 请求时（`activeResponseCallback` 接回的轮次，或引导消息到达之前），直接写入磁盘并记录快照，已打开且无未保存修改的文档由 VS Code 自动重新加载，这部分修改不进入 VS Code 的变更列表。
  - 每次提交只执行一次。`writeFile` 完成后 Pi 才检查中止，写入后发生的中止不影响快照的记录。
- **差异与快照。** 每次提交把修改前后的内容按 SHA-256 存入扩展全局存储的内容目录，Pi 扩展在本轮 `turn_end` 中以 `custom` 条目写入 `pi-harness.edit` 记录（`toolCallId`、工具名、文件路径、修改前内容哈希或“不存在”、修改后内容哈希）。快照记录随会话条目一起复制到分叉出的会话。通过只读内容提供器 `pi-harness-snapshot:` 和 `vscode.diff` 打开本次差异，用户可关闭预览继续工作。命令“清理 Pi 快照”扫描扩展记录过的全部会话文件，删除不再被任何 `pi-harness.edit` 记录引用的内容。
- **终端命令和其他扩展工具。** `bash` 和其他扩展工具正常执行。运行期间，已打开且有未保存修改的文档保留在编辑器中；磁盘文件被命令修改时，由 VS Code 的外部文件冲突处理接管。命令输出按 Pi 实际结果显示，差异归属只记录能确定来源的文件。
- **读取范围。** 附件使用编辑器中的文字，包含未保存内容；Pi 自己的 `read` 工具读取磁盘内容。未保存内容的保护只覆盖当前窗口，其他 VS Code 窗口中的未保存修改由各窗口自己处理。
- **验收。** 分别测试已保存文件、关闭 `chat.saveBeforeSend` 后已打开且未保存的文件、Pi 运行期间用户开始修改的文件、工具读取后用户继续输入以及另一窗口改动磁盘文件。正常修改应直接完成且只执行一次。冲突情况下用户输入应完整保留。对同一文件连续执行两次修改，分别打开两次差异，核对每次的前后内容。另用真实命令修改一个已打开且未保存的文件，核对编辑器内容保持不变、保存时出现 VS Code 的冲突提示。

## 阶段 6 · 分叉、还原检查点、编辑请求和引用会话内容

用户在 Pi 会话中使用 VS Code 原生的编辑请求从一条请求重新开始，使用原生的 Fork Conversation 按钮在新会话中回到一条请求之前并同时恢复文件、把原请求填回输入框，也可以把回复中选中的文字引用到输入框。

- **分叉。**
  - 实现 `ChatSessionItemController.forkHandler(sessionResource, request)`。`request` 是分叉点，新会话包含它之前的轮次，不包含它本身；`request` 为空时复制整个会话。
  - 请求与 Pi 条目的对应：历史轮次的 ID 就是用户消息的条目 ID；本窗口发送的轮次从 `pi-harness.request` 记录和扩展宿主内存中的对应关系查找。找不到对应条目的请求不能作为分叉点，`forkHandler` 返回说明原因的错误。
  - 前提：源会话空闲，本窗口持有写入权限，未持有时按阶段 2 的流程确认。源会话正在运行时返回错误，提示本轮结束后再分叉。
  - 创建：在扩展宿主中执行 `SessionManager.open(sourceFile, sessionDir).createBranchedSession(targetLeafId)`，`targetLeafId` 为分叉点用户消息的父条目，复制整个会话时为当前叶子，这与 Pi 运行时分叉已保存会话的实现相同（`core/agent-session-runtime.js:203-232`），源会话的 Pi 进程保持原会话。新文件的 `parentSession` 指向源会话文件。分叉点之前没有用户或助手消息时，`createBranchedSession` 不写入文件，新会话按空白会话处理：分配会话 ID，第一条消息以 `--session-id` 启动 Pi，父会话关系保存在扩展的全局状态中。
  - 在扩展宿主中分叉不经过 Pi 进程，用户 Pi 扩展的 `session_before_fork` 处理函数不会运行。
  - 返回新会话条目，由 VS Code 打开新会话，原会话保留。
- **还原检查点。**
  - 分叉点及其之后的轮次中的 `pi-harness.edit` 记录列出 Pi 修改过的文件，用户在模态对话框中选择“恢复文件并分叉”或“只分叉”。
  - 恢复时，每个文件还原为分叉点之后第一次修改前的内容，分叉点之后新建的文件删除。
  - 恢复前比较每个文件的当前内容哈希和 Pi 最后一次写入后的哈希，不一致（之后被用户或命令改过）的文件单独列出，由用户逐个选择是否覆盖。目标文件有未保存修改时停止恢复并列出这些文件。
  - 分叉点之后没有 `pi-harness.request` 记录的轮次（在终端中执行的轮次）在对话框中列出，说明其文件修改无法恢复。`bash` 造成的修改不在恢复范围内，与 Copilot 检查点只还原编辑工具修改的范围一致。
- **编辑请求。**
  - 使用 VS Code 原生的编辑：在请求上按 Enter（或点击请求文字）修改后提交，VS Code 确认后撤销该请求及之后的请求通过 `externalEdit` 记录的修改，从列表中移除这些请求，再把编辑后的文字作为新请求发来。
  - participant 在 Pi 空闲时把 `ChatContext.history` 中的请求 ID 与 Pi 当前分支的用户消息对照（请求 ID 为条目 ID，或由 `pi-harness.request` 记录和扩展宿主内存中的对应关系查到）。本窗口显示过的用户消息不在 VS Code 历史中时，把 Pi 的当前分支退回到第一条被移除的用户消息之前：发送 Pi 扩展注册的内部命令 `/pi-harness-rewind <条目 ID>`，命令调用 `ctx.navigateTree(条目 ID, { summarize: false })`，再用 RPC `get_entries` 核对当前叶子为该消息的父条目。之后编辑后的请求按普通请求发送，原分支保留在会话文件中。没有在本窗口显示过的用户消息（例如打开会话之后在终端中发送的消息）不参与对照；被移除的请求不是末尾的一段时返回错误，提示重新打开会话。
  - 从 Fork Conversation 分叉后显示带“把原请求填入输入框”按钮的通知。VS Code 传给 `forkHandler` 的请求不带附件（`src/vs/workbench/api/common/extHostChatSessions.ts` 的 `convertRequestDtoToRequestTurn`），原文和附件取自分叉点的 `pi-harness.request` 记录，没有记录时取用户消息原文。用户点击后，用 `workbench.action.chat.open` 的 `query`、`isPartialQuery: true` 和 `attachFiles`（范围使用从 1 开始的行列号）把原文填入侧边栏 Chat 的输入框，并重新附加其中的文件和选区附件；其他类型的附件在通知中列出。
- **Delete 快捷键。** 扩展贡献同一按键的快捷键，条件为 `inChat && lockedCodingAgentId == 'pi-harness' && !inChatInput && !textInputFocus && !inputFocus && !inChatQuestionCarousel`，命令提示用户通过编辑请求或 Fork Conversation 回到之前的请求。Restore Checkpoint 在下一次发送之前只改变 VS Code 的显示和文件，Pi 的会话没有对应的中间状态，因此在 Pi 会话中拦截。扩展快捷键的权重为 `ExternalExtension`（400），高于工作台快捷键的 `WorkbenchContrib`（200），按键解析从权重最高的快捷键开始匹配（`src/vs/platform/keybinding/common/keybindingsRegistry.ts:62-69`、`keybindingResolver.ts:380-382`）。
- **引用会话内容。** 命令 `piHarness.quoteSelection`，快捷键为 `Ctrl+Alt+Q`（macOS 为 `Cmd+Alt+Q`），条件为 `inChat && !inChatInput && lockedCodingAgentId == 'pi-harness'`，命令面板中隐藏，因为打开命令面板会让焦点离开回复列表。执行时保存剪贴板中的文字并写入随机标记，执行 VS Code 的复制命令 `editor.action.clipboardCopyAction`（焦点位于回复列表时复制页面中选中的文字），再读取剪贴板。读取到的内容仍是标记时说明没有选中文字，恢复剪贴板并提示；否则把文字按 Markdown 引用格式（每行前加 `> `）插入输入框：执行 `workbench.action.chat.focusInput` 后用 `type` 命令在光标处插入，保留输入框已有内容，最后恢复剪贴板中原来的文字。VS Code 的剪贴板接口只支持文字，剪贴板中原有的图片和富文本在执行后丢失。
- **与 Copilot 的行为差异。**
  - 保留原会话的还原检查点通过 Fork Conversation 新建会话完成，原会话保留在列表中。
  - Ask in Side Chat 在 Pi 会话的右键菜单中不可用，`/btw` 不出现；引用会话内容使用 `piHarness.quoteSelection`。
  - Retry 不显示。编辑请求撤销的文件范围由 VS Code 的变更记录决定：Pi 在没有 participant 请求时写入的修改（`activeResponseCallback` 接回的轮次）和 `bash` 造成的修改不在其中。
- **验收。** 界面操作用 Playwright 完成：
  - 在含三轮修改的会话中从第二条请求分叉并恢复文件，核对新会话历史只含第一轮、文件内容等于第二轮之前的内容、点击通知按钮后输入框出现第二条请求的原文和附件。选择“只分叉”时核对文件不变。
  - 第二轮之后用户改过的文件出现在单独列表中，不勾选时保持不变。
  - 用 `/fork` 复制整个会话并核对历史一致。
  - 在 Pi 会话中选中一条请求后按 Delete，核对 VS Code 中的请求和文件均未改变。在第三条请求上按 Enter 修改后提交并确认，核对 VS Code 列表不再显示第三条请求、Pi 当前分支为前两轮加上编辑后的请求，原第三轮保留在会话文件中。
  - 在回复中选中一段含 `#`、`/`、`@` 的文字后按 `Ctrl+Alt+Q`，核对输入框中出现引用格式的文字，原有输入和剪贴板文字保留；没有选中文字时按 `Ctrl+Alt+Q`，核对出现提示且剪贴板不变。

## 阶段 7 · 进程生命周期、错误处理和交付

用户可以切换聊天、重新打开编辑器和安装交付包，仍然回到正确的 Pi 会话。

- **进程生命周期。**
  - 会话进程在首次发送时启动。VS Code 释放该会话内容（该会话的输入状态全部 `onDidDispose`；重新读取内容和每个请求都会先创建新的输入状态、再释放旧的）且会话空闲时，关闭 Pi 标准输入，进程退出后释放写入权限。
  - 在本窗口新建的会话，VS Code 在把空白会话转为正式会话时保留了引用（`chatServiceImpl.ts:1736`），这些会话的内容在窗口关闭前不会被释放。因此 Pi 连续空闲超过 `piHarness.idleShutdownMinutes`（默认 10 分钟）时同样关闭标准输入并释放写入权限，下一次发送时自动重新启动。
  - 只用于读取模型列表的 Pi 进程在对应的工作区文件夹关闭或扩展停用时退出。
  - 扩展停用时，对运行中的会话依次发送 `clear_queue` 和 `abort`，等待 `agent_settled`，再关闭标准输入；3 秒内仍未退出的进程用 `taskkill /T /F` 结束整个进程树。
  - 进程异常退出后标明本轮中断。重新打开时读取已保存的历史，由用户决定是否重新提交本轮任务。请求记录在本轮结束时写入，中断的一轮没有记录，历史中该请求按 Pi 保存的用户消息原文显示。
  - 用户停止请求时 VS Code 立即关闭该响应流，扩展解除该响应流与 Pi 输出的绑定，丢弃这次运行剩余的事件；下一个请求等 `abort` 返回后再发送。
- **切换与中断。** 同一窗口切换会话时，进行中的 Pi 进程继续运行。会话内容被重新读取时，如果 Pi 仍在运行，使用 `activeResponseCallback` 接回本轮输出，已完成的内容从 Pi 历史恢复。该回调的取消信号在两种情况下触发：VS Code 先释放该会话的输入状态再取消时，表示会话内容被释放，扩展只停止向该响应流输出；输入状态仍在时，表示用户点击了停止，扩展按“停止”处理。
- **错误处理。**
  - `npm root -g` 失败、`piHarness.piPackagePath` 指向的目录中没有 Pi 包，或 Pi 版本不在 `^1.5.0` 范围内：新建和发送时返回说明原因的错误，列表照常显示。
  - PATH 中没有满足 `engines.node` 的 `node`：同上。
  - `get_state` 返回的会话 ID 或文件与预期不符、IPC 握手超过 30 秒未完成：结束该进程，本轮返回错误。
  - Pi 进程在完成 IPC 握手前退出：本轮返回错误，说明退出码、信号和标准错误输出；Windows 的异常状态码同时给出十六进制形式，例如 `3221226505（0xC0000409）`，没有标准错误输出时如实说明。用户重新发送时启动新的 Pi 进程。读取模型列表的 Pi 进程异常退出时，同样的说明写入输出通道并提示用户，下一次读取重新启动 Pi。
  - RPC 应答 `success` 为 `false`：本轮显示 Pi 返回的错误，进程保持运行。
  - 工作区未受信任：不启动任何 Pi 进程，Pi 不提供模型，扩展提示“工作区未受信任”，VS Code 禁止在 Pi 会话中发送。
  - 缺少实验接口授权：VS Code 不加载会话类型，扩展日志记录原因。
- **测试方式。**
  - 测试使用本机 VS Code 1.144.0 的副本：`test/setupVscode.ts` 把已安装的 `Code.exe` 和与其版本相同的版本目录复制到 `.test-work/vscode`，删去副本 `product.json` 中的 `target`，并在 `Code.exe` 旁建立 `data` 目录。每次启动都把环境变量 `VSCODE_PORTABLE` 设为本次运行的目录，VS Code 因此以便携模式运行：`argv.json`、用户数据和扩展都在该目录中，也不把自己注册为 `vscode://` 协议的处理程序、不改写任务栏的跳转列表（`src/vs/platform/url/electron-main/electronUrlListener.ts`、`src/vs/platform/workspaces/electron-main/workspacesHistoryMainService.ts`）。非便携模式下，即使传入 `--user-data-dir`，VS Code 仍然读取用户目录中的 `.vscode/argv.json`，并把 `vscode://` 协议和跳转列表指向正在运行的程序。`product.json` 含有 `target` 时 VS Code 忽略 `VSCODE_PORTABLE`，测试程序在启动前检查并直接报错。
  - 扩展宿主中的测试用 `@vscode/test-electron` 启动上述副本，传入 `--enable-proposed-api=local.pi-harness`，并把 `PI_CODING_AGENT_SESSION_DIR` 指向测试会话目录。测试在扩展宿主中用 `workbench.action.chat.openNewSessionSidebar.pi-harness` 在侧边栏新建会话，用 `workbench.action.chat.open` 的 `query`、`modelSelector`（Pi 的模型）、`attachFiles`、`attachScreenshot` 和 `blockOnResponse` 经侧边栏输入框发送消息并等待响应完成（`openSessionWithPrompt` 不携带用户选择的模型），用 `workbench.action.chat.steerWithMessage` 发送引导消息，用 `workbench.action.chat.queueMessage` 把消息加入队列，用 `workbench.action.chat.cancel` 停止，用 `workbench.action.chat.forkConversation` 加会话 URI 复制整个会话。Pi 收到的文字从会话文件读取，工具调用次数、请求与条目的对应关系和会话状态通过扩展导出的接口查询。
  - 指定请求的分叉、Delete 键、Enter 键、回复选区引用、聊天内提问、模态对话框以及通过 Add Context... 附加符号和问题需要真实的界面焦点和选区，用 Playwright 通过 Chrome DevTools Protocol 连接以 `--remote-debugging-port` 启动的 VS Code 窗口完成。以 `--extensionTestsPath` 启动时 VS Code 拒绝显示模态对话框（`src/vs/workbench/services/dialogs/common/dialogService.ts` 的 `skipDialogs`），界面测试因此以普通方式启动 VS Code，由一个只用于测试的驱动扩展在扩展宿主中运行测试并写出结果；用户设置 `window.dialogStyle` 为 `custom`，对话框在工作台页面中绘制。引用依赖系统剪贴板，Windows 锁屏期间剪贴板无法读写，引用的测试需要在解锁的桌面会话中运行。
  - 重新打开窗口：用同一用户目录和工作区先后启动两次 VS Code，第二次启动后从会话列表打开第一次创建的会话并继续发送。
  - 认证失败：工作区的 Pi 扩展用 `pi.registerProvider` 注册一个指向本机 HTTP 服务的模型提供方，该服务对所有请求返回 401。
  - 模型列表进程异常退出：工作区的 Pi 扩展在标记文件存在时删除它并以退出码 9 结束进程，核对第一次读取报告退出码、下一次读取取得模型。
  - 本机已配置的 `cliproxyapi/gpt-6-astra` 作为真实模型样本。
  - 独立用户目录中没有登录 Copilot，`vscode.lm.tools` 中没有 Copilot 工具；Copilot 工具的调用需要在登录了 Copilot 的配置中核对。
  - 覆盖多轮对话、两个会话并行、同一会话跨窗口互斥、执行中停止、引导消息、排队消息、附加选区、文件、图片、符号和问题、子进程异常退出、模型列表进程异常退出、重新打开窗口、认证失败，以及缺少实验接口授权。测试记录仅保存版本、会话 ID、预期行为、实际结果和测试文件差异。
- **安装验收。** 使用 `vsce package` 生成 VSIX，在与开发环境分开的本机 Stable 1.144.0 配置中安装并按 ID 授权，在侧边栏 Chat 中依次完成：
  1. 附加选区或诊断。
  2. Pi 调用启用的 Copilot 查询工具。
  3. Pi 修改文件。
  4. 在 VS Code 打开本次差异。
  5. 引用回复中的一段文字继续提问。
  6. 从第二条请求分叉并恢复文件。
  7. 在终端中继续同一会话。

  另建立一个未保存修改的场景，验证编辑器内容得到保留。保存实际工具结果、文件差异和会话 ID 后交付安装包和记录。

  独立配置与其他测试一样使用便携模式，安装和启动时都把 `VSCODE_PORTABLE` 设为本次验收目录。用户数据、扩展和 `argv.json` 都在验收目录中，VSIX 用副本的命令行安装到其中的 `extensions`，授权写在其中的 `argv.json`，与本机 VS Code 的配置互不影响。安装前、安装后和验收结束时核对本机扩展目录中没有 `local.pi-harness`。
