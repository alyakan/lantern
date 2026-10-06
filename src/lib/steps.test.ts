import { describe, expect, it } from "vitest";
import type { ChatItem } from "../store";
import { andNext, isApproval, isQuestion, modeSwitchNote, movesOn, pageLabel, pagesOf, pageTitle, parseHeading, promptText, withModeNote, withoutModeNote } from "./steps";

describe("parseHeading", () => {
  it("reads each kind of heading the prompt asks for", () => {
    expect(parseHeading("# Frame — Add slugify(s) to utils.js\n\nTask: …")).toEqual({ kind: "frame", n: null, total: null, title: "Add slugify(s) to utils.js" });
    expect(parseHeading("# Plan step 2 — Add tests for slugify")).toMatchObject({ kind: "plan", n: 2, title: "Add tests for slugify" });
    expect(parseHeading("# Plan complete — 3 steps")).toMatchObject({ kind: "plan-complete", total: 3 });
    expect(parseHeading("## Step 1 of 3 - Add slugify")).toMatchObject({ kind: "step", n: 1, total: 3, title: "Add slugify" });
    expect(parseHeading("\n# Done — slugify with tests")).toMatchObject({ kind: "done", title: "slugify with tests" });
  });

  it("reads a review written under Build's headings as the file it names", () => {
    // As Claude wrote it after the chat was switched from Build to Review.
    const text = "# Step 1 of 5 — `Lumiform/Extensions/UIImage+Resized.swift`\n\n**Lumiform/Extensions/UIImage+Resized.swift** (+2 −2)\n\n### What changed\nOpacity.\n\n### Findings\nNone.";
    expect(parseHeading(text)).toEqual({ kind: "file", n: 1, total: 5, title: "Lumiform/Extensions/UIImage+Resized.swift (+2 −2)" });
    const [, page] = pagesOf([{ type: "user", id: "u1", text: "Review" }, { type: "assistant", id: "a1", text: "# Frame — x" }, { type: "user", id: "u2", text: "Next" }, { type: "assistant", id: "a2", text }]);
    expect(page.turns[0].items.map((it) => (it.type === "assistant" ? it.text : ""))).toEqual(["### What changed\nOpacity.\n\n### Findings\nNone."]);
    // A Build step stays a step.
    expect(parseHeading("# Step 1 of 3 — Add slugify\n\n**What changed:** utils.js")).toMatchObject({ kind: "step" });
  });

  it("ignores messages without one", () => {
    expect(parseHeading("Let me look at utils.js first.")).toBeNull();
    expect(parseHeading("# Notes\nsomething")).toBeNull();
  });

  it("labels pages", () => {
    expect(pageLabel(parseHeading("# Step 2 of 5 — x"))).toBe("Step 2 of 5");
    expect(pageLabel(null)).toBe("Step");
  });
});

describe("pagesOf", () => {
  const u = (id: string, text: string, turn?: number): ChatItem => ({ type: "user", id, text, turn });
  const a = (id: string, text: string): ChatItem => ({ type: "assistant", id, text });

  it("makes a page per step, titled by its heading, with the heading taken out of the message", () => {
    const pages = pagesOf([u("u1", "Add slugify", 0), a("a1", "Loading the skill."), a("a2", "# Frame — Add slugify\n\n**Task:** …"), u("u2", "Next", 1), a("a3", "# Plan step 1 — Add slugify\n\nFile: utils.js")]);
    expect(pages.map((p) => [p.key, p.heading?.kind, p.range])).toEqual([
      ["u1", "frame", { from: 0, to: 0 }],
      ["u2", "plan", { from: 1, to: 1 }],
    ]);
    expect(pages[0].turns[0].items.map((it) => (it.type === "assistant" ? it.text : ""))).toEqual(["Loading the skill.", "**Task:** …"]);
  });

  it("reads incremental-pr-review's own format: a page per file line, numbered in order", () => {
    // As Claude wrote it reviewing a local branch (the skill's format, not the "# File N of M" headings).
    const pages = pagesOf([
      u("u1", "Review my branch", 0),
      a("a1", "## Frame\n\nThree commits add a transformation."),
      u("u2", "Next", 1),
      a("a2", "**nodejs/src/cdp/templates/_transformations/device-model-names/device-model-names.template.ts** (+199 −0)\n\n### What changed\nThe template.\n\n### Findings\nNone."),
      u("u3", "why the early return?", 2),
      a("a3", "It skips events that already have a name."),
      u("u4", "Next", 3),
      a("a4", "**nodejs/src/cdp/templates/index.ts** (+2 −0)\n\n### What changed\nRegisters it.\n\n### Findings\nNone."),
    ]);
    expect(pages.map((p) => [p.heading?.kind, p.heading?.n, p.turns.length])).toEqual([["frame", null, 1], ["file", 1, 2], ["file", 2, 1]]);
    expect(pageLabel(pages[2].heading)).toBe("File 2");
    expect(pages[2].heading?.title).toBe("nodejs/src/cdp/templates/index.ts (+2 −0)");
    expect(pages[2].turns[0].items.map((it) => (it.type === "assistant" ? it.text : ""))).toEqual(["### What changed\nRegisters it.\n\n### Findings\nNone."]);
  });

  it("keeps a question and a revision on the step's page, showing the latest version", () => {
    const pages = pagesOf([
      u("u1", "Next", 1),
      a("a1", "# Plan step 1 — Add slugify\n\nv1"),
      u("u2", "why a regex?", 2),
      a("a2", "Because it handles tabs too."),
      u("u3", "use split instead", 3),
      a("a3", "# Plan step 1 — Add slugify\n\nv2"),
    ]);
    expect(pages).toHaveLength(1);
    expect(pages[0].turns.map((t) => t.prompt.id)).toEqual(["u1", "u2", "u3"]);
    expect(pages[0].main).toBe(2);
    expect(pages[0].range).toEqual({ from: 1, to: 3 });
  });

  it("starts a new page when the reply has a new heading, or the prompt moves on (even before its heading streams)", () => {
    const moved = pagesOf([u("u1", "Next"), a("a1", "# Plan step 1 — A"), u("u2", "rename it"), a("a2", "# Plan step 2 — B")]);
    expect(moved.map((p) => p.heading?.n)).toEqual([1, 2]);
    const streaming = pagesOf([u("u1", "Next"), a("a1", "# Plan step 1 — A"), u("u2", andNext("rename it")), a("a2", "Renaming…")]);
    expect(streaming).toHaveLength(2);
    expect(movesOn(andNext("rename it"))).toBe(true);
    expect(promptText(andNext("rename it"))).toBe("rename it");
  });

  it("moves on even when Claude stopped writing headings, and keeps questions on the page", () => {
    const pages = pagesOf([u("u1", "Next"), a("a1", "Both are working."), u("u2", "which products?"), a("a2", "Pick these two."), u("u3", andNext("found it")), a("a3", "AppDelegate now points at localhost.")]);
    expect(pages.map((p) => p.turns.map((t) => t.prompt.id))).toEqual([["u1", "u2"], ["u3"]]);
    // Without a heading, the title is the start of the step's message.
    expect(pages.map(pageTitle)).toEqual(["Both are working.", "AppDelegate now points at localhost."]);
  });

  it("doesn't know a page's changes when one of its turns has no number", () => {
    expect(pagesOf([u("u1", "Next"), a("a1", "# Plan step 1 — A")])[0].range).toBeNull();
  });
});

