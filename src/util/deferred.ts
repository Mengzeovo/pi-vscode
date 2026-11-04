export class Deferred<T> {
	readonly promise: Promise<T>;
	private resolveFn!: (value: T) => void;
	private rejectFn!: (error: Error) => void;
	private done = false;

	constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolveFn = resolve;
			this.rejectFn = reject;
		});
	}

	get settled(): boolean {
		return this.done;
	}

	resolve(value: T): void {
		if (!this.done) {
			this.done = true;
			this.resolveFn(value);
		}
	}

	reject(error: Error): void {
		if (!this.done) {
			this.done = true;
			this.rejectFn(error);
		}
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
