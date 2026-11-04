/** 解析 JSON；失败时带上来源重新抛出，不吞掉错误 */
export function parseJson<T>(text: string, source: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`无法解析来自 ${source} 的 JSON：${text.slice(0, 200)}`, { cause: error });
	}
}
