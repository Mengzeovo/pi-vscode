import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type { JsonAgentSessionEvent, RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";
import { parseJson } from "../util/json";
import type { PiRuntime } from "./piRuntime";

type CommandType = RpcCommand["type"];
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type SuccessOf<T extends CommandType> = Extract<RpcResponse, { command: T; success: true }>;
export type RpcData<T extends CommandType> = SuccessOf<T> extends { data: infer D } ? D : undefined;
export type RpcCommandInput = DistributiveOmit<RpcCommand, "id">;

interface PendingRequest {
	readonly command: CommandType;
	readonly resolve: (data: unknown) => void;
	readonly reject: (error: Error) => void;
}

export interface PiProcessOptions {
	readonly runtime: PiRuntime;
	readonly cwd: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly label: string;
	readonly log: (line: string) => void;
}

export interface PiProcessExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stderrTail: string;
}

const STDERR_TAIL_LIMIT = 16 * 1024;

/** 退出码、信号和标准错误输出的说明。Windows 的异常状态码同时给出十六进制形式，例如 3221226505（0xC0000409） */
export function describeExit(exit: PiProcessExit): string {
	const code = exit.code === null ? "无" : exit.code > 0xffff ? `${exit.code}（0x${exit.code.toString(16).toUpperCase()}）` : String(exit.code);
	const stderr = exit.stderrTail.trim();
	return `退出码 ${code}，信号 ${exit.signal ?? "无"}。${stderr.length > 0 ? `标准错误输出：\n${stderr}` : "没有标准错误输出。"}`;
}

/** 以 RPC 模式运行的 Pi 子进程，负责 JSONL 收发、请求关联和事件分发 */
export class PiRpcProcess {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly events = new EventEmitter();
	private nextRequestId = 1;
	private stderrTail = "";
	private exitInfo: PiProcessExit | undefined;
	private readonly exited: Promise<PiProcessExit>;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(private readonly options: PiProcessOptions) {
		this.child = spawn(options.runtime.nodeExecutable, [options.runtime.cliEntry, "--mode", "rpc", ...options.args], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
			for (const line of chunk.split("\n")) {
				if (line.trim().length > 0) {
					options.log(`[${options.label}] ${line}`);
				}
			}
		});
		options.runtime.modules.attachJsonlLineReader(this.child.stdout, (line) => this.handleLine(line));
		this.exited = new Promise((resolve) => {
			this.child.once("exit", (code, signal) => {
				const exit: PiProcessExit = { code, signal, stderrTail: this.stderrTail };
				this.exitInfo = exit;
				const error = new Error(`Pi 进程（${options.label}）已退出，${describeExit(exit)}`);
				for (const request of this.pending.values()) {
					request.reject(error);
				}
				this.pending.clear();
				this.events.emit("exit", this.exitInfo);
				resolve(this.exitInfo);
			});
		});
		this.child.once("error", (error) => {
			options.log(`[${options.label}] 进程错误：${error.message}`);
		});
		this.child.stdin.on("error", (error) => {
			options.log(`[${options.label}] 标准输入错误：${error.message}`);
		});
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	get hasExited(): boolean {
		return this.exitInfo !== undefined;
	}

	get whenExited(): Promise<PiProcessExit> {
		return this.exited;
	}

	onEvent(listener: (event: JsonAgentSessionEvent) => void): () => void {
		this.events.on("event", listener);
		return () => this.events.off("event", listener);
	}

	onExtensionUiRequest(listener: (request: RpcExtensionUIRequest) => void): () => void {
		this.events.on("ui", listener);
		return () => this.events.off("ui", listener);
	}

	onExit(listener: (exit: PiProcessExit) => void): () => void {
		this.events.on("exit", listener);
		return () => this.events.off("exit", listener);
	}

	async send<C extends RpcCommandInput>(command: C): Promise<RpcData<C["type"]>> {
		if (this.exitInfo) {
			throw new Error(`Pi 进程（${this.options.label}）已退出，无法发送 ${command.type}`);
		}
		const id = `vscode-${this.nextRequestId++}`;
		const result = new Promise<RpcData<C["type"]>>((resolve, reject) => {
			this.pending.set(id, { command: command.type, resolve: resolve as (data: unknown) => void, reject });
		});
		await this.writeRecord({ ...command, id });
		return result;
	}

	respondUi(response: RpcExtensionUIResponse): Promise<void> {
		return this.writeRecord(response);
	}

	/** 关闭标准输入请求 Pi 有序退出，并等待进程结束 */
	async shutdown(): Promise<PiProcessExit> {
		if (!this.exitInfo) {
			await this.writeChain;
			this.child.stdin.end();
		}
		return this.exited;
	}

	/** 强制终止进程 */
	kill(): void {
		this.child.kill();
	}

	/** 结束进程及其全部子进程（bash 启动的命令） */
	killTree(): void {
		const pid = this.child.pid;
		if (pid === undefined || this.exitInfo) {
			return;
		}
		if (process.platform === "win32") {
			const result = spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, encoding: "utf8" });
			if (result.status !== 0 && !this.exitInfo) {
				throw new Error(`taskkill 结束 Pi 进程 ${pid} 失败：${result.stderr}`);
			}
			return;
		}
		this.child.kill("SIGKILL");
	}

	private writeRecord(record: unknown): Promise<void> {
		const line = this.options.runtime.modules.serializeJsonLine(record);
		const write = this.writeChain.then(
			() =>
				new Promise<void>((resolve, reject) => {
					this.child.stdin.write(line, (error) => (error ? reject(error) : resolve()));
				}),
		);
		this.writeChain = write.catch(() => undefined);
		return write;
	}

	private handleLine(line: string): void {
		if (line.trim().length === 0) {
			return;
		}
		const record = parseJson<{ type?: string; id?: string }>(line, `Pi 进程（${this.options.label}）标准输出`);
		if (record.type === "response") {
			this.handleResponse(record as RpcResponse);
			return;
		}
		if (record.type === "extension_ui_request") {
			this.events.emit("ui", record as RpcExtensionUIRequest);
			return;
		}
		this.events.emit("event", record as JsonAgentSessionEvent);
	}

	private handleResponse(response: RpcResponse): void {
		if (response.id === undefined) {
			const message = response.success ? `收到没有请求 ID 的应答：${response.command}` : response.error;
			throw new Error(`Pi 进程（${this.options.label}）协议错误：${message}`);
		}
		const request = this.pending.get(response.id);
		if (!request) {
			throw new Error(`Pi 进程（${this.options.label}）返回了未知请求 ${response.id} 的应答`);
		}
		this.pending.delete(response.id);
		if (response.success) {
			request.resolve("data" in response ? response.data : undefined);
		} else {
			request.reject(new Error(`Pi 命令 ${request.command} 失败：${response.error}`));
		}
	}
}
