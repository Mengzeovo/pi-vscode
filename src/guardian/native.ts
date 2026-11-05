import koffi from "koffi";

export interface ProcessIdentity { readonly pid: number; readonly creationTime: string; }

const kernel = koffi.load("kernel32.dll");
const advapi = koffi.load("advapi32.dll");
const FileTime = koffi.struct({ low: "uint32_t", high: "uint32_t" });
const SecurityAttributes = koffi.struct({ length: "uint32_t", descriptor: "void *", inherit: "int32_t" });
const BasicLimit = koffi.struct({ processTime: "int64_t", jobTime: "int64_t", flags: "uint32_t", minWorkingSet: "size_t", maxWorkingSet: "size_t", activeLimit: "uint32_t", affinity: "uintptr_t", priority: "uint32_t", scheduling: "uint32_t" });
const IoCounters = koffi.struct({ readOperations: "uint64_t", writeOperations: "uint64_t", otherOperations: "uint64_t", readBytes: "uint64_t", writeBytes: "uint64_t", otherBytes: "uint64_t" });
const ExtendedLimit = koffi.struct({ basic: BasicLimit, io: IoCounters, processMemory: "size_t", jobMemory: "size_t", peakProcessMemory: "size_t", peakJobMemory: "size_t" });
const Accounting = koffi.struct({ userTime: "int64_t", kernelTime: "int64_t", periodUserTime: "int64_t", periodKernelTime: "int64_t", pageFaults: "uint32_t", totalProcesses: "uint32_t", activeProcesses: "uint32_t", terminatedProcesses: "uint32_t" });
const TokenUser = koffi.struct({ sid: "void *", attributes: "uint32_t" });
const GetLastError = kernel.func("uint32_t __stdcall GetLastError()");
const SetLastError = kernel.func("void __stdcall SetLastError(uint32_t code)");
const CloseHandle = kernel.func("int __stdcall CloseHandle(void *handle)");
const GetCurrentProcess = kernel.func("void * __stdcall GetCurrentProcess()");
const OpenProcess = kernel.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
const GetProcessTimes = kernel.func("__stdcall", "GetProcessTimes", "int", ["void *", koffi.out(koffi.pointer(FileTime)), koffi.out(koffi.pointer(FileTime)), koffi.out(koffi.pointer(FileTime)), koffi.out(koffi.pointer(FileTime))]);
const WaitForSingleObject = kernel.func("uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t timeout)");
const OpenProcessToken = advapi.func("int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)");
const GetTokenInformation = advapi.func("int __stdcall GetTokenInformation(void *token, uint32_t kind, _Out_ void *data, uint32_t size, _Out_ uint32_t *required)");
const ConvertSidToStringSid = advapi.func("int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)");
const ConvertDescriptor = advapi.func("int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t version, _Out_ void **descriptor, _Out_ uint32_t *size)");
const LocalFree = kernel.func("void * __stdcall LocalFree(void *value)");
const CreateJob = kernel.func("__stdcall", "CreateJobObjectW", "void *", [koffi.pointer(SecurityAttributes), "str16"]);
const OpenJob = kernel.func("void * __stdcall OpenJobObjectW(uint32_t access, int inherit, str16 name)");
const SetJob = kernel.func("int __stdcall SetInformationJobObject(void *job, int kind, void *info, uint32_t size)");
const QueryJob = kernel.func("int __stdcall QueryInformationJobObject(void *job, int kind, _Out_ void *info, uint32_t size, _Out_ uint32_t *returned)");
const AssignProcess = kernel.func("int __stdcall AssignProcessToJobObject(void *job, void *process)");
const TerminateJob = kernel.func("int __stdcall TerminateJobObject(void *job, uint32_t exitCode)");
const TerminateProcess = kernel.func("int __stdcall TerminateProcess(void *process, uint32_t exitCode)");
const GetExitCodeProcess = kernel.func("int __stdcall GetExitCodeProcess(void *process, _Out_ uint32_t *exitCode)");
const IsInJob = kernel.func("int __stdcall IsProcessInJob(void *process, void *job, _Out_ int *result)");

function checked(value: unknown, operation: string): void {
	if (!value) throw new Error(`${operation} 失败，Win32=${GetLastError()}`);
}

function currentUserDescriptor(): unknown {
	const token = [null];
	checked(OpenProcessToken(GetCurrentProcess(), 0x0008, token), "OpenProcessToken");
	try {
		const required = [0];
		GetTokenInformation(token[0], 1, null, 0, required);
		if (GetLastError() !== 122 || required[0] === 0) throw new Error("读取 TokenUser 长度失败");
		const buffer = Buffer.alloc(required[0]);
		checked(GetTokenInformation(token[0], 1, buffer, buffer.length, required), "GetTokenInformation");
		const user = koffi.decode(buffer, TokenUser) as { sid: unknown };
		const sidText = [null];
		checked(ConvertSidToStringSid(user.sid, sidText), "ConvertSidToStringSidW");
		try {
			const sid = koffi.decode(sidText[0], "char16_t", -1) as string;
			const descriptor = [null];
			checked(ConvertDescriptor(`D:P(A;;GA;;;${sid})`, 1, descriptor, null), "ConvertStringSecurityDescriptorToSecurityDescriptorW");
			return descriptor[0];
		} finally { LocalFree(sidText[0]); }
	} finally { CloseHandle(token[0]); }
}

