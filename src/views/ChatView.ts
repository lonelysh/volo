import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, TFile } from "obsidian";
import { VIEW_TYPE_CHAT } from "../constants";
import type MiniMaxPlugin from "../main";
import { chat } from "../api/client";
import { MiniMaxError } from "../api/errors";
import { ChatMessage } from "../api/types";
import { isMobile, isIOS } from "../utils/mobile";
import { truncateByChars, noteContextBlock } from "../utils/prompt";

interface UiMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  status?: "streaming" | "done" | "error";
}

/**
 * 侧边栏 Chat 视图。原生 DOM，无第三方框架，移动端轻量。
 */
export class ChatView extends ItemView {
  private plugin: MiniMaxPlugin;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private modelEl!: HTMLElement;
  private messages: UiMessage[] = [];
  private inflight: AbortController | null = null;
  private streamingOn = true;
  /** 当前 assistant DOM 节点（用于增量更新） */
  private currentAssistantEl: HTMLElement | null = null;
  /** 当前 assistant 累积文本 */
  private currentAssistantText = "";

  constructor(leaf: WorkspaceLeaf, plugin: MiniMaxPlugin) {
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
    return "MiniMax Chat";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("mmxob-chat-root");

    /* -------- 头部 -------- */
    const header = root.createDiv({ cls: "mmxob-chat-header" });
    const title = header.createDiv({ cls: "mmxob-chat-title" });
    title.createSpan({ text: "MiniMax Chat", cls: "mmxob-chat-title-text" });
    this.modelEl = title.createSpan({ cls: "mmxob-chat-model", text: this.plugin.settings.model });

    const headerActions = header.createDiv({ cls: "mmxob-chat-header-actions" });
    headerActions
      .createEl("button", { text: "清空", cls: "mmxob-icon-btn", attr: { "aria-label": "清空对话" } })
      .addEventListener("click", () => {
        this.messages = [];
        this.renderAll();
      });
    headerActions
      .createEl("button", { text: "复制", cls: "mmxob-icon-btn", attr: { "aria-label": "复制最后一轮回答" } })
      .addEventListener("click", async () => {
        const lastAssistant = [...this.messages].reverse().find((m) => m.role === "assistant");
        if (!lastAssistant) {
          new Notice("还没有回答可复制");
          return;
        }
        await navigator.clipboard.writeText(lastAssistant.content);
        new Notice("已复制");
      });

    /* -------- 消息列表 -------- */
    this.messagesEl = root.createDiv({ cls: "mmxob-chat-messages" });
    this.messagesEl.setAttr("role", "log");
    this.messagesEl.setAttr("aria-live", "polite");

    /* -------- 输入区 -------- */
    const inputArea = root.createDiv({ cls: "mmxob-chat-input-area" });

    // 顶部开关栏
    const switches = inputArea.createDiv({ cls: "mmxob-chat-switches" });
    this.statusEl = switches.createSpan({ cls: "mmxob-chat-status", text: "就绪" });
    const streamToggleLabel = switches.createEl("label", { cls: "mmxob-chat-stream-toggle" });
    const streamToggleInput = streamToggleLabel.createEl("input", {
      type: "checkbox",
      attr: { "aria-label": "启用流式" },
    });
    this.streamingOn = isMobile() ? this.plugin.settings.streamOnMobile : true;
    streamToggleInput.checked = this.streamingOn;
    streamToggleLabel.appendText("流式");
    streamToggleInput.addEventListener("change", () => {
      this.streamingOn = streamToggleInput.checked;
    });

    // 文本框 + 按钮
    const composerRow = inputArea.createDiv({ cls: "mmxob-chat-composer-row" });
    this.inputEl = composerRow.createEl("textarea", {
      cls: "mmxob-chat-input",
      attr: { placeholder: "输入消息…(Cmd/Ctrl+Enter 发送)", rows: "2" },
    });

    this.sendBtn = composerRow.createEl("button", {
      cls: "mmxob-btn mmxob-btn-primary",
      text: "发送",
      attr: { "aria-label": "发送" },
    });
    this.stopBtn = composerRow.createEl("button", {
      cls: "mmxob-btn mmxob-btn-danger",
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
      this.currentAssistantEl.classList.remove("mmxob-streaming");
      this.currentAssistantEl = null;
    }
  }

  /* ---------------- 渲染 ---------------- */

  private renderAll() {
    this.messagesEl.empty();
    if (this.messages.length === 0) {
      this.messagesEl.createDiv({ cls: "mmxob-empty", text: "从下方输入框开始与模型对话。可打开一条笔记，我会自动把它作为上下文。" });
      return;
    }
    for (const m of this.messages) this.renderMessage(m);
    this.scrollToBottom();
  }

  private renderMessage(m: UiMessage): HTMLElement {
    const wrap = this.messagesEl.createDiv({
      cls: `mmxob-msg mmxob-msg-${m.role}` + (m.status === "streaming" ? " mmxob-streaming" : "") + (m.status === "error" ? " mmxob-error" : ""),
    });

    const headerRow = wrap.createDiv({ cls: "mmxob-msg-header" });
    headerRow.createSpan({
      cls: "mmxob-msg-role",
      text: m.role === "user" ? "你" : m.role === "assistant" ? "MiniMax" : "系统",
    });

    if (m.role === "assistant") {
      const copyBtn = headerRow.createEl("button", {
        cls: "mmxob-icon-btn",
        text: "复制",
        attr: { "aria-label": "复制本条" },
      });
      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(m.content);
        new Notice("已复制");
      });
    }

