import type { RemoteChat } from "../protocol/generated/RemoteChat";
import type { Waiting } from "../protocol/generated/Waiting";
import { ago, groups, cards, headline, projectColorOf, projectTint, rows } from "./home";
import { parseInline, parseMarkdown, plainText, type Block } from "./markdown";
import { livePage, readPage } from "./pages";
import { approvalOf, promptView, questionsOf } from "./prompts";

describe("what a prompt says", () => {
  it("names a command, with the line to read before allowing it", () => {
    expect(promptView("Bash", { command: "git push origin release/0.1.53", description: "Push the release branch" })).toMatchObject({ kind: "allow", tag: "Run a command", title: "Push the release branch", detail: "git push origin release/0.1.53" });
    expect(promptView("Bash", { command: "ls" }).title).toBe("Run this command?");
  });

  it("names files by their last part, and the path in full as the detail", () => {
    expect(promptView("Edit", { file_path: "/Users/you/dev/lantern/package.json" })).toMatchObject({ tag: "Change a file", title: "Change package.json?", detail: "/Users/you/dev/lantern/package.json" });
    expect(promptView("Write", { file_path: "/p/new.ts" }).tag).toBe("Write a file");
    expect(promptView("WebFetch", { url: "https://example.com" })).toMatchObject({ tag: "Open a web page", detail: "https://example.com" });
  });

  it("reads a question's options, and survives an input that isn't one", () => {
    const input = { questions: [{ question: "Which channel?", header: "Channel", options: [{ label: "Stable", description: "Everyone" }, { label: "Beta" }, { nope: 1 }], multiSelect: false }, { header: "no question" }] };
    const v = promptView("AskUserQuestion", input);
    expect(v).toMatchObject({ kind: "question", tag: "A question", title: "Which channel?" });
    expect(v.questions).toEqual([{ question: "Which channel?", header: "Channel", options: [{ label: "Stable", description: "Everyone" }, { label: "Beta", description: "" }], multiSelect: false }]);
    expect(questionsOf("garbage")).toEqual([]);
    expect(promptView("AskUserQuestion", null).title).toBe("Claude has a question");
  });

  it("says an MCP tool by its name, and an approval by what it approves", () => {
    expect(promptView("mcp__lantern__storage_scan", { path: "/tmp" })).toMatchObject({ tag: "Use a tool", title: "Use lantern storage_scan?", detail: "/tmp" });
    expect(approvalOf("mcp__lantern__request_approval", { action: "merge PR 12", reason: "CI is green" })).toEqual({ action: "merge PR 12", why: "CI is green" });
    expect(approvalOf("Bash", {})).toBeNull();
  });
});

const chat = (over: Partial<RemoteChat>): RemoteChat => ({ slot: "a", title: "Release", project: "lantern", status: "idle", last_seq: 1, active_at: 1000, permissions: null, preset: null, project_color: null, workflow: null, ...over });
const wait = (over: Partial<Waiting>): Waiting => ({ slot: "a", chat_title: null, request_id: "p1", tool_name: "Bash", input: { command: "ls" }, at: 1, ...over });

