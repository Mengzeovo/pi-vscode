import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** 按 SHA-256 保存 Pi 修改前后的文件内容，相同内容只保存一份 */
export class SnapshotStore {
	private readonly blobDir: string;

	constructor(storageDir: string) {
		this.blobDir = join(storageDir, "snapshots");
	}

	async put(bytes: Uint8Array): Promise<string> {
		const hash = sha256(bytes);
		const file = join(this.blobDir, hash);
		if (!existsSync(file)) {
			await mkdir(this.blobDir, { recursive: true });
			await writeFile(file, bytes);
		}
		return hash;
	}

	async get(hash: string): Promise<Buffer> {
		return readFile(join(this.blobDir, hash));
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
			if (!referenced.has(name)) {
				await rm(join(this.blobDir, name));
				removed++;
			}
		}
		return removed;
	}
}
