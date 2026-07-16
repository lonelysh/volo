import { ItemView, WorkspaceLeaf, MarkdownRenderer, MarkdownView, Notice, TFile, Menu } from "obsidian";
import { VIEW_TYPE_AI_OUTLINE } from "../constants";
import type VoloPlugin from "../main";
import { chat } from "../api/client";
import { ProviderError } from "../api/errors";
import { ChatMessage } from "../api/types";
import { search, formatHitsForLLM, SearchOptions } from "../api/search";
import {
  truncateByChars,
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

interface Section {
  file: TFile;
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * 侧边栏 AI 大纲视图：仅服务"当前 Markdown 笔记 + 章节作用域 + 内联 AI 动作"。
 * 与 ChatView 完全独立：各自的 AbortController、消息列表、搜索开关。
 */
export class AiOutlineView extends ItemView {
  private plugin: VoloPlugin;
  private rootEl!: HTMLElement;
  private outlineEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private noteLabel!: HTMLElement;
  private scopePill!: HTMLButtonElement;
  private searchBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;

  private messages: UiMessage[] = [];
  private inflight: AbortController | null = null;
  private currentAssistantEl: HTMLElement | null = null;
  private currentAssistantText = "";
  private insideThink = false;
  /** 联网搜索开关（仅本视图实例有效）。 */
  private webSearchEnabled = false;
  /** true=当前章节；false=整篇笔记。无 section 时被禁用。 */
  private scopeIsSection = true;
  /** 当前选中的章节（用户点击 heading 时更新）。 */
  private selectedSection: Section | null = null;
  /** 上一条助手消息对应的章节；用于在完成后挂"插入到笔记"按钮。 */
  private lastAssistantSection: Section | null = null;
  /** 当前大纲展示的文件。 */
  private currentNote: TFile | null = null;
  private scrollTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: VoloPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_AI_OUTLINE;
  }

  getIcon(): string {
    return "list-tree";
  }

  getDisplayText(): string {
    return "AI 大纲";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("volo-ao-root");
    this.rootEl = root;

    /* -------- 头部（标题 + ⚙） -------- */
    const header = root.createDiv({ cls: "volo-ao-header" });
    header.createSpan({ cls: "volo-ao-header-title", text: "AI 大纲" });
    const gearBtn = header.createEl("button", {
      cls: "volo-ao-gear",
      attr: { "aria-label": "操作", title: "会话操作" },
      text: "⚙",
    });
    gearBtn.addEventListener("click", (ev) => this.openGearMenu(ev));

    /* -------- 笔记标签 -------- */
    this.noteLabel = root.createDiv({ cls: "volo-ao-note-label" });
    this.noteLabel.textContent = "没有打开的笔记";

    /* -------- 大纲区域 -------- */
    this.outlineEl = root.createDiv({ cls: "volo-ao-outline" });
    this.outlineEl.setAttribute("role", "tree");

    /* -------- 对话区域 -------- */
    const chatWrap = root.createDiv({ cls: "volo-ao-chat-wrap" });

    const chatHeader = chatWrap.createDiv({ cls: "volo-ao-chat-header" });
    chatHeader.createSpan({ cls: "volo-ao-chat-scope", text: "针对" });
    this.scopePill = chatHeader.createEl("button", {
      cls: "volo-ao-scope-pill",
      attr: { "aria-label": "切换作用域", title: "切换作用域" },
      text: "当前章节 ▾",
    });
    this.scopePill.addEventListener("click", (ev) => this.openScopeMenu(ev));

    this.searchBtn = chatHeader.createEl("button", {
      cls: "volo-ao-quick-search-toggle",
      attr: { "aria-label": "联网搜索", title: "联网搜索（本次会话）" },
      text: "🔍",
    });
    this.searchBtn.addEventListener("click", () => this.toggleWebSearch(this.searchBtn));

    this.statusEl = chatHeader.createSpan({ cls: "volo-ao-status" });
    this.statusEl.textContent = "";

    this.messagesEl = chatWrap.createDiv({ cls: "volo-ao-messages" });
    this.messagesEl.setAttribute("role", "log");
    this.messagesEl.setAttribute("aria-live", "polite");

    /* -------- 输入区 -------- */
    const composerRow = chatWrap.createDiv({ cls: "volo-ao-composer" });
    this.inputEl = composerRow.createEl("textarea", {
      cls: "volo-ao-input",
      attr: { placeholder: "基于该章节提问…(Cmd/Ctrl+Enter 发送)", rows: "2" },
    });
    this.sendBtn = composerRow.createEl("button", {
      cls: "volo-ao-btn volo-ao-btn-primary",
      attr: { "aria-label": "发送" },
      text: "发送",
    });
    this.sendBtn.addEventListener("click", () => this.handleSend());

    this.inputEl.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.sendBtn.click();
      }
    });

    this.inputEl.addEventListener("focus", () => {
      this.rootEl.addClass("is-input-focused");
    });
    this.inputEl.addEventListener("blur", () => {
      this.rootEl.removeClass("is-input-focused");
    });

    /* -------- 全局事件 -------- */
    this.registerEvent(
      this.plugin.app.workspace.on("file-open", () => {
        void this.refresh();
      }),
    );
    this.registerEvent(
      this.plugin.app.metadataCache.on("changed", (file) => {
        if (this.currentNote && file === this.currentNote) {
          void this.refresh();
        }
      }),
    );

    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.abort();
  }

  /* ---------------- 状态 / 工具 ---------------- */

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  private setBusy(busy: boolean): void {
    this.sendBtn.disabled = busy;
    this.inputEl.disabled = busy;
  }

  private abort(): void {
    if (this.inflight) {
      this.inflight.abort("user-stop");
      this.inflight = null;
    }
    if (this.currentAssistantEl) {
      this.currentAssistantEl.classList.remove("volo-streaming");
      this.currentAssistantEl = null;
    }
    this.setBusy(false);
    this.setStatus("已停止");
  }

  private updateScopePill(): void {
    if (!this.scopePill) return;
    if (!this.selectedSection) {
      this.scopePill.textContent = "整篇笔记 ▾";
      this.scopePill.disabled = true;
      return;
    }
    this.scopePill.disabled = false;
    this.scopePill.textContent = this.scopeIsSection ? "当前章节 ▾" : "整篇笔记 ▾";
  }

  /* ---------------- 大纲渲染 ---------------- */

  private async refresh(): Promise<void> {
    const ws = this.plugin.app.workspace;
    const file = ws.getActiveFile();

    if (!(file instanceof TFile) || file.extension !== "md") {
      this.outlineEl.empty();
      this.outlineEl.createDiv({
        cls: "volo-ao-outline-empty",
        text: "请打开一条 Markdown 笔记",
      });
      this.selectedSection = null;
      this.currentNote = null;
      this.noteLabel.textContent = "没有打开的笔记";
      this.updateScopePill();
      return;
    }

    this.currentNote = file;
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const headings = cache?.headings ?? [];
    const fullText = (await this.plugin.app.vault.cachedRead(file)) ?? "";

    if (headings.length === 0) {
      this.noteLabel.textContent = `${file.basename} · 无标题`;
      this.outlineEl.empty();
      const whole: Section = {
        file,
        heading: file.basename,
        level: 1,
        startLine: 0,
        endLine: fullText.split("\n").length,
        text: fullText,
      };
      this.renderOutlineItem(whole, true);
      this.selectedSection = whole;
      this.updateScopePill();
      return;
    }

    this.noteLabel.textContent = `${file.basename} · ${headings.length} 个标题`;
    this.outlineEl.empty();
    const sections = computeSections(file, fullText, headings);

    // 如果之前 selectedSection 来自另一个文件，清掉
    if (this.selectedSection && this.selectedSection.file !== file) {
      this.selectedSection = null;
    }
    // 如果之前 selectedSection 在新 headings 里找不到（按 startLine），也清掉
    if (this.selectedSection) {
      const stillThere = sections.some(
        (s) => s.startLine === this.selectedSection!.startLine && s.heading === this.selectedSection!.heading,
      );
      if (!stillThere) this.selectedSection = null;
    }

    for (const s of sections) this.renderOutlineItem(s, false);

    // 默认选中第一节（首个 heading）
    if (!this.selectedSection && sections.length > 0) {
      this.selectedSection = sections[0];
    }
    // 重新标记 is-selected
    if (this.selectedSection) {
      const items = this.outlineEl.querySelectorAll(".volo-ao-outline-item");
      items.forEach((el) => {
        const hl = el.querySelector(".volo-ao-outline-item-heading");
        if (hl && hl.textContent && this.selectedSection &&
            (el as HTMLElement).dataset["start"] === String(this.selectedSection.startLine)) {
          el.classList.add("is-selected");
        }
      });
    }
    this.updateScopePill();
  }

  private renderOutlineItem(section: Section, isWhole: boolean): void {
    const indentPx = Math.max(0, section.level - 1) * 12;
    const item = this.outlineEl.createDiv({ cls: "volo-ao-outline-item" });
    item.setAttribute("role", "treeitem");
    item.dataset["start"] = String(section.startLine);
    if (this.selectedSection && this.selectedSection.startLine === section.startLine) {
      item.classList.add("is-selected");
    }

    const headingBtn = item.createDiv({ cls: "volo-ao-outline-item-heading" });
    headingBtn.textContent = (isWhole ? "📄 " : "") + section.heading;
    if (indentPx > 0) headingBtn.style.paddingLeft = `${indentPx}px`;
    headingBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.selectSection(section);
    });

    const actions = item.createDiv({ cls: "volo-ao-outline-item-actions" });

    const summarizeChip = actions.createEl("button", {
      cls: "volo-ao-chip",
      attr: { "aria-label": "总结", title: "总结此章节" },
      text: "💬",
    });
    summarizeChip.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.runSectionAction("summarize", section);
    });

    const translateChip = actions.createEl("button", {
      cls: "volo-ao-chip",
      attr: { "aria-label": "翻译为英文", title: "翻译为英文" },
      text: "🌐",
    });
    translateChip.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.runSectionAction("translate", section);
    });

    const polishChip = actions.createEl("button", {
      cls: "volo-ao-chip",
      attr: { "aria-label": "润色", title: "润色此章节" },
      text: "✨",
    });
    polishChip.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.runSectionAction("polish", section);
    });
  }

  private async selectSection(section: Section): Promise<void> {
    this.selectedSection = section;

    // 刷新选中态（直接操作 DOM，避免重渲染整个大纲丢失滚动位置）
    const items = this.outlineEl.querySelectorAll(".volo-ao-outline-item");
    items.forEach((el) => {
      const startAttr = (el as HTMLElement).dataset["start"];
      if (startAttr === String(section.startLine)) {
        el.classList.add("is-selected");
      } else {
        el.classList.remove("is-selected");
      }
    });

    // 滚动到对应编辑器位置
    const view = this.findMarkdownView();
    if (view && view.file === section.file) {
      const editor = view.editor;
      const targetLine = Math.min(section.startLine, editor.lastLine());
      editor.setCursor({ line: targetLine, ch: 0 });
      editor.focus();
    }
    this.updateScopePill();
  }

  /* ---------------- 消息渲染 ---------------- */

  private renderMessage(m: UiMessage): HTMLElement {
    const wrap = this.messagesEl.createDiv({
      cls:
        `volo-ao-msg volo-ao-msg-${m.role}` +
        (m.status === "streaming" ? " volo-streaming" : "") +
        (m.status === "error" ? " volo-ao-msg-error" : ""),
    });
    const headerRow = wrap.createDiv({ cls: "volo-ao-msg-header" });
    headerRow.createSpan({
      cls: "volo-ao-msg-role",
      text: m.role === "user" ? "你" : m.role === "assistant" ? "Volo" : "系统",
    });

    const body = wrap.createDiv({ cls: "volo-ao-msg-body" });
    this.renderBody(body, m);
    return wrap;
  }

  private renderBody(body: HTMLElement, m: UiMessage): void {
    body.empty();
    if (m.role === "assistant") {
      const text = stripThinkingFully(m.content) || "▍";
      void MarkdownRenderer.render(this.plugin.app, text, body, "", this.plugin);
    } else {
      body.createEl("div", { text: m.content });
    }
  }

  private appendUser(content: string): void {
    if (this.messages.length === 0) {
      this.messagesEl.empty();
    }
    const m: UiMessage = { role: "user", content, ts: Date.now() };
    this.messages.push(m);
    this.renderMessage(m);
    this.scrollToBottom();
  }

  private startAssistant(): void {
    const m: UiMessage = {
      role: "assistant",
      content: "",
      ts: Date.now(),
      status: "streaming",
    };
    this.messages.push(m);
    this.currentAssistantText = "";
    this.insideThink = false;
    this.currentAssistantEl = this.renderMessage(m);
    this.currentAssistantEl.classList.add("volo-streaming");

    // 如果上一轮 chip 触发的，就挂"插入到笔记"
    if (this.lastAssistantSection) {
      const section = this.lastAssistantSection;
      const actions = this.currentAssistantEl.createDiv({
        cls: "volo-ao-msg-actions",
      });
      const btn = actions.createEl("button", {
        cls: "volo-ao-insert-btn",
        attr: { "aria-label": "插入到笔记", title: "插入到笔记对应章节" },
        text: "📥 插入到笔记",
      });
      btn.addEventListener("click", () => {
        const last = this.messages[this.messages.length - 1];
        void this.insertAssistantIntoNote(last?.content ?? "", section);
      });
      this.lastAssistantSection = null;
    }
    this.scrollToBottom();
  }

  private appendDelta(delta: string): void {
    const result = stripThinking(delta, this.insideThink);
    this.insideThink = result.insideThink;
    if (!this.currentAssistantEl || !result.cleaned) return;
    this.currentAssistantText += result.cleaned;
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "assistant") last.content = this.currentAssistantText;
    this.renderBody(
      this.currentAssistantEl.querySelector(".volo-ao-msg-body") as HTMLElement,
      last!,
    );
    this.scheduleScrollToBottom();
  }

  private finishAssistant(): void {
    if (this.currentAssistantEl) {
      this.currentAssistantEl.classList.remove("volo-streaming");
      const last = this.messages[this.messages.length - 1];
      if (last) last.status = "done";
      this.currentAssistantEl = null;
    }
    this.setStatus("完成");
  }

  private failAssistant(e: Error): void {
    if (this.currentAssistantEl) {
      this.currentAssistantEl.classList.remove("volo-streaming");
      const last = this.messages[this.messages.length - 1];
      if (last) {
        last.status = "error";
        const msg = e instanceof ProviderError ? e.userMessage() : e.message;
        last.content = (last.content || "") +
          (last.content ? "\n\n---\n" : "") +
          `**错误：** ${msg}`;
        this.renderBody(
          this.currentAssistantEl.querySelector(".volo-ao-msg-body") as HTMLElement,
          last,
        );
      }
      this.currentAssistantEl = null;
    }
    this.setStatus(`失败 · ${e.message}`);
  }

  private scheduleScrollToBottom(): void {
    if (this.scrollTimer != null) return;
    this.scrollTimer = window.setTimeout(() => {
      this.scrollToBottom();
      this.scrollTimer = null;
    }, 80);
  }

  private scrollToBottom(): void {
    if (!this.messagesEl) return;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /* ---------------- 发送 ---------------- */

  private async handleSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (this.inflight) {
      new Notice("请等待当前请求完成");
      return;
    }
    if (!this.plugin.settings.apiKey) {
      new Notice("请先在设置中填入 API Key");
      return;
    }

    this.inputEl.value = "";
    this.appendUser(text);

    this.inflight = new AbortController();
    const signal = this.inflight.signal;

    await this.dispatchChat(text, signal);

    if (this.inflight) {
      this.inflight = null;
      this.setBusy(false);
    }
  }

  private async runSectionAction(
    kind: "summarize" | "translate" | "polish",
    section: Section,
  ): Promise<void> {
    if (this.inflight) {
      new Notice("请等待当前请求完成");
      return;
    }
    if (!this.plugin.settings.apiKey) {
      new Notice("请先在设置中填入 API Key");
      return;
    }

    let tpl: string;
    if (kind === "summarize") {
      tpl = "请对以下章节生成结构化中文摘要（核心观点、关键论据、行动项），仅基于原文：\n\n---\n{{text}}\n---";
    } else if (kind === "translate") {
      tpl = "请将以下文本准确翻译为英文，保持 Markdown 结构与代码块不变：\n\n{{text}}";
    } else {
      tpl = "请在不改变原意的前提下润色以下文本，使其更通顺、更专业：\n\n{{text}}";
    }
    const userText = applyTemplate(tpl, { text: section.text });

    // 记录：assistant 完成后挂"插入到笔记"
    this.lastAssistantSection = section;
    this.selectedSection = section;
    this.updateScopePill();

    this.appendUser(userText);

    this.inflight = new AbortController();
    const signal = this.inflight.signal;

    await this.dispatchChat(section.heading, signal);

    if (this.inflight) {
      this.inflight = null;
      this.setBusy(false);
    }
  }

  /**
   * 共享的发请求流程：搜索 + 系统提示 + 历史消息 + 流式。
   * 用户消息已经在 messages 里（最后一条）。contextKind 决定是否注入 section/note 上下文。
   */
  private async dispatchChat(queryForSearch: string, signal: AbortSignal): Promise<void> {
    const chatMsgs: ChatMessage[] = [];
    const sys = this.plugin.settings.systemPrompt.trim();
    if (sys) chatMsgs.push({ role: "system", content: sys });

    if (this.webSearchEnabled && this.plugin.settings.webSearchProvider !== "off") {
      this.setStatus("搜索中…");
      try {
        const searchCtx = await this.maybeRunSearch(queryForSearch, signal);
        if (searchCtx) chatMsgs.push({ role: "system", content: searchCtx });
      } catch (e) {
        if ((e as Error)?.name === "AbortError") {
          this.abort();
          return;
        }
        // 非 abort 错误已在 maybeRunSearch 中提示过
      }
    }

    // 作用域上下文：当前章节 / 整篇笔记 / 无（仅 chat-only）
    const file = this.currentNote;
    if (!file) {
      new Notice("请先打开笔记以便 AI 引用");
    } else if (this.scopeIsSection && this.selectedSection && this.selectedSection.file === file) {
      const s = this.selectedSection;
      chatMsgs.push({
        role: "system",
        content: `[笔记 ${file.basename}] 章节 "${s.heading}"\n\n${s.text}`,
      });
    } else {
      const raw = (await this.plugin.app.vault.cachedRead(file)) ?? "";
      const body = truncateByChars(raw, 12000);
      chatMsgs.push({
        role: "system",
        content: `[笔记] ${file.basename}\n\n${body}`,
      });
    }

    for (const m of this.messages.filter((x) => x.role !== "system")) {
      chatMsgs.push({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      });
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
        onDelta: (d) => this.appendDelta(d),
      });
      this.finishAssistant();
    } catch (e) {
      this.failAssistant(e as Error);
      if (e instanceof ProviderError) new Notice(e.userMessage());
    }
  }

  /* ---------------- 编辑器交互 ---------------- */

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

  private async insertAssistantIntoNote(content: string, section: Section): Promise<void> {
    const view = this.findMarkdownView();
    if (!view) {
      new Notice("请先打开 Markdown 笔记");
      return;
    }
    if (view.file !== section.file) {
      new Notice("当前笔记与章节不一致，已取消插入");
      return;
    }
    const editor = view.editor;
    const cleanContent = stripThinkingFully(content);
    if (!cleanContent) {
      new Notice("回复为空，无可插入内容");
      return;
    }
    const totalLines = editor.lastLine() + 1;
    const startLine = Math.min(Math.max(section.startLine, 0), totalLines);
    const endLine = Math.min(Math.max(section.endLine, startLine), totalLines);
    const orig = editor.getValue();
    const lines = orig.split("\n");
    const newLines = [
      ...lines.slice(0, startLine),
      ...cleanContent.split("\n"),
      ...lines.slice(endLine),
    ];
    editor.setValue(newLines.join("\n"));
    new Notice("已插入到笔记");
  }

  /* ---------------- 联网搜索 ---------------- */

  private toggleWebSearch(btn: HTMLButtonElement): void {
    this.webSearchEnabled = !this.webSearchEnabled;
    btn.classList.toggle("is-active", this.webSearchEnabled);
    new Notice(this.webSearchEnabled ? "本次会话开启联网搜索" : "本次会话关闭联网搜索");
    if (this.webSearchEnabled) {
      const cfg = this.plugin.settings;
      if (
        cfg.webSearchProvider === "off" ||
        (cfg.webSearchProvider === "brave" && !cfg.braveApiKey)
      ) {
        new Notice("联网搜索未配置：去设置里选 provider 并填 API Key");
      }
    }
  }

  private async maybeRunSearch(query: string, signal: AbortSignal): Promise<string> {
    const cfg = this.plugin.settings;
    if (cfg.webSearchProvider === "off") return "";
    const provider = cfg.webSearchProvider;
    const apiKey =
      provider === "tavily" ? cfg.tavilyApiKey : cfg.braveApiKey;
    try {
      const opts: SearchOptions = {
        provider,
        apiKey,
        maxResults: cfg.webSearchMaxResults,
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

  /* ---------------- 菜单 ---------------- */

  private openScopeMenu(ev: MouseEvent): void {
    if (this.scopePill.disabled) return;
    const menu = new Menu();
    menu.addItem((it) =>
      it
        .setTitle("当前章节")
        .setIcon("heading-1")
        .onClick(() => {
          this.scopeIsSection = true;
          this.updateScopePill();
        }),
    );
    menu.addItem((it) =>
      it
        .setTitle("整篇笔记")
        .setIcon("file-text")
        .onClick(() => {
          this.scopeIsSection = false;
          this.updateScopePill();
        }),
    );
    menu.showAtMouseEvent(ev);
  }

  private openGearMenu(ev: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((it) =>
      it
        .setTitle("新会话")
        .setIcon("refresh-cw")
        .onClick(() => this.newSession()),
    );
    menu.addItem((it) =>
      it
        .setTitle("切换到编辑器")
        .setIcon("type")
        .onClick(() => this.focusActiveEditor()),
    );
    menu.addItem((it) =>
      it
        .setTitle("在此处插入")
        .setIcon("corner-down-left")
        .onClick(() => this.insertLastAssistant()),
    );
    menu.addSeparator();
    menu.addItem((it) =>
      it
        .setTitle(this.webSearchEnabled ? "关闭联网搜索" : "开启联网搜索")
        .setIcon("search")
        .onClick(() => this.toggleWebSearch(this.searchBtn)),
    );
    menu.showAtMouseEvent(ev);
  }

  private newSession(): void {
    if (this.inflight) {
      new Notice("请先停止当前请求");
      return;
    }
    this.messages = [];
    this.messagesEl.empty();
    this.lastAssistantSection = null;
    new Notice("已开启新会话");
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
   * 把最近一条 assistant 消息插入到其对应章节。
   * 用于 gear 菜单里"在此处插入"，对所有 assistant 消息都尝试；
   * 只有那些挂过 lastAssistantSection 的（即 chip 触发的）才能命中。
   */
  private insertLastAssistant(): void {
    if (!this.lastAssistantSection) {
      new Notice("最近一条助手消息没有可关联的章节；请用 chip 触发后再试。");
      return;
    }
    const section = this.lastAssistantSection;
    const last = this.messages[this.messages.length - 1];
    void this.insertAssistantIntoNote(last?.content ?? "", section);
  }
}

/* ---------------- helpers ---------------- */

interface HeadingsCacheEntry {
  heading: string;
  level: number;
  position: { start: { line: number } };
}

function computeSections(
  file: TFile,
  content: string,
  headings: HeadingsCacheEntry[],
): Section[] {
  const lines = content.split("\n");
  if (headings.length === 0) {
    return [
      {
        file,
        heading: file.basename,
        level: 1,
        startLine: 0,
        endLine: lines.length,
        text: content,
      },
    ];
  }
  return headings.map((h, i) => {
    const startLine = h.position.start.line;
    const endLine =
      i + 1 < headings.length ? headings[i + 1].position.start.line : lines.length;
    const text = lines.slice(startLine, endLine).join("\n");
    return {
      file,
      heading: h.heading,
      level: h.level,
      startLine,
      endLine,
      text,
    };
  });
}