describe("the Home screen", () => {
  it("counts what waits, and says so when nothing does", () => {
    expect(headline(0)).toEqual({ big: "Nothing", small: "waiting on you" });
    expect(headline(1).big).toBe("1 thing");
    expect(headline(2).big).toBe("2 things");
  });

  it("says times in a few words", () => {
    const now = 10_000_000;
    expect([ago(now - 5_000, now), ago(now - 4 * 60_000, now), ago(now - 2 * 3_600_000, now), ago(now - 86_400_000, now), ago(now - 3 * 86_400_000, now)]).toEqual(["now", "4 min", "2 h", "1 day", "3 days"]);
  });

  it("stacks what waits oldest first, each with its chat and where it is", () => {
    const list = cards([wait({ request_id: "late", at: 9, slot: "b", chat_title: "Other" }), wait({ request_id: "early", at: 2 })], [chat({}), chat({ slot: "b", title: null, project: null })]);
    expect(list.map((c) => c.waiting.request_id)).toEqual(["early", "late"]);
    expect(list[0].from).toBe("Release, in lantern");
    expect(list[1].from).toBe("Other");
  });

  it("lists chats most recent first, with what to say at the right of each", () => {
    const now = 5 * 60_000 + 1000;
    const r = rows([chat({ slot: "old", title: "Network tab", status: "asleep", active_at: 10 }), chat({ slot: "now", title: "release", status: "working", active_at: 1000 }), chat({ slot: "idle", title: null, status: "idle", active_at: 1000 - 1 }), chat({ slot: "n", status: "needs_you", active_at: 500 })], now);
    expect(r.map((x) => [x.slot, x.note])).toEqual([["now", null], ["idle", "5 min"], ["n", "Needs you"], ["old", "Asleep"]]);
    expect(r[0]).toMatchObject({ initial: "R", project: "lantern" });
    expect(r[1]).toMatchObject({ title: "New chat" });
  });

  it("lists chats under their projects: the project with the latest chat first, those with none last, the most recent chat first in each", () => {
    const list = rows(
      [
        chat({ slot: "a1", project: "alpha", active_at: 100 }),
        chat({ slot: "b1", project: "beta", active_at: 900, status: "needs_you" }),
        chat({ slot: "n1", project: null, active_at: 1000 }),
        chat({ slot: "a2", project: "alpha", active_at: 800 }),
        chat({ slot: "b2", project: "beta", active_at: 50 }),
      ],
      2000,
    );
    const g = groups(list);
    expect(g.map((x) => [x.project, x.rows.map((r) => r.slot), x.needsYou])).toEqual([
      ["beta", ["b1", "b2"], 1],
      ["alpha", ["a2", "a1"], 0],
      ["", ["n1"], 0],
    ]);
    expect(groups([])).toEqual([]);
  });

  it("shows a project in the colour the Mac gave it, and in a plain one when it gave none or garbage", () => {
    expect(projectColorOf("#5b5bd6")).toBe("#5b5bd6");
    for (const bad of [null, undefined, "", "red", "#12345", "#12345g", "5b5bd6", "#5b5bd6aa", 5]) expect(projectColorOf(bad)).toBeNull();
    expect(projectTint("#5b5bd6")).toEqual({ bg: "#5b5bd626", fg: "#5b5bd6" });
    expect(projectTint(null).fg).toBe("#566272");
    const r = rows([chat({ slot: "a", project: "lantern", project_color: "#0f8a7e" }), chat({ slot: "b", project: "site", project_color: "javascript:1" })], 5000);
    expect(r.map((x) => [x.slot, x.projectColor]).sort()).toEqual([["a", "#0f8a7e"], ["b", null]]);
  });
});

describe("Step by step's pages", () => {
  it("reads each heading shape, with its kicker and title", () => {
    expect(readPage("# Step 2 of 4 — Bump the version\n\n1. package.json")).toMatchObject({ kind: "step", kicker: "Step 2 of 4", title: "Bump the version", body: "1. package.json" });
    expect(readPage("# Frame — a mobile app")).toMatchObject({ kind: "frame", kicker: "Frame", title: "a mobile app" });
    expect(readPage("# Plan step 3 — Add the sync")).toMatchObject({ kind: "plan", kicker: "Plan step 3" });
    expect(readPage("# Part 4 of 9 — The gateway\nCovers: gw")).toMatchObject({ kind: "part", kicker: "Part 4 of 9" });
    expect(readPage("# File 1 of 3 — src/a.ts (+3 −1)")).toMatchObject({ kind: "file", title: "src/a.ts (+3 −1)" });
    expect(readPage("# Evidence 1 — what this round tells apart")).toMatchObject({ kind: "evidence" });
  });

  it("is not a page when it is an ordinary message", () => {
    expect(readPage("Bumping the version.")).toBeNull();
    expect(readPage("## Review · File 2 of 9 — x")).toBeNull();
    expect(readPage("")).toBeNull();
  });

  it("answers a build step with the Mac's own words, so Claude can't tell them apart", () => {
    const actions = readPage("# Step 1 of 3 — x")!.actions;
    expect(actions.map((a) => [a.label, a.reply, a.primary])).toEqual([["Don't commit", "Next. Don't commit this step.", false], ["Commit, next", "Next. Commit this step first.", true]]);
  });

  it("starts a suggested flavour, with the option it suggested, or isn't taken up", () => {
    const a = readPage("# Switch to Build, explaining as you go — it fits")!.actions;
    expect(a.map((x) => [x.label, x.reply])).toEqual([["Not now", null], ["Start Build", "Start Build, explaining as you go."]]);
    expect(readPage("# Switch to Debug — a crash")!.actions[1].reply).toBe("Start Debug.");
  });

  it("gives other pages Next, and the last ones none", () => {
    expect(readPage("# Plan complete — 5 steps")!.actions.map((a) => a.reply)).toEqual(["Next"]);
    expect(readPage("# Done — built it")!.actions).toEqual([]);
    expect(readPage("# Summary — all")!.actions).toEqual([]);
  });

  it("only the last page can be answered", () => {
    const items = [{ kind: "assistant", text: "# Step 1 of 2 — a" }, { kind: "user", text: "Next" }, { kind: "assistant", text: "# Step 2 of 2 — b" }];
    expect([livePage(items, 0), livePage(items, 2)]).toEqual([false, true]);
    expect(livePage([{ kind: "assistant", text: "# Step 1 of 2 — a" }, { kind: "assistant", text: "A question answered in discussion." }], 0)).toBe(true);
  });
});

