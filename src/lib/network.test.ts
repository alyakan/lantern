import { describe, expect, it } from "vitest";
import { bodyJson, formatBytes, outline, shortUrl, statusLabel, summarizeRequest, tone } from "./network";
import type { NetworkTx } from "../types";

const tx = (over: Partial<NetworkTx> = {}): NetworkTx => ({
  id: "abc", revision: 1, started_at: 0, method: "GET", url: "https://api.x/v1/items?page=2", host: "api.x", path: "/v1/items", status: 200, duration_ms: 12,
  state: "completed", error: null, request_content_type: null, response_content_type: "application/json", request_size: 0, response_size: 10, ...over,
});

describe("network", () => {
  it("colours a request by how it went", () => {
    expect([tone(tx()), tone(tx({ status: 302 })), tone(tx({ status: 404 })), tone(tx({ state: "pending", status: null })), tone(tx({ state: "failed", status: null }))]).toEqual(["ok", "redirect", "error", "pending", "failed"]);
    expect([statusLabel(tx()), statusLabel(tx({ state: "pending" })), statusLabel(tx({ state: "failed" }))]).toEqual(["200", "…", "Failed"]);
  });

  it("reads JSON bodies, whatever the content type, and nothing else", () => {
    expect(bodyJson({ encoding: "utf8", data: ' {"a": 1}', size: 9, truncated: false })).toEqual({ a: 1 });
    expect(bodyJson({ encoding: "utf8", data: "<html>", size: 6, truncated: false })).toBeUndefined();
    expect(bodyJson({ encoding: "utf8", data: "{broken", size: 7, truncated: false })).toBeUndefined();
    expect(bodyJson({ encoding: "base64", data: "e30=", size: 2, truncated: false })).toBeUndefined();
    expect(bodyJson({ encoding: "utf8", data: '{"a": 1', size: 9, truncated: true })).toBeUndefined();
  });

  it("outlines a response two levels down, a list by its first item, and marks nulls and empty lists", () => {
    const rows = outline({ data: [{ id: 1, owner: null }], meta: { total: 41, tags: [] }, ok: true });
    expect(rows).toEqual([
      { path: "data", text: "1 item", odd: false },
      { path: "data[0].id", text: "1", odd: false },
      { path: "data[0].owner", text: "null", odd: true },
      { path: "meta", text: "2 keys", odd: false },
      { path: "meta.total", text: "41", odd: false },
      { path: "meta.tags", text: "empty list", odd: true },
      { path: "ok", text: "true", odd: false },
    ]);
    expect(outline([{ a: "x" }])[0]).toEqual({ path: "(root)", text: "1 item", odd: false });
    expect(outline({ s: "y".repeat(80) })[0].text).toBe(`"${"y".repeat(60)}…"`);
  });

  it("formats sizes and URLs, and asks Claude about the request by its id", () => {
    expect([formatBytes(0), formatBytes(512), formatBytes(2048), formatBytes(3 * 1024 * 1024)]).toEqual(["empty", "512 B", "2.0 KB", "3.0 MB"]);
    expect(shortUrl("https://api.x/v1/items?page=2")).toBe("api.x/v1/items?page=2");
    const ask = summarizeRequest({ tx: tx({ url: "https://api.x/v1/items?token=s3cret" }), watch: "Items", summary: null, has_response: true });
    expect(ask).toContain("network request abc (GET https://api.x/v1/items)");
    expect(ask).not.toContain("s3cret");
    expect(ask).toContain("network_summarize");
  });
});
