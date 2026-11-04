import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";
import { env, waitFor } from "../suite/helpers";

let connected: { browser: Browser; page: Page } | undefined;

/** 通过 Chrome DevTools Protocol 连接测试实例的工作台窗口 */
export async function workbench(): Promise<Page> {
	if (connected) {
		return connected.page;
	}
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${env("PI_HARNESS_TEST_CDP_PORT")}`);
	const page = await waitFor("工作台页面", () =>
		browser
			.contexts()
			.flatMap((context) => context.pages())
			.find((candidate) => candidate.url().includes("workbench")),
	);
	connected = { browser, page };
	return page;
}

/** 侧边栏 Chat 视图 */
export function chatView(page: Page): Locator {
	return page.locator(".interactive-session").first();
}

/** 聊天列表中的全部请求行。列表的行按需创建和复用，页面中的顺序与显示顺序无关，定位单行时按文字查找 */
export function requestRows(page: Page): Locator {
	return chatView(page).locator(".monaco-list-row.request");
}

/** aria-label 包含指定文字的请求行 */
export function requestRow(page: Page, text: string): Locator {
	return chatView(page).locator(`.monaco-list-row.request[aria-label*="${text}"]`).first();
}

/** aria-label 包含指定文字的回复行 */
export function responseRow(page: Page, text: string): Locator {
	return chatView(page).locator(`.monaco-list-row.response[aria-label*="${text}"]`).first();
}

/** 工作台中绘制的模态对话框里的按钮 */
export function dialogButton(page: Page, label: string): Locator {
	return page.locator(".monaco-dialog-box .dialog-buttons a.monaco-button", { hasText: label }).first();
}

/** 通知中的按钮 */
export function notificationButton(page: Page, label: string): Locator {
	return page.locator(".notifications-toasts .notification-toast a.monaco-button", { hasText: label }).first();
}

export function notification(page: Page, text: string): Locator {
	return page.locator(".notifications-toasts .notification-toast", { hasText: text }).first();
}

/** 输入框中的全部文字 */
export async function inputText(page: Page): Promise<string> {
	return page.evaluate(() => {
		const lines = Array.from(document.querySelectorAll(".interactive-session .interactive-input-part .interactive-input-editor .view-line")) as HTMLElement[];
		// 编辑器中的行按 top 定位，页面顺序可能与显示顺序不同
		lines.sort((left, right) => Number.parseFloat(left.style.top) - Number.parseFloat(right.style.top));
		return lines.map((line) => line.innerText.replace(/\u00a0/g, " ")).join("\n");
	});
}

/** 把工作台的一部分页面结构写入测试目录，界面测试失败时用于查看实际结构 */
export async function dumpDom(page: Page, selector: string, name: string): Promise<void> {
	const dump = await page.evaluate((rootSelector) => {
		const lines: string[] = [];
		const describe = (element: Element, depth: number): void => {
			if (depth > 18) {
				return;
			}
			const html = element as HTMLElement;
			const label = element.getAttribute("aria-label");
			const role = element.getAttribute("role");
			const text = element.children.length === 0 ? (html.innerText ?? "").trim().slice(0, 80) : "";
			lines.push(`${"  ".repeat(depth)}<${element.tagName.toLowerCase()} class="${element.className}"${role ? ` role="${role}"` : ""}${label ? ` aria-label="${label}"` : ""}>${text}`);
			for (const child of Array.from(element.children)) {
				describe(child, depth + 1);
			}
		};
		for (const root of Array.from(document.querySelectorAll(rootSelector))) {
			describe(root, 0);
		}
		return lines.join("\n");
	}, selector);
	writeFileSync(join(env("PI_HARNESS_TEST_WORK"), `${name}.txt`), dump);
}
