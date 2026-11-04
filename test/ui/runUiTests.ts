import { createLayout } from "../environment";
import { runWithDriver } from "./launch";

/** 界面测试：参数为测试名称过滤条件 */
async function main(): Promise<void> {
	const runName = `ui-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	const passed = await runWithDriver({ layout: createLayout(runName), runName, suite: "ui-suite", piHarness: "source", grep: process.argv[2] });
	if (!passed) {
		process.exit(1);
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
