/**
 * 去除模型回复中的 思考过程 标签块（<think>...</think>）。
 * 流式增量到来时调用；通过返回 insideThink 状态让调用方维护跨增量的边界。
 */
export function stripThinking(
  delta: string,
  insideThink: boolean,
): { cleaned: string; insideThink: boolean } {
  let inside = insideThink;
  let out = "";
  let i = 0;
  while (i < delta.length) {
    if (inside) {
      const close = delta.indexOf("</think>", i);
      if (close === -1) {
        return { cleaned: out, insideThink: true };
      }
      i = close + "</think>".length;
      inside = false;
    } else {
      const open = delta.indexOf("<think>", i);
      if (open === -1) {
        out += delta.slice(i);
        return { cleaned: out, insideThink: false };
      }
      out += delta.slice(i, open);
      i = open + "<think>".length;
      inside = true;
    }
  }
  return { cleaned: out, insideThink: inside };
}

/** 单次清洗完整的字符串：去掉所有 <think>...</think> 块（含多块）。 */
export function stripThinkingFully(text: string): string {
  // Greedy across-line match, multiline
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/**
 * 把 {{text}} / {{note}} 占位符替换为真实输入。多行保留。
 */
export function applyTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => {
    const v = vars[key];
    if (v === undefined) return "";
    return v;
  });
}

/**
 * 截断文本到指定 token 估值下，避免触发 TPM 超限。粗略按 1 字符 ≈ 1 token 估。
 */
export function truncateByChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n...(已截断)...";
}

/**
 * 给上下文攒一条消息：把笔记路径/标题附带上去，便于模型自我定位。
 */
export function noteContextBlock(title: string, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  return `[笔记] ${title}\n\n${trimmed}`;
}
