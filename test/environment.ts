import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseJson } from "../src/util/json";

/** 项目根目录：从构建后的测试文件所在目录向上查找扩展的 package.json */
function findRoot(start: string): string {
	let dir = start;
	while (!existsSync(join(dir, "package.json")) || !existsSync(join(dir, "pi-extension"))) {
		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(`没有找到项目根目录（从 ${start} 向上查找）`);
		}
		dir = parent;
	}
	return dir;
}

export const ROOT = findRoot(__dirname);
export const WORK = join(ROOT, ".test-work");
/** 测试使用的 VS Code：setupVscode 复制出的副本，PI_HARNESS_VSCODE 可以指定其他副本 */
export const VSCODE_EXECUTABLE = process.env.PI_HARNESS_VSCODE ?? join(WORK, "vscode", "Code.exe");
export const CDP_PORT = 9333;

export interface TestLayout {
	/** 本次运行的目录，同时是 VS Code 的便携数据目录（其中有 argv.json、user-data 和 extensions） */
	readonly base: string;
	readonly userDataDir: string;
	readonly extensionsDir: string;
	readonly sessionDir: string;
	readonly workspaceA: string;
	readonly workspaceB: string;
}

/** 每次运行使用独立目录，避免读取上一次运行留下的会话和 VS Code 状态 */
export function createLayout(runName: string): TestLayout {
	const base = join(WORK, runName);
	const layout: TestLayout = {
		base,
		userDataDir: join(base, "user-data"),
		extensionsDir: join(base, "extensions"),
		sessionDir: join(base, "sessions"),
		workspaceA: join(base, "workspace-a"),
		workspaceB: join(base, "workspace-b"),
	};
	for (const dir of Object.values(layout)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(join(layout.workspaceA, "README.md"), "# workspace-a\n");
	writeFileSync(join(layout.workspaceB, "README.md"), "# workspace-b\n");
	// 模态对话框使用工作台内绘制的样式，界面测试才能点击其中的按钮
	mkdirSync(join(layout.userDataDir, "User"), { recursive: true });
	writeFileSync(join(layout.userDataDir, "User", "settings.json"), JSON.stringify({ "window.dialogStyle": "custom", "chat.requestQueuing.defaultAction": "queue" }, null, "\t"));
	return layout;
}

/** 测试用 VS Code 的应用目录：Code.exe 旁版本目录中的 resources/app */
export function vscodeAppDirectory(): string {
	const root = dirname(VSCODE_EXECUTABLE);
	const apps = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name, "resources", "app"))
		.filter((app) => existsSync(join(app, "product.json")));
	if (apps.length !== 1) {
		throw new Error(`${root} 中应当正好有一个版本目录，实际有 ${apps.length} 个`);
	}
	return apps[0];
}

/**
 * 测试启动的 VS Code 一律使用便携模式，便携数据目录为本次运行的目录：
 * argv.json、用户数据和扩展都在其中，VS Code 也不注册 vscode:// 协议、不改写任务栏的跳转列表。
 * 非便携模式下 VS Code 总是读取用户目录中的 .vscode/argv.json，并把自己注册为 vscode:// 协议的处理程序。
 * product.json 含有 target 时 VS Code 忽略 VSCODE_PORTABLE，这时直接报错。
 */
export function portableEnvironment(layout: TestLayout): { VSCODE_PORTABLE: string } {
	const productFile = join(vscodeAppDirectory(), "product.json");
	const product = parseJson<Record<string, unknown>>(readFileSync(productFile, "utf8"), productFile);
	if ("target" in product) {
		throw new Error(`${productFile} 含有 target，VS Code 不会使用便携模式。请先运行 node dist/test/setupVscode.js <已安装的 Code.exe 路径>，或用 PI_HARNESS_VSCODE 指向一份删去了 target 的副本`);
	}
	return { VSCODE_PORTABLE: layout.base };
}
