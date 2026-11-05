import { isStaleExtensionContextError, isUnboundExtensionRuntimeError } from "../shared/extension-context.js";
import { currentHarnessScope } from "../../harness-context.js";
let mainThinkingLevelSource = () => undefined;
/** Registers where the main session's current thinking level is read; glyphs that stand for several children take its color. */
export function setMainThinkingLevelSource(source) {
    const scope = currentHarnessScope();
    if (scope) { scope.mainThinkingLevelSource = source; return; }
    mainThinkingLevelSource = source;
}
/** Reads the main session's level through `read`; a stale or not-yet-bound Pi runtime has no level to show. */
export function readMainThinkingLevel(read) {
    try {
        return read();
    }
    catch (error) {
        if (isStaleExtensionContextError(error) || isUnboundExtensionRuntimeError(error))
            return undefined;
        throw error;
    }
}
/** The running tone of a glyph: Pi's prompt-box color for the recorded level of the one child it stands for, else for the main session's current level, else accent. */
export function runningTone(theme, childLevel) {
    const level = childLevel ?? (currentHarnessScope()?.mainThinkingLevelSource ?? mainThinkingLevelSource)();
    return level ? theme.getThinkingBorderColor(level) : (text) => theme.fg("accent", text);
}
