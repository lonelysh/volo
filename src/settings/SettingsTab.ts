import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type MiniMaxPlugin from "../main";
import { MODEL_OPTIONS, DEFAULT_BASE_URL } from "../constants";
import { isIOS } from "../utils/mobile";

/**
 * 设置面板。
 * 注意触屏目标：按钮高度、最低 44px，iOS 友好。
 */
export class MiniMaxSettingsTab extends PluginSettingTab {
  plugin: MiniMaxPlugin;

  constructor(app: App, plugin: MiniMaxPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h1", { text: "MiniMax Assistant 设置" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "驱动对话的是 MiniMax 国内版大模型。在下方填入 API Key 后即可使用。完整字段说明见 README。",
    });

    /* ---------- API Key（密码框） ---------- */
    new Setting(containerEl)
      .setName("API Key")
      .setDesc("在 platform.minimaxi.com 创建。仅存本机 data.json，不会上传。")
      .addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "off";
        t.inputEl.spellcheck = false;
        t.setPlaceholder("eyJ...");
        t.setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.apiKey = v.trim();
            await this.plugin.saveSettings();
            new Notice("API Key 已保存");
          });
        // 让 placeholder / value 占位更宽
        t.inputEl.style.width = "320px";
        t.inputEl.maxLength = 256;
      });

    /* ---------- Base URL（可切海外站 / 自建） ---------- */
    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("默认是国内站 https://api.minimaxi.com/v1。可改为海外站 / 自建代理。务必与 API Key 同区。")
      .addText((t) => {
        t.inputEl.spellcheck = false;
        t.setPlaceholder(DEFAULT_BASE_URL);
        t.setValue(this.plugin.settings.baseUrl)
          .onChange(async (v) => {
            const norm = v.trim().replace(/\/+$/, "");
            this.plugin.settings.baseUrl = norm || DEFAULT_BASE_URL;
            await this.plugin.saveSettings();
          });
        t.inputEl.style.width = "380px";
      })
      .addButton((b) =>
        b.setButtonText("恢复默认").onClick(async () => {
          this.plugin.settings.baseUrl = DEFAULT_BASE_URL;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    /* ---------- Model ---------- */
    new Setting(containerEl)
      .setName("模型")
      .setDesc("推荐 MiniMax-M3；想要极速档就选 highspeed。M2 系列 thinking 不可关闭。")
      .addDropdown((d) => {
        for (const m of MODEL_OPTIONS) d.addOption(m.value, m.label);
        d.setValue(this.plugin.settings.model).onChange(async (v) => {
          this.plugin.settings.model = v;
          await this.plugin.saveSettings();
        });
      });

    /* ---------- Temperature ---------- */
    new Setting(containerEl)
      .setName("温度 Temperature")
      .setDesc("0 = 更确定，2 = 更发散。默认 0.7。")
      .addSlider((s) => {
        s.setLimits(0, 2, 0.1)
          .setValue(this.plugin.settings.temperature)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.temperature = v;
            await this.plugin.saveSettings();
          });
      });

    /* ---------- Max Tokens ---------- */
    new Setting(containerEl)
      .setName("最大输出 tokens")
      .setDesc("单轮最大生成 tokens。M3 上限 65536。")
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.min = "256";
        t.inputEl.max = "65536";
        t.setValue(String(this.plugin.settings.maxTokens)).onChange(async (v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 256) {
            new Notice("无效值，已忽略");
            return;
          }
          this.plugin.settings.maxTokens = Math.min(65536, Math.floor(n));
          await this.plugin.saveSettings();
        });
      });

    /* ---------- System Prompt ---------- */
    new Setting(containerEl)
      .setName("系统提示词")
      .setDesc("定义助手的角色与回答风格。每次请求都会带上，可留空。")
      .addTextArea((t) => {
        t.inputEl.rows = 6;
        t.inputEl.style.width = "100%";
        t.setValue(this.plugin.settings.systemPrompt).onChange(async (v) => {
          this.plugin.settings.systemPrompt = v;
          await this.plugin.saveSettings();
        });
      });

    /* ---------- 自定义选中文本 Prompt ---------- */
    new Setting(containerEl)
      .setName('自定义"选中文本"操作 Prompt')
      .setDesc("在「选中文本 > 自定义」命令里使用。用 {{text}} 代表原文，可用 {{note}} 代表笔记标题。")
      .addTextArea((t) => {
        t.inputEl.rows = 5;
        t.inputEl.style.width = "100%";
        t.setValue(this.plugin.settings.customSelectionPrompt).onChange(async (v) => {
          this.plugin.settings.customSelectionPrompt = v;
          await this.plugin.saveSettings();
        });
      });

    /* ---------- 行为开关 ---------- */
    new Setting(containerEl)
      .setName("侧边栏 Chat 默认注入当前笔记上下文")
      .setDesc("开启后，新一轮对话会自动把当前编辑笔记拼到 user message 之前。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.injectActiveNoteContext).onChange(async (v) => {
          this.plugin.settings.injectActiveNoteContext = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("移动端默认开启流式")
      .setDesc(isIOS() ? "当前在 iOS。" : "当前在桌面/平板。")
      .setDesc(
        isIOS()
          ? "iOS 上默认开启流式响应。如果流式卡顿或失败，请在每条消息底部手动切换。"
          : "仅在移动端生效：是否走流式 SSE。桌面端总是走流式。"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.streamOnMobile).onChange(async (v) => {
          this.plugin.settings.streamOnMobile = v;
          await this.plugin.saveSettings();
        })
      );

    /* ---------- 测试按钮 ---------- */
    new Setting(containerEl)
      .setName("连通性测试")
      .setDesc("用当前配置发一个 1-token 请求，验证 Key / Base URL 是否可用。")
      .addButton((b) =>
        b
          .setButtonText("测试 API")
          .setWarning()
          .onClick(async () => {
            b.setDisabled(true);
            b.setButtonText("测试中...");
            try {
              const r = await this.plugin.testConnection();
              if (r.ok) new Notice(`成功：模型 ${r.model}，回包"${r.preview}"`);
              else new Notice("失败：见下方 Notice");
            } catch (e) {
              new Notice(`失败：${(e as Error).message}`);
            } finally {
              b.setDisabled(false);
              b.setButtonText("测试 API");
            }
          })
      );

    /* ---------- 自检清单 ---------- */
    if (isIOS()) {
      const note = containerEl.createDiv({ cls: "mmxob-ios-note" });
      note.createEl("strong", { text: "iOS 提示： " });
      note.appendText(
        "本插件在移动端走 fetch + AbortController（需要 MiniMax API 已开启 CORS）。若流式失败会自动回退到 requestUrl 一次性获取。"
      );
    }
  }
}
