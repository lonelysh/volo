import { ItemView, WorkspaceLeaf, MarkdownRenderer, MarkdownView, Notice, TFile, Menu } from "obsidian";
import { VIEW_TYPE_CHAT, QUICK_PROMPTS, QuickPrompt } from "../constants";
import type VoloPlugin from "../main";
import { chat } from "../api/client";
import { ProviderError } from "../api/errors";
import { ChatMessage } from "../api/types";
import { search, formatHitsForLLM, SearchProvider, SearchOptions } from "../api/search";
import {
  truncateByChars,
  noteContextBlock,
  stripThinking,
  stripThinkingFully,
  applyTemplate,
} from "../utils/prompt";

interface UiMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  status?: "streaming" | "done" | "error";
}

/**
 * Volo sidebar chat view. Native DOM, no third-party framework,
 * lightweight on mobile.
 */
export class ChatView extends ItemView {
  private plugin: VoloPlugin;
  private rootEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private sessionIndicatorEl!: HTMLElement;
  private gearBtn!: HTMLButtonElement;
  private messages: UiMessage[] = [];
  private inflight: AbortController | null = null;
  private streamingOn = true;
  private insideThink = false;
  /** 当前 assistant DOM 节点（用于增量更新） */
  private currentAssistantEl: HTMLElement | null = null;
  /** 当前 assistant 累积文本 */
  private currentAssistantText = "";
  /** 联网搜索开关（仅本视图实例有效，不持久化）。 */
  private webSearchEnabled = false;
  /** quick prompt 互斥锁：避免双击导致并发请求。 */
  private quickPromptInFlight = false;

