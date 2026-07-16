/**
 * Plugin-wide constants for the Volo plugin.
 * Keep model lists and defaults here so users can switch without code changes.
 */

export const PLUGIN_ID = "volo";
export const VIEW_TYPE_CHAT = "volo-chat-view";
export const VIEW_TYPE_AI_OUTLINE = "volo-ai-outline-view";

/**
 * 国内站默认 Base URL（兼容 OpenAI Chat Completions 协议）。
 * 路径前缀 `/v1`，端点 `/chat/completions`。
 * 用户可在设置中改成自建/代理/海外站。
 */
export const DEFAULT_BASE_URL = "https://api.minimaxi.com/v1";

/**
 * 国内站常用模型清单。MiniMax-M3 是当前旗舰；M2.7/M2.5 是性价比主力；
 * M2-highspeed 走极速档。模型只是下发到 API 的字符串，因此可以追加用户
 * 想要的任何字符串到设置中。
 */
export const MODEL_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  {
    value: "MiniMax-M3",
    label: "MiniMax-M3 (推荐)",
    hint: "当前旗舰 · 1M 上下文 · 多模态 · 工具调用",
  },
  {
    value: "MiniMax-M2.7",
    label: "MiniMax-M2.7",
    hint: "204K 上下文 · 自我迭代 · ~60 TPS",
  },
  {
    value: "MiniMax-M2.7-highspeed",
    label: "MiniMax-M2.7-highspeed",
    hint: "204K 上下文 · 极速档 · ~100 TPS",
  },
  {
    value: "MiniMax-M2.5",
    label: "MiniMax-M2.5",
    hint: "204K 上下文 · 性价比 · ~60 TPS",
  },
  {
    value: "MiniMax-M2.5-highspeed",
    label: "MiniMax-M2.5-highspeed",
    hint: "204K 上下文 · 极速档 · ~100 TPS",
  },
  {
    value: "MiniMax-M2.1",
    label: "MiniMax-M2.1",
    hint: "204K 上下文 · 多语言编程",
  },
  {
    value: "MiniMax-M2.1-highspeed",
    label: "MiniMax-M2.1-highspeed",
    hint: "204K 上下文 · 极速档",
  },
];

/**
 * 选中文本预设操作（命令面板中的 Quick Action）。
 * 用户也可通过自定义 prompt 写入设置中。
 */
export const SELECTION_PRESETS: Array<{ id: string; label: string; prompt: string }> = [
  {
    id: "translate-en",
    label: "翻译为英文",
    prompt: "请将下面的文本准确翻译为英文，保持 Markdown 结构与代码块不变：\n\n{{text}}",
  },
  {
    id: "translate-zh",
    label: "翻译为中文",
    prompt: "请将下面的文本准确翻译为简体中文，保持 Markdown 结构与代码块不变：\n\n{{text}}",
  },
  {
    id: "explain",
    label: "解释这段",
    prompt: "请逐句解释下面的内容，便于我这种读者理解：\n\n{{text}}",
  },
  {
    id: "summarize",
    label: "总结要点",
    prompt: "请用要点列表总结下面的内容（保留关键概念、术语、结论），不要添加未提及的信息：\n\n{{text}}",
  },
  {
    id: "rewrite-pretty",
    label: "润色改写",
    prompt: "请在不改变原意的前提下润色下面的文本，使其更通顺、更专业：\n\n{{text}}",
  },
  {
    id: "rewrite-casual",
    label: "改写更口语化",
    prompt: "请用口语化、自然的中文改写下面的文本：\n\n{{text}}",
  },
];

/**
 * 整篇笔记命令提示词模板。
 * 这些是 system prompt，会和笔记正文一起发给模型。
 */
export const NOTE_COMMAND_TEMPLATES: Record<string, { label: string; system: string }> = {
  summarize: {
    label: "总结当前笔记",
    system:
      "你是笔记助手。基于用户提供的笔记内容，输出结构化中文摘要：核心观点、关键论据、行动项（若有）。只基于原文，不要补充新事实。保持 Markdown 格式。",
  },
  outline: {
    label: "生成大纲",
    system:
      "你是笔记助手。根据用户的笔记内容生成可被复制粘贴回笔记的大纲（Markdown 层级列表），不要添加笔记中没有的主题。",
  },
  continue: {
    label: "续写笔记",
    system:
      "你是笔记助手。基于用户笔记的现有风格、术语和上下文续写一段 Markdown 内容，紧跟前文。续写内容直接以新段落开始，不要重复用户已写过的内容，也不要加任何解释。",
  },
  fix: {
    label: "修正错别字与语法",
    system:
      "你是校对助手。修正用户文本中的错别字、语法、标点问题，保持原意和段落结构不变，以 Markdown 形式输出，仅返回修正后的完整文本，不要加解释。",
  },
};

/**
 * Chat 视图里的快捷动作 chip。点击后立即拼上下文 + 发请求，
 * 不弹二次确认。和 SELECTION_PRESETS 的区别：这些是 整篇笔记/选区 + 预设 prompt，
 * 一键发起；SELECTION_PRESETS 是命令面板入口。
 */
export interface QuickPrompt {
  id: string;
  icon: string;        // emoji
  label: string;       // 2-4 Chinese chars, fits in chip
  description?: string; // 6-12 chars, shown only in empty-state cards; optional in custom prompts
  prompt: string;      // template, supports {{text}} and {{note}} via applyTemplate
  context: "note" | "selection" | "none";  // what context to pull before sending
  needsActiveNote?: boolean;
  needsSelection?: boolean;
}

export const QUICK_PROMPTS: QuickPrompt[] = [
  {
    id: "summarize-note",
    icon: "💬",
    label: "总结笔记",
    description: "生成结构化摘要",
    prompt:
      "请用结构化中文摘要以下笔记的核心观点、关键论据和行动项。仅基于原文，不要补充新事实。保持 Markdown 格式。\n\n---\n{{note}}\n---",
    context: "note",
    needsActiveNote: true,
  },
  {
    id: "outline-note",
    icon: "📝",
    label: "生成大纲",
    description: "按层级列大纲",
    prompt:
      "请为以下笔记生成 Markdown 层级列表大纲。不要添加笔记中不存在的主题。\n\n---\n{{note}}\n---",
    context: "note",
    needsActiveNote: true,
  },
  {
    id: "translate-en",
    icon: "🌐",
    label: "译为英文",
    description: "保留 Markdown",
    prompt:
      "请将下面的文本准确翻译为英文，保持 Markdown 结构与代码块不变：\n\n{{text}}",
    context: "selection",
    needsSelection: true,
  },
  {
    id: "polish",
    icon: "✨",
    label: "润色",
    description: "保留原意 + 更通顺",
    prompt:
      "请在不改变原意的前提下润色下面的文本，使其更通顺、更专业：\n\n{{text}}",
    context: "selection",
    needsSelection: true,
  },
  {
    id: "action-items",
    icon: "⚡",
    label: "找出行动项",
    description: "从笔记里挑 TODO",
    prompt:
      "从以下笔记里找出所有 TODO / 行动项 / 待办事项，按列表输出，并保留上下文。找不到就回 没有发现明确的行动项。\n\n---\n{{note}}\n---",
    context: "note",
    needsActiveNote: true,
  },
];