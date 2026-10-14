import type { NetworkBody, NetworkItem, NetworkTx } from "../types";

/** How a request went, for its colour: a success, a redirect, an error status, still waiting, or no response at all. */
export type Tone = "ok" | "redirect" | "error" | "pending" | "failed";

export function tone(tx: NetworkTx): Tone {
  if (tx.state === "pending") return "pending";
  if (tx.state === "failed") return "failed";
  const s = tx.status ?? 0;
  return s >= 400 ? "error" : s >= 300 ? "redirect" : "ok";
}

export function statusLabel(tx: NetworkTx): string {
  if (tx.state === "pending") return "…";
  if (tx.state === "failed") return "Failed";
  return tx.status === null ? "?" : String(tx.status);
}

export function formatBytes(n: number): string {
  if (n === 0) return "empty";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The URL without its scheme, as the list shows it: host, path and query. */
export function shortUrl(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "");
}

/** A body's JSON, when it is JSON (whatever its content type says); undefined otherwise. */
export function bodyJson(body: NetworkBody): unknown {
  if (body.encoding !== "utf8" || body.truncated) return undefined;
  const text = body.data.trim();
  if (!text || !"{[".includes(text[0])) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** One line of a response's outline: where in the JSON, what's there, and whether it looks off (null, empty). */
export interface OutlineRow {
  path: string;
  text: string;
  odd: boolean;
}

const preview = (v: unknown): string => {
  if (typeof v === "string") return JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v);
  return String(v);
};

/**
 * The shape of a response at a glance, before Claude has summarized it: each key two levels down with its value (a
 * scalar), how many items an array has, or how many keys an object has. Nulls and empty lists are marked.
 */
export function outline(value: unknown, max = 40): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const describe = (v: unknown): { text: string; odd: boolean } => {
    if (v === null) return { text: "null", odd: true };
    if (Array.isArray(v)) return { text: v.length === 0 ? "empty list" : `${v.length} item${v.length === 1 ? "" : "s"}`, odd: v.length === 0 };
    if (typeof v === "object") {
      const n = Object.keys(v as object).length;
      return { text: n === 0 ? "empty object" : `${n} key${n === 1 ? "" : "s"}`, odd: n === 0 };
    }
    if (v === "") return { text: '""', odd: true };
    return { text: preview(v), odd: false };
  };
  const walk = (v: unknown, path: string, depth: number) => {
    if (rows.length >= max) return;
    if (Array.isArray(v)) {
      // A list is described by its first item (lists of records are the usual payload), at the list's own level.
      const first = v[0];
      if (first !== null && typeof first === "object") walk(first, `${path}[0]`, depth);
      return;
    }
    if (v === null || typeof v !== "object") return;
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (rows.length >= max) return;
      const at = path ? `${path}.${k}` : k;
      rows.push({ path: at, ...describe(child) });
      if (depth > 0 && child !== null && typeof child === "object") walk(child, at, depth - 1);
    }
  };
  if (Array.isArray(value)) rows.push({ path: "(root)", ...describe(value) });
  walk(value, "", 1);
  return rows;
}

/** What the Summarize button asks Claude, naming the request so it reads that one. The URL goes without its query,
 * fragment and user info: they can hold credentials. */
export function summarizeRequest(item: NetworkItem): string {
  const url = item.tx.url.split(/[?#]/)[0].replace(/^([a-z]+:\/\/)[^/@]*@/i, "$1");
  return `Summarize the response of network request ${item.tx.id} (${item.tx.method} ${url}): read it with network_request, then save your summary with network_summarize.`;
}
