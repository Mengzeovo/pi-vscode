# Pi Harness 兼容资源

运行环境为 Pi 1.5.0、Node.js 24.15.0 或更高版本。全部包保留上游许可证；兼容修改位于本目录。用户原有安装目录保持原内容。

| 目录 | 来源版本 | 项目内来源 | 许可证 |
|---|---|---|---|
| `pi-subagents` | 0.84.0 | `compat/pi-subagents` | MIT，见 `pi-subagents/LICENSE` |
| `pi-cliproxyapi-provider` | 1.4.24 | `compat/pi-cliproxyapi-provider` | MIT，见 `pi-cliproxyapi-provider/LICENSE` |
| `pi-mcp` | Pi 1.5.0 内置 MCP extension | `node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/index.js` | MIT，见 `pi-mcp/LICENSE`；Mario Zechner，2025 |
| `pi-lens` | 4.4.8 | `compat/pi-lens` | MIT，见 `pi-lens/LICENSE` |
| `pi-token-usage` | 0.2.1 | `compat/pi-token-usage` | MIT，见 `pi-token-usage/LICENSE` |

`pi-subagents` 的 `index.js`、`package.json` 和 `src/` 使用按会话传递的上下文。`harness-context.js` 管理资源加载、子任务启动、前台 child 与后台 runner 的所属关系；`harness-runner.js` 将完整请求身份和编辑器连接传给独立进程。`src/runs/shared/child-session.js` 使用真实 SDK 的公开接口，每个 child 接收专用配置与文件提交身份。`src/runs/background/async-execution.js` 在创建 runner 前登记启动操作，结束时等待真实进程退出证据。`src/extension/index.js`、`src/tui/running-tone.js` 和斜杠命令状态模块保持各会话独立。`src/workflows/scripted-workflow.js` 在 Harness 中使用构造参数指定的目录。

`pi-cliproxyapi-provider/extensions/index.ts` 关闭时向原 provider 传入当前 `sessionId`，只关闭所属连接。

`pi-mcp/index.js` 保留 Pi 的 MCP 协议、登录及工具流程，增加每会话、每运行代次的配置、连接尝试、工具注册和关闭完成通知。`dependencies.js` 从实际 Pi 安装路径加载同版本依赖。

`pi-lens/runtime-source.js` 保留上游完整模块。`build.mjs` 使用 esbuild 生成 CommonJS 产物；`index.js` 使用 Node.js `vm.compileFunction` 的参数绑定，为每次激活提供独立模块变量、全局属性与 `process` 符号状态。实际 SDK、文件、网络、子进程及 Worker 继续使用真实接口。每个会话记录自己创建的进程句柄、Worker、定时器和进程监听器。完整 `safeSpawnAsync` 操作涵盖进程、管道与采样清理，目录登记写入从创建时计入所属任务；关闭等待这些实际 Promise、graph 构建和 checkpoint Worker，执行上游 graph 与 snapshot 保存，等待真实进程退出、后台写入及日志保存，再清理所属监听器和计时器。LSP 退出后的目录登记使用所属清理上下文。写入错误通过 SDK 生命周期错误报告原始系统原因与路径。其他上游修改包含 SDK 文件修改队列的来源、单会话关闭使用完整 LSP 进程树清理、共享 PID 登记只移除所属目录与子进程。`skills/` 保留原包技能；语法资源、配置、原生依赖和工作进程文件来自固定版本的生产依赖 `pi-lens@4.4.8`。

`pi-token-usage/build.mjs` 的 `buildTokenUsage(output, packageDirectory?)` 从固定版本完整入口构建，保留上游命令、界面与统计范围；`scan.js` 使用 Pi 公开 `parseSessionEntries` 读取会话记录。缓存按照文件身份、纳秒时间和大小更新，新增、追加、重写、删除和替换文件都会重新计算。该包作为构建依赖，生产扩展包含已构建的 `dist/compat/pi-token-usage/dist/index.js`。

构建执行 `npm ci` 和 `npm run build`。`scripts/build.mjs` 将本目录原样复制到 `dist/compat`，调用 `buildLensRuntime` 生成 `dist/compat/pi-lens/dist/runtime.cjs`，调用 `buildTokenUsage` 生成统计扩展入口，保留 runner、资源及相对导入路径；生产依赖复制到 `dist/node_modules`。动态 Pi SDK 与 `typebox` 解析到配置指定的 Pi 1.5.0 安装目录。VSIX 包含 `dist/compat`、生产依赖及许可证。

来源文件 SHA-256：

- `pi-subagents/src/runs/shared/child-session.js`：`3959467D7B7E95120C039DDCA6EE9A770661BE7D2198E195B51B230C2C8632CA`
- `pi-cliproxyapi-provider/extensions/index.ts`：`51EE8C36AA3275D7D085472117F51953CEBD01505BEF265605F08C1464D7658F`
- Pi 1.5.0 `dist/extensions/mcp/index.js`：`C0570B9D256120A1DF9B65A015964076DFF6A3710646E041FCB2770AE7132FDE`
- `pi-lens/dist/index.js`：`59E40189C1B4C00B5BD928EE93F474762B9DF8530DEBCA90EB363D5AB2C1749C`
- `pi-token-usage/src/index.ts`：`D5C0799DDAE606A7EB91D6A049DD296EDBF950F0768FC4D096DA34B4C0231DD5`
- `pi-token-usage/src/scan.ts`：`686913B6B00F4E1BC211917FF90F4A74F58B4E80E7E956CDD696EA79344F58A5`
