// 短显示名提取规则（会话名与 agent 卡片名共用）：取首行去首尾空白。
// ≤max 字符全取；>max 字符优先按第一个句子分隔符（中英文逗号/句号/分号/冒号/
// 问号/叹号/顿号/换行）截断取前半段，仍超 max 再截到 max；无分隔符取前 max 字符。
// 会话列表展示侧用 CSS 省略号打点，hover 由 tooltip 展示全称。
// 纯函数，供 App（创建会话时命名）与 AgentPanel（agent 卡片命名）及测试使用。

const SENTENCE_SEPARATOR = /[，。、；：？！,.;:?!\n]/u;

function shortNameFromText(content: string, max: number): string {
	const firstLine = content.split("\n", 1)[0]?.trim() ?? "";
	if (firstLine === "") {
		return "";
	}
	if (firstLine.length <= max) {
		return firstLine;
	}
	const idx = firstLine.search(SENTENCE_SEPARATOR);
	if (idx > 0) {
		const cut = firstLine.slice(0, idx).trim();
		if (cut !== "") {
			return cut.length > max ? cut.slice(0, max) : cut;
		}
	}
	return firstLine.slice(0, max);
}

export function sessionNameFromPrompt(content: string): string {
	const name = shortNameFromText(content, 20);
	return name === "" ? "新会话" : name;
}

// agent 卡片显示名：纯前端按同一规则派生（max=10）；空结果由调用方回退 agentId
export function agentNameFromTask(task: string): string {
	return shortNameFromText(task, 10);
}