    const body = wrap.createDiv({ cls: "mmxob-msg-body" });
    this.renderBody(body, m);
    return wrap;
  }

  private renderBody(body: HTMLElement, m: UiMessage) {
    body.empty();
    if (m.role === "assistant") {
      // 用 Obsidian 自身的 MarkdownRenderer 渲染，保证风格统一
      // 注意：sourcePath 传空串即可，因为上下文为助手消息，无 wikilink 解析需求
      void MarkdownRenderer.render(this.plugin.app, m.content || "▍", body, "", this.plugin);
    } else {
      body.createEl("div", { text: m.content });
    }
  }

  private appendUser(content: string) {
    const m: UiMessage = { role: "user", content, ts: Date.now() };
    this.messages.push(m);
    this.renderMessage(m);
    this.scrollToBottom();
  }

  private startAssistant() {
    const m: UiMessage = { role: "assistant", content: "", ts: Date.now(), status: "streaming" };
    this.messages.push(m);
    this.currentAssistantText = "";
    this.currentAssistantEl = this.renderMessage(m);
    this.currentAssistantEl.classList.add("mmxob-streaming");
    this.scrollToBottom();
  }

  private appendDelta(delta: string) {
    if (!this.currentAssistantEl) return;
    this.currentAssistantText += delta;
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "assistant") last.content = this.currentAssistantText;
    this.renderBody(this.currentAssistantEl.querySelector(".mmxob-msg-body") as HTMLElement, last!);
    this.scheduleScrollToBottom();
  }

  private finishAssistant(usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
    if (this.currentAssistantEl) {
      this.currentAssistantEl.classList.remove("mmxob-streaming");
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
      this.currentAssistantEl.classList.remove("mmxob-streaming");
      const last = this.messages[this.messages.length - 1];
      if (last) {
        last.status = "error";
        last.content = (last.content || "") + (last.content ? "\n\n---\n" : "") + `**错误：** ${e instanceof MiniMaxError ? e.userMessage() : e.message}`;
        this.renderBody(this.currentAssistantEl.querySelector(".mmxob-msg-body") as HTMLElement, last);
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

    // 上下文注入
    const chatMsgs: ChatMessage[] = [];
    const sys = this.plugin.settings.systemPrompt.trim();
    if (sys) chatMsgs.push({ role: "system", content: sys });
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
    this.inflight = new AbortController();

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
      if (e instanceof MiniMaxError) new Notice(e.userMessage());
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
}