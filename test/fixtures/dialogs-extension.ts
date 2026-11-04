import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 测试用的 Pi 项目扩展：依次打开四种对话框和一个带超时的对话框，把回答写入工作目录 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("dialogs", {
		description: "依次打开 select、confirm、input、editor 和带超时的 select",
		handler: async (_args, ctx) => {
			const choice = await ctx.ui.select("Pick a fruit", ["apple", "banana"]);
			const confirmed = await ctx.ui.confirm("Proceed?", "Confirm to continue");
			const text = await ctx.ui.input("Your name", "type a name");
			const edited = await ctx.ui.editor("Edit the note", "prefilled note");
			const timed = await ctx.ui.select("Timed pick", ["left", "right"], { timeout: 6000 });
			writeFileSync(join(ctx.cwd, "dialog-answers.json"), JSON.stringify({ choice, confirmed, text, edited, timed: timed ?? null }));
		},
	});
}
