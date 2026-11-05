import { createMessageConnection, IPCMessageReader, IPCMessageWriter } from "vscode-jsonrpc/node";
import { BackendCatalog, BackendCommand, BackendInitialize, BackendMarkSubmitted, BackendOpen, BackendPendingRecovery, BackendPrepareSession, BackendRecordFileIntent, BackendRelease, BackendReload, BackendRespondUi, BackendRestore, BackendResumeRecovery, BackendSetProtection, BackendShutdown, BackendSubscribe, BackendUnsubscribe, BackendValidateIdentity } from "./protocol";
import type { BackendRegistry } from "./registry";

if (!process.send) throw new Error("Pi 后台必须通过具有 IPC 通道的 fork 启动");
process.once("disconnect", () => process.exit(1));
const handshake = setTimeout(() => { console.error("Pi 后台没有在期限内收到进程管理确认"); process.exit(1); }, 15_000);
const connection = createMessageConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
let registry: BackendRegistry | undefined;
let initializing = false;
const current = (): BackendRegistry => { if (!registry) throw new Error("Pi 后台尚未完成初始化"); return registry; };

connection.onRequest(BackendInitialize, async (params) => {
	if (initializing || registry) throw new Error("Pi 后台已经接收初始化请求");
	const authorization = params.authorization;
	if (!authorization.token || authorization.token !== process.env.PI_HARNESS_STARTUP_NONCE || authorization.backendPid !== process.pid || authorization.hostPid !== process.ppid || !authorization.jobName || !authorization.guardianPid) throw new Error("Pi 后台进程管理确认无效");
	initializing = true; clearTimeout(handshake);
	const { BackendRegistry } = await import("./registry");
	registry = await BackendRegistry.create(params, connection);
	return { pid: process.pid, generationId: params.generationId };
});
connection.onRequest(BackendPrepareSession, (params) => current().prepare(params));
connection.onRequest(BackendOpen, (params) => current().open(params));
connection.onRequest(BackendCommand, (params) => current().command(params));
connection.onRequest(BackendSubscribe, (params) => current().subscribe(params, params.subscriptionId));
connection.onRequest(BackendUnsubscribe, (params) => current().unsubscribe(params, params.subscriptionId));
connection.onRequest(BackendReload, (params) => current().reload(params));
connection.onRequest(BackendRelease, (params) => current().release(params, params.stop, params.reason));
connection.onRequest(BackendCatalog, (params) => current().catalog(params));
connection.onRequest(BackendSetProtection, (params) => current().protect(params));
connection.onRequest(BackendValidateIdentity, (params) => current().validateIdentity(params));
connection.onRequest(BackendRecordFileIntent, (params) => current().recordFileIntent(params.identity, params.edit));
connection.onRequest(BackendRestore, (params) => current().restore(params, params.input));
connection.onRequest(BackendResumeRecovery, async (params) => (await current().resumeRecovery(params)) ?? null);
connection.onRequest(BackendPendingRecovery, (params) => current().pendingRecovery(params) ?? null);
connection.onRequest(BackendMarkSubmitted, (params) => current().markSubmitted(params));
connection.onNotification(BackendRespondUi, (params) => current().respondUi(params));
connection.onRequest(BackendShutdown, async (params) => { current().assertGeneration(params); await current().shutdown(params.deadline); setImmediate(() => process.disconnect()); });
connection.listen();
