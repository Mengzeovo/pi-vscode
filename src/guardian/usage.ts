import { availableParallelism } from "node:os";
import type { ProcessUsage } from "./protocol";

export class ProcessSampler {
	private previousUsage = process.cpuUsage();
	private previousTime = process.hrtime.bigint();
	sample(): ProcessUsage {
		const now = process.hrtime.bigint();
		const usage = process.cpuUsage();
		const elapsedMicroseconds = Number(now - this.previousTime) / 1_000;
		const usedMicroseconds = usage.user - this.previousUsage.user + usage.system - this.previousUsage.system;
		this.previousUsage = usage;
		this.previousTime = now;
		return { pid: process.pid, cpuPercent: elapsedMicroseconds > 0 ? usedMicroseconds / elapsedMicroseconds / availableParallelism() * 100 : 0, rssBytes: process.memoryUsage.rss(), sampledAt: Date.now() };
	}
}
