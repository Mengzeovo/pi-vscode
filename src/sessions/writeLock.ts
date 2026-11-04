import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function lockPipePath(cwd: string, sessionId: string): string {
	const normalizedCwd = process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
	const digest = createHash("sha256").update(`${normalizedCwd}\0${sessionId}`).digest("hex");
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pi-harness-lock-${digest}`;
	}
	// Unix 套接字路径有长度限制，只取摘要的前 32 位
	return join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `pi-harness-lock-${digest.slice(0, 32)}.sock`);
}

/**
 * 同一台机器上多个 VS Code 窗口之间的会话写入权。
 * 命名管道只能有一个监听方，进程退出时操作系统自动释放。
 */
export class WriteLock {
	private constructor(private readonly server: Server) {}

	/** 取得写入权；另一个窗口持有时返回 undefined */
	static acquire(cwd: string, sessionId: string): Promise<WriteLock | undefined> {
		const server = createServer((socket) => socket.destroy());
		return new Promise((resolvePromise, reject) => {
			server.once("error", (error: NodeJS.ErrnoException) => {
				if (error.code === "EADDRINUSE") {
					resolvePromise(undefined);
					return;
				}
				reject(error);
			});
			server.listen(lockPipePath(cwd, sessionId), () => resolvePromise(new WriteLock(server)));
		});
	}

	release(): Promise<void> {
		return new Promise((resolvePromise, reject) => this.server.close((error) => (error ? reject(error) : resolvePromise())));
	}
}
