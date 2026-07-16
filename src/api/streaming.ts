/**
 * SSE 解析器。把 fetch 的 ReadableStream<Uint8Array> 解析成 ChatCompletionChunk。
 * 兼容 OpenAI / MiniMax 协议：
 *   event: chat_message\n
 *   data: {...}\n\n
 * 数据结尾是 `data: [DONE]\n\n`。
 */

import { ChatCompletionChunk, ApiErrorBody } from "./types";

export class SSEParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SSEParseError";
  }
}

/**
 * 让消费侧能优雅中断。
 */
export interface SSEReadable {
  controller: AbortController;
}

export interface StreamCallbacks {
  /** 每个增量内容。模型可能分多批回调，UI 层负责拼。 */
  onDelta: (delta: string) => void;
  onDone: (usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void;
  onError: (err: Error) => void;
}

/**
 * 真正发起 fetch 并解析 SSE。
 * 该函数假定服务端开启了 stream=true。
 */
export async function streamChat(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  cb: StreamCallbacks,
  signal: AbortSignal
): Promise<void> {
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  }).catch((e) => {
    throw new Error(`网络请求失败：${(e as Error)?.message ?? e}`);
  });

  if (!resp.ok || !resp.body) {
    // 取一次文本以便拿到错误体
    let text = "";
    try {
      text = await resp.text();
    } catch {
      /* ignore */
    }
    let parsed: ApiErrorBody | undefined;
    try {
      parsed = text ? (JSON.parse(text) as ApiErrorBody) : undefined;
    } catch {
      parsed = { error: { message: text || `HTTP ${resp.status}` } };
    }
    throw Object.assign(new Error(parsed?.error?.message ?? `HTTP ${resp.status}`), {
      status: resp.status,
      body: parsed,
    });
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 帧以 \n\n 分割
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleFrame(frame, cb);
      }
    }
    // 处理可能剩余的最后一条
    if (buffer.trim().length > 0) {
      handleFrame(buffer, cb);
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      cb.onError(new Error("已取消"));
      return;
    }
    cb.onError(e as Error);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function handleFrame(frame: string, cb: StreamCallbacks) {
  // 一帧可能有多行（多 event: 字段），我们对 data: 行做合流
  const lines = frame.split(/\r?\n/);
  let data = "";
  let isErrorEvent = false;
  for (const line of lines) {
    if (line.startsWith("data:")) {
      data += line.slice(5).trim();
    } else if (line.startsWith("event:")) {
      if (line.slice(6).trim() === "error") isErrorEvent = true;
    }
  }
  if (!data) return;
  if (data === "[DONE]") {
    cb.onDone();
    return;
  }
  let chunk: ChatCompletionChunk;
  try {
    chunk = JSON.parse(data) as ChatCompletionChunk;
  } catch (e) {
    if (isErrorEvent) {
      cb.onError(new Error(data));
    } else {
      cb.onError(new SSEParseError(`无法解析 SSE 数据：${data.slice(0, 200)}`));
    }
    return;
  }
  for (const choice of chunk.choices) {
    const delta = choice.delta?.content;
    if (delta) cb.onDelta(delta);
    const reason = choice.finish_reason;
    if (reason && reason !== null) {
      if (chunk.usage && typeof chunk.usage === "object") {
        cb.onDone({
          prompt_tokens: chunk.usage.prompt_tokens ?? 0,
          completion_tokens: chunk.usage.completion_tokens ?? 0,
          total_tokens: chunk.usage.total_tokens ?? 0,
        });
      } else {
        cb.onDone();
      }
      return;
    }
  }
  // usage-only chunk（在 usage 块出现时立即终止）
  if (chunk.usage) {
    cb.onDone({
      prompt_tokens: chunk.usage.prompt_tokens ?? 0,
      completion_tokens: chunk.usage.completion_tokens ?? 0,
      total_tokens: chunk.usage.total_tokens ?? 0,
    });
  }
}
