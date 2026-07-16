import { App, ButtonComponent, PluginSettingTab, Setting, Notice } from "obsidian";
import type VoloPlugin from "../main";
import type { VoloSettings } from "./defaults";
import { MODEL_OPTIONS, DEFAULT_BASE_URL } from "../constants";
import { isIOS } from "../utils/mobile";

function renderCustomQuickPrompts(
  containerEl: HTMLElement,
  arr: VoloSettings["customQuickPrompts"],
  onChange: () => Promise<void>,
): HTMLElement[] {
  const rows: HTMLElement[] = [];

  arr.forEach((quickPrompt) => {
    const row = containerEl.createDiv({ cls: "volo-custom-quick-prompt-row" });
    rows.push(row);

    const updatePrompt = async (patch: Partial<typeof quickPrompt>) => {
      const currentIndex = arr.findIndex((item) => item.id === quickPrompt.id);
      if (currentIndex === -1) return;
      arr[currentIndex] = { ...arr[currentIndex], ...patch };
      await onChange();
    };

    const controls = new Setting(row)
      .setName(`Quick Prompt ${rows.length}`)
      .setDesc("图标 · 标签 · 上下文");

    controls
      .addText((t) => {
        t.setPlaceholder("💬").setValue(quickPrompt.icon);
        t.inputEl.maxLength = 4;
        t.inputEl.minLength = 1;
        t.inputEl.style.width = "64px";
        t.inputEl.setAttribute("aria-label", "图标");
        t.inputEl.title = "图标";
        t.onChange(async (value) => {
          await updatePrompt({ icon: value });
        });
      })
      .addText((t) => {
        t.setPlaceholder("总结").setValue(quickPrompt.label);
        t.inputEl.maxLength = 8;
        t.inputEl.style.flex = "1 1 120px";
        t.inputEl.style.width = "120px";
        t.inputEl.setAttribute("aria-label", "标签");
        t.inputEl.title = "标签";
        t.onChange(async (value) => {
          await updatePrompt({ label: value });
        });
      })
      .addDropdown((d) => {
        d.addOption("none", "无").addOption("note", "当前笔记").addOption("selection", "选区");
        d.setValue(quickPrompt.context ?? "none");
        d.selectEl.setAttribute("aria-label", "上下文");
        d.selectEl.title = "上下文";
        d.onChange(async (value) => {
          await updatePrompt({ context: value as VoloSettings["customQuickPrompts"][number]["context"] });
        });
      });

    controls.addButton((b) => {
      b.buttonEl.setAttribute("aria-label", "删除");
      b.buttonEl.title = "删除";
      const buttonWithIcon = b as ButtonComponent & { setIcon?: (icon: string) => unknown };
      if (typeof buttonWithIcon.setIcon === "function") {
        buttonWithIcon.setIcon("trash");
      } else {
        b.setButtonText("删除");
      }
      b.onClick(async () => {
        const currentIndex = arr.findIndex((item) => item.id === quickPrompt.id);
        if (currentIndex === -1) return;
        arr.splice(currentIndex, 1);
        await onChange();
        row.remove();
      });
    });

    const descSetting = new Setting(row).setName("描述").setDesc("可选 · 显示在空状态卡片，最多 16 字");
    descSetting.addText((t) => {
      t.setPlaceholder("可选 · 显示在空状态卡片").setValue(quickPrompt.description ?? "");
      t.inputEl.maxLength = 16;
      t.inputEl.style.width = "100%";
      t.inputEl.setAttribute("aria-label", "描述");
      t.inputEl.title = "描述";
      t.onChange(async (value) => {
        await updatePrompt({ description: value });
      });
    });
    descSetting.settingEl.style.alignItems = "flex-start";
    descSetting.controlEl.style.flex = "1 1 auto";

    const promptSetting = new Setting(row).setName("Prompt 模板");
    promptSetting.addTextArea((t) => {
      t.setValue(quickPrompt.prompt);
      t.inputEl.rows = 4;
      t.inputEl.style.width = "100%";
      t.inputEl.style.fontFamily = "var(--font-monospace, monospace)";
      t.inputEl.setAttribute("aria-label", "Prompt 模板");
      t.onChange(async (value) => {
        await updatePrompt({ prompt: value });
      });
    });
    promptSetting.settingEl.style.alignItems = "flex-start";
    promptSetting.controlEl.style.flex = "1 1 auto";
  });

  return rows;
}

/**
 * 设置面板。
 * 注意触屏目标：按钮高度、最低 44px，iOS 友好。
 */
export class VoloSettingsTab extends PluginSettingTab {
  plugin: VoloPlugin;

