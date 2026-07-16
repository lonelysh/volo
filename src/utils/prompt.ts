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
