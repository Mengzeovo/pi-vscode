import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Mocha from "mocha";

interface TestOutcome {
	readonly title: string;
	readonly state: "passed" | "failed";
	readonly durationMs: number | undefined;
	readonly error: string | undefined;
}

/**
 * 运行 dir 目录中的 *.test.js。PI_HARNESS_TEST_GREP 过滤测试名称；
 * PI_HARNESS_TEST_RESULTS 指定时把每个测试的结果写入该文件（界面测试由驱动扩展启动，没有测试运行器的输出）。
 */
export function runDirectory(dir: string): Promise<void> {
	const mocha = new Mocha({ ui: "bdd", timeout: 15 * 60_000, color: false });
	const grep = process.env.PI_HARNESS_TEST_GREP;
	if (grep !== undefined) {
		mocha.grep(grep);
	}
	for (const name of readdirSync(dir).filter((file) => file.endsWith(".test.js")).sort()) {
		mocha.addFile(join(dir, name));
	}
	const outcomes: TestOutcome[] = [];
	const resultsFile = process.env.PI_HARNESS_TEST_RESULTS;
	const record = (outcome: TestOutcome): void => {
		outcomes.push(outcome);
		if (resultsFile !== undefined) writeFileSync(resultsFile, JSON.stringify(outcomes, null, 2));
	};
	return new Promise((resolve, reject) => {
		const runner = mocha.run((failures) => {
			if (resultsFile !== undefined) {
				writeFileSync(resultsFile, JSON.stringify(outcomes, null, 2));
			}
			if (runner.stats?.tests === 0) {
				reject(new Error("没有执行任何测试，请检查测试名称和构建结果"));
			} else if (failures > 0) {
				reject(new Error(`${failures} 个测试失败`));
			} else {
				resolve();
			}
		});
		runner.on("pass", (test) => record({ title: test.fullTitle(), state: "passed", durationMs: test.duration, error: undefined }));
		runner.on("fail", (test, error: Error) => record({ title: test.fullTitle(), state: "failed", durationMs: test.duration, error: error.stack ?? String(error) }));
	});
}

export function run(): Promise<void> {
	return runDirectory(__dirname);
}