  constructor(app: App, plugin: VoloPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h1", { text: "Volo 设置" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "驱动对话的是 LLM（默认 MiniMax 国内版）。在下方填入 API Key 后即可使用。任何兼容 OpenAI Chat Completions 协议的 provider 都可接入。",
    });

    /* ---------- API Key（密码框） ---------- */
    new Setting(containerEl)
      .setName("API Key")
      .setDesc("在 platform.minimaxi.com 创建。仅存本机 data.json，不会上传。")
      .setClass("volo-setting-wide-input")
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
        t.inputEl.style.minWidth = "240px";
        t.inputEl.maxLength = 256;
      });

    /* ---------- Base URL（可切海外站 / 自建） ---------- */
    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("默认是国内站 https://api.minimaxi.com/v1。可改为海外站 / 自建代理。务必与 API Key 同区。")
      .setClass("volo-setting-wide-input")
      .addText((t) => {
        t.inputEl.spellcheck = false;
        t.setPlaceholder(DEFAULT_BASE_URL);
        t.setValue(this.plugin.settings.baseUrl)
          .onChange(async (v) => {
            const norm = v.trim().replace(/\/+$/, "");
            this.plugin.settings.baseUrl = norm || DEFAULT_BASE_URL;
            await this.plugin.saveSettings();
          });
        t.inputEl.style.minWidth = "240px";
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

    /* ---------- 高级设置（默认折叠） ---------- */
    const advanced = containerEl.createEl("details", { cls: "volo-settings-advanced" });
    const advancedSummary = advanced.createEl("summary", { text: "🔧 高级设置" });
    advancedSummary.style.cursor = "pointer";
    const advancedBody = advanced.createDiv();
    advancedBody.style.paddingTop = "8px";

    /* ---------- Temperature ---------- */
    new Setting(advancedBody)
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
    new Setting(advancedBody)
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
    new Setting(advancedBody)
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
    new Setting(advancedBody)
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
    new Setting(advancedBody)
      .setName("侧边栏 Chat 默认注入当前笔记上下文")
      .setDesc("开启后，新一轮对话会自动把当前编辑笔记拼到 user message 之前。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.injectActiveNoteContext).onChange(async (v) => {
          this.plugin.settings.injectActiveNoteContext = v;
          await this.plugin.saveSettings();
        })
      );

    /* ---------- 自定义 Quick Prompt ---------- */
    containerEl.createEl("h2", { text: "自定义 Quick Prompt" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "在聊天 chip 行（新建会话时为卡片，之后在 ⚡ 菜单里）追加显示。{{text}} = 当前选区，{{note}} = 当前笔记正文，留空则当作普通消息。",
    });
    renderCustomQuickPrompts(containerEl, this.plugin.settings.customQuickPrompts, async () => {
      await this.plugin.saveSettings();
    });
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("+ 新增").onClick(async () => {
        this.plugin.settings.customQuickPrompts.push({
          id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          icon: "",
          label: "",
          description: "",
          prompt: "",
          context: "none",
        });
        await this.plugin.saveSettings();
        this.display();
      })
    );

    /* ---------- 联网搜索 (Web Search) ---------- */
    containerEl.createEl("h2", { text: "联网搜索 (Web Search)" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "在 Chat 的 ⚙ 菜单里开启后，每条发送的消息都会先调用一次搜索，把结果拼到 system prompt 里再发给模型。",
    });

    const tavilyKeySetting = new Setting(containerEl)
      .setName("Tavily API Key")
      .setDesc("留空走 keyless，免费 1000 次/月，中文一般，国内站弱。")
      .setClass("volo-setting-wide-input")
      .addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "off";
        t.inputEl.spellcheck = false;
        t.setPlaceholder("留空走 keyless，免费 1000 次/月");
        t.setValue(this.plugin.settings.tavilyApiKey).onChange(async (v) => {
          this.plugin.settings.tavilyApiKey = v.trim();
          await this.plugin.saveSettings();
        });
        t.inputEl.style.minWidth = "240px";
        t.inputEl.maxLength = 256;
      });

    const braveKeySetting = new Setting(containerEl)
      .setName("Brave API Key")
      .setDesc("从 brave.com/search/api 申请，X-Subscription-Token 必填。")
      .setClass("volo-setting-wide-input")
      .addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "off";
        t.inputEl.spellcheck = false;
        t.setPlaceholder("从 brave.com/search/api 申请。");
        t.setValue(this.plugin.settings.braveApiKey).onChange(async (v) => {
          this.plugin.settings.braveApiKey = v.trim();
          await this.plugin.saveSettings();
        });
        t.inputEl.style.minWidth = "240px";
        t.inputEl.maxLength = 256;
      });

    new Setting(containerEl)
      .setName("搜索 provider")
      .setDesc("默认 Tavily（keyless 可用）。Brave 速度更快但必须自备 Key。")
      .addDropdown((d) => {
        d.addOption("off", "关闭")
          .addOption("tavily", "Tavily（推荐 · 可 keyless）")
          .addOption("brave", "Brave Search")
          .setValue(this.plugin.settings.webSearchProvider)
          .onChange(async (v) => {
            const next = v as "off" | "tavily" | "brave";
            this.plugin.settings.webSearchProvider = next;
            await this.plugin.saveSettings();
            refreshSearchVisibility();
          });
      });

    new Setting(containerEl)
      .setName("每次搜索条数")
      .setDesc("1 到 10，默认 5。太多会撑爆 system prompt。")
      .addSlider((s) => {
        s.setLimits(1, 10, 1)
          .setValue(this.plugin.settings.webSearchMaxResults)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.webSearchMaxResults = v;
            await this.plugin.saveSettings();
          });
      });

    const refreshSearchVisibility = () => {
      const p = this.plugin.settings.webSearchProvider;
      tavilyKeySetting.settingEl.style.display = p === "tavily" ? "" : "none";
      braveKeySetting.settingEl.style.display = p === "brave" ? "" : "none";
    };
    refreshSearchVisibility();

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
      const note = containerEl.createDiv({ cls: "volo-ios-note" });
      note.createEl("strong", { text: "iOS 提示： " });
      note.appendText(
        "本插件在移动端走 fetch + AbortController（需要 MiniMax API 已开启 CORS）。若流式失败会自动回退到 requestUrl 一次性获取。"
      );
    }
  }
}