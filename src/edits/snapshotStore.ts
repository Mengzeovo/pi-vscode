import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { serializeFile } from "./fileIdentity";

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** 按 SHA-256 保存 Pi 修改前后的文件内容，相同内容只保存一份 */
export class SnapshotStore {
	private readonly blobDir: string;
	private readonly protectedHashes = new Map<string, number>();

	constructor(storageDir: string) {
		this.blobDir = join(storageDir, "snapshots");
	}

	async put(bytes: Uint8Array): Promise<string> {
		const hash = sha256(bytes);
		const file = join(this.blobDir, hash);
		await serializeFile(file, async () => {
			if (existsSync(file)) {
				if (sha256(await readFile(file)) !== hash) throw new Error(`快照内容校验失败：${hash}`);
				return;
			}
			await mkdir(this.blobDir, { recursive: true });
			const handle = await open(file, "wx");
			try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
		});
		return hash;
	}

	async get(hash: string): Promise<Buffer> {
		if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("快照 hash 格式不正确");
		const bytes = await readFile(join(this.blobDir, hash));
		if (sha256(bytes) !== hash) throw new Error(`快照内容校验失败：${hash}`);
		return bytes;
	}

	protect(hashes: readonly string[]): () => void {
		for (const hash of hashes) this.protectedHashes.set(hash, (this.protectedHashes.get(hash) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			for (const hash of hashes) {
				const count = this.protectedHashes.get(hash);
				if (count === 1) this.protectedHashes.delete(hash); else if (count !== undefined) this.protectedHashes.set(hash, count - 1);
			}
		};
	}

	has(hash: string): boolean {
		return existsSync(join(this.blobDir, hash));
	}

	/** 删除不在 referenced 中的内容，返回删除的数量 */
	async prune(referenced: ReadonlySet<string>): Promise<number> {
		if (!existsSync(this.blobDir)) {
			return 0;
		}
		let removed = 0;
		for (const name of await readdir(this.blobDir)) {
			await serializeFile(join(this.blobDir, name), async () => {
				if (!referenced.has(name) && !this.protectedHashes.has(name)) {
					await rm(join(this.blobDir, name));
					removed++;
				}
			});
		}
		return removed;
	}
}
