import { statSync } from "node:fs";
import type { ImageContent } from "@earendil-works/pi-ai";
import * as vscode from "vscode";
import type { RangeRecord, ReferenceRecord } from "../../shared/protocol";

const MAX_FILE_CHARS = 200_000;

export interface RequestContext {
	readonly references: readonly ReferenceRecord[];
	/** `<vscode-context>` 块；没有附件和文件变更事件时为空字符串 */
	readonly contextBlock: string;
	readonly images: readonly ImageContent[];
}

function rangeRecord(range: vscode.Range): RangeRecord {
	return { startLine: range.start.line, startCharacter: range.start.character, endLine: range.end.line, endCharacter: range.end.character };
}

function escapeAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function lineSpan(range: vscode.Range): string {
	return `${range.start.line + 1}-${range.end.line + 1}`;
}

const SEVERITY_NAMES: Record<vscode.DiagnosticSeverity, string> = {
	[vscode.DiagnosticSeverity.Error]: "error",
	[vscode.DiagnosticSeverity.Warning]: "warning",
	[vscode.DiagnosticSeverity.Information]: "information",
	[vscode.DiagnosticSeverity.Hint]: "hint",
};

/** 严重程度加来源和代码，写法与 Problems 面板相同，例如 error ts(2322) */
function diagnosticLabel(diagnostic: vscode.Diagnostic): string {
	const code = typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
	const origin = `${diagnostic.source ?? ""}${code !== undefined ? `(${code})` : ""}`;
	return origin.length > 0 ? `${SEVERITY_NAMES[diagnostic.severity]} ${origin}` : SEVERITY_NAMES[diagnostic.severity];
}

const EDIT_EVENT_NAMES: Record<vscode.ChatRequestEditedFileEventKind, string> = {
	[vscode.ChatRequestEditedFileEventKind.Keep]: "kept",
	[vscode.ChatRequestEditedFileEventKind.Undo]: "undone",
	[vscode.ChatRequestEditedFileEventKind.UserModification]: "modified-by-user",
};

async function documentFor(uri: vscode.Uri): Promise<vscode.TextDocument> {
	return vscode.workspace.openTextDocument(uri);
}

/**
 * 把本轮引用转换为发送给 Pi 的上下文：文件和选区读取编辑器中的文字（包含未保存内容），
 * 诊断只展开用户选择的项目，图片转为 Pi 的 ImageContent。
 */
export async function buildRequestContext(request: vscode.ChatRequest, excludedReferenceIds: ReadonlySet<string> = new Set()): Promise<RequestContext> {
	const references: ReferenceRecord[] = [];
	const sections: string[] = [];
	const images: ImageContent[] = [];
	for (const reference of request.references) {
		if (excludedReferenceIds.has(reference.id)) continue;
		const value = reference.value;
		if (value instanceof vscode.Location) {
			const document = await documentFor(value.uri);
			references.push({
				kind: "selection",
				id: reference.id,
				name: reference.name,
				uri: value.uri.toString(),
				range: rangeRecord(value.range),
				documentVersion: document.version,
			});
			sections.push(
				`<selection path="${escapeAttribute(value.uri.fsPath)}" lines="${lineSpan(value.range)}" unsaved="${document.isDirty}">\n${document.getText(value.range)}\n</selection>`,
			);
		} else if (value instanceof vscode.Uri) {
			if (value.scheme === "file" && statSync(value.fsPath).isDirectory()) {
				references.push({ kind: "file", id: reference.id, name: reference.name, uri: value.toString() });
				sections.push(`<folder path="${escapeAttribute(value.fsPath)}" />`);
				continue;
			}
			const document = await documentFor(value);
			const text = document.getText();
			references.push({ kind: "file", id: reference.id, name: reference.name, uri: value.toString(), documentVersion: document.version });
			const truncated = text.length > MAX_FILE_CHARS;
			sections.push(
				`<file path="${escapeAttribute(value.fsPath)}" unsaved="${document.isDirty}"${truncated ? ` truncated="true" totalCharacters="${text.length}"` : ""}>\n${truncated ? text.slice(0, MAX_FILE_CHARS) : text}\n</file>`,
			);
		} else if (value instanceof vscode.ChatReferenceDiagnostic) {
			references.push({ kind: "diagnostic", id: reference.id, name: reference.name });
			const lines: string[] = [];
			for (const [uri, diagnostics] of value.diagnostics) {
				for (const diagnostic of diagnostics) {
					lines.push(`${uri.fsPath}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} [${diagnosticLabel(diagnostic)}] ${diagnostic.message}`);
				}
			}
			sections.push(`<diagnostics>\n${lines.join("\n")}\n</diagnostics>`);
		} else if (value instanceof vscode.ChatReferenceBinaryData) {
			const data = await value.data();
			references.push({ kind: "image", id: reference.id, name: reference.name, uri: value.reference?.toString() });
			images.push({ type: "image", data: Buffer.from(data).toString("base64"), mimeType: value.mimeType });
		} else if (typeof value === "string") {
			references.push({ kind: "other", id: reference.id, name: reference.name });
			sections.push(`<attachment name="${escapeAttribute(reference.name)}">\n${value}\n</attachment>`);
		} else {
			throw new Error(`不支持的附件类型：${reference.id}（${reference.name}）`);
		}
	}
	const editEvents = request.editedFileEvents ?? [];
	if (editEvents.length > 0) {
		sections.push(
			`<edited-files note="Changes the user made in VS Code to files you edited, since the previous request.">\n${editEvents
				.map((event) => `${EDIT_EVENT_NAMES[event.eventKind]}: ${event.uri.fsPath}`)
				.join("\n")}\n</edited-files>`,
		);
	}
	const contextBlock = sections.length === 0 ? "" : `<vscode-context>\n${sections.join("\n")}\n</vscode-context>`;
	return { references, contextBlock, images };
}

export function composePrompt(userText: string, contextBlock: string): string {
	return contextBlock.length === 0 ? userText : `${userText}\n\n${contextBlock}`;
}