describe("questions about a step", () => {
  const u = (id: string, text: string, turn?: number): ChatItem => ({ type: "user", id, text, turn });
  const a = (id: string, text: string): ChatItem => ({ type: "assistant", id, text });

  it("tells a question from a change request (prompts from a real session)", () => {
    for (const q of ["what is the twelve-factor app rules", "can you explain more the first point in Why these choices", "why a Set instead of a range check?", "Explain the backoff"]) expect(isQuestion(q), q).toBe(true);
    for (const c of ["yeah sure we can remove the trailing slash.", "also include 500", "use a regex instead", "Next", "continue please"]) expect(isQuestion(c), c).toBe(false);
  });

  it("keeps the step when a reply to a suggestion discusses it instead of rewriting its plan", () => {
    // From a real session: a suggestion (no "?"), answered under the heading with a discussion and no plan block.
    const plan = "# Plan step 6 — PostHog client: run a HogQL query\n\n```\nPlan step 6 — PostHog client\nFile:   pulse/posthog_client.py\nChange: query(sql) returns the rows.\nVerify: a 500 raises.\n```";
    const pages = pagesOf([
      u("u1", "Next", 1),
      a("a1", plan),
      u("u2", "maybe we transform it into a list of objects and return that?  so it would be: event.name, event.date, event.count", 2),
      a("a2", "# Plan step 6 — PostHog client: run a HogQL query\n\nGood call: typed objects are clearer. The question is where the conversion happens."),
      u("u3", "ok make it return objects then", 3),
      a("a3", "# Plan step 6 — PostHog client: run a HogQL query\n\nLet's talk about it more first."),
      u("u4", "Update the step with this", 4),
      a("a4", plan.replace("returns the rows", "returns EventCount objects")),
    ]);
    expect(pages[0].turns.map((t) => !!t.answer)).toEqual([false, true, true, false]);
    expect(pages[0].main).toBe(3);
  });

  it("keeps the step when an answer to a question repeats its heading", () => {
    const step = "# Plan step 2 — Read configuration from environment variables\n\nFile: config/settings.py";
    const pages = pagesOf([
      u("u1", "Next", 1),
      a("a1", step),
      u("u2", "what is the twelve-factor app rules", 2),
      a("a2", "# Plan step 2 — Read configuration from environment variables\n\n## The Twelve-Factor App\nIt's a short manifesto."),
      u("u3", "rename it to Config", 3),
      a("a3", "# Plan step 2 — Read configuration from environment variables\n\nFile: config/settings.py, as Config"),
    ]);
    expect(pages).toHaveLength(1);
    expect(pages[0].turns.map((t) => !!t.answer)).toEqual([false, true, false]);
    // The change request is the version shown; the answer never was.
    expect(pages[0].main).toBe(2);
    expect(pages[0].turns[1].items).toEqual([{ type: "assistant", id: "a2", text: "## The Twelve-Factor App\nIt's a short manifesto." }]);
  });
});

describe("isApproval", () => {
  it("tells moving on from asking for a change", () => {
    for (const t of ["Next", "next.", "ok", "Yes!", "go ahead", "LGTM"]) expect(isApproval(t)).toBe(true);
    for (const t of ["Next, but rename it", "use a regex instead"]) expect(isApproval(t)).toBe(false);
  });
});

describe("modeSwitchNote", () => {
  it("names the new mode's headings, and comes off a prompt as you wrote it", () => {
    expect(modeSwitchNote("review")).toMatch(/Review mode.*incremental-pr-review.*# File N of M/);
    expect(modeSwitchNote("steps")).toMatch(/Build mode.*incremental-dev.*# Step N of M/);
    expect(modeSwitchNote("teach")).toMatch(/Teach mode.*why/);
    for (const m of ["steps", "teach", "review"] as const) expect(withoutModeNote(withModeNote(m, "Next"))).toBe("Next");
    expect(withoutModeNote("[Lantern] something else")).toBe("[Lantern] something else");
  });
});
