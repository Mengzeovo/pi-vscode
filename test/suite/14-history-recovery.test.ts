import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type * as Pi from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { createMessageConnection, SocketMessageReader, SocketMessageWriter, type MessageConnection } from "vscode-jsonrpc/node";
import * as vscode from "vscode";
import { FileCommit, FileReadBase, type CommitIdentity } from "../../shared/protocol";
import type { HarnessExtensionConfig } from "../../pi-extension/index";
import { OperationStore } from "../../src/backend/operationStore";
import { BackendCommand } from "../../src/backend/protocol";
import { FileGate } from "../../src/edits/fileGate";
import { SnapshotStore, sha256 } from "../../src/edits/snapshotStore";
import { env, harness, messageText, readBranch, TEST_MODEL, waitFor } from "./helpers";

async function setup(name: string, cwd?: string) {
	const directory = cwd ?? join(env("PI_HARNESS_TEST_WORK"), "history-recovery", name);
	await mkdir(directory, { recursive: true });
	const api = await harness();
	const backend = await api.hub.backend();
	const session = await api.hub.session(await api.hub.allocate(directory, randomUUID()));
	let store: OperationStore | undefined;
	try {
		await session.reload();
		const request = { generationId: backend.generationId!, sessionId: session.location.sessionId, requestId: randomUUID() };
		const slash = TEST_MODEL.indexOf("/");
		await backend.request(BackendCommand, { ...request, command: { type: "set_model", provider: TEST_MODEL.slice(0, slash), modelId: TEST_MODEL.slice(slash + 1) } });
		await backend.request(BackendCommand, { ...request, command: { type: "prompt", message: "Use the write tool to create authorization.txt containing exactly READY. Then reply READY. Do not use other tools." } });
		await waitFor("真实模型完成授权文件写入", () => {
			const snapshot = backend.snapshot?.sessions.find((entry) => entry.sessionId === request.sessionId);
			return existsSync(join(directory, "authorization.txt")) && snapshot && !snapshot.busy && snapshot.messages.some((message) => typeof message === "object" && message !== null && "role" in message && message.role === "assistant" && "stopReason" in message && message.stopReason === "stop") ? snapshot : undefined;
		});
		assert.equal(await readFile(join(directory, "authorization.txt"), "utf8"), "READY");
		store = new OperationStore(session.location.sessionFile!);
		const reader = new DatabaseSync(store.path, { readOnly: true });
		let identity: CommitIdentity;
		let initializationToolCallId: string;
		try {
			const row = reader.prepare("SELECT identity_json,tool_call_id FROM file_commits WHERE root_request_id=? ORDER BY commit_id LIMIT 1").get(request.requestId);
			assert.ok(row);
			identity = JSON.parse(String(row.identity_json));
			initializationToolCallId = String(row.tool_call_id);
		} finally { reader.close(); }
		const ownership = store.latestOwnership();
		assert.ok(ownership);
		assert.equal(ownership.state, "running");
		assert.equal(ownership.ownershipId, identity.ownershipId);
		assert.equal(ownership.backendPid, backend.pid);
		assert.notEqual(ownership.hostPid, ownership.backendPid);
		assert.notEqual(ownership.guardianPid, ownership.backendPid);
		await writeFile(join(directory, "authorization-proof.json"), JSON.stringify({ identity, ownership, backendPid: backend.pid, extensionHostPid: process.pid, node: process.version }, null, 2));
		const snapshots = new SnapshotStore(join(directory, "storage"));
		const validate = (candidate: CommitIdentity) => backend.validateIdentity(candidate);
		const recordIntent = (record: Parameters<NonNullable<ConstructorParameters<typeof FileGate>[3]>>[0]) => backend.recordFileIntent(record.identity, record);
		const gate = new FileGate(snapshots, () => undefined, validate, recordIntent);
		const database = store;
		return { directory, store: database, identity, ownership, snapshots, gate, validate, recordIntent, session, backend, api,
			edits: () => database.editsFor([identity.rootRequestId]).filter((edit) => edit.toolCallId !== initializationToolCallId),
			async close() { try { await session.deactivate(); } finally { database.close(); } } };
	} catch (error) {
		try { await session.deactivate(); } finally { store?.close(); }
		throw error;
	}
}

