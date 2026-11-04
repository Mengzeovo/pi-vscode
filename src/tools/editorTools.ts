import { isAbsolute, resolve } from "node:path";
import * as vscode from "vscode";
import type { DiagnosticResult, DiagnosticsParams, LocationResult, PositionParams } from "../../shared/protocol";

function toUri(cwd: string, path: string): vscode.Uri {
	const normalized = path.startsWith("@") ? path.slice(1) : path;
	return vscode.Uri.file(isAbsolute(normalized) ? normalized : resolve(cwd, normalized));
}

async function preview(uri: vscode.Uri, line: number): Promise<string> {
	const document = await vscode.workspace.openTextDocument(uri);
	return line < document.lineCount ? document.lineAt(line).text.trim() : "";
}

async function toLocationResults(items: ReadonlyArray<vscode.Location | vscode.LocationLink>): Promise<LocationResult[]> {
	const results: LocationResult[] = [];
	for (const item of items) {
		const uri = item instanceof vscode.Location ? item.uri : item.targetUri;
		const range = item instanceof vscode.Location ? item.range : (item.targetSelectionRange ?? item.targetRange);
		results.push({
			path: uri.fsPath,
			startLine: range.start.line,
			startCharacter: range.start.character,
			endLine: range.end.line,
			endCharacter: range.end.character,
			preview: await preview(uri, range.start.line),
		});
	}
	return results;
}

export async function findDefinitions(cwd: string, params: PositionParams): Promise<LocationResult[]> {
	const uri = toUri(cwd, params.path);
	await vscode.workspace.openTextDocument(uri);
	const items = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
		"vscode.executeDefinitionProvider",
		uri,
		new vscode.Position(params.line, params.character),
	);
	return toLocationResults(items);
}

export async function findReferences(cwd: string, params: PositionParams): Promise<LocationResult[]> {
	const uri = toUri(cwd, params.path);
	await vscode.workspace.openTextDocument(uri);
	const items = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeReferenceProvider", uri, new vscode.Position(params.line, params.character));
	return toLocationResults(items);
}

const SEVERITY: Record<vscode.DiagnosticSeverity, DiagnosticResult["severity"]> = {
	[vscode.DiagnosticSeverity.Error]: "error",
	[vscode.DiagnosticSeverity.Warning]: "warning",
	[vscode.DiagnosticSeverity.Information]: "information",
	[vscode.DiagnosticSeverity.Hint]: "hint",
};

function toDiagnosticResult(uri: vscode.Uri, diagnostic: vscode.Diagnostic): DiagnosticResult {
	return {
		path: uri.fsPath,
		line: diagnostic.range.start.line,
		character: diagnostic.range.start.character,
		severity: SEVERITY[diagnostic.severity],
		source: diagnostic.source,
		message: diagnostic.message,
	};
}

export function readDiagnostics(cwd: string, params: DiagnosticsParams): DiagnosticResult[] {
	if (params.path !== undefined) {
		const uri = toUri(cwd, params.path);
		return vscode.languages.getDiagnostics(uri).map((diagnostic) => toDiagnosticResult(uri, diagnostic));
	}
	return vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) => diagnostics.map((diagnostic) => toDiagnosticResult(uri, diagnostic)));
}
