import { ItemView, WorkspaceLeaf, MarkdownRenderer, MarkdownView, Notice, TFile, TFolder, Menu } from "obsidian";
import { VIEW_TYPE_CHAT, QUICK_PROMPTS, QuickPrompt } from "../constants";
import type VoloPlugin from "../main";
import { chat } from "../api/client";
import { ProviderError } from "../api/errors";
import { ChatMessage } from "../api/types";
import { search, formatHitsForLLM, SearchProvider, SearchOptions } from "../api/search";
import { FolderSuggestModal } from "./FolderSuggestModal";
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
  private gearBtn!: HTMLButtonElement;
  private messages: UiMessage[] = [];
  private inflight: AbortController | null = null;
  private streamingOn = true;
  private contextRefreshTimer: number | null = null;
  private insideThink = false;
  /** 当前 assistant DOM 节点（用于增量更新） */
  private currentAssistantEl: HTMLElement | null = null;
  /** 当前 assistant 累积文本 */
  private currentAssistantText = "";
  /** 联网搜索开关（仅本视图实例有效，不持久化）。 */
  private webSearchEnabled = false;
  /** 顶栏 pill 簇容器（v0.1.3；承载 🔍 联网 / ⚡ 快捷两颗 pill）。 */
  private pillCluster!: HTMLElement;
  /** 联网搜索 pill（v0.1.3：移至顶栏 pillCluster 中）。 */
  private searchPill!: HTMLButtonElement;
  /** 快捷提示 pill（v0.1.3：移至顶栏 pillCluster 中）。 */
  private quickMenuPill!: HTMLButtonElement;
  /** v0.1.6：context row（Beneath the composer）：three inline chips。 */
  private contextRowEl!: HTMLElement;
  private contextFileChipEl!: HTMLElement;
  private contextFolderChipEl!: HTMLElement;
  private contextDetailsEl!: HTMLElement;
  /** v0.1.6：当前上下文范围（file = 当前笔记 / folder = contextFolder）。 */
  private contextScope: "file" | "folder" = "file";
  /** v0.1.6：选中的文件夹（folder scope 才有值）。 */
  private contextFolder: TFolder | null = null;
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

    /* -------- 顶部状态条：Volo + 🔍/⚡ pills + ⚙ -------- */
    const topBar = root.createDiv({ cls: "volo-chat-top-bar" });
    this.statusEl = topBar.createSpan({ cls: "volo-chat-brand", text: "Volo" });

    /* v0.1.4 pill 簇（v0.1.6 移除 folder/Obsidian pill，仅保留联网 / 快捷）。 */
    this.pillCluster = topBar.createDiv({ cls: "volo-pill-cluster" });

    /* 🔍 联网搜索 pill（toggle，激活时获得 .is-active） */
    this.searchPill = this.pillCluster.createEl("button", {
      cls: "volo-pill",
      attr: { "aria-label": "联网搜索", title: "联网搜索：本次会话" },
    });
    this.searchPill.createSpan({ cls: "volo-pill-icon", text: "🔍" });
    this.searchPill.createSpan({ cls: "volo-pill-label", text: "联网" });
    this.searchPill.addEventListener("click", () => this.toggleWebSearch(this.searchPill));

    /* ⚡ 快捷提示 pill（非 toggle：点击弹出快捷菜单） */
    this.quickMenuPill = this.pillCluster.createEl("button", {
      cls: "volo-pill",
      attr: { "aria-label": "快捷操作", title: "快捷操作" },
    });
    this.quickMenuPill.createSpan({ cls: "volo-pill-icon", text: "⚡" });
    this.quickMenuPill.createSpan({ cls: "volo-pill-label", text: "快捷" });
    this.quickMenuPill.addEventListener("click", (ev) => this.openQuickMenu(ev));

    /* ⚙ 会话菜单（保留在状态行尾部） */
    this.gearBtn = topBar.createEl("button", {
      cls: "volo-chat-quick-gear",
      attr: { "aria-label": "会话操作", title: "会话操作" },
      text: "⚙",
    });
    this.gearBtn.addEventListener("click", (ev) => this.openGearMenu(ev));

    this.refreshContextRow();
    this.registerEvent(this.plugin.app.workspace.on("file-open", () => this.refreshContextRow()));
    this.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => this.refreshContextRow()));
    this.startContextRefresh();

    this.streamingOn = true;

    /* -------- 消息列表 -------- */
    this.messagesEl = root.createDiv({ cls: "volo-chat-messages" });
    this.messagesEl.setAttr("role", "log");
    this.messagesEl.setAttr("aria-live", "polite");

    /* -------- 输入区 -------- */
    const inputArea = root.createDiv({ cls: "volo-chat-input-area" });

    // v0.1.3 — composer 行只剩 textarea + 发送/停止。pill 已挪到顶栏。
    const composerRow = inputArea.createDiv({ cls: "volo-chat-composer-row" });

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

    /* v0.1.6 — context row（位于 composer 下方）：
     *   file chip + folder chip + line details，11px 紧凑行。
     */
    const contextRow = inputArea.createDiv({ cls: "volo-chat-context-row" });
    this.contextRowEl = contextRow;
    this.contextFileChipEl = contextRow.createSpan({ cls: "volo-context-chip" });
    this.contextFolderChipEl = contextRow.createSpan({ cls: "volo-context-chip" });
    this.contextDetailsEl = contextRow.createSpan({ cls: "volo-context-details" });
    this.contextFileChipEl.addEventListener("click", () => this.switchContextScope("file"));
    this.contextFolderChipEl.addEventListener("click", () => this.openFolderPicker());

    this.renderAll();
  }

  async onClose(): Promise<void> {
    this.stopContextRefresh();
    this.abort();
  }

  /* ---------------- 状态机 ---------------- */

  private setStatus(text: string) {
    // The compact top bar is branded as Volo; retain operation status for diagnostics
    // without replacing the brand label.
    if (this.statusEl) this.statusEl.setAttribute("data-status", text);
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
      insertBtn.addEventListener("click", () => this.insertAssistantAtCursor(m.content));

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
    this.scrollToBottom();
  }

  private startAssistant() {
    const m: UiMessage = { role: "assistant", content: "", ts: Date.now(), status: "streaming" };
    this.messages.push(m);
    this.currentAssistantText = "";
    this.insideThink = false;
    this.currentAssistantEl = this.renderMessage(m);
    this.currentAssistantEl.classList.add("volo-streaming");
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
    if (this.plugin.settings.injectActiveNoteContext || this.contextScope === "folder") {
      const ctx = await this.getCurrentContextText();
      if (ctx.source) {
        const title = ctx.noteTitle || "笔记";
        const body = truncateByChars(
          noteContextBlock(title, ctx.source),
          12000
        );
        if (body) chatMsgs.push({ role: "system", content: body });
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

  /**
   * v0.1.6 — 刷新 context row 内的三个 chip / details。
   * 由 file-open / active-leaf-change / 1s polling 触发。
   */
  private refreshContextRow(): void {
    const ws = this.plugin.app.workspace;
    const file = ws.getActiveFile();

    if (!file || !(file instanceof TFile)) {
      this.contextFileChipEl.textContent = "无文件";
      this.contextFileChipEl.removeClass("is-active");
      this.contextFolderChipEl.textContent = "📁 选文件夹";
      this.contextFolderChipEl.removeClass("is-active");
      this.contextDetailsEl.textContent = "";
      return;
    }

    // File chip
    this.contextFileChipEl.textContent = file.basename;
    if (this.contextScope === "file") {
      this.contextFileChipEl.addClass("is-active");
    } else {
      this.contextFileChipEl.removeClass("is-active");
    }

    // Folder chip
    if (this.contextFolder && this.contextScope === "folder") {
      const files = this.contextFolder.children.filter((c) => c instanceof TFile).length;
      this.contextFolderChipEl.textContent = `📁 ${this.contextFolder.name} (${files} 个文件)`;
      this.contextFolderChipEl.addClass("is-active");
      this.contextDetailsEl.textContent = "已切换到文件夹范围";
    } else {
      this.contextFolderChipEl.textContent = "📁 选文件夹";
      this.contextFolderChipEl.removeClass("is-active");
      if (this.contextScope === "folder") {
        this.contextDetailsEl.textContent = "请选择一个文件夹";
      } else {
        this.contextDetailsEl.textContent = "默认当前笔记";
      }
    }

    // Line range details (overrides when active markdown view has a selection)
    const view = ws.getActiveViewOfType(MarkdownView);
    const editor = view?.editor;
    if (editor) {
      const sel = editor.getSelection();
      if (sel && sel.trim().length > 0) {
        const from = editor.getCursor("from");
        const to = editor.getCursor("to");
        const lineCount = Math.abs(to.line - from.line) + 1;
        this.contextDetailsEl.textContent = `Line${from.line + 1}-Line${to.line + 1}, ${lineCount}Lines`;
      }
    }
  }

  /** v0.1.6 — 切换上下文范围。点击 file chip 时切回 file 并清空 folder。 */
  private switchContextScope(scope: "file" | "folder"): void {
    if (scope === "file") {
      this.contextScope = "file";
      this.contextFolder = null;
      new Notice("已切换到当前笔记");
    } else {
      this.contextScope = "folder";
      if (!this.contextFolder) {
        new Notice("请点击文件夹按钮选择一个");
        return;
      }
    }
    this.refreshContextRow();
  }

  /** v0.1.6 — 打开文件夹选择 modal；选完同步刷新 context row。 */
  private openFolderPicker(): void {
    new FolderSuggestModal(this.plugin.app, (folder) => {
      if (folder) {
        this.contextFolder = folder;
        this.contextScope = "folder";
        new Notice(`📁 ${folder.path}`);
      }
      this.refreshContextRow();
    }).open();
  }

  /**
   * v0.1.6 — 单一上下文来源（handleSend / runQuickPrompt 共用）：
   *   - folder 范围：拼接 contextFolder 下所有 .md 文件，标题做分隔。
   *   - file 范围：返回当前激活笔记（frontmatter 已剥）。
   */
  private async getCurrentContextText(): Promise<{ source: string; noteTitle: string }> {
    if (this.contextScope === "folder" && this.contextFolder) {
      const mdFiles = this.contextFolder.children.filter(
        (c): c is TFile => c instanceof TFile && c.extension === "md",
      );
      const parts: string[] = [];
      for (const f of mdFiles) {
        const body = (await this.plugin.app.vault.cachedRead(f)) ?? "";
        parts.push(`# ${f.basename}\n\n${this.stripFrontmatter(body)}`);
      }
      return { source: parts.join("\n\n---\n\n"), noteTitle: this.contextFolder.name };
    }
    const file = this.plugin.app.workspace.getActiveFile();
    if (file instanceof TFile) {
      const body = (await this.plugin.app.vault.cachedRead(file)) ?? "";
      const active = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
      const sel = active?.editor?.getSelection();
      const trimmed = sel && sel.trim().length > 0
        ? this.stripFrontmatter(body)
        : this.stripFrontmatter(body);
      return { source: trimmed, noteTitle: file.basename };
    }
    return { source: "", noteTitle: "" };
  }

  private startContextRefresh(): void {
    if (this.contextRefreshTimer !== null) return;
    this.contextRefreshTimer = window.setInterval(() => this.refreshContextRow(), 1000);
  }

  private stopContextRefresh(): void {
    if (this.contextRefreshTimer !== null) {
      window.clearInterval(this.contextRefreshTimer);
      this.contextRefreshTimer = null;
    }
  }

  private insertAtCursor(text: string): void {
    const input = this.inputEl;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const value = input.value;
    input.value = value.slice(0, start) + text + value.slice(end);
    if (text === "```\n\n```") {
      const caret = start + 4;
      input.selectionStart = input.selectionEnd = caret;
    } else {
      const caret = start + text.length;
      input.selectionStart = input.selectionEnd = caret;
    }
    input.focus();
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

  private async insertAssistantAtCursor(content: string): Promise<void> {
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
    const file = view.file;
    if (!(file instanceof TFile)) {
      new Notice("请先打开 Markdown 笔记");
      return;
    }
    const currentValue = view.editor.getValue();
    // Detect whether the file already has an H1 title (# ...) anywhere.
    const hasH1 = /^#\s+\S+/m.test(currentValue);

    let finalContent = content;
    if (!hasH1) {
      // No title in the original — prepend one based on the file name.
      finalContent = `# ${file.basename}\n\n${content}`;
    }

    view.editor.setValue(finalContent);
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

  /**
   * v0.1.6：notice 短化（不挡顶栏），pill 颜色变化为主反馈。
   */
  private toggleWebSearch(btn: HTMLButtonElement): void {
    this.webSearchEnabled = !this.webSearchEnabled;
    btn.toggleClass("is-active", this.webSearchEnabled);
    if (this.webSearchEnabled) {
      const cfg = this.plugin.settings;
      if (cfg.webSearchProvider === "off" || (cfg.webSearchProvider === "brave" && !cfg.braveApiKey)) {
        new Notice("联网未配置：去设置里选 provider");
      } else {
        new Notice("联网：开");
      }
    } else {
      new Notice("联网：关");
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

  /** ⚙ 按钮弹出的菜单：会话级操作（联网搜索改由顶栏 🔍 pill 控制，v0.1.3）。 */
  private openGearMenu(ev: MouseEvent) {
    const menu = new Menu();
    menu.addItem((it) =>
      it.setTitle("切换到编辑器").setIcon("type").onClick(() => this.focusActiveEditor()),
    );
    menu.addItem((it) =>
      it.setTitle("新会话").setIcon("refresh-cw").onClick(() => this.newSession()),
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
      // v0.1.7：noteTitle / noteFileCount 用于把"已注入笔记/文件夹"的提示渲染到可见气泡，
      //           同时给系统消息里的 [笔记] {title} 提供标题，避免文件名被丢弃。
      let noteTitle = "";
      let noteFileCount = 0;
      const needsNote = qp.needsActiveNote === true || qp.context === "note";
      const needsSelection = qp.needsSelection === true || qp.context === "selection";
      // v0.1.6：folder scope 强制覆盖 note 来源；其它情况维持既有逻辑。
      if (this.contextScope === "folder") {
        const ctx = await this.getCurrentContextText();
        note = truncateByChars(ctx.source, 12000);
        noteTitle = ctx.noteTitle || (this.contextFolder ? this.contextFolder.name : "文件夹");
        if (this.contextFolder) {
          noteFileCount = this.contextFolder.children.filter(
            (c): c is TFile => c instanceof TFile && c.extension === "md",
          ).length;
        }
      } else if (needsNote) {
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
        noteTitle = file.basename;
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

      // v0.1.7：可见气泡只显示 prompt 模板 + 紧凑 chip，绝不内联笔记正文。
      //         笔记正文通过下面的系统消息通道送给模型（见 chatMsgs 构造处）。
      //         {{text}} 保留：用户选中的文本是用户的动作，理应在气泡里可见。
      let visibleNotePlaceholder = "";
      if (note) {
        if (this.contextScope === "folder" && this.contextFolder) {
          visibleNotePlaceholder = `📎 已注入文件夹：${this.contextFolder.name}（${noteFileCount} 个文件）`;
        } else if (noteTitle) {
          visibleNotePlaceholder = `📎 已注入笔记：${noteTitle}（${note.length} 字）`;
        } else {
          visibleNotePlaceholder = `📎 已注入笔记（${note.length} 字）`;
        }
      }

      const rendered = applyTemplate(qp.prompt, { text, note: visibleNotePlaceholder });
      this.appendUser(rendered);

      // 2. 建立 inflight（互斥锁 + 取消通道），直接发请求
      // v0.1.2+：quick prompt 忽略 webSearchEnabled，绝不触发联网搜索。
      this.inflight = new AbortController();

      const chatMsgs: ChatMessage[] = [];
      const sys = this.plugin.settings.systemPrompt.trim();
      if (sys) chatMsgs.push({ role: "system", content: sys });

      // v0.1.7：把笔记正文以系统消息的形式送给模型，避免把巨型正文塞进可见气泡
      //         撑爆对话布局。framing 由 noteContextBlock() 提供 [笔记] {title} 前缀。
      if (note) {
        const title = noteTitle || "笔记";
        const body = truncateByChars(noteContextBlock(title, note), 12000);
        if (body) chatMsgs.push({ role: "system", content: body });
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