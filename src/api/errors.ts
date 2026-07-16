/**
 * 错误归一化。把各家错误码/状态码折叠成用户能看懂的几个分级。
 */

import { ApiErrorBody } from "./types";

export type ErrorKind =
  | "auth" // 401/1004/2049 — API Key 错 / GroupId 缺失
  | "balance" // 1008 — 余额不足
  | "rate-limit" // 429/1002/1039/2045/2056
  | "input-sensitive" // 1026
  | "output-sensitive" // 1027
  | "network" // 0/断网/CORS/超时
  | "server" // 5xx/1013/1033
  | "invalid-param" // 400/2013
  | "unknown";

export class ProviderError extends Error {
  kind: ErrorKind;
  status?: number;
  businessCode?: number;
  raw?: unknown;

  constructor(opts: {
    kind: ErrorKind;
    message: string;
    status?: number;
    businessCode?: number;
    raw?: unknown;
  }) {
    super(opts.message);
    this.name = "ProviderError";
    this.kind = opts.kind;
    this.status = opts.status;
    this.businessCode = opts.businessCode;
    this.raw = opts.raw;
  }

  /** 给 UI 展示的友好提示。 */
  userMessage(): string {
    switch (this.kind) {
      case "auth":
        return "鉴权失败：请检查 API Key 是否正确，以及 Base URL 是否和 Key 同区（国内/海外）。";
      case "balance":
        return "账户余额不足：请前往 MiniMax 开放平台充值后再试。";
      case "rate-limit":
        return "触发限流：请稍后重试，或考虑降低请求频率 / 调低 max_tokens。";
      case "input-sensitive":
        return "输入内容触发安全审核，已被拒。请修改内容后再试。";
      case "output-sensitive":
        return "模型输出内容触发安全审核，已被拒。可调整提示词或换种提问方式。";
      case "network":
        return "网络异常：请检查设备网络，或 Base URL 是否可访问。";
      case "server":
        return "MiniMax 服务端错误，请稍后重试。";
      case "invalid-param":
        return "请求参数有误：请检查模型名、temperature、max_tokens 是否合法。";
      default:
        return this.message || "未知错误。";
    }
  }
}

/**
 * 从 401/403/404/429/413/500/529 映射到 kind。
 * 业务码表见 README 中的速查表。
 */
const BUSINESS_CODE_MAP: Record<number, ErrorKind> = {
  1002: "rate-limit",
  1004: "auth",
  1008: "balance",
  1013: "server",
  1026: "input-sensitive",
  1027: "output-sensitive",
  1033: "server",
  1039: "rate-limit",
  1041: "rate-limit",
  1042: "invalid-param",
  2013: "invalid-param",
  2045: "rate-limit",
  2049: "auth",
  2056: "rate-limit",
};

export function classifyError(status: number, body: ApiErrorBody | undefined, raw?: unknown): ProviderError {
  // 1. HTTP 状态码优先
  if (status === 401 || status === 403) {
    const msg = body?.error?.message ?? body?.message ?? body?.base_resp?.status_msg ?? "鉴权失败";
    return new ProviderError({ kind: "auth", message: msg, status, raw });
  }
  if (status === 404) {
    return new ProviderError({
      kind: "invalid-param",
      message: "模型不存在或端点路径有误",
      status,
      raw,
    });
  }
  if (status === 413) {
    return new ProviderError({
      kind: "invalid-param",
      message: "请求体过大（>64MB）",
      status,
      raw,
    });
  }
  if (status === 429) {
    return new ProviderError({
      kind: "rate-limit",
      message: body?.error?.message ?? "请求频率超限",
      status,
      raw,
    });
  }
  if (status >= 500 && status <= 599) {
    return new ProviderError({
      kind: "server",
      message: body?.error?.message ?? "服务端错误",
      status,
      raw,
    });
  }

  // 2. 业务码 base_resp（旧版接口）
  const code = body?.base_resp?.status_code;
  if (typeof code === "number") {
    const kind = BUSINESS_CODE_MAP[code] ?? "unknown";
    return new ProviderError({
      kind,
      businessCode: code,
      message: body?.base_resp?.status_msg ?? body?.error?.message ?? `业务错误 ${code}`,
      status,
      raw,
    });
  }

  // 3. 未知
  return new ProviderError({
    kind: "unknown",
    message: body?.error?.message ?? body?.message ?? `HTTP ${status}`,
    status,
    raw,
  });
}

/**
 * 把没有 HTTP 状态的网络异常（如断网、CORS、aborted）归一化。
 */
export function networkError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const name = (err as { name?: string })?.name;
  const message = (err as { message?: string })?.message ?? "网络错误";
  if (name === "AbortError") {
    return new ProviderError({ kind: "network", message: "请求已取消" });
  }
  return new ProviderError({ kind: "network", message });
}