import { Editor, MarkdownView, Notice } from "obsidian";
import type MiniMaxPlugin from "../main";
import { chat } from "../api/client";
import { MiniMaxError } from "../api/errors";
import { SELECTION_PRESETS } from "../constants";
import { applyTemplate } from "../utils/prompt";

/**
 * 选中文本 AI 操作：命令面板 / 编辑器菜单 / ribbon。
 * 实现思路：拿到当前编辑器 + 选区 → 替换为流式响应；用户可中断。
 */

export function registerSelectionCommands(plugin: MiniMaxPlugin) {
  // ribbon 图标（桌面端可见；iOS 在 ribbon 菜单中仍可触达）
  plugin.addRibbonIcon("sparkles", "MiniMax：选中文本操作", async () => {
    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("请打开 Markdown 笔记并选中文本");
      return;
    }
    const ed = view.editor;
    const sel = ed.getSelection();
    if (!sel) {
      new Notice("先选中文本再点 ribbon 图标");
      return;
    }
    const preset = SELECTION_PRESETS[0]; // 默认走"翻译为英文"
    await runSelectionAction(plugin, ed, sel, preset);
  });

  // 命令面板里的预设
  for (const preset of SELECTION_PRESETS) {
    plugin.addCommand({
      id: `mmxob-selection-${preset.id}`,
      name: `MiniMax: 选中文本 → ${preset.label}`,
      editorCallback: async (editor: Editor) => {
        const sel = editor.getSelection();
        if (!sel) {
          new Notice("请先在编辑器中选中文本");
          return;
        }
        await runSelectionAction(plugin, editor, sel, preset);
      },
    });
  }

  // 自定义 prompt
  plugin.addCommand({
    id: "mmxob-selection-custom",
    name: "MiniMax: 选中文本 → 自定义 Prompt",
    editorCallback: async (editor: Editor, ctx: MarkdownView | import("obsidian").MarkdownFileInfo) => {
      const sel = editor.getSelection();
      if (!sel) {
        new Notice("请先选中文本");
        return;
      }
      const customTpl = plugin.settings.customSelectionPrompt.trim();
      if (!customTpl) {
        new Notice("请在设置里填写「自定义选中文本操作 Prompt」");
        return;
      }
      const noteName =
        (ctx && "file" in ctx && ctx.file?.basename) ? ctx.file.basename : "";
      await runSelectionPrompt(plugin, editor, sel, applyTemplate(customTpl, { text: sel, note: noteName }));
    },
  });
}

async function runSelectionAction(plugin: MiniMaxPlugin, editor: Editor, selection: string, preset: { id: string; label: string; prompt: string }) {
  const prompt = applyTemplate(preset.prompt, { text: selection });
  await runSelectionPrompt(plugin, editor, selection, prompt, preset.label);
}

async function runSelectionPrompt(
  plugin: MiniMaxPlugin,
  editor: Editor,
  selection: string,
  userPrompt: string,
  label?: string
) {
  if (!plugin.settings.apiKey) {
    new Notice("请先在设置中填入 API Key");
    return;
  }

  const sys =
    plugin.settings.systemPrompt.trim() +
    "\n\n仅基于用户给出的文本操作，不要添加未在原文中的事实。保持 Markdown 与代码块原样；如果用户没有特殊要求，请直接返回最终结果，不要加任何前缀说明。";

  let acc = "";
  // 用一个不可见的零宽字符作为占位，待流式回来后逐步替换
  const placeholder = "\u200B";
  editor.replaceSelection(placeholder);

  try {
    const result = await chat([{ role: "user", content: userPrompt }], {
      baseUrl: plugin.settings.baseUrl,
      apiKey: plugin.settings.apiKey,
      model: plugin.settings.model,
      temperature: plugin.settings.temperature,
      maxTokens: plugin.settings.maxTokens,
      // 选中文本操作保持简单：流式优先，但客户端会自动在 iOS 兜底到 requestUrl
      onDelta: (d) => {
        acc += d;
        const cur = editor.getValue();
        const replaced = cur.replace(placeholder, acc + placeholder);
        if (replaced !== cur) {
          // 注意：replaceSelection 会移动光标；这里直接全量 setValue 会破坏选区，简化方案：保留占位，后续整段替换
        }
      },
    });
    // 流式结束（或非流式）：最终整段替换占位
    const finalText = (acc || result.content || "").trim();
    const cur = editor.getValue();
    const next = cur.replace(placeholder, finalText);
    if (next !== cur) {
      // 重设全部内容（保留 firstLine/头部信息足够用；选区不再保留）
      editor.setValue(next);
    }
    if (label) new Notice(`${label} 完成`);
  } catch (e) {
    // 出错时恢复占位为原文
    const cur = editor.getValue();
    const next = cur.replace(placeholder, selection);
    if (next !== cur) editor.setValue(next);
    if (e instanceof MiniMaxError) new Notice(e.userMessage());
    else new Notice(`失败：${(e as Error).message}`);
  }
}