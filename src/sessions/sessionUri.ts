import * as vscode from "vscode";

export const SESSION_TYPE = "pi-harness";

export function sessionResource(sessionId: string): vscode.Uri {
	return vscode.Uri.from({ scheme: SESSION_TYPE, path: `/${sessionId}` });
}

export function isUntitledResource(resource: vscode.Uri): boolean {
	return resource.scheme === SESSION_TYPE && resource.path.startsWith("/untitled-");
}

export function parseSessionResource(resource: vscode.Uri): string {
	if (resource.scheme !== SESSION_TYPE) {
		throw new Error(`不是 Pi 会话资源：${resource.toString()}`);
	}
	const segments = resource.path.split("/").filter((segment) => segment.length > 0);
	if (segments.length !== 1 || isUntitledResource(resource)) {
		throw new Error(`Pi 会话资源格式错误：${resource.toString()}`);
	}
	return segments[0];
}
