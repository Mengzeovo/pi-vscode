# Pi Harness

在 VS Code 侧边栏的 Chat 中使用 Pi 编码代理。Pi 以 RPC 模式运行，沿用你在终端中配置的登录信息、模型、扩展和会话文件。

安装和授权步骤见扩展目录中的 `INSTALL.md`。

## 功能

- 在新建聊天中选择 Pi，会话列表显示当前工作区的 Pi 会话（包括终端中创建的会话）。
- Pi 的模型和思考级别出现在 Chat 的模型选择器中。
- 附加文件、选区、符号、诊断和图片；Pi 运行时可以发送引导消息或停止。
- Pi 的文件修改进入 Chat 的变更记录，可以打开每次修改的差异；Pi 不会覆盖你在编辑器中修改且尚未保存的文件。
- 编辑请求、Fork Conversation（可同时恢复文件）、`/fork` 和引用回复中的文字。
- Pi 扩展的选择、确认、输入和编辑对话框在 Chat 或 VS Code 的输入框中回答。
- 编辑器工具 `vscode_definition`、`vscode_references`、`vscode_diagnostics`，以及 VS Code 中存在时的 Copilot 查询工具。

## 构建

```powershell
npm install
npm run typecheck
npm run build
npm run package
```

测试使用本机 VS Code 的副本和 Pi 中配置的真实模型。第一次运行前把已安装的 VS Code 复制到 `.test-work/vscode`：

```powershell
npm run build
node dist/test/setupVscode.js "E:\Microsoft VS Code\Code.exe"
```

副本的 `product.json` 中没有 `target`，每次测试都以便携模式启动它，`argv.json`、用户数据和扩展都在该次运行的目录中，测试不读写本机 VS Code 的配置，也不改变 `vscode://` 链接的处理程序。环境变量 `PI_HARNESS_VSCODE` 可以指定其他副本的 `Code.exe`。

```powershell
npm test                  # 扩展宿主中的功能测试
npm run test:ui           # 界面操作测试
npm run test:reopen       # 重新启动 VS Code 后继续会话
npm run test:no-proposed  # 没有实验接口授权时的行为
npm run test:acceptance   # 打包后在便携配置中安装 VSIX 并验收
```

界面操作测试中的引用使用系统剪贴板，Windows 锁屏期间剪贴板无法读写，需要在解锁的桌面会话中运行。验收结果见源码目录中的 `ACCEPTANCE.md`。