export class ProcessHandle {
	private closed = false;
	readonly identity: ProcessIdentity;
	private constructor(readonly handle: unknown, pid: number) {
		const created = { low: 0, high: 0 };
		checked(GetProcessTimes(handle, created, {}, {}, {}), "GetProcessTimes");
		this.identity = { pid, creationTime: ((BigInt(created.high) << 32n) | BigInt(created.low)).toString() };
	}
	static open(pid: number, assign = false, terminate = false): ProcessHandle {
		const handle = OpenProcess(0x100000 | 0x1000 | (assign ? 0x0101 : 0) | (terminate ? 1 : 0), 0, pid);
		checked(handle, "OpenProcess");
		try { return new ProcessHandle(handle, pid); } catch (error) { CloseHandle(handle); throw error; }
	}
	static matches(identity: ProcessIdentity): boolean {
		const handle = OpenProcess(0x100000 | 0x1000, 0, identity.pid);
		if (!handle) {
			if (GetLastError() === 87) return false;
			throw new Error(`OpenProcess 身份核查失败，Win32=${GetLastError()}`);
		}
		let processHandle: ProcessHandle | undefined;
		try { processHandle = new ProcessHandle(handle, identity.pid); return processHandle.identity.creationTime === identity.creationTime && !processHandle.exited; }
		finally { if (processHandle) processHandle.close(); else CloseHandle(handle); }
	}
	assertIdentity(identity: ProcessIdentity): void {
		if (identity.pid !== this.identity.pid || identity.creationTime !== this.identity.creationTime || this.exited) throw new Error(`进程身份无效：${identity.pid}`);
	}
	get exited(): boolean {
		if (this.closed) throw new Error("进程句柄已经关闭");
		const result = WaitForSingleObject(this.handle, 0);
		if (result === 0xffffffff) throw new Error(`WaitForSingleObject 失败，Win32=${GetLastError()}`);
		return result === 0;
	}
	terminate(): void {
		if (this.exited || TerminateProcess(this.handle, 1)) return;
		const error = GetLastError();
		const exitCode = [259];
		checked(GetExitCodeProcess(this.handle, exitCode), "GetExitCodeProcess");
		if (error === 5 && exitCode[0] !== 259) return;
		throw new Error(`TerminateProcess 失败，Win32=${error}`);
	}
	close(): void { if (!this.closed) { checked(CloseHandle(this.handle), "CloseHandle"); this.closed = true; } }
}

export class WindowsJob {
	private closed = false;
	private terminating = false;
	private constructor(readonly name: string, private readonly handle: unknown) {}
	static create(name: string): WindowsJob {
		const descriptor = currentUserDescriptor();
		let handle: unknown;
		try {
			SetLastError(0);
			handle = CreateJob({ length: koffi.sizeof(SecurityAttributes), descriptor, inherit: 0 }, name);
			const error = GetLastError();
			checked(handle, "CreateJobObjectW");
			if (error === 183) { CloseHandle(handle); throw new Error(`Job 名称已经存在：${name}`); }
		} finally { LocalFree(descriptor); }
		const job = new WindowsJob(name, handle);
		try {
			const info = { basic: { flags: 0x2000 } };
			checked(SetJob(handle, 9, koffi.as(info, koffi.pointer(ExtendedLimit)), koffi.sizeof(ExtendedLimit)), "SetInformationJobObject");
			return job;
		} catch (error) { job.close(); throw error; }
	}
	static open(name: string): WindowsJob {
		const handle = OpenJob(0x0004 | 0x0008, 0, name);
		checked(handle, `OpenJobObjectW ${name}`);
		return new WindowsJob(name, handle);
	}
	assign(processHandle: ProcessHandle): void {
		if (this.closed || this.terminating) throw new Error("Job 当前禁止接纳进程");
		checked(AssignProcess(this.handle, processHandle.handle), "AssignProcessToJobObject");
		const member = [0];
		checked(IsInJob(processHandle.handle, this.handle, member), "IsProcessInJob");
		if (member[0] !== 1) throw new Error("后台进程未加入 Job");
	}
	get activeProcesses(): number {
		if (this.closed) throw new Error("Job 句柄已经关闭");
		const info = { activeProcesses: 0 };
		checked(QueryJob(this.handle, 1, koffi.as(info, koffi.pointer(Accounting)), koffi.sizeof(Accounting), null), "QueryInformationJobObject");
		return info.activeProcesses;
	}
	async terminate(deadline: number): Promise<void> {
		if (this.closed) throw new Error("Job 句柄已经关闭");
		this.terminating = true;
		checked(TerminateJob(this.handle, 1), "TerminateJobObject");
		while (this.activeProcesses !== 0) {
			if (Date.now() >= deadline) throw new Error(`等待 Job 全部进程退出超时：${this.name}`);
			await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
		}
	}
	close(): void { if (!this.closed) { checked(CloseHandle(this.handle), "CloseHandle"); this.closed = true; } }
}
