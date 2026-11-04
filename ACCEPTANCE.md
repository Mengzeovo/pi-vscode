# Pi Harness 验收记录

## 交付物

- 安装包：`.\pi-harness-0.1.0.vsix`，1,295,824 字节，SHA-256 `4c46d84440d604b3e7cc7060d213a9aa0171fe66773d4ebba08a5af440c2b03c`。包内文件为 `package.json`、`readme.md`、`INSTALL.md`、`dist/extension.js` 和 `dist/pi-extension/index.js`。
- 安装说明：`INSTALL.md`，安装包中附带同一份。
- 开发计划：`DEVELOPMENT_PLAN.md`。

## 验收环境

- Windows 11，版本 10.0.26200。
- VS Code Stable 1.144.0（提交 `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`）和 1.144.1（提交 `261c84cb1eddf11235f9e2c921425e9663fbe556`）。两个版本都从本机安装复制到 `.test-work`，删去 `product.json` 中的 `target`，以便携模式运行。每次运行的 `argv.json`、用户数据、扩展和 Pi 会话文件都在 `.test-work` 下该次运行的目录中。
- Pi 1.5.0（npm 包 `@earendil-works/pi-coding-agent`），Node.js 24.15.0。Pi 沿用本机的登录信息、模型提供方和 Pi 扩展（包括 pi-lens）。
- 模型 `cliproxyapi/gpt-6-astra`；切换模型的测试另用 `cliproxyapi/gpt-6-luna`。
- 测试使用的 VS Code 配置中没有登录 GitHub Copilot。

## 安装验收

执行 `npm run test:acceptance`：打包 VSIX；在验收目录中写入 `argv.json`，内容为 `"enable-proposed-api": ["local.pi-harness"]`；用 VS Code 的命令行把 VSIX 安装到验收目录的 `extensions`；以普通方式启动 VS Code，Pi Harness 不以开发模式加载。一个只用于测试的驱动扩展通过界面完成下列步骤，并把每一步的预期和实际结果写入 `acceptance.json`。安装前、安装后和验收结束时都核对了本机 `~/.vscode/extensions` 中没有 `local.pi-harness`。

下列记录来自 VS Code 1.144.0 的验收目录 `.test-work/acceptance-2026-11-03T06-59-34-885Z`。

### 1. 安装与授权

- 预期：扩展从验收目录的 `extensions` 加载，实验接口可用，找到 Pi 1.5.x。
- 实际：扩展目录为 `.test-work\acceptance-2026-11-03T06-59-34-885Z\extensions\local.pi-harness-0.1.0`；Pi 1.5.0；Node.js v24.15.0。
- 结果：通过。

### 2. 附加选区

- 会话：`01ccb1e0-b980-4125-a8e7-6a660c96ea13`。
- 操作：把 `calc.ts` 第 1–3 行作为选区附加到请求，请 Pi 修复其中的错误。
- 预期：Pi 收到的用户消息包含选区文字。
- 实际：用户消息为原文、一个空行和 `<vscode-context>` 块，块中的 `<selection path="…\calc.ts" lines="1-3" unsaved="false">` 包含这三行。
- 结果：通过。

### 3. Pi 修改文件

- 会话：`01ccb1e0-b980-4125-a8e7-6a660c96ea13`。
- 工具调用依次为 `edit`、`read`、`edit`、`bash`。第一次 `edit` 被本机 Pi 加载的 pi-lens 扩展拒绝，理由是修改前需要先读取文件；Pi 读取后再次 `edit` 成功，随后用 `bash` 运行 `node --experimental-strip-types`，断言 `add(2, 3)`、`add(-2, 3)`、`add(0, 0)` 的结果，命令正常结束。
- 文件差异：

  ```diff
   export function add(a: number, b: number): number {
  -	return a - b;
  +	return a + b;
   }
  ```

- 会话中有一条 `pi-harness.edit` 记录，修改前后内容的 SHA-256 以 `9f92e9b4` 和 `75fc6153` 开头，两份内容都保存在扩展的快照目录中。
- 结果：通过。

### 4. 打开差异

- 操作：对上一步的修改执行“打开 Pi 修改的差异”。
- 实际：差异编辑器左侧为修改前的快照，含 `a - b`；右侧含 `a + b`。
- 结果：通过。

### 5. Copilot 查询工具

- 预期：Pi 调用 `copilot_searchWorkspaceSymbols` 并返回项目中的符号。
- 实际：测试配置没有登录 GitHub Copilot，`vscode.lm.tools` 列出的 40 个工具中没有 `copilot_searchWorkspaceSymbols`、`copilot_searchCodebase` 和 `copilot_getErrors`。
- 结果：未执行。

### 6. 引用回复

- 会话：`6d37ecbf-6092-4f82-8752-9d86d75d732c`。
- 操作：在回复中选中 `QUOTE-THIS-LINE`，按 `Ctrl+Alt+Q`。
- 实际：输入框内容为 `> QUOTE-THIS-LINE`，剪贴板恢复为引用前写入的文字。
- 结果：通过。

