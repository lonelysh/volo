import { Editor, MarkdownView, Notice, TFile } from "obsidian";
import type VoloPlugin from "../main";
import { chat } from "../api/client";
import { ProviderError } from "../api/errors";
import { NOTE_COMMAND_TEMPLATES } from "../constants";
import { truncateByChars } from "../utils/prompt";

type NoteCommandId = keyof typeof NOTE_COMMAND_TEMPLATES;

/**
 * 整篇笔记命令：总结 / 大纲 / 续写 / 修正。
 * 结果插入到当前光标位置（或续写到末尾）。
 */
export function registerNoteCommands(plugin: VoloPlugin) {
  for (const id of Object.keys(NOTE_COMMAND_TEMPLATES) as NoteCommandId[]) {
    const meta = NOTE_COMMAND_TEMPLATES[id];
    plugin.addCommand({
      id: `volo-note-${id}`,
      name: `Volo: ${meta.label}`,
      callback: async () => {
        const file = plugin.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md") {
          new Notice("请先打开一个 Markdown 笔记");
          return;
        }
        const text = (await plugin.app.vault.cachedRead(file)) ?? "";
        if (!text.trim()) {
          new Notice("当前笔记为空");
          return;
        }
        await runNoteCommand(plugin, id, file, text);
      },
    });
  }
}

async function runNoteCommand(plugin: VoloPlugin, id: NoteCommandId, file: TFile, source: string) {
  if (!plugin.settings.apiKey) {
    new Notice("请先在设置中填入 API Key");
    return;
  }

  const tpl = NOTE_COMMAND_TEMPLATES[id];

  let userInstruction = source;
  if (id === "summarize" || id === "outline" || id === "fix") {
    userInstruction = `下面是笔记的全文。请基于此完成任务。\n\n---\n${truncateByChars(source, 12000)}\n---\n\n开始：`;
  } else if (id === "continue") {
    userInstruction = `下面是笔记的末尾若干段。请基于相同风格与术语续写一段新内容，约 200-400 字，紧接上文，不要重复已有内容。\n\n---\n${truncateByChars(source, 8000)}\n---`;
  }

  new Notice(`Volo: ${tpl.label} …`);
  let acc = "";
  try {
    const result = await chat([{ role: "system", content: plugin.settings.systemPrompt + "\n\n" + tpl.system }, { role: "user", content: userInstruction }], {
      baseUrl: plugin.settings.baseUrl,
      apiKey: plugin.settings.apiKey,
      model: plugin.settings.model,
      temperature: plugin.settings.temperature,
      maxTokens: plugin.settings.maxTokens,
      onDelta: (d) => {
        acc += d;
      },
    });
    const out = (acc || result.content || "").trim();
    if (!out) {
      new Notice("模型没有返回内容");
      return;
    }
    await insertResult(plugin, file, out, id);
    new Notice(`${tpl.label} 完成`);
  } catch (e) {
    if (e instanceof ProviderError) new Notice(e.userMessage());
    else new Notice(`失败：${(e as Error).message}`);
  }
}

async function insertResult(plugin: VoloPlugin, file: TFile, content: string, id: NoteCommandId) {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  const original = (await plugin.app.vault.cachedRead(file)) ?? "";

  if (id === "continue") {
    // 续写：附加到末尾，确保有空行隔开
    const sep = original.endsWith("\n") ? "\n" : "\n\n";
    await plugin.app.vault.modify(file, original + sep + content + "\n");
    // 把光标移到末尾
    if (view) {
      const ed = view.editor;
      ed.setCursor({ line: ed.lastLine() + 1, ch: 0 });
    }
    return;
  }

  // 其它：插入到当前光标位置
  if (view) {
    const ed = view.editor;
    const cur = ed.getCursor();
    const prefix = original.split("\n").slice(0, cur.line).join("\n");
    const suffixStart = cur.line;
    const lines = original.split("\n");
    const suffix = lines.slice(suffixStart).join("\n");
    const insert = content + (cur.ch === 0 ? "" : "\n");
    await plugin.app.vault.modify(file, prefix + (prefix && !prefix.endsWith("\n") ? "\n\n" : "") + insert + "\n\n" + suffix);
  } else {
    // 没有激活编辑器就追加到尾部
    const sep = original.endsWith("\n") ? "\n" : "\n\n";
    await plugin.app.vault.modify(file, original + sep + "## Volo 输出\n\n" + content + "\n");
  }
}