# Pi Harness

在 VS Code Chat 中使用 Pi。每个窗口共用一个 Pi 后台，每个会话分别管理目录、模型、工具、历史和扩展资源。

安装与操作见 [INSTALL.md](INSTALL.md)，当前验证记录见 [ACCEPTANCE.md](ACCEPTANCE.md)，开发说明见 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)。

## 功能

- Pi 会话列表、模型和思考级别选择、文件及图片附件。
- 默认排队、显式引导、停止及独立会话释放。
- Pi 技能菜单和单会话 `/reload`。
- 历史编辑、持久文件恢复、Fork Conversation 和引用回复。
- 文件修改差异、未保存文本保护、编辑器查询和实际可用的 Copilot 工具。
- 唯一 Pi 状态按钮，显示会话状态及真实进程资源占用。

## 构建与验证

```powershell
npm install
npm run typecheck
npm run build
npm run package
```

使用 Node.js 24.15.0 或更高版本，Pi 固定为 1.5.0。构建将后台、进程管理辅助程序、兼容代码和生产依赖复制进 `dist`。

测试使用本机 VS Code 副本、真实 Pi SDK、模型、进程和工具。第一次使用时准备独立副本：

```powershell
npm run build
node dist/test/setupVscode.js "E:\Microsoft VS Code\Code.exe"
```

```powershell
npm test
npm run test:ui
npm run test:reopen
npm run test:no-proposed
npm run test:acceptance
```

`PI_HARNESS_VSCODE` 可以指定另一份测试用 `Code.exe`。所有测试的用户配置、会话及结果保存在 `.test-work`。安装验收使用独立的扩展目录，并检查日常安装内容保持一致。界面检查通过 DOM 和实际事件完成；引用功能需要可读写剪贴板的桌面会话。
