/**
 * MiniMax 客户端。
 *
 * 设计要点：
 * - 完全兼容 OpenAI Chat Completions 协议，所以 baseURL 末尾保留 `/v1`，
 *   直接 POST `{baseUrl}/chat/completions`。
 * - 默认走 fetch + SSE 流式；如果用户在移动端关闭流式，则走 requestUrl
 *   一次性获取。iOS 上 fetch 受 CORS 限制，MiniMax 公网默认开启了
 *   Access-Control-Allow-Origin，所以多数情况下流式可用；fetch 失败时
 *   自动回退到 requestUrl（非流式）。
 */

import { requestUrl } from "obsidian";
import { MiniMaxError, classifyError, networkError } from "./errors";
import { streamChat } from "./streaming";
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ApiErrorBody,
} from "./types";

const DEFAULT_TIMEOUT_MS = 90_000; // M3 长上下文生成可能慢

export interface ChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** 注入额外 system prompt，会拼到 messages[0] 前。 */
  systemPromptSuffix?: string;
  /** 显式禁用流式（移动端兜底）。 */
  preferNonStream?: boolean;
  /** 进度回调，delta 为本次新增内容。 */
  onDelta?: (delta: string) => void;
  /** 整体完成回调。 */
  onComplete?: (usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void;
}

function ensureUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/chat/completions";
}

function buildMessages(messages: ChatMessage[], suffix?: string): ChatMessage[] {
  if (!suffix || !suffix.trim()) return messages;
  const first = messages[0];
  if (first && first.role === "system") {
    return [
      { role: "system", content: `${first.content}\n\n${suffix}` },
      ...messages.slice(1),
    ];
  }
  return [{ role: "system", content: suffix }, ...messages];
}

/**
 * 单轮聊天。返回完整 assistant 内容（即使流式，会拼到 done）。
 */
export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions
): Promise<{ content: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  if (!opts.apiKey) {
    throw new MiniMaxError({
      kind: "auth",
      message: "尚未配置 API Key。请在插件设置中填入后重试。",
    });
  }

  const useStream = !opts.preferNonStream && !!opts.onDelta;

  if (useStream) {
    return await runStream(messages, opts);
  }
  return await runOnce(messages, opts);
}

/* ---------------- 流式 ---------------- */

async function runStream(
  messages: ChatMessage[],
  opts: ChatOptions
): Promise<{ content: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort("timeout"), DEFAULT_TIMEOUT_MS);
  let accumulated = "";
  const usageRef: { current?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } = {};

  const body: ChatCompletionRequest = {
    model: opts.model,
    messages: buildMessages(messages, opts.systemPromptSuffix),
    stream: true,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 4096,
    stream_options: { include_usage: true },
  };

  try {
    await streamChat(
      ensureUrl(opts.baseUrl),
      body,
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      {
        onDelta: (d) => {
          accumulated += d;
          opts.onDelta?.(d);
        },
        onDone: (u) => {
          if (u) usageRef.current = u;
          opts.onComplete?.(usageRef.current);
        },
        onError: (e) => {
          // 把错误转成 MiniMaxError 再 throw
          throw e;
        },
      },
      controller.signal
    );
  } catch (e) {
    clearTimeout(timeoutHandle);
    // 流式失败（很可能是 iOS CORS/网络），回退到非流式 requestUrl
    const msg = (e as Error)?.message ?? "";
    if (looksLikeCorsOrNetwork(msg)) {
      return await runOnceWithRequestUrl(messages, opts, accumulated, e as Error);
    }
    throw networkError(e);
  }
  clearTimeout(timeoutHandle);
  return { content: accumulated, usage: usageRef.current };
}

/**
 * 调用 fetch 走流式但仍失败时，抛出的错误可能是：
 *   "Failed to fetch" / "Network request failed" / "Load failed"
 */
function looksLikeCorsOrNetwork(msg: string): boolean {
  if (!msg) return false;
  return /failed to fetch|network request failed|load failed|cors/i.test(msg);
}

/* ---------------- 非流式 ---------------- */

async function runOnce(
  messages: ChatMessage[],
  opts: ChatOptions
): Promise<{ content: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  return await runOnceWithRequestUrl(messages, opts, "");
}

async function runOnceWithRequestUrl(
  messages: ChatMessage[],
  opts: ChatOptions,
  partialStreamed: string,
  priorErr?: Error
): Promise<{ content: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const body: ChatCompletionRequest = {
    model: opts.model,
    messages: buildMessages(messages, opts.systemPromptSuffix),
    stream: false,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 4096,
  };

  let resp;
  try {
    resp = await requestUrl({
      url: ensureUrl(opts.baseUrl),
      method: "POST",
      contentType: "application/json",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e) {
    if (partialStreamed) {
      // 流式途中才回退，不算完全失败 → 返回已累积的部分
      return { content: partialStreamed };
    }
    throw networkError(e);
  }

  if (resp.status < 200 || resp.status >= 300) {
    let parsed: ApiErrorBody | undefined;
    try {
      parsed = (resp.json as ApiErrorBody) ?? JSON.parse(resp.text ?? "{}");
    } catch {
      parsed = { error: { message: resp.text } };
    }
    throw classifyError(resp.status, parsed);
  }

  let data: ChatCompletionResponse;
  try {
    data = resp.json as ChatCompletionResponse;
  } catch (e) {
    throw new MiniMaxError({
      kind: "unknown",
      message: "无法解析响应 JSON",
      raw: resp.text,
    });
  }

  const content =
    data.choices?.[0]?.message?.content ??
    "" + (partialStreamed ? partialStreamed : "");

  if (data.usage) opts.onComplete?.(data.usage);
  return { content, usage: data.usage };
}
