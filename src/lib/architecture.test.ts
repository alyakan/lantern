import { describe, expect, it } from "vitest";
import type { ChatItem } from "../store";
import { architectureMap, coveredIds, coversOf, parseArchitecturePart } from "./architecture";
import { pagesOf } from "./steps";

const u = (id: string, text: string): ChatItem => ({ type: "user", id, text });
const a = (id: string, text: string): ChatItem => ({ type: "assistant", id, text });

const OVERVIEW = "# Overview — auth behind a gateway\n\nThe gateway is new.\n\n```mermaid\nflowchart LR\n  gw[Gateway]:::new --> authSvc[Auth service]:::changed\n  authSvc --> tokenStore[(Tokens)]\n```";
const PART = "# Part 1 of 2 — Gateway\n\nCovers: gw\n\n### Role\nTerminates TLS.\n\n### Connects to\nAuth service.\n\n### Changes\nNew: `gateway.ts`.\n\n### Concerns\n⚠ (should-fix): no timeout, so a slow auth service ties up every connection.\n\n### Notes\nChecked the retry path.";

describe("parseArchitecturePart", () => {
  it("reads the Covers line, the sections and the concerns", () => {
    const part = parseArchitecturePart(PART.replace(/^# [^\n]*\n\n/, ""))!;
    expect(part.covers).toEqual(["gw"]);
    expect(part.role).toBe("Terminates TLS.");
    expect(part.connects).toBe("Auth service.");
    expect(part.changes).toBe("New: `gateway.ts`.");
    expect(part.concerns).toEqual([{ index: 0, line: null, lineEnd: null, severity: "should-fix", text: "no timeout, so a slow auth service ties up every connection." }]);
    expect(part.clean).toBe(false);
    expect(part.notes).toBe("Checked the retry path.");
    expect(part.preface).toBe("");
  });

  it("reads a part with no concerns, and ids written in other ways", () => {
    const part = parseArchitecturePart("**Covers:** `authSvc`, tokenStore\n\n### Role\nx\n\n### Concerns\nNone.")!;
    expect(part.covers).toEqual(["authSvc", "tokenStore"]);
    expect(part.clean).toBe(true);
    expect(part.concerns).toEqual([]);
    expect(coveredIds("a; b c")).toEqual(["a", "b", "c"]);
  });

  it("is null for a message without the sections", () => {
    expect(parseArchitecturePart("Covers: gw\n\nJust talking.")).toBeNull();
  });
});

const NATIVE = '# Overview — auth behind a gateway\n\n```architecture\n{"nodes": [{"id": "gw", "label": "Gateway", "change": "new"}, {"id": "authSvc", "label": "Auth service"}, {"id": "tokenStore", "label": "Tokens"}], "edges": [{"from": "gw", "to": "authSvc"}]}\n```';

describe("architectureMap", () => {
  const parts = [u("u2", "Next"), a("a2", PART), u("u3", "Next"), a("a3", "# Part 2 of 2 — Auth\n\nCovers: authSvc, tokenStore\n\n### Role\nx")];
  const chat = [u("u1", "map it"), a("a1", NATIVE), ...parts];

  it("is the latest Overview's boxes and arrows, with the page each box opens", () => {
    const pages = pagesOf(chat);
    const map = architectureMap(pages)!;
    expect(map.kind).toBe("native");
    if (map.kind !== "native") return;
    expect(map.spec.nodes.map((n) => n.id)).toEqual(["gw", "authSvc", "tokenStore"]);
    expect(map.title).toBe("auth behind a gateway");
    expect(map.page).toBe(pages[0].key);
    expect(map.nodes).toEqual({ gw: pages[1].key, authSvc: pages[2].key, tokenStore: pages[2].key });
    expect(coversOf(pages[2])).toEqual(["authSvc", "tokenStore"]);
    expect(coversOf(pages[0])).toEqual([]);
  });

  it("draws the map of an Overview Claude opened with a sentence of its own before the heading", () => {
    // What a real Design chat did: "Feature flags … here is the map." and then the heading. The map didn't draw at all.
    const map = architectureMap(pagesOf([u("u1", "map it"), a("a1", `Flags are read in three places, so here is the map.\n\n${NATIVE}`), ...parts]))!;
    expect(map.kind).toBe("native");
    if (map.kind === "native") expect(map.spec.nodes.map((n) => n.id)).toEqual(["gw", "authSvc", "tokenStore"]);
  });

  it("shows an Overview written in Mermaid (before Lantern drew maps) as that diagram", () => {
    const map = architectureMap(pagesOf([u("u1", "map it"), a("a1", OVERVIEW), ...parts]))!;
    expect(map.kind).toBe("mermaid");
    if (map.kind === "mermaid") expect(map.source).toContain("gw[Gateway]:::new");
  });

  it("says why an Overview's block can't be drawn", () => {
    const map = architectureMap(pagesOf([u("u1", "map it"), a("a1", "# Overview — x\n\n```architecture\n{nodes\n```")]))!;
    expect(map).toMatchObject({ kind: "broken", error: "It isn't valid JSON.", text: "{nodes" });
  });

  it("is null until an Overview has a map", () => {
    expect(architectureMap(pagesOf([u("u1", "map it"), a("a1", "# Frame — x")]))).toBeNull();
    expect(architectureMap(pagesOf([u("u1", "map it"), a("a1", "# Overview — x\n\nNo diagram yet.")]))).toBeNull();
  });

  it("follows a rewritten Overview", () => {
    const rewritten = [...chat, u("u4", "add a cache to the map"), a("a4", NATIVE.replace('{"id": "tokenStore", "label": "Tokens"}', '{"id": "cache", "label": "Cache", "change": "new"}'))];
    const map = architectureMap(pagesOf(rewritten))!;
    expect(map.kind === "native" && map.spec.nodes.map((n) => n.id)).toEqual(["gw", "authSvc", "cache"]);
  });
});