  constructor(leaf: WorkspaceLeaf, plugin: VoloPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getIcon(): string {
    return "message-square";
  }

  getDisplayText(): string {
    return "Volo Chat";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("volo-chat-root");
    this.rootEl = root;

    /* -------- 状态 -------- */
    const statusRow = root.createDiv({ cls: "volo-chat-status-row" });
    this.statusEl = statusRow.createSpan({ cls: "volo-chat-status", text: "就绪" });
    this.statusEl.style.flex = "0 0 auto";
    this.sessionIndicatorEl = statusRow.createSpan({ cls: "volo-chat-session-indicator" });
    this.sessionIndicatorEl.style.flex = "1 1 auto";
    this.sessionIndicatorEl.style.textAlign = "right";
    this.streamingOn = true;

    /* ⚙ 会话 / 联网菜单（从原 quick-row 迁移到状态行尾部） */
    this.gearBtn = statusRow.createEl("button", {
      cls: "volo-chat-quick-gear",
      attr: { "aria-label": "会话操作", title: "会话操作" },
      text: "⚙",
    });
    this.gearBtn.addEventListener("click", (ev) => this.openGearMenu(ev));

    /* -------- 消息列表 -------- */
    this.messagesEl = root.createDiv({ cls: "volo-chat-messages" });
    this.messagesEl.setAttr("role", "log");
    this.messagesEl.setAttr("aria-live", "polite");

    /* -------- 输入区 -------- */
    const inputArea = root.createDiv({ cls: "volo-chat-input-area" });

    // 文本框 + 按钮
    const composerRow = inputArea.createDiv({ cls: "volo-chat-composer-row" });

    /* ⚡ 快捷操作菜单按钮（置于 textarea 左侧） */
    const quickMenuBtn = composerRow.createEl("button", {
      cls: "volo-chat-quick-menu-btn",
      attr: { "aria-label": "快捷操作", title: "快捷操作" },
      text: "⚡",
    });
    quickMenuBtn.addEventListener("click", (ev) => this.openQuickMenu(ev));

    this.inputEl = composerRow.createEl("textarea", {
      cls: "volo-chat-input",
      attr: { placeholder: "输入消息…(Cmd/Ctrl+Enter 发送)", rows: "2" },
    });

    this.sendBtn = composerRow.createEl("button", {
      cls: "volo-btn volo-btn-primary",
      text: "发送",
      attr: { "aria-label": "发送" },
    });
    this.stopBtn = composerRow.createEl("button", {
      cls: "volo-btn volo-btn-danger",
      text: "停止",
      attr: { "aria-label": "停止生成" },
    });
    this.stopBtn.style.display = "none";

    this.inputEl.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.sendBtn.click();
      }
    });

    /* 焦点感知：focus 时让 root 获得 is-input-focused 类 */
    this.inputEl.addEventListener("focus", () => {
      this.rootEl.addClass("is-input-focused");
    });
    this.inputEl.addEventListener("blur", () => {
      this.rootEl.removeClass("is-input-focused");
    });

    this.sendBtn.addEventListener("click", () => this.handleSend());
    this.stopBtn.addEventListener("click", () => this.abort());

    this.renderAll();
  }

  async onClose(): Promise<void> {
    this.abort();
  }

  /* ---------------- 状态机 ---------------- */

  private setStatus(text: string) {
    this.statusEl.textContent = text;
  }

  private setBusy(busy: boolean) {
    this.sendBtn.style.display = busy ? "none" : "";
    this.stopBtn.style.display = busy ? "" : "none";
    this.inputEl.disabled = busy;
  }

  private abort() {
    if (this.inflight) {
      this.inflight.abort("user-stop");
      this.inflight = null;
    }
    this.setBusy(false);
    this.setStatus("已停止");
    if (this.currentAssistantEl) {
      this.currentAssistantEl.classList.remove("volo-streaming");
      this.currentAssistantEl = null;
    }
  }

  /* ---------------- 渲染 ---------------- */

  private renderAll() {
    this.messagesEl.empty();
    this.updateSessionIndicator();
    if (this.messages.length === 0) {
      this.renderEmptyQuickCards();
      return;
    }
    for (const m of this.messages) this.renderMessage(m);
    this.scrollToBottom();
  }

  /**
   * 空状态：在消息区显示一张张动作卡片，点击即触发对应的 quick prompt。
   * 如果内置 + 自定义均为空（仅全新安装无任何 QUICK_PROMPTS 时），回退到原 empty 提示文本。
   */
  private renderEmptyQuickCards() {
    const builtIn = QUICK_PROMPTS
      .map((qp) => ({ qp, source: "built-in" as const }))
      .filter(({ qp }: { qp: QuickPrompt }) => qp.label && qp.prompt);
    const custom = this.plugin.settings.customQuickPrompts
      .map((qp) => ({ qp, source: "custom" as const }))
      .filter(({ qp }: { qp: QuickPrompt }) => qp.label && qp.prompt);
    const all = [...builtIn, ...custom];

    if (all.length === 0) {
      this.messagesEl.createDiv({
        cls: "volo-empty",
        text: "从下方输入框开始与 Volo 对话。可打开一条笔记，我会自动把它作为上下文。",
      });
      return;
    }

    const wrap = this.messagesEl.createDiv({ cls: "volo-chat-empty-quick" });
    for (const { qp, source } of all) {
      const card = wrap.createEl("button", {
        cls: "volo-chat-empty-card",
        attr: { "data-source": source, "aria-label": qp.label, title: qp.prompt },
      });
      card.createSpan({ cls: "volo-chat-empty-card-icon", text: qp.icon });
      card.createSpan({ cls: "volo-chat-empty-card-label", text: qp.label });
      const desc = qp.description ?? "";
      if (desc) {
        card.createSpan({ cls: "volo-chat-empty-card-desc", text: desc });
      }
      card.createSpan({ cls: "volo-chat-empty-card-chev", text: "›" });
      card.addEventListener("click", () => this.runQuickPrompt(qp));
    }
  }

  private renderMessage(m: UiMessage): HTMLElement {
    const wrap = this.messagesEl.createDiv({
      cls: `volo-msg volo-msg-${m.role}` + (m.status === "streaming" ? " volo-streaming" : "") + (m.status === "error" ? " volo-error" : ""),
    });

    const headerRow = wrap.createDiv({ cls: "volo-msg-header" });
    headerRow.createSpan({
      cls: "volo-msg-role",
      text: m.role === "user" ? "你" : m.role === "assistant" ? "Volo" : "系统",
    });

    const body = wrap.createDiv({ cls: "volo-msg-body" });
    this.renderBody(body, m);

    if (m.role === "assistant") {
      const actions = wrap.createDiv({ cls: "volo-msg-actions volo-msg-actions-footer" });
      const copyBtn = actions.createEl("button", {
        cls: "volo-msg-action-btn",
        text: "复制",
        attr: { "aria-label": "复制本条" },
      });
      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(stripThinkingFully(m.content));
        new Notice("已复制");
      });

      const insertBtn = actions.createEl("button", {
        cls: "volo-msg-action-btn",
        text: "插入光标",
        attr: { "aria-label": "插入到当前光标位置" },
      });
      insertBtn.addEventListener("click", () => this.insertAtCursor(m.content));

      const replaceBtn = actions.createEl("button", {
        cls: "volo-msg-action-btn",
        text: "替换笔记",
        attr: { "aria-label": "替换当前笔记内容" },
      });
      replaceBtn.addEventListener("click", () => this.replaceNote(m.content));

      const appendBtn = actions.createEl("button", {
        cls: "volo-msg-action-btn",
        text: "追加末尾",
        attr: { "aria-label": "追加到笔记末尾" },
      });
      appendBtn.addEventListener("click", () => this.appendToNote(m.content));
    }
    return wrap;
  }

  private renderBody(body: HTMLElement, m: UiMessage) {
    body.empty();
    if (m.role === "assistant") {
      // 用 Obsidian 自身的 MarkdownRenderer 渲染，保证风格统一
      // 注意：sourcePath 传空串即可，因为上下文为助手消息，无 wikilink 解析需求
      void MarkdownRenderer.render(this.plugin.app, stripThinkingFully(m.content) || "▍", body, "", this.plugin);
    } else {
      body.createEl("div", { text: m.content });
    }
  }

  private appendUser(content: string) {
    if (this.messages.length === 0) {
      // 第一条消息：清掉空状态卡片，避免它和新消息堆在同一列里。
      this.messagesEl.empty();
    }
    const m: UiMessage = { role: "user", content, ts: Date.now() };
    this.messages.push(m);
    this.renderMessage(m);
    this.updateSessionIndicator();
    this.scrollToBottom();
  }

  private startAssistant() {
    const m: UiMessage = { role: "assistant", content: "", ts: Date.now(), status: "streaming" };
    this.messages.push(m);
    this.currentAssistantText = "";
    this.insideThink = false;
    this.currentAssistantEl = this.renderMessage(m);
    this.currentAssistantEl.classList.add("volo-streaming");
    this.updateSessionIndicator();
    this.scrollToBottom();
  }

  private appendDelta(delta: string) {
    const result = stripThinking(delta, this.insideThink);
    this.insideThink = result.insideThink;
    if (!this.currentAssistantEl || !result.cleaned) return;
    this.currentAssistantText += result.cleaned;
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "assistant") last.content = this.currentAssistantText;
    this.renderBody(this.currentAssistantEl.querySelector(".volo-msg-body") as HTMLElement, last!);
    this.scheduleScrollToBottom();
  }

  private finishAssistant(usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
    if (this.currentAssistantEl) {
      this.currentAssistantEl.classList.remove("volo-streaming");
      const last = this.messages[this.messages.length - 1];
      if (last) last.status = "done";
      this.currentAssistantEl = null;
    }
    if (usage) {
      this.setStatus(`完成 · ↑${usage.prompt_tokens} ↓${usage.completion_tokens} Σ${usage.total_tokens}`);
    } else {
      this.setStatus("完成");
    }
  }

  private failAssistant(e: Error) {
    if (this.currentAssistantEl) {
      this.currentAssistantEl.classList.remove("volo-streaming");
      const last = this.messages[this.messages.length - 1];
      if (last) {
        last.status = "error";
        last.content = (last.content || "") + (last.content ? "\n\n---\n" : "") + `**错误：** ${e instanceof ProviderError ? e.userMessage() : e.message}`;
        this.renderBody(this.currentAssistantEl.querySelector(".volo-msg-body") as HTMLElement, last);
      }
      this.currentAssistantEl = null;
    }
    this.setStatus(`失败 · ${e.message}`);
  }

  private scrollTimer: number | null = null;
  private scheduleScrollToBottom() {
    if (this.scrollTimer != null) return;
    this.scrollTimer = window.setTimeout(() => {
      this.scrollToBottom();
      this.scrollTimer = null;
    }, 80);
  }
  private scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /* ---------------- 发送 ---------------- */

  private async handleSend() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (!this.plugin.settings.apiKey) {
      new Notice("请先在设置中填入 API Key");
      return;
    }

    this.inputEl.value = "";
    this.appendUser(text);

    // 先建立 inflight 控制器，让搜索也能响应 stop。
    this.inflight = new AbortController();
    const signal = this.inflight.signal;

    // 上下文注入（含可选联网搜索）
    const chatMsgs: ChatMessage[] = [];
    const sys = this.plugin.settings.systemPrompt.trim();
    if (sys) chatMsgs.push({ role: "system", content: sys });
    if (this.webSearchEnabled && this.plugin.settings.webSearchProvider !== "off") {
      this.setStatus("搜索中…");
      try {
        const searchCtx = await this.maybeRunSearch(text, signal);
        if (searchCtx) chatMsgs.push({ role: "system", content: searchCtx });
      } catch (e) {
        if ((e as Error)?.name === "AbortError") {
          this.abort();
          return;
        }
        // 非 abort 错误已在 maybeRunSearch 中提示过
      }
    }
    if (this.plugin.settings.injectActiveNoteContext) {
      const active = this.plugin.app.workspace.getActiveFile();
      if (active instanceof TFile && active.extension === "md") {
        const cache = this.plugin.app.metadataCache.getFileCache(active);
        const title = active.basename;
        const body = truncateByChars(
          noteContextBlock(title, this.stripFrontmatter((await this.plugin.app.vault.cachedRead(active)) ?? "")),
          12000
        );
        if (body) chatMsgs.push({ role: "system", content: body });
        // 用 cache 仅做诊断，目前用不到 frontmatter
        void cache;
      }
    }
    for (const m of this.messages.filter((x) => x.role !== "system")) {
      chatMsgs.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
    }

    this.setBusy(true);
    this.startAssistant();
    this.setStatus("请求中…");

    try {
      await chat(chatMsgs, {
        baseUrl: this.plugin.settings.baseUrl,
        apiKey: this.plugin.settings.apiKey,
        model: this.plugin.settings.model,
        temperature: this.plugin.settings.temperature,
        maxTokens: this.plugin.settings.maxTokens,
        preferNonStream: !this.streamingOn,
        onDelta: (d) => this.appendDelta(d),
      });
      const last = this.messages[this.messages.length - 1];
      const tokens = last ? last.content.length : 0;
      this.finishAssistant();
      this.setStatus(`完成 · ${tokens} 字符`);
    } catch (e) {
      this.failAssistant(e as Error);
      if (e instanceof ProviderError) new Notice(e.userMessage());
    } finally {
      this.inflight = null;
      this.setBusy(false);
    }
  }

  /** 移除 YAML frontmatter，避免被作为系统消息回灌。 */
  private stripFrontmatter(s: string): string {
    if (!s.startsWith("---")) return s;
    const end = s.indexOf("\n---", 3);
    if (end === -1) return s;
    const after = s.indexOf("\n", end + 4);
    return after === -1 ? "" : s.slice(after + 1);
  }

  /* ---------------- 会话 / 编辑器交互 ---------------- */

  private newSession() {
    this.messages = [];
    this.renderAll();
    new Notice("已开启新会话");
  }

  private updateSessionIndicator() {
    if (!this.sessionIndicatorEl) return;
    this.sessionIndicatorEl.textContent = ` · ${this.messages.length} 条`;
  }

  private focusActiveEditor(): void {
    const view = this.findMarkdownView();
    if (!view) {
      new Notice("请先打开 Markdown 笔记");
      return;
    }
    const ws = this.plugin.app.workspace;
    ws.setActiveLeaf(view.leaf, { focus: true });
    ws.revealLeaf(view.leaf);
    new Notice("已切换到编辑器");
  }

  /**
   * 找一个 Markdown 视图：先取当前激活的，否则从所有 markdown leaf 中兜底。
   * 移动端聊天常占满全屏、没有"激活"的 md 视图，必须兜底。
   */
  private findMarkdownView(): MarkdownView | null {
    const ws = this.plugin.app.workspace;
    const active = ws.getActiveViewOfType(MarkdownView);
    if (active) return active;
    const leaves = ws.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      if (leaf.view instanceof MarkdownView) return leaf.view;
    }
    return null;
  }

  /**
   * 两段式插入：移动端聊天常常占满全屏，光标所在的笔记编辑器不可见。
   * 用户第一次点击插入按钮时，我们把目标记下来并尝试切到编辑器；
   * 用户定位光标后第二次点击同一按钮才真正执行。
   *
   * v0.2.0 已废弃：每个按钮直接执行一次，不再要求用户二次确认光标位置。
   * （保留本注释仅为 git blame 留痕。）
   */

  private async insertAtCursor(content: string): Promise<void> {
    const view = this.findMarkdownView();
    if (!view) {
      new Notice("请先打开 Markdown 笔记");
      return;
    }
    const editor = view.editor;
    const cleanContent = stripThinkingFully(content);
    const cursor = editor.getCursor();
    const original = editor.getValue();
    const lines = original.split("\n");

    const headBefore = (lines[cursor.line] ?? "").slice(0, cursor.ch);
    const headAfter = (lines[cursor.line] ?? "").slice(cursor.ch);
    const before = lines.slice(0, cursor.line);
    const after = lines.slice(cursor.line + 1);

    const prefix = before.length > 0 ? before.join("\n") + "\n" : "";
    const suffixJoiner = after.length > 0 ? "\n" : "";
    const suffix = after.join("\n");

    const newValue = prefix + headBefore + cleanContent + headAfter + suffixJoiner + suffix;
    editor.setValue(newValue);

    // 计算插入内容之后的新光标位置（行/列）
    const contentLines = cleanContent.split("\n");
    const numNewlines = Math.max(0, contentLines.length - 1);
    const lastPartLength = contentLines[contentLines.length - 1].length;
    const endsWithNewline = cleanContent.endsWith("\n");
    let newLine: number;
    let newCh: number;
    if (endsWithNewline) {
      newLine = cursor.line + numNewlines;
      newCh = 0;
    } else if (numNewlines === 0) {
      newLine = cursor.line;
      newCh = cursor.ch + cleanContent.length;
    } else {
      newLine = cursor.line + numNewlines;
      newCh = lastPartLength;
    }
    editor.setCursor({ line: newLine, ch: newCh });

    new Notice("已插入到光标位置");
  }

  private async replaceNote(content: string): Promise<void> {
    const view = this.findMarkdownView();
    if (!view) {
      new Notice("请先打开 Markdown 笔记");
      return;
    }
    view.editor.setValue(stripThinkingFully(content));
    new Notice("已替换当前笔记");
  }

  private async appendToNote(content: string): Promise<void> {
    const view = this.findMarkdownView();
    if (!view) {
      new Notice("请先打开 Markdown 笔记");
      return;
    }
    const editor = view.editor;
    const cleanContent = stripThinkingFully(content);
    const original = editor.getValue();
    let sep: string;
    if (original.length === 0) sep = "";
    else if (original.endsWith("\n\n")) sep = "";
    else if (original.endsWith("\n")) sep = "\n";
    else sep = "\n\n";
    const next = original + sep + cleanContent;
    editor.setValue(next);
    const lastLine = editor.lastLine();
    editor.setCursor({ line: lastLine, ch: editor.getLine(lastLine).length });
    new Notice("已追加到笔记末尾");
  }

  /* ---------------- 联网搜索 ---------------- */

  private toggleWebSearch() {
    this.webSearchEnabled = !this.webSearchEnabled;
    new Notice(this.webSearchEnabled ? "本次会话开启联网搜索" : "本次会话关闭联网搜索");
    if (this.webSearchEnabled) {
      const ws = this.plugin.settings;
      if (ws.webSearchProvider === "off" || (ws.webSearchProvider === "brave" && !ws.braveApiKey)) {
        new Notice("联网搜索未配置：去设置里选 provider 并填 API Key");
      }
    }
  }

  /**
   * 用 provider 跑一次搜索，返回拼好的 system 上下文块。
   * - 成功有结果：返回 markdown 块，Notice 提示用户。
   * - 成功无结果：返回空串，Notice 提示。
   * - 非 abort 失败：Notice 提示，返回空串（不阻断对话）。
   * - abort：直接抛 AbortError，由调用者统一处理。
   */
  private async maybeRunSearch(query: string, signal: AbortSignal): Promise<string> {
    const ws = this.plugin.settings;
    if (ws.webSearchProvider === "off") return "";
    const provider: SearchProvider = ws.webSearchProvider;
    const apiKey = provider === "tavily" ? ws.tavilyApiKey : ws.braveApiKey;
    try {
      const opts: SearchOptions = {
        provider,
        apiKey,
        maxResults: ws.webSearchMaxResults,
        signal,
      };
      const result = await search(query, opts);
      if (!result.hits.length) {
        new Notice("🔍 未检索到相关内容");
        return "";
      }
      new Notice(`🔍 已搜索 ${result.hits.length} 条结果`);
      return formatHitsForLLM(result.hits);
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      new Notice(`联网搜索失败：${(e as Error).message}（已自动跳过，仍可继续对话）`);
      return "";
    }
  }

  /* ---------------- Quick prompts ---------------- */

  /** ⚡ 按钮弹出的菜单：内置 + 自定义，两组用分隔线隔开。 */
  private openQuickMenu(ev: MouseEvent) {
    const menu = new Menu();
    const builtIn = QUICK_PROMPTS.filter((qp: QuickPrompt) => qp.label && qp.prompt);
    const custom = this.plugin.settings.customQuickPrompts.filter((qp: QuickPrompt) => qp.label && qp.prompt);

    for (const qp of builtIn) {
      menu.addItem((it) =>
        it.setTitle(qp.label).setIcon(qp.icon).onClick(() => this.runQuickPrompt(qp)),
      );
    }
    if (builtIn.length > 0 && custom.length > 0) {
      menu.addSeparator();
    }
    for (const qp of custom) {
      menu.addItem((it) =>
        it.setTitle(qp.label).setIcon(qp.icon).onClick(() => this.runQuickPrompt(qp)),
      );
    }

    menu.showAtMouseEvent(ev);
  }

  /** ⚙ 按钮弹出的菜单：会话级操作 + 联网搜索开关。 */
  private openGearMenu(ev: MouseEvent) {
    const menu = new Menu();
    menu.addItem((it) =>
      it.setTitle("切换到编辑器").setIcon("type").onClick(() => this.focusActiveEditor()),
    );
    menu.addItem((it) =>
      it.setTitle("新会话").setIcon("refresh-cw").onClick(() => this.newSession()),
    );
    menu.addItem((it) =>
      it
        .setTitle(this.webSearchEnabled ? "关闭联网搜索" : "开启联网搜索")
        .setIcon("search")
        .onClick(() => this.toggleWebSearch()),
    );
    menu.showAtMouseEvent(ev);
  }

  private async runQuickPrompt(qp: QuickPrompt): Promise<void> {
    if (this.quickPromptInFlight) return;
    if (this.inflight) return; // 与正常 send 互斥
    if (!this.plugin.settings.apiKey) {
      new Notice("请先在设置中填入 API Key");
      return;
    }
    this.quickPromptInFlight = true;
    try {
      // 1. 解析上下文
      let text = "";
      let note = "";
      const needsNote = qp.needsActiveNote === true || qp.context === "note";
      const needsSelection = qp.needsSelection === true || qp.context === "selection";
      if (needsNote) {
        const view = this.findMarkdownView();
        if (!view) {
          new Notice("请先打开 Markdown 笔记");
          return;
        }
        const file = view.file;
        if (!(file instanceof TFile)) {
          new Notice("请先打开 Markdown 笔记");
          return;
        }
        const raw = (await this.plugin.app.vault.cachedRead(file)) ?? "";
        note = truncateByChars(this.stripFrontmatter(raw), 12000);
      } else if (needsSelection) {
        const view = this.findMarkdownView();
        if (!view) {
          new Notice("请先打开 Markdown 笔记");
          return;
        }
        text = view.editor.getSelection();
        if (!text) {
          new Notice("请先在编辑器中选中文本");
          return;
        }
      }

      const rendered = applyTemplate(qp.prompt, { text, note });
      this.appendUser(rendered);

      // 2. 建立 inflight，准备搜索 + 发请求
      this.inflight = new AbortController();
      const signal = this.inflight.signal;

      const chatMsgs: ChatMessage[] = [];
      const sys = this.plugin.settings.systemPrompt.trim();
      if (sys) chatMsgs.push({ role: "system", content: sys });

      if (this.webSearchEnabled && this.plugin.settings.webSearchProvider !== "off") {
        this.setStatus("搜索中…");
        try {
          const searchCtx = await this.maybeRunSearch(rendered, signal);
          if (searchCtx) chatMsgs.push({ role: "system", content: searchCtx });
        } catch (e) {
          if ((e as Error)?.name === "AbortError") {
            this.abort();
            return;
          }
          // 非 abort 错误已在 maybeRunSearch 中提示过
        }
      }

      // 不再注入 active note 上下文，笔记正文已在 user prompt 里
      for (const m of this.messages.filter((x) => x.role !== "system")) {
        chatMsgs.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
      }

      this.setBusy(true);
      this.startAssistant();
      this.setStatus("请求中…");

      try {
        await chat(chatMsgs, {
          baseUrl: this.plugin.settings.baseUrl,
          apiKey: this.plugin.settings.apiKey,
          model: this.plugin.settings.model,
          temperature: this.plugin.settings.temperature,
          maxTokens: this.plugin.settings.maxTokens,
          preferNonStream: !this.streamingOn,
          onDelta: (d) => this.appendDelta(d),
          systemPromptSuffix:
            "\n\n（这是一条 quick prompt 自动发起的请求，请直接给到答案，不要加前缀说明。）",
        });
        const last = this.messages[this.messages.length - 1];
        const tokens = last ? last.content.length : 0;
        this.finishAssistant();
        this.setStatus(`完成 · ${tokens} 字符`);
      } catch (e) {
        this.failAssistant(e as Error);
        if (e instanceof ProviderError) new Notice(e.userMessage());
      } finally {
        this.inflight = null;
        this.setBusy(false);
      }
    } finally {
      this.quickPromptInFlight = false;
    }
  }
}