describe("历史恢复文件提交", () => {
	it("独立打包的 bridge 通过真实连接完成 SDK edit 和 write", async () => {
		const value = await setup("bundled-bridge");
		const extension = vscode.extensions.getExtension("local.pi-harness");
		assert.ok(extension);
		const packageDir = join(extension.extensionPath, "node_modules", "@earendil-works", "pi-coding-agent");
		const sdkPath = join(packageDir, "dist", "index.js");
		const sdk = await import(pathToFileURL(sdkPath).href) as typeof Pi;
		const bridgePath = join(extension.extensionPath, "dist", "pi-extension", "index.js");
		const sdkRequire = createRequire(join(packageDir, "package.json"));
		const importer = createJiti(bridgePath, { fsCache: false, alias: { "@earendil-works/pi-coding-agent": sdkPath, typebox: sdkRequire.resolve("typebox") } });
		const bridge = await importer.import(bridgePath) as { createHarnessExtension(config: HarnessExtensionConfig): Pi.ExtensionFactory };
		let accept!: (connection: MessageConnection) => void;
		const accepted = new Promise<MessageConnection>((resolve) => { accept = resolve; });
		let serverSocket: Socket | undefined;
		const server = createServer((socket) => {
			serverSocket = socket;
			const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
			connection.onRequest(FileReadBase, (params) => value.gate.readBase(params));
			connection.onRequest(FileCommit, (params) => value.gate.commit(params));
			connection.listen();
			accept(connection);
		});
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const socket = connect(address.port, "127.0.0.1");
		await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
		const client = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
		client.listen();
		const host = await accepted;
		let session: Pi.AgentSession | undefined;
		try {
			const agentDir = join(value.directory, "agent");
			await mkdir(agentDir, { recursive: true });
			const settingsManager = sdk.SettingsManager.inMemory();
			const loader = new sdk.DefaultResourceLoader({ cwd: value.directory, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
				extensionFactories: [{ name: "bundled-harness", factory: bridge.createHarnessExtension({ cwd: value.directory, role: "child", identity: () => value.identity, connection: client, copilotTools: [], onEdit: (data, identity) => value.backend.recordFileIntent(identity, data) }) }] });
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
			({ session } = await sdk.createAgentSession({ cwd: value.directory, agentDir, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.create(value.directory, join(value.directory, "sessions")), noTools: "all" }));
			const errors: string[] = [];
			await session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error.error); } });
			assert.deepEqual(errors, []);
			const file = join(value.directory, "notes.txt");
			await writeFile(file, "alpha\n");
			const edit = session.extensionRunner.getToolDefinition("edit");
			assert.ok(edit);
			await edit.execute("bundled-edit", { path: file, edits: [{ oldText: "alpha", newText: "beta" }] }, undefined, undefined, session.extensionRunner.createToolContext("bundled-edit", undefined));
			assert.equal(await readFile(file, "utf8"), "beta\n");
			const created = join(value.directory, "new", "written.txt");
			const write = session.extensionRunner.getToolDefinition("write");
			assert.ok(write);
			await write.execute("bundled-write", { path: created, content: "真实文件写入" }, undefined, undefined, session.extensionRunner.createToolContext("bundled-write", undefined));
			assert.equal(await readFile(created, "utf8"), "真实文件写入");
			const edits = value.edits();
			assert.equal(edits.length, 2);
			assert.deepEqual(new Set(edits.map((entry) => entry.toolCallId)), new Set(["bundled-edit", "bundled-write"]));
		} finally {
			if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
			host.dispose(); client.dispose(); socket.destroy(); serverSocket?.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await value.close();
		}
	});

	it("真实文件并发提交检查修改基准，并在写入前保存持久记录", async () => {
		const value = await setup("parallel");
		try {
			const file = join(value.directory, "shared.txt");
			await writeFile(file, "原始内容");
			const second = new FileGate(value.snapshots, () => undefined, value.validate, value.recordIntent);
			await Promise.all([value.gate.readBase({ path: file, toolCallId: "first", identity: value.identity }), second.readBase({ path: file, toolCallId: "second", identity: value.identity })]);
			const outcomes = await Promise.allSettled([
				value.gate.commit({ path: file, toolCallId: "first", tool: "write", identity: value.identity, contentBase64: Buffer.from("第一项内容").toString("base64") }),
				second.commit({ path: file, toolCallId: "second", tool: "write", identity: value.identity, contentBase64: Buffer.from("第二项内容").toString("base64") }),
			]);
			assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
			assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
			const edits = value.edits();
			assert.equal(edits.length, 1);
			assert.equal(sha256(await readFile(file)), edits[0].afterHash);
			assert.equal((await value.snapshots.get(edits[0].beforeHash!)).toString(), "原始内容");
		} finally { await value.close(); }
	});

	it("未保存文档和用户修改保持原内容", async () => {
		const value = await setup("dirty-document");
		try {
			const file = join(value.directory, "document.txt");
			await writeFile(file, "原始内容");
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
			await vscode.window.showTextDocument(document);
			const edit = new vscode.WorkspaceEdit();
			edit.insert(document.uri, new vscode.Position(0, 0), "未保存内容：");
			assert.equal(await vscode.workspace.applyEdit(edit), true);
			assert.equal(document.isDirty, true);
			await assert.rejects(value.gate.readBase({ path: file, toolCallId: "dirty", identity: value.identity }), /未保存/);
			assert.equal(await readFile(file, "utf8"), "原始内容");
			await vscode.commands.executeCommand("workbench.action.files.revert");
			await value.gate.readBase({ path: file, toolCallId: "changed", identity: value.identity });
			await writeFile(file, "用户更改");
			await assert.rejects(value.gate.commit({ path: file, toolCallId: "changed", identity: value.identity, tool: "edit", contentBase64: Buffer.from("工具更改").toString("base64") }), /修改/);
			assert.equal(await readFile(file, "utf8"), "用户更改");
		} finally { await value.close(); }
	});

	it("旧请求和旧后台身份无法写入文件", async () => {
		const value = await setup("identities");
		try {
			const file = join(value.directory, "target.txt");
			await writeFile(file, "保留内容");
			await value.gate.readBase({ path: file, toolCallId: "expired", identity: value.identity });
			value.gate.invalidate([value.identity.rootRequestId]);
			await assert.rejects(value.gate.commit({ path: file, toolCallId: "expired", identity: value.identity, tool: "write", contentBase64: "" }), /失效/);
			const other = new FileGate(value.snapshots, () => undefined, value.validate, value.recordIntent);
			for (const replacement of [{ sessionId: randomUUID() }, { generationId: randomUUID() }, { ownershipId: randomUUID() }, { runtimeGeneration: value.identity.runtimeGeneration + 1 }, { operationEpoch: value.identity.operationEpoch + 1 }, { rootRequestId: randomUUID() }, { runId: randomUUID() }]) {
				await assert.rejects(other.readBase({ path: file, toolCallId: "identity", identity: { ...value.identity, ...replacement } }));
			}
			await value.session.stop();
			await assert.rejects(other.readBase({ path: file, toolCallId: "stopped", identity: value.identity }), /失效/);
			await value.session.shutdown();
			await assert.rejects(other.readBase({ path: file, toolCallId: "released", identity: value.identity }));
			assert.equal(value.store.latestOwnership()!.state, "released");
			assert.equal(await readFile(file, "utf8"), "保留内容");
		} finally { await value.close(); }
	});

	it("文件恢复区分新建文件与空文件，并允许重新核对已完成写入", async () => {
		const value = await setup("restore-files");
		try {
			const empty = join(value.directory, "empty.txt");
			const created = join(value.directory, "created.txt");
			await writeFile(empty, "");
			for (const [index, file] of [empty, created].entries()) {
				const toolCallId = `write-${index}`;
				await value.gate.readBase({ path: file, toolCallId, identity: value.identity });
				await value.gate.commit({ path: file, toolCallId, identity: value.identity, tool: "write", contentBase64: Buffer.from("工具内容").toString("base64") });
			}
			const operationId = randomUUID();
			const files = await value.gate.prepareRestore({ operationId, rootRequestIds: [value.identity.rootRequestId], files: [] });
			assert.equal(files.length, 2);
			for (const file of files) {
				await value.gate.applyRestore({ operationId, file, reopened: false });
				await value.gate.applyRestore({ operationId, file, reopened: true });
			}
			assert.equal(existsSync(created), false);
			assert.equal(existsSync(empty), true);
			assert.equal((await readFile(empty)).length, 0);
			value.gate.releaseRestore(operationId);
		} finally { await value.close(); }
	});

	it("快照清理保留正在提交操作引用的内容", async () => {
		const value = await setup("snapshot-protection");
		try {
			const bytes = Buffer.from("正在使用的快照");
			const hash = sha256(bytes);
			const unprotect = value.snapshots.protect([hash]);
			await value.snapshots.put(bytes);
			assert.equal(await value.snapshots.prune(new Set()), 0);
			assert.deepEqual(await value.snapshots.get(hash), bytes);
			unprotect();
			assert.equal(await value.snapshots.prune(new Set()), 1);
		} finally { await value.close(); }
	});

	it("主请求执行期间与停止后立即恢复，保留输入并限制受保护会话操作", async () => {
		const value = await setup("active-root-restore");
		const results: unknown[] = [];
		try {
			for (const mode of ["running", "stopped"]) {
				const requestId = randomUUID();
				const file = join(value.directory, `${mode}-target.txt`);
				const waiting = join(value.directory, `${mode}-waiting.txt`);
				const after = join(value.directory, `${mode}-after.txt`);
				await writeFile(file, "ORIGINAL");
				const message = `依次使用 write 工具将 ${mode}-target.txt 写为 BEFORE；使用 bash 工具执行 powershell.exe -NoProfile -Command "Set-Content -LiteralPath '${mode}-waiting.txt' -Value 'RUNNING'; Start-Sleep -Seconds 120"；命令结束后使用 write 工具创建 ${mode}-after.txt，内容为 AFTER。严格按顺序完成。`;
				const envelope = { generationId: value.backend.generationId!, sessionId: value.session.location.sessionId };
				await value.backend.request(BackendCommand, { ...envelope, requestId, command: { type: "prompt", message } });
				await waitFor("实际主请求命令进入等待", () => existsSync(waiting) && value.backend.snapshot?.sessions.find((entry) => entry.sessionId === envelope.sessionId && entry.busy));
				assert.equal(await readFile(file, "utf8"), "BEFORE");
				const reader = new DatabaseSync(value.store.path, { readOnly: true });
				let identity: CommitIdentity;
				try {
					const row = reader.prepare("SELECT identity_json FROM file_commits WHERE root_request_id=? ORDER BY commit_id LIMIT 1").get(requestId);
					assert.ok(row);
					identity = JSON.parse(String(row.identity_json));
				} finally { reader.close(); }
				await value.backend.validateIdentity(identity);
				const branch = await readBranch(value.api, value.session.location.sessionFile!);
				const user = branch.find((entry) => entry.type === "message" && entry.message.role === "user" && messageText(entry.message.content) === message);
				assert.ok(user);
				if (mode === "stopped") await value.session.stop();
				const replacement = randomUUID();
				const savedText = `请仅回复 SAVED-${replacement}。`;
				const contextBlock = `<vscode-context>\n<attachment name="恢复前文件内容">${await readFile(file, "utf8")}</attachment>\n</vscode-context>`;
				await value.session.rewindBefore(user.id, user.parentId, { requestId: replacement, promptText: `${savedText}\n\n${contextBlock}`, userText: savedText, contextBlock, references: [{ kind: "other", id: `${mode}-saved-content`, name: "恢复前文件内容" }], images: [], enabledCopilotTools: [], selection: undefined }, [requestId]);
				await assert.rejects(value.backend.validateIdentity(identity), /失效/);
				assert.equal(await readFile(file, "utf8"), "ORIGINAL");
				assert.equal(existsSync(after), false);
				const stopped = await waitFor("历史恢复等待主请求结束", () => value.backend.snapshot?.sessions.find((entry) => entry.sessionId === envelope.sessionId && !entry.busy && entry.childTasks === 0));
				const pending = value.store.getPendingRestore();
				assert.equal(pending?.stage, "restored");
				assert.ok(pending);
				assert.ok(value.store.files(pending.operationId).every((entry) => entry.restored));
				const restoredBranch = await readBranch(value.api, value.session.location.sessionFile!);
				assert.equal(restoredBranch.some((entry) => entry.id === user.id), false);
				const guardFile = join(value.directory, `${mode}-guard.txt`);
				await writeFile(guardFile, "保留内容");
				await assert.rejects(value.session.reload(), /恢复|输入/);
				await assert.rejects(value.session.setArchived(true), /恢复|输入/);
				await assert.rejects(value.session.deleteFile(() => rm(guardFile)), /恢复|输入/);
				await assert.rejects(value.backend.withReleasedSession(envelope.sessionId, () => rm(guardFile)), /恢复/);
				await assert.rejects(value.backend.release(envelope.sessionId, false, "terminal"), /恢复/);
				assert.equal(await readFile(guardFile, "utf8"), "保留内容");
				assert.equal(value.store.latestOwnership()!.state, "running");
				assert.equal(value.session.holdsWritePermission, true);
				await value.session.prepareRecoveryInput(pending.operationId);
				const editedText = `请仅回复 EDITED-${replacement}，不要调用工具。`;
				const input = await value.session.applyRecoveryInput({ requestId: replacement, promptText: editedText, userText: editedText, basePrompt: editedText, contextBlock: "", references: [], images: [], enabledCopilotTools: [], selection: undefined });
				assert.equal(input.promptText, `${editedText}\n\n${contextBlock}`);
				assert.equal(input.references.length, 1);
				await value.backend.request(BackendCommand, { ...envelope, requestId: replacement, command: { type: "prompt", message: input.promptText, images: [...input.images] }, input: { userText: input.userText, contextBlock: input.contextBlock, references: input.references } });
				const submitted = await waitFor("明确发送产生实际用户条目", async () => (await readBranch(value.api, value.session.location.sessionFile!)).find((entry) => entry.type === "message" && entry.message.role === "user" && messageText(entry.message.content).includes(`EDITED-${replacement}`)));
				await value.backend.markSubmitted(envelope.sessionId, replacement, submitted.id);
				await waitFor("明确发送完成模型回复", () => value.backend.snapshot?.sessions.find((entry) => entry.sessionId === envelope.sessionId && !entry.busy && entry.messages.some((item) => typeof item === "object" && item !== null && "role" in item && item.role === "assistant" && "content" in item && messageText(item.content).includes(`EDITED-${replacement}`))));
				assert.equal(value.store.getPendingRestore(), undefined);
				assert.equal(existsSync(after), false);
				const completed = value.store.getRestore(pending.operationId);
				assert.equal(completed?.stage, "completed");
				assert.equal(completed?.input.userText, editedText);
				assert.equal(completed?.input.contextBlock, contextBlock);
				results.push({ mode, identity, ownership: value.store.latestOwnership(), stopped, completed, submittedId: submitted.id });
				await writeFile(join(value.directory, "restore-results.json"), JSON.stringify(results, null, 2));
			}
		} finally { await value.close(); }
	});

	it("未加载的历史会话从持久恢复记录阻止归档", async () => {
		const value = await setup("unloaded-archive", env("PI_HARNESS_TEST_WORKSPACE_A"));
		try {
			const sessionId = value.session.location.sessionId;
			const branch = await readBranch(value.api, value.session.location.sessionFile!);
			const user = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
			assert.ok(user);
			const requestId = randomUUID();
			const prompt = `请仅回复 ARCHIVE-${requestId}，不要调用工具。`;
			await value.session.rewindBefore(user.id, user.parentId, { requestId, promptText: prompt, userText: prompt, contextBlock: "", references: [], images: [], enabledCopilotTools: [], selection: undefined }, [value.identity.rootRequestId]);
			const pending = value.store.getPendingRestore();
			assert.equal(pending?.stage, "restored");
			assert.ok(value.backend.pid);
			process.kill(value.backend.pid);
			await waitFor("真实后台退出与 guardian 清理完成", () => !value.session.isRunning && !value.session.holdsWritePermission && value.store.latestOwnership()?.state === "cleaned");
			value.api.hub.forget(sessionId);
			assert.equal(value.api.hub.existingSession(sessionId), undefined);
			assert.equal(value.api.hub.isArchived(sessionId), false);
			await assert.rejects(value.api.hub.setArchived(sessionId, true), /恢复|输入/);
			assert.equal(value.api.hub.isArchived(sessionId), false);
			const reopened = value.api.hub.existingSession(sessionId);
			assert.ok(reopened?.isRunning);
			assert.equal(value.store.latestOwnership()!.state, "running");
			assert.equal(value.store.getPendingRestore()?.operationId, pending!.operationId);
			const envelope = { generationId: value.backend.generationId!, sessionId };
			await value.backend.request(BackendCommand, { ...envelope, requestId, command: { type: "prompt", message: prompt } });
			const submitted = await waitFor("重新打开后明确发送产生用户条目", async () => (await readBranch(value.api, reopened.location.sessionFile!)).find((entry) => entry.type === "message" && entry.message.role === "user" && messageText(entry.message.content) === prompt));
			await value.backend.markSubmitted(sessionId, requestId, submitted.id);
			await waitFor("重新打开后完成模型回复", () => value.backend.snapshot?.sessions.find((entry) => entry.sessionId === sessionId && !entry.busy && entry.messages.some((item) => typeof item === "object" && item !== null && "role" in item && item.role === "assistant" && "content" in item && messageText(item.content).includes(`ARCHIVE-${requestId}`))));
			assert.equal(value.store.getPendingRestore(), undefined);
			const directory = join(env("PI_HARNESS_TEST_WORK"), "history-recovery", "unloaded-archive");
			await mkdir(directory, { recursive: true });
			await writeFile(join(directory, "results.json"), JSON.stringify({ previousOwnership: value.ownership, ownership: value.store.latestOwnership(), completed: value.store.getRestore(pending!.operationId), submittedId: submitted.id }, null, 2));
			await reopened.deactivate();
		} finally { await value.close(); }
	});
});
