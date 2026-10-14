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

describe("architectureMap", () => {
  const chat = [u("u1", "map it"), a("a1", OVERVIEW), u("u2", "Next"), a("a2", PART), u("u3", "Next"), a("a3", "# Part 2 of 2 — Auth\n\nCovers: authSvc, tokenStore\n\n### Role\nx")];

  it("is the latest Overview's diagram, with the page each node opens", () => {
    const pages = pagesOf(chat);
    const map = architectureMap(pages)!;
    expect(map.source).toContain("flowchart LR");
    expect(map.source).toContain("gw[Gateway]:::new");
    expect(map.page).toBe(pages[0].key);
    expect(map.nodes).toEqual({ gw: pages[1].key, authSvc: pages[2].key, tokenStore: pages[2].key });
    expect(coversOf(pages[2])).toEqual(["authSvc", "tokenStore"]);
    expect(coversOf(pages[0])).toEqual([]);
  });

  it("is null until an Overview has a diagram", () => {
    expect(architectureMap(pagesOf([u("u1", "map it"), a("a1", "# Frame — x")]))).toBeNull();
    expect(architectureMap(pagesOf([u("u1", "map it"), a("a1", "# Overview — x\n\nNo diagram yet.")]))).toBeNull();
  });

  it("follows a rewritten Overview", () => {
    const rewritten = [...chat, u("u4", "add a cache to the map"), a("a4", OVERVIEW.replace("authSvc --> tokenStore", "authSvc --> cache --> tokenStore"))];
    expect(architectureMap(pagesOf(rewritten))!.source).toContain("cache");
  });
});
