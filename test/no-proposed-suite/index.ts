import { runDirectory } from "../suite/index";

export function run(): Promise<void> {
	return runDirectory(__dirname);
}
