import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createMessageConnection, type MessageConnection, SocketMessageReader, SocketMessageWriter } from "vscode-jsonrpc/node";
import { Hello, type HelloParams, type HelloResult } from "../../shared/protocol";

export interface IpcEndpoint {
	readonly path: string;
	readonly token: string;
}

/** 一个 Chat 的编辑器连接，分别验证主会话与所属子任务。 */
export class IpcServer {
	readonly endpoint: IpcEndpoint;
	private readonly server: Server;
	private connection: MessageConnection | undefined;
	private readonly clients = new Map<MessageConnection, Socket>();
	private readonly waiters = new Set<{ resolve(connection: MessageConnection): void; reject(error: Error): void }>();
	private closed = false;

	private constructor(
		server: Server,
		endpoint: IpcEndpoint,
		private readonly onHello: (params: HelloParams) => HelloResult | Promise<HelloResult>,
		private readonly configure: (connection: MessageConnection) => void,
	) {
		this.server = server;
		this.endpoint = endpoint;
		server.on("connection", (socket) => this.accept(socket));
	}

	static async listen(onHello: (params: HelloParams) => HelloResult | Promise<HelloResult>, configure: (connection: MessageConnection) => void): Promise<IpcServer> {
		const directory = join(process.cwd(), ".test-work", "ipc");
		if (process.platform !== "win32") {
			mkdirSync(directory, { recursive: true });
		}
		const path = process.platform === "win32" ? `\\\\.\\pipe\\pi-harness-ipc-${randomUUID()}` : join(directory, `${randomUUID()}.sock`);
		const endpoint = { path, token: randomBytes(32).toString("base64url") };
		const server = createServer();
		const ipc = new IpcServer(server, endpoint, onHello, configure);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, () => {
				server.off("error", reject);
				resolve();
			});
		});
		return ipc;
	}

	/** 等待 Pi 扩展完成握手 */
	whenConnected(): Promise<MessageConnection> {
		if (this.closed) {
			return Promise.reject(new Error("编辑器连接已经关闭"));
		}
		if (this.connection) {
			return Promise.resolve(this.connection);
		}
		return new Promise((resolve, reject) => this.waiters.add({ resolve, reject }));
	}

	get current(): MessageConnection | undefined {
		return this.connection;
	}

	failPendingConnection(error: Error): void {
		for (const waiter of this.waiters) {
			waiter.reject(error);
		}
		this.waiters.clear();
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.failPendingConnection(new Error("编辑器连接已经关闭"));
		for (const [connection, socket] of this.clients) {
			connection.dispose();
			socket.destroy();
		}
		this.clients.clear();
		this.connection = undefined;
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private accept(socket: Socket): void {
		if (this.closed) {
			socket.destroy();
			return;
		}
		const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
		this.clients.set(connection, socket);
		let authenticated = false;
		connection.onRequest(Hello, async (params) => {
			if (authenticated) {
				throw new Error("重复握手");
			}
			if (params.token !== this.endpoint.token) {
				socket.destroy();
				throw new Error("IPC 令牌不正确");
			}
			if (params.role === "root" && this.connection) {
				throw new Error("主会话已有编辑器连接");
			}
			authenticated = true;
			const result = await this.onHello(params);
			if (this.closed) {
				throw new Error("编辑器连接已经关闭");
			}
			if (params.role === "root" && this.connection) {
				throw new Error("主会话已有编辑器连接");
			}
			this.configure(connection);
			if (params.role === "root") {
				this.connection = connection;
				for (const waiter of this.waiters) {
					waiter.resolve(connection);
				}
				this.waiters.clear();
			}
			return result;
		});
		socket.on("close", () => {
			this.clients.delete(connection);
			connection.dispose();
			if (this.connection === connection) {
				this.connection = undefined;
			}
		});
		connection.listen();
	}
}
