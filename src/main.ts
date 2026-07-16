import { Plugin, WorkspaceLeaf, Notice } from "obsidian";
import { DEFAULT_SETTINGS, MiniMaxSettings, cloneDefaults } from "./settings/defaults";
import { MiniMaxSettingsTab } from "./settings/SettingsTab";
import { ChatView } from "./views/ChatView";
import { registerSelectionCommands } from "./commands/selection";
import { registerNoteCommands } from "./commands/note";
import { chat } from "./api/client";
import { VIEW_TYPE_CHAT } from "./constants";
import { isMobile } from "./utils/mobile";

export default class MiniMaxPlugin extends Plugin {
  settings: MiniMaxSettings = cloneDefaults();

  async onload(): Promise<void> {
    await this.loadSettings();

    // 注册视图类型（如果还未注册）
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));

    // 设置面板
    this.addSettingTab(new MiniMaxSettingsTab(this.app, this));

    // Ribbon：打开 Chat 视图
    this.addRibbonIcon("message-square", "MiniMax：打开侧边栏聊天", () => this.activateChatView());

    // 命令：直接打开 Chat 视图
    this.addCommand({
      id: "mmxob-open-chat",
      name: "MiniMax: 打开侧边栏聊天",
      callback: () => this.activateChatView(),
    });

    // 命令：复制 API Key 健康检查入口
    this.addCommand({
      id: "mmxob-test-connection",
      name: "MiniMax: 测试 API 连通性",
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
    const raw = (await this.loadData()) as Partial<MiniMaxSettings> | null;
    this.settings = Object.assign(cloneDefaults(), raw ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateChatView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    // 桌面端：右侧栏；移动端：主容器（tab）
    const leaf = isMobile() ? workspace.getLeaf("tab") : workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("无法创建 Chat 视图：没有可用的工作区 leaf");
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    workspace.revealLeaf(leaf);
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