### 7. 从第二条请求分叉并恢复文件

- 源会话：`a63c3e70-990a-430a-8bb5-f1561fb29f4e`。第一条请求用 `write` 把 `steps.txt` 写为 `one`，第二条改为 `two`。
- 操作：在第二条请求上点击 Fork Conversation，选择“恢复文件并分叉”，再点击通知中的“把原请求填入输入框”。
- 实际：`steps.txt` 从 `two` 恢复为 `one`；新会话 `01a1a037-c74c-7259-afef-c5f607193e81` 只含第一条请求；第二条请求的文字回到输入框。
- 结果：通过。

### 8. 保护未保存的修改

- 会话：`aa897bf4-f01e-436f-8260-12985691060c`。
- 操作：Pi 先运行一条持续 12 秒的 `bash` 命令，在此期间把编辑器中 `draft.txt` 的第 2 行改为 `typed during the run`，不保存。
- 实际：Pi 随后的 `edit` 返回错误“…draft.txt 在 VS Code 中有未保存的修改。Pi 不修改该文件，请用户保存或撤销这些修改后再让 Pi 重试。”，Pi 回复 `BLOCKED`。磁盘内容仍为 `first line\nsecond line\n`，编辑器保留未保存的第 2 行。
- 结果：通过。

### 9. 在终端中继续

- 操作：对源会话 `a63c3e70-990a-430a-8bb5-f1561fb29f4e` 执行会话列表菜单中的“在终端中继续此会话”。
- 实际：终端的参数为 Pi 的 `cli.js`、`--session <该会话文件>` 和 `--session-dir <会话目录>`；VS Code 中该会话的 Pi 进程已经退出。
- 结果：通过。

### VS Code 1.144.1

同一个安装包在 1.144.1 上执行同样的验收，验收目录为 `.test-work/acceptance-2026-11-03T07-23-16-028Z`。第 1–4 步和第 6–9 步通过，第 5 步未执行，原因相同。会话为：附加选区并修改文件 `86e4e065-7612-4f0a-ae88-7478762f0678`（工具调用 `edit`、`read`、`edit`、`bash`），引用回复 `bea92637-da3e-4475-9b31-fdd4a7077d53`，分叉源会话 `f621a748-dfe3-4eb8-a91d-938745510f8b`，分叉出的会话 `01a1a04d-1169-7284-9d6f-2c5cbf481bd2`，未保存修改 `6adcc9ab-1216-4338-8720-cf93890c454e`。

## 其他测试

安装验收之后，用同一份代码在两个版本上依次运行下列测试，全部通过。这些测试从源码目录加载扩展，用命令行参数授权实验接口。

### 扩展宿主中的功能测试（`npm test`）

1.144.0 为 `.test-work/run-2026-11-03T07-09-41-560Z`，1.144.1 为 `.test-work/run-2026-11-03T07-33-14-051Z`，两次都是 25 项全部通过。

- 新建 Pi 会话并收到真实模型的回复。
- Pi 用 `read`、`edit`、`bash` 读取、修改文件并运行验证命令，修改进入快照；第二轮继续同一会话，Pi 回答出第一轮写入的内容。
- 列出终端中创建的会话，读取历史不改写会话文件；列出会话不创建会话目录；重命名和删除本窗口创建的会话。
- Pi 运行时发送的引导消息作为同一次运行中的第二条用户消息送达，Pi 的最终回复按引导消息的要求以 `ORANGE` 结尾。
- 排队的消息在第一轮的最终回复之后作为另一个请求送达。
- 停止时中止 Pi 的运行和正在执行的 60 秒命令，用时 11.3 秒（1.144.0）和 12.0 秒（1.144.1），`bash` 的结果为已中止。
- `/fork` 复制整个会话，原会话保留。
- 附加的选区使用编辑器中未保存的文字；编辑器中有未保存修改的文件 Pi 不修改；Pi 运行期间用户开始修改的文件 Pi 不覆盖；截图作为图片送达；用户保留 Pi 的修改后，下一个请求携带 `<edited-files>` 中的 `kept: …events.txt`。
- Pi 进程在运行中被结束后本轮中断，重新发送时恢复同一会话；两个会话同时运行，输出各自写入自己的会话；另一个窗口持有写入权限时不启动 Pi；空闲超时后结束进程、下次发送时重新启动；从历史打开的会话被 VS Code 释放且 Pi 空闲时结束进程。
- 在模型选择器中换用 `cliproxyapi/gpt-6-luna` 后，会话中的 `model_change` 依次为 `gpt-6-astra`、`gpt-6-luna`。
- 在终端中继续会话时先结束 VS Code 中的 Pi 进程并释放写入权限。
- 认证失败：模型服务对请求返回 401，本轮的错误为 `401: {"message":"Incorrect API key provided",…}`，Pi 进程保持运行。
- 读取模型列表的 Pi 进程在启动时以退出码 9 结束后，输出通道记录“…已退出，退出码 9，信号 无。没有标准错误输出。”，下一次读取重新启动 Pi 并取得模型。
- VS Code 中实际存在的 Copilot 工具：没有登录 Copilot，列表为空。

