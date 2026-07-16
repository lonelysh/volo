import { Plugin, WorkspaceLeaf, Notice } from "obsidian";
import { DEFAULT_SETTINGS, VoloSettings, cloneDefaults } from "./settings/defaults";
import { VoloSettingsTab } from "./settings/SettingsTab";
import { ChatView } from "./views/ChatView";
import { AiOutlineView } from "./views/AiOutlineView";
import { registerSelectionCommands } from "./commands/selection";
import { registerNoteCommands } from "./commands/note";
import { chat } from "./api/client";
import { VIEW_TYPE_CHAT, VIEW_TYPE_AI_OUTLINE } from "./constants";
import { isMobile } from "./utils/mobile";

/**
 * Volo plugin (formerly MiniMax Assistant).
 * Sidebar chat with LLMs in Obsidian.
 */
export default class VoloPlugin extends Plugin {
  settings: VoloSettings = cloneDefaults();

  async onload(): Promise<void> {
    await this.loadSettings();

    // 注册视图类型（如果还未注册）
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));
    this.registerView(VIEW_TYPE_AI_OUTLINE, (leaf) => new AiOutlineView(leaf, this));

    // 设置面板
    this.addSettingTab(new VoloSettingsTab(this.app, this));

    // Ribbon：打开 Chat 视图
    this.addRibbonIcon("message-square", "Volo：打开侧边栏聊天", () => this.activateChatView());

    // Ribbon：打开 AI 大纲视图
    this.addRibbonIcon("list-tree", "Volo：打开 AI 大纲", () => this.activateAiOutlineView());

    // 命令：直接打开 Chat 视图
    this.addCommand({
      id: "volo-open-chat",
      name: "Volo: 打开侧边栏聊天",
      callback: () => this.activateChatView(),
    });

    // 命令：直接打开 AI 大纲视图
    this.addCommand({
      id: "volo-open-ai-outline",
      name: "Volo: 打开 AI 大纲",
      callback: () => this.activateAiOutlineView(),
    });

    // 命令：复制 API Key 健康检查入口
    this.addCommand({
      id: "volo-test-connection",
      name: "Volo: 测试 API 连通性",
      callback: async () => {
        try {
          const r = await this.testConnection();
          if (r.ok) new Notice(`连接成功 · 模型 ${r.model} · 回包"${r.preview}"`);
        } catch (e) {
          new Notice(`连接失败：${(e as Error).message}`);
        }
      },
    });

    // 选中文本 AI 操作
    registerSelectionCommands(this);

    // 整篇笔记命令
    registerNoteCommands(this);

    // 样式
    // 通过设置开关加载：移动端紧凑布局已经写在 styles.css，按平台/窗口宽度自适应
  }

  onunload(): void {
    // Obsidian 会自动卸载视图与命令；无需手动清理
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<VoloSettings> | null;
    this.settings = Object.assign(cloneDefaults(), raw ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateChatView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    if (existing.length > 0) {
      // 已存在 → reveal + focus。revealLeaf 顺带展开右侧栏（若折叠）
      workspace.revealLeaf(existing[0]);
      workspace.setActiveLeaf(existing[0], { focus: true });
      return;
    }
    // 不存在 → 在右侧栏新建 leaf；移动端走主容器 tab
    let leaf: WorkspaceLeaf | null = null;
    if (isMobile()) {
      leaf = workspace.getLeaf("tab");
    } else {
      leaf = workspace.getRightLeaf(false);
      // 兜底：如果拿不到（极端情况），改用主区
      if (!leaf) leaf = workspace.getLeaf("tab");
    }
    if (!leaf) {
      new Notice("无法创建 Chat 视图：没有可用的工作区 leaf");
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    workspace.revealLeaf(leaf);
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  async activateAiOutlineView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_AI_OUTLINE);
    if (existing.length > 0) {
      // 已存在 → reveal + focus。revealLeaf 顺带展开右侧栏（若折叠）
      workspace.revealLeaf(existing[0]);
      workspace.setActiveLeaf(existing[0], { focus: true });
      return;
    }
    // 不存在 → 在右侧栏新建 leaf；移动端走主容器 tab
    let leaf: WorkspaceLeaf | null = null;
    if (isMobile()) {
      leaf = workspace.getLeaf("tab");
    } else {
      leaf = workspace.getRightLeaf(false);
      // 兜底：如果拿不到（极端情况），改用主区
      if (!leaf) leaf = workspace.getLeaf("tab");
    }
    if (!leaf) {
      new Notice("无法创建 AI 大纲视图：没有可用的工作区 leaf");
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE_AI_OUTLINE, active: true });
    workspace.revealLeaf(leaf);
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  /**
   * 连通性测试：发一条 1-token 极简请求。
   */
  async testConnection(): Promise<{ ok: true; model: string; preview: string }> {
    if (!this.settings.apiKey) throw new Error("尚未配置 API Key");
    const r = await chat(
      [{ role: "user", content: "回 OK 一个字" }],
      {
        baseUrl: this.settings.baseUrl,
        apiKey: this.settings.apiKey,
        model: this.settings.model,
        temperature: 0,
        maxTokens: 4,
        preferNonStream: true, // 测试场景强制非流式
      }
    );
    return { ok: true, model: this.settings.model, preview: r.content.slice(0, 12) };
  }
}