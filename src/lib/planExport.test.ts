import { describe, expect, it } from "vitest";
import type { ChatItem } from "../store";
import { demoteHeadings, exportFileName, planMarkdown } from "./planExport";
import { pagesOf } from "./steps";
import { summarize } from "./stepsSummary";

const u = (id: string, text: string, turn: number): ChatItem => ({ type: "user", id, text, turn });
const a = (id: string, text: string): ChatItem => ({ type: "assistant", id, text });
const chat = (...replies: string[]): ChatItem[] => replies.flatMap((text, i) => [u(`u${i}`, i === 0 ? "Do the thing" : "Next", i), a(`a${i}`, text)]);

const DATE = new Date(2026, 9, 12);
const PLAN = (n: number, title: string, change: string, file = "src/x.ts") => `# Plan step ${n} — ${title}\n\n\`\`\`\nFile:   ${file}\nChange: ${change}\nVerify: a test.\n\`\`\``;

function exported(replies: string[], opts: { results?: boolean; files?: Record<string, { path: string; created: boolean; added: number; removed: number }[]>; folder?: string | null } = {}) {
  const pages = pagesOf(chat(...replies));
  return planMarkdown({ pages, summary: summarize(pages), files: opts.files ?? {}, title: "Retry chat", folder: opts.folder === undefined ? "/work/acme-api" : opts.folder, date: DATE, results: opts.results ?? true });
}

const FRAME = "# Frame — Retry fetchJson\n\n**Task:** retry transient errors.\n\n## Out of scope\n\nPOST requests.";

describe("planMarkdown for a Build chat", () => {
  const replies = [FRAME, PLAN(1, "Name the statuses", "Add RETRYABLE."), PLAN(2, "Retry | with backoff", "Loop up to attempts.\n          Wait 250ms."), "# Plan complete — 2 steps", "# Step 1 of 2 — Name the statuses\n\n- `retry.ts:1`: added RETRYABLE.\n\n## Notes\n\nSmall."];

  it("opens with the title, project and date, the plan's progress, and the Frame", () => {
    const md = exported(replies);
    expect(md.split("\n").slice(0, 6)).toEqual(["# Retry fetchJson", "", "acme-api · 2026-10-12", "", "**Plan: 2 steps · 1 built**", ""]);
    expect(md).toContain("> [!NOTE]\n> Draft: the plan isn't fully built yet.");
    // The Frame's own headings sit under the document's.
    expect(md).toContain("## Frame\n\n**Task:** retry transient errors.\n\n### Out of scope\n\nPOST requests.");
  });

  it("lays the plan out as a table with each step's file, change, check and status", () => {
    const md = exported(replies);
    expect(md).toContain(
      [
        "| Step | What | Files | Change | Verify | Status |",
        "| --- | --- | --- | --- | --- | --- |",
        "| Step 1 | Name the statuses | src/x.ts | Add RETRYABLE. | a test. | Built |",
        "| Step 2 | Retry \\| with backoff | src/x.ts | Loop up to attempts. Wait 250ms. | a test. | Planned |",
      ].join("\n"),
    );
  });

  it("adds what each built step did, with its files and its own headings moved down, and leaves planned steps out of the details", () => {
    const md = exported(replies, { files: { u4: [{ path: "/work/acme-api/src/retry.ts", created: false, added: 12, removed: 3 }, { path: "/work/acme-api/src/new.ts", created: true, added: 5, removed: 0 }] } });
    const details = md.slice(md.indexOf("## Details"));
    expect(details).toContain("### Step 1 — Name the statuses\n\n**Files:** `src/retry.ts` +12 −3, `src/new.ts` (new) +5 −0\n\n- `retry.ts:1`: added RETRYABLE.\n\n#### Notes\n\nSmall.");
    expect(details).not.toContain("Step 2");
  });

  it("without results is the plan alone", () => {
    const md = exported(replies, { results: false });
    expect(md).toContain("## Plan");
    expect(md).not.toContain("## Details");
    expect(md).not.toContain("retry.ts:1");
  });

  it("ends with one newline", () => {
    expect(exported(replies).endsWith("Small.\n")).toBe(true);
  });
});

describe("planMarkdown for other flavours", () => {
  it("lists a debug chat's evidence and fix, and has no plan table", () => {
    const md = exported(["# Frame — Crash on save", "# Evidence 1 — The stack\n\nIt dies in `save()`.", "# Fix — Guard the null\n\nAdded a check."]);
    expect(md).toContain("# Crash on save");
    expect(md).not.toContain("## Plan");
    expect(md).toContain("### Evidence 1 — The stack\n\nIt dies in `save()`.");
    expect(md).toContain("### Fix — Guard the null\n\nAdded a check.");
    expect(md).not.toContain("Draft");
  });

  it("gives a review's files their size and findings, and an outline when it's only the plan", () => {
    const replies = ["# Frame — PR 12", "# File 1 of 2 — src/a.ts (+4 −1)\n\n**What changed:** a thing.\n\n**Findings:**\n\n- **Should fix** — x.", "# File 2 of 2 — src/b.ts (+1 −0)\n\n**What changed:** b."];
    const full = exported(replies);
    expect(full).toContain("### File 1 of 2 — src/a.ts\n\n+4 −1");
    const outline = exported(replies, { results: false });
    expect(outline).toContain("## Outline\n\n- **File 1 of 2** — src/a.ts");
    expect(outline).not.toContain("## Details");
  });

  it("falls back to the chat's title, and to no project, when there's no Frame or folder", () => {
    const md = exported(["# Done — all of it\n\nShipped."], { folder: null });
    expect(md.startsWith("# Retry chat\n\n2026-10-12\n")).toBe(true);
    expect(md).toContain("### Done — all of it\n\nShipped.");
  });
});

describe("demoteHeadings", () => {
  it("moves headings down, stops at six, and leaves code and non-headings alone", () => {
    expect(demoteHeadings("# A\n\n##### B\n\n#nothing\n\n```md\n# in code\n```\n\nText # not\n", 2)).toBe("### A\n\n###### B\n\n#nothing\n\n```md\n# in code\n```\n\nText # not\n");
  });
});

describe("exportFileName", () => {
  it("names the file for the project and the day", () => {
    expect(exportFileName("/work/Acme API", DATE)).toBe("acme-api-plan-2026-10-12.md");
    expect(exportFileName(null, DATE)).toBe("lantern-plan-2026-10-12.md");
    expect(exportFileName("/work/日本", DATE)).toBe("lantern-plan-2026-10-12.md");
  });
});
