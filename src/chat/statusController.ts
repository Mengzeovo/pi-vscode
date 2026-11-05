import { stripVTControlCharacters } from "node:util";
import * as vscode from "vscode";
import type { BackendProcessSnapshot, BackendSessionSnapshot } from "../backend/protocol";
import type { GuardianSnapshot, ProcessUsage } from "../guardian/protocol";

const labels: Record<BackendSessionSnapshot["state"], string> = {
	loading: "正在加载", loaded: "已加载", running: "运行中", waiting: "等待输入", "reload-pending": "等待重载",
	reloading: "正在重载", "reload-failed": "重载失败", releasing: "正在释放", released: "已经释放", protected: "等待恢复",
};

function plain(value: string): string { return stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f]/g, " "); }
function usageText(label: string, usage: Pick<ProcessUsage, "pid" | "cpuPercent" | "rssBytes">): string {
	return `${label} PID ${usage.pid} · CPU ${usage.cpuPercent.toFixed(1)}% · 内存 ${(usage.rssBytes / 1_048_576).toFixed(1)} MiB`;
}

/** 每个扩展窗口创建一个实例。 */
export class StatusController implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private backend: BackendProcessSnapshot | undefined;
	private guardian: GuardianSnapshot | undefined;
	private previousText = "";
	constructor() {
		this.item = vscode.window.createStatusBarItem("piHarness.status", vscode.StatusBarAlignment.Left, 100);
		this.item.name = "Pi";
		this.item.text = "Pi";
		this.item.command = "piHarness.refreshSessions";
		this.render();
		this.item.show();
	}
	updateBackend(snapshot: BackendProcessSnapshot | undefined): void { this.backend = snapshot; this.render(); }
	updateGuardian(snapshot: GuardianSnapshot | undefined): void { this.guardian = snapshot; this.render(); }
	private render(): void {
		const sessions = this.backend?.sessions.filter((session) => session.state !== "released") ?? [];
		const waiting = sessions.filter((session) => session.pendingInteractions > 0 || session.state === "waiting").length;
		const running = sessions.filter((session) => session.busy && session.pendingInteractions === 0 && session.state !== "waiting").length;
		const lines = [`活动会话 ${running + waiting} · 运行中 ${running} · 等待输入 ${waiting} · 已加载 ${sessions.length}`];
		const names = new Map<string, number>();
		for (const session of sessions) names.set(plain(session.name), (names.get(plain(session.name)) ?? 0) + 1);
		for (const session of sessions) {
			const name = plain(session.name) || "新的 Pi 会话";
			const suffix = (names.get(name) ?? 0) > 1 ? ` (${session.sessionId.slice(0, 8)})` : "";
			const reload = session.reloadPending && session.state !== "reload-pending" ? " · 等待重载" : "";
			lines.push(`${name}${suffix}：${labels[session.state]}${reload}`);
			if (session.error) lines.push(`  ${plain(session.error)}${session.state === "reload-failed" ? "；通过会话菜单重新加载会话" : ""}`);
		}
		lines.push(this.backend ? usageText("Pi 后台", this.backend) : "后台未启动");
		if (this.guardian) {
			lines.push(`${usageText("进程管理辅助程序", this.guardian.usage)} · ${this.guardian.state === "cleaning" ? "正在清理" : "运行中"}`);
			if (this.guardian.state === "cleaning" && this.guardian.sessionIds.length > 0) lines.push(`正在清理的会话：${this.guardian.sessionIds.map((id) => plain(sessions.find((session) => session.sessionId === id)?.name ?? id.slice(0, 8))).join("、")}`);
		}
		const text = lines.join("\n");
		if (text === this.previousText) return;
		this.previousText = text;
		const tooltip = new vscode.MarkdownString();
		for (const [index, line] of lines.entries()) { if (index > 0) tooltip.appendMarkdown("\n\n"); tooltip.appendText(line); }
		this.item.tooltip = tooltip;
	}
	dispose(): void { this.item.dispose(); }
}
