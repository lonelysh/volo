/**
 * 联网搜索后端。当前只支持 Tavily（keyless 试用 + free tier）和 Brave Search。
 * 默认 Tavily：免 key、1000 次/月、CORS 友好；中文一般，国内站弱。
 */

export type SearchProvider = "off" | "tavily" | "brave";

export interface SearchOptions {
  provider: SearchProvider;
  apiKey: string;          // empty for Tavily keyless
  maxResults: number;      // 1..10
  signal?: AbortSignal;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  provider: SearchProvider;
}

/* ---------------- Tavily ---------------- */

interface TavilyApiResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
  answer?: string;
  query?: string;
}

/* ---------------- Brave ---------------- */

interface BraveApiResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
}

/**
 * Run a search. Throws if provider unavailable or upstream error.
 * Caller is responsible for catching AbortError when wiring up AbortSignal.
 */
export async function search(query: string, opts: SearchOptions): Promise<SearchResult> {
  if (opts.provider === "off") {
    throw new Error("联网搜索未启用");
  }
  if (opts.provider === "tavily") {
    return await tavilySearch(query, opts);
  }
  return await braveSearch(query, opts);
}

async function tavilySearch(query: string, opts: SearchOptions): Promise<SearchResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.apiKey) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }
  const maxResults = clampMaxResults(opts.maxResults);

  let resp: Response;
  try {
    resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers,
      body: JSON.stringify({ query, max_results: maxResults }),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new Error(`Tavily 搜索失败：${(e as Error).message}`);
  }

  if (!resp.ok) {
    const detail = await safeReadText(resp);
    throw new Error(`Tavily 搜索失败：${resp.status} ${truncate(detail, 200)}`);
  }

  const data = (await resp.json().catch(() => ({}))) as TavilyApiResponse;
  const hits: SearchHit[] = (data.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
  return { query, hits, provider: "tavily" };
}

async function braveSearch(query: string, opts: SearchOptions): Promise<SearchResult> {
  if (!opts.apiKey) {
    throw new Error("Brave 搜索失败：未提供 API Key（X-Subscription-Token 必填）");
  }
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(clampMaxResults(opts.maxResults)));

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": opts.apiKey,
      },
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new Error(`Brave 搜索失败：${(e as Error).message}`);
  }

  if (!resp.ok) {
    const detail = await safeReadText(resp);
    throw new Error(`Brave 搜索失败：${resp.status} ${truncate(detail, 200)}`);
  }

  const data = (await resp.json().catch(() => ({}))) as BraveApiResponse;
  const hits: SearchHit[] = (data.web?.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.description ?? "",
  }));
  return { query, hits, provider: "brave" };
}

/** Pretty-print results as a markdown block for LLM context. */
export function formatHitsForLLM(hits: SearchHit[]): string {
  if (!hits.length) {
    return "# 联网搜索结果\n\n未检索到相关内容。\n";
  }
  const lines = hits.map((h, i) => {
    const title = h.title?.trim() || "(无标题)";
    const url = h.url?.trim() || "";
    const snippet = h.snippet?.trim() || "";
    return `${i + 1}. **${title}**\n   来源：${url}\n   ${snippet}`;
  });
  return `# 联网搜索结果（最新）\n\n${lines.join("\n\n")}\n`;
}

/* ---------------- helpers ---------------- */

function clampMaxResults(n: number): number {
  if (!Number.isFinite(n)) return 5;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > 10) return 10;
  return i;
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}