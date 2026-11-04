import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { createMessageConnection, type MessageConnection, SocketMessageReader, SocketMessageWriter } from "vscode-jsonrpc/node";
import { Hello, type HelloParams, type HelloResult } from "../../shared/protocol";

export interface IpcEndpoint {
	readonly path: string;
	readonly token: string;
}

/**
 * 一个 Pi 进程对应的命名管道服务端。只接受第一个通过令牌握手的连接，
 * 握手失败或出现第二个连接时直接断开。
 */
export class IpcServer {
	readonly endpoint: IpcEndpoint;
	private readonly server: Server;
	private connection: MessageConnection | undefined;
	private readonly connected: Promise<MessageConnection>;
	private resolveConnected!: (connection: MessageConnection) => void;
	private rejectConnected!: (error: Error) => void;

	private constructor(
		server: Server,
		endpoint: IpcEndpoint,
		private readonly onHello: (params: HelloParams) => HelloResult,
		private readonly configure: (connection: MessageConnection) => void,
	) {
		this.server = server;
		this.endpoint = endpoint;
		this.connected = new Promise((resolve, reject) => {
			this.resolveConnected = resolve;
			this.rejectConnected = reject;
		});
		server.on("connection", (socket) => this.accept(socket));
	}

	static async listen(onHello: (params: HelloParams) => HelloResult, configure: (connection: MessageConnection) => void): Promise<IpcServer> {
		const path = process.platform === "win32" ? `\\\\.\\pipe\\pi-harness-ipc-${randomUUID()}` : `/tmp/pi-harness-ipc-${randomUUID()}.sock`;
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
		return this.connected;
	}

	get current(): MessageConnection | undefined {
		return this.connection;
	}

	failPendingConnection(error: Error): void {
		if (!this.connection) {
			this.rejectConnected(error);
		}
	}

	async close(): Promise<void> {
		this.connection?.dispose();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private accept(socket: Socket): void {
		if (this.connection) {
			socket.destroy();
			return;
		}
		const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
		let authenticated = false;
		connection.onRequest(Hello, (params) => {
			if (authenticated) {
				throw new Error("重复握手");
			}
			if (params.token !== this.endpoint.token) {
				socket.destroy();
				throw new Error("IPC 令牌不正确");
			}
			authenticated = true;
			this.connection = connection;
			const result = this.onHello(params);
			this.configure(connection);
			this.resolveConnected(connection);
			return result;
		});
		socket.on("close", () => {
			if (this.connection === connection) {
				this.connection = undefined;
			}
		});
		connection.listen();
	}
}
