/**
 * 类型定义。协议对齐 OpenAI Chat Completions，因为 MiniMax 兼容。
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  /** 是否把 thinking 拆出来，仅对支持 thinking 的 M 系列模型有意义 */
  reasoning_split?: boolean;
  /** 流式时配置 */
  stream_options?: { include_usage: boolean };
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: Usage;
}

/**
 * 流式响应中的一条 delta。SSE 的 `data: {json}` 反序列化后是这个形状。
 */
export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  /** SSE chunk 通常为 null，最后一块包含 usage（如果 stream_options.include_usage=true） */
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
    };
    finish_reason?: "stop" | "length" | "content_filter" | "tool_calls" | null;
  }>;
  usage?: Usage | null;
}

/**
 * 错误响应体。可能形如：
 *   { "error": { "type": "...", "message": "..." } }
 * 或 Anthropic-兼容：
 *   { "type": "error", "error": { ... } }
 * 或旧版 base_resp：
 *   { "base_resp": { "status_code": 1004, "status_msg": "..." } }
 */
export interface ApiErrorBody {
  error?: { type?: string; message?: string; code?: number | string };
  type?: string;
  message?: string;
  base_resp?: {
    status_code: number;
    status_msg: string;
  };
}