describe("the little markdown", () => {
  it("reads code, bold, italic and links, and leaves unmatched marks as text", () => {
    expect(parseInline("run `npm test` **now** and *then* see [docs](https://a.b/c)")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "npm test" },
      { kind: "text", text: " " },
      { kind: "bold", text: "now" },
      { kind: "text", text: " and " },
      { kind: "italic", text: "then" },
      { kind: "text", text: " see " },
      { kind: "link", text: "docs", url: "https://a.b/c" },
    ]);
    expect(parseInline("2 * 3 = 6 and snake_case_name")).toEqual([{ kind: "text", text: "2 * 3 = 6 and snake_case_name" }]);
    expect(parseInline("a `b")).toEqual([{ kind: "text", text: "a `b" }]);
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ kind: "text", text: "[x](javascript:alert(1))" }]);
  });

  it("reads headings, paragraphs, lists, quotes and fenced code", () => {
    const blocks = parseMarkdown("## Plan\nfirst line\nsecond line\n\n- one\n- **two**\n\n1. a\n2. b\n\n> quoted\n> more\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\nafter");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "list", "quote", "code", "paragraph"]);
    expect(blocks[1]).toEqual({ kind: "paragraph", spans: [{ kind: "text", text: "first line second line" }] });
    expect(blocks[2]).toMatchObject({ ordered: false, items: [[{ kind: "text", text: "one" }], [{ kind: "bold", text: "two" }]] });
    expect(blocks[3]).toMatchObject({ ordered: true });
    expect(blocks[5]).toEqual({ kind: "code", lang: "ts", text: "const x = 1;\n\nconst y = 2;" });
  });

  it("reads a table: its header, the alignment from the dashes, and its rows, with marks inside cells", () => {
    const [table] = parseMarkdown("| Name | Count | Note |\n|:--|--:|:-:|\n| `npm test` | **412** | passed |\n| lint | 0 | ok |");
    expect(table).toMatchObject({ kind: "table", align: ["left", "right", "center"] });
    const t = table as Extract<Block, { kind: "table" }>;
    expect(t.head.map((c) => plainText(c))).toEqual(["Name", "Count", "Note"]);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0][0]).toEqual([{ kind: "code", text: "npm test" }]);
    expect(t.rows[0][1]).toEqual([{ kind: "bold", text: "412" }]);
    expect(t.rows[1].map((c) => plainText(c))).toEqual(["lint", "0", "ok"]);
  });

  it("reads a table without outer bars, and keeps a bar inside code or escaped as text", () => {
    const [table] = parseMarkdown("a | b\n-- | --\n`x | y` | 1 \\| 2");
    const t = table as Extract<Block, { kind: "table" }>;
    expect(t.head.map((c) => plainText(c))).toEqual(["a", "b"]);
    expect(t.rows[0].map((c) => plainText(c))).toEqual(["x | y", "1 | 2"]);
  });

  it("pads a short row and ignores the extra cells of a long one, so a table still streaming in doesn't break", () => {
    const [table] = parseMarkdown("| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |");
    const t = table as Extract<Block, { kind: "table" }>;
    expect(t.rows[0].map((c) => plainText(c))).toEqual(["1", "", ""]);
    expect(t.rows[1].map((c) => plainText(c))).toEqual(["1", "2", "3"]);
  });

  it("shows a table's header as text until the dashes under it have come, and ends it at the first line without a bar", () => {
    expect(parseMarkdown("| a | b |").map((b) => b.kind)).toEqual(["paragraph"]);
    expect(parseMarkdown("| a | b |\n|---|").map((b) => b.kind)).not.toContain("table");
    expect(parseMarkdown("| a |\n|---|\n| 1 |\n\nafter it").map((b) => b.kind)).toEqual(["table", "paragraph"]);
    expect(parseMarkdown("| a |\n|---|").map((b) => b.kind)).toEqual(["table"]);
  });

  it("reads a rule, and keeps a dash list a list", () => {
    expect(parseMarkdown("before\n\n---\n\nafter").map((b) => b.kind)).toEqual(["paragraph", "rule", "paragraph"]);
    expect(parseMarkdown("***").map((b) => b.kind)).toEqual(["rule"]);
    expect(parseMarkdown("- one\n- two").map((b) => b.kind)).toEqual(["list"]);
  });

  it("reads nested lists with their depth and marks, and keeps the numbers the message gave", () => {
    const [list] = parseMarkdown("1. first\n   - inner a\n   - inner b\n     - deeper\n2. second");
    const l = list as Extract<Block, { kind: "list" }>;
    expect(l.meta.map((m) => [m.depth, m.marker])).toEqual([[0, "1."], [1, "◦"], [1, "◦"], [2, "▪"], [0, "2."]]);
    expect(l.items.map((i) => plainText(i))).toEqual(["first", "inner a", "inner b", "deeper", "second"]);
  });

  it("keeps a loose numbered list (blank lines between items) as one list, not many starting at 1", () => {
    const blocks = parseMarkdown("1. one\n\n2. two\n\n3. three");
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as Extract<Block, { kind: "list" }>).meta.map((m) => m.marker)).toEqual(["1.", "2.", "3."]);
  });

  it("goes on with an indented line under an item, and ends the list at text that isn't", () => {
    const blocks = parseMarkdown("- first item\n  carries on here\n- second\nplain text");
    expect(blocks.map((b) => b.kind)).toEqual(["list", "paragraph"]);
    expect(plainText((blocks[0] as Extract<Block, { kind: "list" }>).items[0])).toBe("first item carries on here");
  });

  it("reads task boxes, ticked or not", () => {
    const [list] = parseMarkdown("- [ ] write it\n- [x] test it\n- [X] ship it\n- plain");
    const l = list as Extract<Block, { kind: "list" }>;
    expect(l.meta.map((m) => m.checked)).toEqual([false, true, true, null]);
    expect(l.items.map((i) => plainText(i))).toEqual(["write it", "test it", "ship it", "plain"]);
  });

  it("starts another list when the kind changes at the list's own level", () => {
    expect(parseMarkdown("- a\n\n1. b").map((b) => b.kind)).toEqual(["list", "list"]);
  });

  it("reads strikethrough, marks inside marks, and bare links without the full stop after them", () => {
    expect(parseInline("~~old~~ **bold `code`** *it's `x`*")).toEqual([
      { kind: "strike", text: "old" },
      { kind: "text", text: " " },
      { kind: "bold", text: "bold `code`", spans: [{ kind: "text", text: "bold " }, { kind: "code", text: "code" }] },
      { kind: "text", text: " " },
      { kind: "italic", text: "it's `x`", spans: [{ kind: "text", text: "it's " }, { kind: "code", text: "x" }] },
    ]);
    expect(parseInline("see https://example.com/a?b=1, then (https://x.dev/y).")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "https://example.com/a?b=1", url: "https://example.com/a?b=1" },
      { kind: "text", text: ", then (" },
      { kind: "link", text: "https://x.dev/y", url: "https://x.dev/y" },
      { kind: "text", text: ")." },
    ]);
    expect(parseInline("snake__case__name and a ~ b")).toEqual([{ kind: "text", text: "snake__case__name and a ~ b" }]);
  });

  it("takes an unterminated code block to the end, and an empty message to nothing", () => {
    expect(parseMarkdown("```\nopen")).toEqual([{ kind: "code", lang: "", text: "open" }]);
    expect(parseMarkdown("")).toEqual([]);
  });
});
