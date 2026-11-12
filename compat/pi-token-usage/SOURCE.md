# pi-token-usage

来源为 npm 包 pi-token-usage 0.2.1，许可证为 MIT，版权声明保存在 LICENSE。项目 package.json 与 package-lock.json 将该版本固定为构建依赖。构建直接采用依赖中的 src/index.ts 及命令、汇总、格式与配置模块，scan 导入通过 esbuild 解析到本目录实现。

上游声明的 Pi peer 范围为 ^0.75.3，项目通过定向 overrides 使用项目的 Pi 开发依赖。上游入口只导入 ExtensionAPI 类型；兼容扫描在运行时调用当前 Pi 公开的 parseSessionEntries。

缓存按会话文件绝对路径保存解析结果，并检查 dev、ino、birthtimeNs、ctimeNs、mtimeNs、size。读取前后通过同一文件句柄再次确认元数据，持续变化时明确报告错误。每次刷新重新枚举全部目录和文件，移除删除文件，只重新读取新增或变化文件。完整记录继续使用上游的去重键、时间排序和统计字段；JSONL 由 Pi 的公开 parseSessionEntries 读取。

命令、完整历史范围、项目归属、费用、token 字段与界面配置保持上游功能。文件不存在时跳过对应文件；其他文件系统错误直接报告。

来源文件 SHA-256：src/index.ts 为 D5C0799DDAE606A7EB91D6A049DD296EDBF950F0768FC4D096DA34B4C0231DD5；src/scan.ts 为 686913B6B00F4E1BC211917FF90F4A74F58B4E80E7E956CDD696EA79344F58A5。