### 界面操作测试（`npm run test:ui`）

1.144.0 为 `.test-work/ui-2026-11-03T07-04-17-086Z`，1.144.1 为 `.test-work/ui-2026-11-03T07-27-41-402Z`，两次都是 8 项全部通过。

- Pi 扩展的对话框：选择、确认、输入在聊天内回答，编辑在无标题文档中完成后文档不保存直接关闭，带超时的选择在到期时关闭。Pi 扩展收到的回答为 `{"choice":"banana","confirmed":true,"text":"Alice","edited":"prefilled note","timed":null}`。
- 继续终端创建的会话前，模态对话框确认其他写入方已关闭。
- 在输入框中附加文件、图片、符号（通过 Add Context... 的 Symbols...）和问题（通过 Problems...，来自 VS Code 自带的 TypeScript 语言功能）。Pi 收到 `<file>`、`<selection>`、`<diagnostics>` 三个部分和一张图片，诊断一行为 `…shapes.ts:5:14 [error ts(2322)] Type 'string' is not assignable to type 'number'.`，回复为 `CODE=FILE-TOKEN-5813; COLOR=blue; SYMBOL=computeArea; ERROR=2322`。
- 从第二条请求分叉并恢复文件，原请求填回输入框；只分叉时文件不变。
- 在 Pi 会话的请求上按 Delete 只显示提示，请求和文件不变。
- 选中回复中的 `QUOTE-ME #tag /path @user` 后按 `Ctrl+Alt+Q`，输入框出现引用，剪贴板保持原样；没有选中文字时提示先选中。
- 在第三条请求上按 Enter 编辑后提交并确认：VS Code 撤销第三条请求中 Pi 的写入，`fork.txt` 从 `v3` 回到 `v2`；Pi 的当前分支退回到第二轮之后，编辑后的请求接在第二轮后面，原来的第三轮作为另一个分支保留在会话文件中。

### 重新启动 VS Code（`npm run test:reopen`）

1.144.0 为 `.test-work/reopen-2026-11-03T07-07-49-488Z`（会话 `a3c29c2b-9c4d-4613-9a19-6a07f097a694`），1.144.1 为 `.test-work/reopen-2026-11-03T07-31-20-204Z`。第一次启动新建会话并收到回复；关闭后用同一用户目录再次启动，会话出现在列表中，打开历史、确认其他写入方已关闭后继续发送，第二条消息写入同一个会话文件。两个版本都通过。

### 没有实验接口授权（`npm run test:no-proposed`）

不传入 `--enable-proposed-api` 启动时，扩展激活失败，错误为 `Extension 'local.pi-harness' CANNOT use API proposal: chatSessionsProvider.`，Pi 会话类型不出现。两个版本都通过。

## 没有执行的项目

- **Copilot 查询工具。** 测试使用的 VS Code 配置没有登录 GitHub Copilot，`copilot_searchWorkspaceSymbols`、`copilot_searchCodebase`、`copilot_getErrors` 不存在，Pi 调用这些工具的流程没有执行。在登录了 Copilot 的配置中运行 `npm run test:acceptance`，第 5 步会执行并断言 Pi 调用了 `copilot_searchWorkspaceSymbols` 且回复中有 `calc.ts`。

## 使用限制

- 引用回复通过系统剪贴板取得选中的文字，执行后恢复剪贴板中原来的文字；剪贴板中原有的图片和富文本不保留。Windows 锁屏期间剪贴板无法读写，引用不起作用。
- 编辑请求时 VS Code 只撤销 Pi 在这些请求的响应中用 `edit` 和 `write` 做的修改；`bash` 命令改动的文件，以及会话被重新打开后接回显示的那一轮中的修改不撤销。分叉时的“恢复文件”同样只覆盖 `edit` 和 `write`。
- Pi 会话中请求上的 Delete 键（VS Code 的 Restore Checkpoint）只显示提示，还原使用编辑请求或 Fork Conversation。
- 测试期间，Pi 进程有两次在启动阶段以 3221226505（0xC0000409）退出，没有任何输出：一次是读取模型列表的进程，一次是会话进程，分别在两次扩展宿主测试中。单独重复启动 Pi 的 40 次尝试没有复现，Windows 事件日志和错误报告中也没有记录。Node.js 自身中止（`process.abort()`、堆内存耗尽）时的退出码是 134，这个状态码来自 Pi 进程中的原生代码。会话启动时出现这种情况，本轮显示退出码，重新发送即可；读取模型列表时出现，下一次读取自动重新启动 Pi。
