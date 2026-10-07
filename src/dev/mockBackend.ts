// Dev-only fake backend so the UI can be designed in a plain browser: `npm run dev`, then open /?mock.
// It answers the app's Tauri commands and plays a scripted Claude turn. Never imported in production builds.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { McpServer, SkillEntry, UiEvent } from "../types";

const FOLDER = "/Users/you/projects/acme-api";
const FILE = `${FOLDER}/src/client/retry.ts`;
// With &more the demo turn also writes a test file and hits a failing typecheck, for the file tabs and failure count.
const MORE = new URLSearchParams(location.search).has("more");
const TEST_FILE = `${FOLDER}/src/client/retry.test.ts`;
const TEST_SOURCE = `import { fetchJson } from "./retry";\n\ntest("retries 503 twice then succeeds", async () => {\n  mockFetch([503, 503, 200]);\n  await expect(fetchJson("/x")).resolves.toEqual({});\n});\n`;

const ORIGINAL = `export async function fetchJson(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  return res.json();
}
`;

const CURRENT = `const RETRYABLE = new Set([429, 502, 503, 504]);

export async function fetchJson(url: string, attempts = 3) {
  for (let i = 1; ; i++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (!RETRYABLE.has(res.status) || i === attempts) throw new Error(\`HTTP \${res.status}\`);
    await new Promise((r) => setTimeout(r, 250 * 2 ** i));
  }
}
`;

// A small fake project for the Files tab: directory path → entries (a trailing "/" marks a folder).
const TREE: Record<string, string[]> = {
  [FOLDER]: ["src/", "test/", ".gitignore", "package.json", "README.md", "tsconfig.json"],
  [`${FOLDER}/src`]: ["client/", "server/", "index.ts"],
  [`${FOLDER}/src/client`]: ["index.ts", "retry.ts"],
  [`${FOLDER}/src/server`]: ["app.ts", "routes.ts"],
  [`${FOLDER}/test`]: ["retry.test.ts"],
};

function listDir(dir: string) {
  return (TREE[dir] ?? []).map((name) => ({ name: name.replace(/\/$/, ""), path: `${dir}/${name.replace(/\/$/, "")}`, dir: name.endsWith("/") }));
}

const sleep =(ms: number) => new Promise((r) => setTimeout(r, ms));
// Events carry their chat's slot, like the real backend's.
const sendTo = (slot: string) => (event: UiEvent) => emit("ui-event", { slot, event });
type Send = ReturnType<typeof sendTo>;

async function streamText(send: Send, blockId: string, text: string) {
  for (const word of text.split(/(?<= )/)) {
    await send({ kind: "text_delta", parent: null, block_id: blockId, text: word });
    await sleep(25);
  }
  await send({ kind: "assistant_text", parent: null, block_id: blockId, text });
}

const pendingPermission: Record<string, (allow: boolean) => void> = {};

// A few of what the real `initialize` reply lists: built-ins, and user skills with their "(user)" tag.
const COMMANDS = [
  { name: "compact", description: "Clear conversation history but keep a summary in context", argument_hint: "<optional custom summarization instructions>" },
  { name: "context", description: "Visualize current context usage as a colored grid", argument_hint: "" },
  { name: "clear", description: "Clear conversation history and free up context", argument_hint: "" },
  { name: "code-review", description: "Review the current diff for correctness bugs", argument_hint: "[level]" },
  { name: "config", description: "Open the settings panel", argument_hint: "" },
  { name: "grill-me", description: "Interview the user relentlessly about a plan or design until reaching shared understanding (user)", argument_hint: "" },
  { name: "superpowers:brainstorming", description: "You MUST use this before any creative work - creating features, building components (plugin)", argument_hint: "" },
  { name: "pr-description", description: "Write a short, human-sounding pull request description from the real commits (user)", argument_hint: "" },
  { name: "superpowers:systematic-debugging", description: "Use when encountering any bug or test failure, before proposing fixes (plugin)", argument_hint: "" },
  { name: "mcp__claude_ai_Linear__triage", description: "Triage new issues into the right team (MCP)", argument_hint: "" },
];

// The real initialize reply's model list (CLI 2.1.284, trimmed): recommended picks first, then older versions.
const MODELS = [
  { value: "default", resolved_model: "claude-opus-5-5", display_name: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", effort_levels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus", resolved_model: "claude-opus-5-5", display_name: "Opus 5.5", description: "For complex work and everyday tasks", effort_levels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-fable-5-1", resolved_model: "claude-fable-5-1", display_name: "Fable 5.1", description: "For your toughest challenges", effort_levels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", resolved_model: "claude-sonnet-5-5", display_name: "Sonnet 5.5", description: "Most efficient for simpler tasks", effort_levels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "haiku", resolved_model: "claude-haiku-4-5-20251001", display_name: "Haiku 4.5", description: "Fastest for quick answers", effort_levels: [] },
  { value: "claude-fable-5", resolved_model: "claude-fable-5", display_name: "Fable 5", description: "Most capable for your hardest and longest-running tasks", effort_levels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-opus-4-8", resolved_model: "claude-opus-4-8", display_name: "Opus 4.8", description: "Best for everyday, complex tasks", effort_levels: ["low", "medium", "high", "xhigh", "max"] },
];

// Each chat's permission mode, as the backend would run it.
const slotMode: Record<string, string> = {};

/** Step by step's Debug: hypotheses, a round of evidence with the reproduce card, the fix, then done; Next moves on. */
async function playDebug(slot: string, text: string) {
  const send = sendTo(slot);
  const done = () => send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, duration_ms: 2400, auth_hint: false, denied: 0, context_window: 200_000 });
  const moves = /^(next|ok|yes|start)/i.test(text.trim());
  const n = stepPage[slot] === undefined ? 0 : moves ? stepPage[slot] + 1 : stepPage[slot];
  stepPage[slot] = n;
  if (n === 0) {
    await streamText(send, `db0-${Date.now()}:0`, "# Frame — Saving a todo reloads the page and loses it\n\nClicking **Save** clears the list instead of adding to it.\n\n**Likely causes, most likely first:**\n\n1. The form submits natively, so the page reloads.\n2. The list re-renders from empty state after the save.");
    return done();
  }
  if (n === 1) {
    await send({ kind: "tool_started", parent: null, tool_use_id: `d2-${slot}`, name: "Edit", summary: FILE });
    await sleep(300);
    await send({ kind: "tool_finished", parent: null, tool_use_id: `d2-${slot}`, is_error: false, output: "updated" });
    await send({ kind: "tool_started", parent: null, tool_use_id: `d3-${slot}`, name: "mcp__lantern__reproduce", summary: "" });
    const steps = "1. Open `index.html` with DevTools open, **Console** tab, and **Preserve log** on.\n2. Type a title and click **Save**.\n3. Paste the lines starting with `[lantern-debug]`.";
    await send({ kind: "permission_requested", request_id: `repro-${slot}`, tool_name: "Reproduce", input: { steps } });
    await new Promise<boolean>((resolve) => (pendingPermission[slot] = resolve));
    await send({ kind: "tool_finished", parent: null, tool_use_id: `d3-${slot}`, is_error: false, output: "The user reproduced the problem." });
    await streamText(send, `db1-${Date.now()}:0`, "# Evidence 1 — Does the page reload on Save?\n\nI logged the submit handler and page load, marked `lantern-debug`.\n\n**What the logs show:** the handler runs, then the page loads again.\n\n- Cause 1 (native submit): **confirmed**.\n- Cause 2 (re-render from empty): ruled out; the list is never re-rendered before the reload.");
    return done();
  }
  const pages = [
    "# Fix — Stop the form's native submit\n\n- `src/app.ts:14`: `e.preventDefault()` at the top of the submit handler.\n\nReproduced again: the todo stays and the page doesn't reload.",
    "# Done — The form submitted natively and reloaded the page\n\nThe temporary logs are removed (no `lantern-debug` left). The fix is the one line in `src/app.ts`.",
  ];
  await streamText(send, `db${n}-${Date.now()}:0`, pages[Math.min(n - 2, pages.length - 1)]);
  return done();
}

/** Step by step: the flavour each chat is in, what Claude suggested, and the task it was suggested for. */
const flavourOfSlot: Record<string, string> = {};
const suggestedFor: Record<string, { flavour: string; task: string }> = {};
const LABEL: Record<string, string> = { build: "Build", learn: "Learn", review: "Review", debug: "Debug" };

/** What Claude would suggest for a task. */
function suggestionFor(text: string): { flavour: string; why: string } {
  if (/\breview\b|\bPR\b|pull request/i.test(text)) return { flavour: "review", why: "you asked for a review of a change" };
  if (/crash|bug|broken|fails|error|wrong|reload|loses/i.test(text)) return { flavour: "debug", why: "this is a bug, so the cause comes first" };
  if (/learn|teach|interview|understand|exam|test prep/i.test(text)) return { flavour: "learn", why: "you said you want to learn this" };
  return { flavour: "build", why: "it's something to add, one step at a time" };
}

/**
 * Step by step: Claude suggests a flavour and waits; "Start X." plays that flavour's pages from the task; a flavour you
 * picked comes as a note and starts without asking; a bug reported during a build gets Debug suggested.
 */
async function playStepByStep(slot: string, raw: string) {
  const send = sendTo(slot);
  const done = () => send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, duration_ms: 1400, auth_hint: false, denied: 0, context_window: 200_000 });
  const note = /^\[Lantern: this chat switched to (Build|Learn|Review|Debug)\b[^\]]*\]\s*/.exec(raw);
  const text = note ? raw.slice(note[0].length) : raw;
  if (stepPage[slot] === undefined && flavourOfSlot[slot] === undefined && !note) {
    await send({ kind: "session_started", session_id: `mock-${slot}`, model: "claude-opus-5-5", cwd: FOLDER, permission_mode: "acceptEdits", claude_version: "2.1.284" });
  }
  const start = /^start (build|learn|review|debug)\b/i.exec(text.trim());
  let task = text;
  if (note) {
    flavourOfSlot[slot] = note[1].toLowerCase();
    delete stepPage[slot];
  } else if (start && suggestedFor[slot]) {
    flavourOfSlot[slot] = start[1].toLowerCase();
    task = suggestedFor[slot].task;
    delete suggestedFor[slot];
    delete stepPage[slot];
  } else if (/^stay in/i.test(text.trim()) && suggestedFor[slot]) {
    delete suggestedFor[slot];
    task = "Next";
  } else {
    const fresh = flavourOfSlot[slot] === undefined;
    const s = suggestionFor(text);
    const changes = !fresh && !/^(next|ok|yes)/i.test(text.trim()) && s.flavour === "debug" && flavourOfSlot[slot] !== "debug";
    if (fresh || changes) {
      suggestedFor[slot] = { flavour: s.flavour, task: text };
      await sleep(300);
      await streamText(send, `sw-${Date.now()}:0`, `# Switch to ${LABEL[s.flavour]} — ${s.why}\n\n${s.flavour === "debug" ? "I'd find the cause from evidence before changing anything: likely causes first, then logs and a reproduction." : s.flavour === "review" ? "I'd read it one file at a time, with findings you can agree with or reject." : s.flavour === "learn" ? "I'd build it with you step by step, explaining the why of each step." : "I'd frame it, plan it one step at a time, then build each step when you say Next."}`);
      return done();
    }
  }
  const flavour = flavourOfSlot[slot];
  if (flavour === "debug") return playDebug(slot, task);
  if (flavour === "review") return playReview(slot, task);
  return playSteps(slot, task, flavour === "learn");
}

/** Step-by-step mode: each message sent gets the next page of a scripted incremental-dev session. */
const stepPage: Record<string, number> = {};
const turnCount: Record<string, number> = {};
async function playSteps(slot: string, text: string, teach: boolean) {
  const send = sendTo(slot);
  // "…go on to the next step." is what ⌘Enter adds: do the change, then move on.
  const approved = /^(next|ok|yes)/i.test(text.trim()) || text.includes("this step is approved");
  if (!approved && text.trim().endsWith("?") && stepPage[slot] !== undefined) {
    // A question about the step: answered without a heading, so it stays on the page.
    await streamText(send, `sq-${Date.now()}:0`, "Good question. A `Set` keeps the check to one `has()` call and names the policy in one place; a range check would also retry 500 and 501, which usually aren't transient.");
    return send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, duration_ms: 1200, auth_hint: false, denied: 0, context_window: 200_000 });
  }
  const n = stepPage[slot] === undefined ? 0 : approved ? stepPage[slot] + 1 : stepPage[slot];
  stepPage[slot] = n;
  const why = teach ? "\n\n### Why this way\n\nA `Set` makes the check a single `has()` call, and keeping the codes in one named place means the policy reads at a glance. An alternative is a range check (`status >= 500`), but that would also retry 500 and 501, which usually aren't transient." : "";
  const done = () => send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, duration_ms: 2400, auth_hint: false, denied: 0, context_window: 200_000 });
  if (n === 0) {
    await send({ kind: "session_started", session_id: `mock-${slot}`, model: "claude-opus-5-5", cwd: FOLDER, permission_mode: "acceptEdits", claude_version: "2.1.284" });
    await send({ kind: "tool_started", parent: null, tool_use_id: "s0a", name: "Skill", summary: "incremental-dev" });
    await sleep(200);
    await send({ kind: "tool_finished", parent: null, tool_use_id: "s0a", is_error: false, output: "loaded" });
    await send({ kind: "tool_started", parent: null, tool_use_id: "s0b", name: "Read", summary: FILE });
    await sleep(200);
    await send({ kind: "tool_finished", parent: null, tool_use_id: "s0b", is_error: false, output: ORIGINAL });
  }
  const pages = [
    `# Frame — Retry transient errors in fetchJson\n\n**Task:** make \`fetchJson\` retry 429 and gateway errors with exponential backoff. Done when a 503 twice then 200 resolves, and a 404 throws at once.\n\n**Tech spec:** none covers this (I checked \`README.md\` and \`docs/\`).\n\n> [!WARNING]\n> Retrying a POST can repeat its side effect. This change only retries GETs.\n\n**Question:** should the number of attempts be configurable? I'd default it to 3 with an optional argument.`,
    `# Plan step 1 — Name the retryable statuses\n\n\`\`\`\nFile:   src/client/retry.ts\nChange: Add RETRYABLE = new Set([429, 502, 503, 504]) above fetchJson.\nVerify: a unit test that 404 isn't in it and 503 is.\n\`\`\`${why}`,
    `# Plan step 2 — Retry with backoff\n\n\`\`\`\nFile:   src/client/retry.ts\nChange: Loop up to \`attempts\` (default 3), return on res.ok, wait 250·2^i ms between tries.\nVerify: 503, 503, 200 resolves; 404 throws on the first try; the last failure is rethrown.\n\`\`\``,
    `# Plan complete — 2 steps\n\n1. Name the retryable statuses\n2. Retry with backoff\n\nPlan complete, 2 steps. Starting step 1?`,
    `# Step 1 of 2 — Name the retryable statuses\n\n- \`src/client/retry.ts:1\`: added \`RETRYABLE\`.\n\n\`\`\`ts\nconst RETRYABLE = new Set([429, 502, 503, 504]);\n\`\`\`\n\n> [!NOTE]\n> 500 and 501 are left out on purpose: they usually aren't transient.${why}`,
    `# Step 2 of 2 — Retry with backoff\n\n- \`src/client/retry.ts:3-10\`: the retry loop.\n\nThe retry tests pass.`,
    `# Done — fetchJson retries transient errors\n\nBoth steps are in and the retry tests pass.`,
  ];
  const page = pages[Math.min(n, pages.length - 1)];
  if (n === 4 || n === 5) {
    const id = `se${n}`;
    await send({ kind: "tool_started", parent: null, tool_use_id: id, name: "Edit", summary: FILE });
    await sleep(300);
    const hunks =
      n === 4
        ? [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 3, lines: ["+const RETRYABLE = new Set([429, 502, 503, 504]);", "+", " export async function fetchJson(url: string) {"] }]
        : [{ old_start: 3, old_lines: 4, new_start: 3, new_lines: 8, lines: ["-export async function fetchJson(url: string) {", "-  const res = await fetch(url);", "+export async function fetchJson(url: string, attempts = 3) {", "+  for (let i = 1; ; i++) {", "+    const res = await fetch(url);", "+    if (res.ok) return res.json();", "+    if (!RETRYABLE.has(res.status) || i === attempts) throw new Error(`HTTP ${res.status}`);", "+    await new Promise((r) => setTimeout(r, 250 * 2 ** i));", "+  }"] }];
    await send({ kind: "edit_applied", parent: null, tool_use_id: id, path: FILE, created: false, hunks });
    await send({ kind: "tool_finished", parent: null, tool_use_id: id, is_error: false, output: "updated" });
    if (n === 5) {
      // A look around (left out of the page's Commands) and the test run (listed).
      for (const [cid, command, output] of [["sc1", "cat src/client/retry.ts", ORIGINAL], ["sc2", "npm test -- retry", "PASS src/client/retry.test.ts\n  ✓ retries 503 twice then succeeds (12 ms)"]]) {
        await send({ kind: "tool_started", parent: null, tool_use_id: `${cid}-${slot}`, name: "Bash", summary: command });
        await sleep(200);
        await send({ kind: "tool_finished", parent: null, tool_use_id: `${cid}-${slot}`, is_error: false, output });
      }
      // A dev server left running in the background, as run_in_background does.
      const dev = `sc3-${slot}`;
      await send({ kind: "tool_started", parent: null, tool_use_id: dev, name: "Bash", summary: "npm run dev -- --port 5173" });
      await send({ kind: "background_tasks", tasks: [{ id: "bstep", task_type: "local_bash", description: "npm run dev -- --port 5173" }] });
      await send({ kind: "task_started", task_id: "bstep", tool_use_id: dev });
      await send({ kind: "tool_finished", parent: null, tool_use_id: dev, is_error: false, output: "Command running in background with ID: bstep." });
    }
  }
  await streamText(send, `sp${n}-${Date.now()}:0`, approved || n === 0 ? page : page.replace(/\n\n/, `\n\nRevised: ${text.trim()}\n\n`));
  await done();
}

const reviewAsk: Record<string, string> = {};
/** Review mode: an incremental-pr-review of a two-file PR, a file per message; any Next moves on. */
async function playReview(slot: string, text: string) {
  const send = sendTo(slot);
  const moves = /^next/i.test(text.trim());
  if (!moves && stepPage[slot] !== undefined) {
    await streamText(send, `rq-${Date.now()}:0`, "Only if the server sends `Retry-After`; otherwise the backoff is the fallback.");
    return send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, duration_ms: 1200, auth_hint: false, denied: 0, context_window: 200_000 });
  }
  const n = stepPage[slot] === undefined ? 0 : stepPage[slot] + 1;
  stepPage[slot] = n;
  if (n === 0) reviewAsk[slot] = text;
  if (n === 0) {
    await send({ kind: "session_started", session_id: `mock-${slot}`, model: "claude-opus-5-5", cwd: FOLDER, permission_mode: "acceptEdits", claude_version: "2.1.284" });
    await send({ kind: "tool_started", parent: null, tool_use_id: "r0a", name: "Skill", summary: "incremental-pr-review" });
    await sleep(200);
    await send({ kind: "tool_finished", parent: null, tool_use_id: "r0a", is_error: false, output: "loaded" });
    await send({ kind: "tool_started", parent: null, tool_use_id: "r0b", name: "Bash", summary: "gh pr diff 128" });
    await sleep(200);
    await send({ kind: "tool_finished", parent: null, tool_use_id: "r0b", is_error: false, output: "diff --git a/src/client/retry.ts b/src/client/retry.ts" });
  }
  const pages = [
    "# Frame — Retry transient errors in fetchJson (#128)\n\n**Intent:** retry 429 and gateway errors with exponential backoff, up to 3 attempts.\n\n**Files, in review order:**\n\n1. `src/client/retry.ts` (+14 −3), the retry loop\n2. `src/client/retry.test.ts` (+32 −0), its tests\n\nSay \"Next\" to start with the first file.",
    "# File 1 of 2 — src/client/retry.ts (+14 −3)\n\nThis is the core of the PR, so I read it against `fetch`'s behaviour on network errors too.\n\n### What changed\n\n- `RETRYABLE` names 429, 502, 503 and 504.\n- `fetchJson` takes `attempts = 3` and loops, waiting `250·2^i` ms between tries.\n\n### Findings\n\n⚠ line 7 (blocker): a network error (`fetch` rejecting) isn't retried; it escapes the loop on the first try, which is the most common transient failure.\n\n⚠ line 9 (should-fix): the first wait is 500 ms, not 250, because `i` starts at 1. Use `2 ** (i - 1)`.\n\n⚠ line 3 (nit): `attempts` reads better as `maxAttempts`.\n\n### Notes\n\n**Retry-After:** a 429 usually says how long to wait. Not required for this PR, but worth a follow-up.\n\nSay \"Next\" to go on, or tell me which findings to drop.",
    "# File 2 of 2 — src/client/retry.test.ts (+32 −0)\n\n### What changed\n\n- Tests for 503, 503, 200 resolving and 404 throwing at once.\n\n### Findings\n\nNone.\n\n### Notes\n\n**What I checked:** fake timers are restored after each test, and the 404 case asserts a single `fetch` call.",
    "# Summary — 2 files reviewed\n\nThe loop is right in shape; the network-error gap is the one thing to fix before merging.",
  ];
  // A local branch (no PR named): Claude writes the skill's own format, "## Frame" and a bold line per file.
  if (!/\bPR\b|\/pull\//i.test(reviewAsk[slot] ?? text)) {
    const skillFormat = pages.map((pg) =>
      pg
        .replace(/^# Frame — .*$/m, "## Frame")
        .replace(/^# File \d+ of \d+ — (\S+) (\(.*\))$/m, "**$1** $2")
        .replace(/^# Summary — (.*)$/m, "**Summary** $1"),
    );
    pages.splice(0, pages.length, ...skillFormat);
  }
  await streamText(send, `rp${n}-${Date.now()}:0`, pages[Math.min(n, pages.length - 1)]);
  await send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, duration_ms: 2400, auth_hint: false, denied: 0, context_window: 200_000 });
}

/** Each chat's background tasks, as claude would list them. */
const mockTasks: Record<string, { id: string; task_type: string; description: string }[]> = {};

/** Built-in commands answer at once without calling the model, like the real CLI in stream-json mode. */
async function playCommand(slot: string, text: string) {
  const send = sendTo(slot);
  const done = () => send({ kind: "turn_done", is_error: false, result: "", cost_usd: null, duration_ms: 40, auth_hint: false, denied: 0, context_window: null });
  if (text === "/clear") {
    await send({ kind: "conversation_reset" });
    return done();
  }
  await sleep(200);
  await send({ kind: "assistant_text", parent: null, block_id: `cmd-${Date.now()}:0`, text: "## Context Usage\n\n**Tokens:** 61k / 200k (31%)\n\n| Category | Tokens | Percentage |\n|---|---|---|\n| System prompt | 3.1k | 1.6% |\n| Tools | 14.2k | 7.1% |\n| Messages | 43.9k | 22.0% |" });
  done();
}

async function playTurn(slot: string) {
  const send = sendTo(slot);
  await send({ kind: "session_started", session_id: `mock-${slot}`, model: "claude-opus-5-5", cwd: FOLDER, permission_mode: "acceptEdits", claude_version: "2.1.284" });
  await send({ kind: "thinking", parent: null });
  await sleep(600);
  await streamText(send, "m1:0", "I'll add retries with exponential backoff to `fetchJson`, limited to status codes that are safe to retry.");
  for (const [id, name, summary] of [
    ["t1", "Read", `${FOLDER}/src/client/retry.ts`],
    ["t2", "Grep", "fetchJson"],
    ["t3", "Read", `${FOLDER}/src/client/index.ts`],
  ]) {
    await send({ kind: "tool_started", parent: null, tool_use_id: id, name, summary });
    await sleep(250);
    await send({ kind: "tool_finished", parent: null, tool_use_id: id, is_error: false, output: "ok" });
  }
  await send({ kind: "tool_started", parent: null, tool_use_id: "t4", name: "Edit", summary: FILE });
  await sleep(300);
  await send({
    kind: "edit_applied",
    parent: null,
    tool_use_id: "t4",
    path: FILE,
    created: false,
    hunks: [{ old_start: 1, old_lines: 5, new_start: 1, new_lines: 10, lines: ["+const RETRYABLE = new Set([429, 502, 503, 504]);", "+", "-export async function fetchJson(url: string) {", "-  const res = await fetch(url);", "-  if (!res.ok) throw new Error(`HTTP ${res.status}`);", "-  return res.json();", "+export async function fetchJson(url: string, attempts = 3) {", "+  for (let i = 1; ; i++) {", "+    const res = await fetch(url);", "+    if (res.ok) return res.json();", "+    if (!RETRYABLE.has(res.status) || i === attempts) throw new Error(`HTTP ${res.status}`);", "+    await new Promise((r) => setTimeout(r, 250 * 2 ** i));", "+  }", " }"] }],
  });
  await send({ kind: "tool_finished", parent: null, tool_use_id: "t4", is_error: false, output: "updated" });
  if (MORE) {
    await send({ kind: "tool_started", parent: null, tool_use_id: "t4b", name: "Write", summary: TEST_FILE });
    await sleep(250);
    await send({ kind: "edit_applied", parent: null, tool_use_id: "t4b", path: TEST_FILE, created: true, hunks: [{ old_start: 0, old_lines: 0, new_start: 1, new_lines: 6, lines: TEST_SOURCE.trimEnd().split("\n").map((l) => `+${l}`) }] });
    await send({ kind: "tool_finished", parent: null, tool_use_id: "t4b", is_error: false, output: "created" });
    await send({ kind: "tool_started", parent: null, tool_use_id: "t4c", name: "Bash", summary: "npx tsc --noEmit" });
    await sleep(400);
    await send({ kind: "tool_finished", parent: null, tool_use_id: "t4c", is_error: true, output: "src/client/retry.test.ts(4,3): error TS2304: Cannot find name 'mockFetch'." });
    // A first test run with a failure, so the Tests tab has something to compare the passing rerun with.
    await send({ kind: "tool_started", parent: null, tool_use_id: "t4d", name: "Bash", summary: "npx vitest run src/client" });
    await sleep(400);
    await send({ kind: "tool_finished", parent: null, tool_use_id: "t4d", is_error: true, output: " ❯ src/client/retry.test.ts (3 tests | 1 failed) 14ms" });
    await send({
      kind: "test_run",
      parent: null,
      tool_use_id: "t4d",
      command: "npx vitest run src/client",
      run: {
        framework: "vitest",
        outcome: "failed",
        passed: 2,
        failed: 1,
        skipped: 1,
        duration_ms: 1240,
        cases: [
          { name: "does not retry 404", suite: "fetchJson", status: "passed", duration_ms: 2, message: null, location: null },
          { name: "gives up after 3 attempts", suite: "fetchJson", status: "passed", duration_ms: 3, message: null, location: null },
          { name: "retries 503 twice then succeeds", suite: "fetchJson", status: "failed", duration_ms: 9, message: "ReferenceError: mockFetch is not defined", location: "src/client/retry.test.ts:4" },
          { name: "honours Retry-After", suite: "fetchJson", status: "skipped", duration_ms: null, message: null, location: null },
        ],
        tail: " FAIL  src/client/retry.test.ts > fetchJson > retries 503 twice then succeeds\nReferenceError: mockFetch is not defined\n ❯ src/client/retry.test.ts:4:3\n\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed | 1 skipped (4)",
      },
    });
  }
  await send({ kind: "permission_requested", request_id: "perm-1", tool_name: "Bash", input: { command: "npm test -- retry" } });
  const allowed = await new Promise<boolean>((resolve) => (pendingPermission[slot] = resolve));
  if (allowed) {
    await send({ kind: "tool_started", parent: null, tool_use_id: "t5", name: "Bash", summary: "npm test -- retry" });
    await sleep(700);
    await send({ kind: "tool_finished", parent: null, tool_use_id: "t5", is_error: false, output: "PASS src/client/retry.test.ts\n  ✓ retries 503 twice then succeeds (12 ms)\n  ✓ does not retry 404 (2 ms)" });
    await send({
      kind: "test_run",
      parent: null,
      tool_use_id: "t5",
      command: "npm test -- retry",
      run: {
        framework: "vitest",
        outcome: "passed",
        passed: 3,
        failed: 0,
        skipped: 1,
        duration_ms: 980,
        cases: [
          { name: "retries 503 twice then succeeds", suite: "fetchJson", status: "passed", duration_ms: 12, message: null, location: null },
          { name: "does not retry 404", suite: "fetchJson", status: "passed", duration_ms: 2, message: null, location: null },
          { name: "gives up after 3 attempts", suite: "fetchJson", status: "passed", duration_ms: 3, message: null, location: null },
        ],
        tail: " ✓ src/client/retry.test.ts (4 tests | 1 skipped) 12ms\n\n Test Files  1 passed (1)\n      Tests  3 passed | 1 skipped (4)",
      },
    });
  }
  await streamText(send, "m2:0", allowed ? "Done. `fetchJson` now retries 429 and 5xx gateway errors up to 3 times with backoff, and the retry tests pass." : "Done. I didn't run the tests since you denied it.");
  await send({ kind: "context_used", tokens: 61_480 });
  // The dev server and a watcher keep running after the turn, like run_in_background commands.
  const dev = { id: "bdev1", task_type: "local_bash", description: "npm run dev -- --port 5173" };
  const watch = { id: "bwatch", task_type: "local_bash", description: "npx vitest --watch src/client" };
  mockTasks[slot] = [dev, watch];
  await send({ kind: "background_tasks", tasks: [dev, watch] });
  await send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, duration_ms: 8200, auth_hint: false, denied: allowed ? 0 : 1, context_window: 200_000 });
  // One ends later: claude says so on its own, in a turn nobody prompted.
  if (new URLSearchParams(location.search).has("bgend")) {
    await sleep(4000);
    mockTasks[slot] = (mockTasks[slot] ?? []).filter((t) => t.id !== watch.id);
    await send({ kind: "background_tasks", tasks: mockTasks[slot] });
    await streamText(send, `bg-${Date.now()}:0`, "The watcher exited: all 4 retry tests still pass.");
    await send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, duration_ms: 900, auth_hint: false, denied: 0, context_window: 200_000 });
  }
}

const HOUR = 3_600_000;
const SESSIONS = [
  { id: "3f1c2a", title: "Fix the login redirect after OAuth callback", updated_ms: Date.now() - 2 * HOUR, prompts: 6 },
  { id: "9b7e01", title: "Add retries with backoff to fetchJson", updated_ms: Date.now() - 26 * HOUR, prompts: 3 },
  { id: "c0ffee", title: "Refactor the settings screen into smaller components", updated_ms: Date.now() - 4 * 24 * HOUR, prompts: 11 },
];

// Long enough that a turn needs scrolling, so the pinned prompt header can be seen.
const LONG_REPLY = Array.from({ length: 8 }, (_, i) => `**Step ${i + 1}.** Retrying only idempotent requests keeps side effects safe; the delay doubles each attempt and is capped so a slow upstream can't stall the UI for long. Tests cover 429, 502, 503 and 504, and assert that 4xx errors other than 429 fail immediately.`).join("\n\n");

// A past session's replayed events, as the backend's open_session would return them.
const REPLAY: UiEvent[] = [
  { kind: "user_text", text: "Add retries with backoff to fetchJson for transient errors" },
  { kind: "assistant_text", parent: null, block_id: "r1", text: "I'll add retries limited to 429 and 5xx gateway errors." },
  { kind: "tool_started", parent: null, tool_use_id: "r2", name: "Read", summary: FILE },
  { kind: "tool_finished", parent: null, tool_use_id: "r2", is_error: false, output: "ok" },
  { kind: "tool_started", parent: null, tool_use_id: "r3", name: "Edit", summary: FILE },
  { kind: "edit_applied", parent: null, tool_use_id: "r3", path: FILE, created: false, hunks: [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 2, lines: ["+const RETRYABLE = new Set([429, 502, 503, 504]);", " export async function fetchJson(url: string) {"] }] },
  { kind: "tool_finished", parent: null, tool_use_id: "r3", is_error: false, output: "updated" },
  { kind: "assistant_text", parent: null, block_id: "r4", text: "Done. `fetchJson` now retries up to 3 times.\n\n" + LONG_REPLY },
  { kind: "user_text", text: "Should the backoff have jitter so clients don't retry in lockstep?" },
  { kind: "assistant_text", parent: null, block_id: "r5", text: "Yes — adding full jitter.\n\n" + LONG_REPLY },
];

// /?mock=demo drives the UI by itself (open folder, send a message) so headless screenshots show a real turn;
// /?mock=ready stops after opening the folder; /?mock=history opens the folder and then the history menu.
// Add &allow to also approve the permission prompt and finish the turn.
function autoplay(allow: boolean, openOnly: boolean, history = false) {
  const until = async <T,>(find: () => T | null | undefined): Promise<T> => {
    for (;;) {
      const found = find();
      if (found) return found;
      await sleep(50);
    }
  };
  void (async () => {
    if (new URLSearchParams(location.search).has("folders")) return;
    (await until(() => document.querySelector<HTMLButtonElement>(".composer-pills .pill"))).click();
    (await until(() => [...document.querySelectorAll<HTMLButtonElement>(".folder-menu .menu-row")].find((b) => b.textContent === "Open folder…"))).click();
    if (history) {
      const pill = new URLSearchParams(location.search).has("pill");
      const selector = pill ? '.composer-pills .pill[title="Continue a past session"]:not(:disabled)' : 'button[aria-label="Session history"]:not(:disabled)';
      (await until(() => document.querySelector<HTMLButtonElement>(selector))).click();
      return;
    }
    if (openOnly) return;
    const box = await until(() => document.querySelector<HTMLTextAreaElement>(".composer textarea:not(:disabled)"));
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setValue.call(box, "Add retries with backoff to fetchJson for transient errors, then run the retry tests.");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(50);
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    if (allow) (await until(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Allow"))).click();
  })();
}

/** Commands the user runs from the chat box, while they stream: how to stop each. */
const mockShells: Record<string, () => void> = {};

/** MCP servers in the mock: one connected, one needing a login, one failing, one still connecting. */
const mockServers: McpServer[] = [
  { name: "claude.ai Linear", status: "connected", serverInfo: { name: "Linear MCP", title: "Linear", version: "1.0.0" }, config: { type: "claudeai-proxy", url: "https://mcp.linear.app/mcp" }, scope: "claudeai", source: "claudeai" },
  { name: "sentry", status: "needs-auth", config: { type: "http", url: "https://mcp.sentry.dev/mcp", headers: { "X-Org": "acme" } }, scope: "user" },
  { name: "postgres", status: "failed", error: "Connection closed: ECONNREFUSED 127.0.0.1:5432", config: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgres://localhost/acme"], env: { PGPASSWORD: "secret" } }, scope: "local" },
  { name: "plugin:figma:figma", status: "pending", config: { type: "http", url: "https://mcp.figma.com/mcp" }, scope: "dynamic", source: "plugin" },
];
const MCP_TOOLS = ["mcp__claude_ai_Linear__list_issues", "mcp__claude_ai_Linear__create_issue", "mcp__claude_ai_Linear__update_issue", "mcp__claude_ai_Linear__list_projects"];

const MOCK_SKILLS: SkillEntry[] = [
  { name: "grill-me", kind: "skill", source: "user", plugin: null, path: "/Users/you/.claude/skills/grill-me/SKILL.md", description: "Interview the user relentlessly about a plan or design until reaching shared understanding." },
  { name: "pr-description", kind: "skill", source: "user", plugin: null, path: "/Users/you/.claude/skills/pr-description/SKILL.md", description: "Write a short, human-sounding pull request description from the real commits." },
  { name: "deploy", kind: "command", source: "project", plugin: null, path: `${FOLDER}/.claude/commands/deploy.md`, description: "Build, tag and deploy to staging" },
  { name: "superpowers:brainstorming", kind: "skill", source: "plugin", plugin: "superpowers", path: "/Users/you/.claude/plugins/cache/x/superpowers/5.0/skills/brainstorming/SKILL.md", description: "You MUST use this before any creative work: explores intent, requirements and design." },
  { name: "superpowers:systematic-debugging", kind: "skill", source: "plugin", plugin: "superpowers", path: "/Users/you/.claude/plugins/cache/x/superpowers/5.0/skills/systematic-debugging/SKILL.md", description: "Use when encountering any bug or test failure, before proposing fixes." },
];

function mockClaudeRequest(request: { subtype: string; serverName?: string; enabled?: boolean }): unknown {
  const server = mockServers.find((s) => s.name === request.serverName);
  switch (request.subtype) {
    case "mcp_status":
      // Figma finishes connecting after a moment.
      for (const s of mockServers) if (s.status === "pending") setTimeout(() => (s.status = "connected"), 2000);
      return { mcpServers: mockServers.map((s) => ({ ...s })) };
    case "mcp_toggle":
      if (server) server.status = request.enabled ? "connected" : "disabled";
      return {};
    case "mcp_reconnect":
      if (server?.name === "postgres") return Promise.reject("Connection closed: ECONNREFUSED 127.0.0.1:5432");
      return {};
    case "mcp_authenticate":
      // As if the login in the browser went through.
      if (server) setTimeout(() => (server.status = "connected"), 3000);
      return { authUrl: "https://example.com/oauth/authorize", requiresUserAction: true, callbackExpected: false };
    case "mcp_clear_auth":
      if (server) server.status = "needs-auth";
      return {};
    case "reload_plugins":
    case "reload_skills":
      return { commands: COMMANDS.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argument_hint })) };
  }
  return Promise.reject(`${request.subtype} isn't in the mock`);
}

/** Commands waiting for the user's reply in the mock: what to do with it. */
const mockReplies: Record<string, (text: string) => void> = {};

/** Interactive commands in the mock: sudo asks for a password (echo off), rm -i asks y/n. */
function playAsking(slot: string, id: string, command: string): boolean {
  const send = sendTo(slot);
  const key = `${slot}:${id}`;
  const done = (code: number | null, stopped = false) => {
    delete mockReplies[key];
    delete mockShells[key];
    void send({ kind: "shell_done", id, code, stopped });
  };
  mockShells[key] = () => done(null, true);
  if (command.startsWith("sudo")) {
    let tries = 0;
    const ask = () => {
      void send({ kind: "shell_output", id, text: "Password:" });
      setTimeout(() => void send({ kind: "shell_secret", id, secret: true }), 100);
    };
    setTimeout(ask, 150);
    mockReplies[key] = (text) => {
      void send({ kind: "shell_secret", id, secret: false });
      // Wrong the first time, like a mistyped password.
      if (tries++ === 0) setTimeout(() => (send({ kind: "shell_output", id, text: "\r\nSorry, try again.\r\n" }), ask()), 600);
      else if (text !== "\u0004") setTimeout(() => (send({ kind: "shell_output", id, text: "\r\n==> Installing redis\r\n🍺  redis was installed\r\n" }), done(0)), 400);
      else done(1);
    };
    return true;
  }
  if (command.startsWith("rm -i")) {
    const file = command.split(/\s+/).pop();
    setTimeout(() => void send({ kind: "shell_output", id, text: `remove ${file}? ` }), 150);
    mockReplies[key] = (text) => {
      void send({ kind: "shell_output", id, text: `${text.replace("\r", "")}\r\n` });
      done(text.startsWith("y") ? 0 : 1);
    };
    return true;
  }
  return false;
}

/** A few believable outputs for "!command" in the mock; anything else prints a line and fails. */
function playShell(slot: string, id: string, command: string) {
  if (playAsking(slot, id, command)) return;
  const send = sendTo(slot);
  const name = command.trim().split(/\s+/)[0];
  const scripts: Record<string, { lines: string[]; code: number; every: number; forever?: boolean }> = {
    git: { lines: ["On branch main", "Changes not staged for commit:", "  modified:   src/net/fetchJson.ts", "", "Untracked files:", "  src/net/fetchJson.test.ts"], code: 0, every: 30 },
    ls: { lines: ["README.md", "package.json", "src", "tsconfig.json"], code: 0, every: 20 },
    npm: { lines: ["> retry-demo@0.1.0 dev", "> vite", "", "  VITE v5.4.0  ready in 212 ms", "", "  ➜  Local:   http://localhost:5173/", "\x1b[2m12:01:04\x1b[0m [vite] page reload src/net/fetchJson.ts"], code: 0, every: 250, forever: true },
  };
  const script = scripts[name] ?? { lines: [`zsh: command not found: ${name}`], code: 127, every: 20 };
  let i = 0;
  const timer = setInterval(() => {
    if (i < script.lines.length) void send({ kind: "shell_output", id, text: `${script.lines[i++]}\n` });
    else if (!script.forever) finish(false);
  }, script.every);
  const finish = (stopped: boolean) => {
    clearInterval(timer);
    delete mockShells[`${slot}:${id}`];
    void send({ kind: "shell_done", id, code: stopped ? null : script.code, stopped });
  };
  mockShells[`${slot}:${id}`] = () => finish(true);
}

export function installMockBackend() {
  const mode = new URLSearchParams(location.search).get("mock");
  // ?mock = UI with no folder; ?mock=ready = folder open, empty chat; ?mock=demo = a scripted turn.
  if (mode === "demo" || mode === "ready" || mode === "history") autoplay(new URLSearchParams(location.search).has("allow"), mode === "ready", mode === "history");
  mockWindows("main");
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case "locate_claude":
          return "/Users/you/.local/bin/claude";
        case "user_name":
          return "Sam Rivera";
        case "branch_review":
          return {
            branch: "feat/retry-transient",
            base: "origin/main",
            commits: [
              { sha: "a41c9e2", subject: "test: retries and give-ups for fetchJson", author: "Sam Rivera", at: Date.now() - 40 * 60_000 },
              { sha: "7d03b1f", subject: "feat: retry transient errors in fetchJson", author: "Sam Rivera", at: Date.now() - 3 * 3_600_000 },
            ],
          };
        case "stop_task": {
          // Like claude: the task is killed and the list comes again without it.
          const slot = String(a.slot);
          const left = (mockTasks[slot] ?? []).filter((t) => t.id !== a.taskId);
          mockTasks[slot] = left;
          void sendTo(slot)({ kind: "background_tasks", tasks: left });
          return null;
        }
        case "plugin:dialog|open":
          return FOLDER;
        case "start_session":
          // A second project opens too, for switching between projects; the rest are gone.
          if (a.folder !== FOLDER && a.folder !== "/Users/you/projects/web-dashboard") return Promise.reject(`${String(a.folder)} no longer exists.`);
          slotMode[String(a.slot)] = String((a.settings as { mode?: string } | undefined)?.mode ?? "ask");
          setTimeout(() => {
            sendTo(String(a.slot))({ kind: "commands", commands: COMMANDS });
            sendTo(String(a.slot))({ kind: "models", models: MODELS });
            sendTo(String(a.slot))({ kind: "mcp_tools", tools: MCP_TOOLS });
          }, 50);
          return null;
          return null;
        case "restart_session":
          slotMode[String(a.slot)] = String(a.mode);
          return null;
        case "interrupt":
          return null;
        case "run_shell":
          playShell(String(a.slot), String(a.id), String(a.command));
          return null;
        case "claude_request":
          return mockClaudeRequest(a.request as { subtype: string });
        case "skill_index":
          return MOCK_SKILLS;
        case "read_skill": {
          const skill = MOCK_SKILLS.find((k) => k.path === a.path);
          return `---\nname: ${skill?.name}\n---\n# ${skill?.name}\n\n${skill?.description}\n\n## How it works\n\n1. Read the request.\n2. Ask one question at a time.\n3. Summarise what was decided.\n`;
        }
        case "mcp_add": {
          const spec = a.spec as { name: string; transport: string; target: string; scope: string };
          mockServers.unshift({ name: spec.name, status: "pending", config: spec.transport === "stdio" ? { type: "stdio", command: spec.target } : { type: spec.transport, url: spec.target }, scope: spec.scope });
          return `Added ${spec.transport} MCP server ${spec.name}`;
        }
        case "mcp_remove": {
          const at = mockServers.findIndex((m) => m.name === a.name);
          if (at >= 0) mockServers.splice(at, 1);
          return `Removed MCP server ${String(a.name)}`;
        }
        case "shell_input":
          mockReplies[`${String(a.slot)}:${String(a.id)}`]?.(String(a.text));
          return null;
        case "stop_shell":
          mockShells[`${String(a.slot)}:${String(a.id)}`]?.();
          return null;
        case "send_message": {
          const slot = String(a.slot);
          const mode = slotMode[slot];
          void (String(a.text).startsWith("/") ? playCommand(slot, String(a.text)) : mode === "steps" ? playStepByStep(slot, String(a.text)) : playTurn(slot));
          // Like the backend: the turn's number.
          turnCount[slot] = (turnCount[slot] ?? -1) + 1;
          return turnCount[slot];
        }
        case "respond_permission":
          pendingPermission[String(a.slot)]?.(Boolean(a.allow));
          delete pendingPermission[String(a.slot)];
          return null;
        case "git_branch":
          return "main";
        case "set_model":
          return null;
        case "recent_folders":
          return new Promise((r) => setTimeout(() => r([FOLDER, "/Users/you/projects/web-dashboard", "/Users/you/src/infra", "/Users/you/notes"].map((path, i) => ({ path, updated_ms: Date.now() - i * 3_600_000 }))), 100));
        case "list_sessions":
          return new Promise((r) => setTimeout(() => r(SESSIONS), 150));
        case "open_session":
          return REPLAY;
        case "title_session":
          // Like the Haiku call: a moment later, a few words.
          return new Promise((r) => setTimeout(() => r(/review/i.test(String(a.prompt)) ? "Review retries PR" : /^Chat \w+/.test(String(a.prompt)) ? String(a.prompt).split(":")[0] : "Retry transient fetch errors"), 600));
        case "change_summary":
          // The local branch under review: the same two files, committed on it.
          if (a.scope === "branch") return new Promise((r) => setTimeout(() => r([{ path: FILE, created: false, deleted: false, added: 14, removed: 3 }, { path: TEST_FILE, created: true, deleted: false, added: 32, removed: 0 }]), 300));
          // The reviewed PR: the retry code and its test, against main.
          if (a.scope === "pr") return new Promise((r) => setTimeout(() => r([{ path: FILE, created: false, deleted: false, added: 14, removed: 3 }, { path: TEST_FILE, created: true, deleted: false, added: 32, removed: 0 }]), 500));
          // A Step-by-step page's turn: only the two build steps change the file.
          if (a.scope === "turn" && typeof a.turn === "number" && stepPage[String(a.slot)] !== undefined) return a.turn === 4 || a.turn === 5 ? [{ path: FILE, created: false, deleted: false, added: a.turn === 4 ? 2 : 6, removed: a.turn === 4 ? 0 : 2 }] : [];
          // What the demo turn changed, as the disk has it now.
          return [{ path: FILE, created: false, deleted: false, added: 9, removed: 4 }, ...(MORE ? [{ path: TEST_FILE, created: true, deleted: false, added: 6, removed: 0 }] : [])];
        case "get_file_diff":
          if (a.path === TEST_FILE) return { path: a.path, original: "", current: TEST_SOURCE, created: true, deleted: false };
          return { path: a.path, original: ORIGINAL, current: CURRENT, created: false, deleted: false };
        case "list_dir":
          return listDir(String(a.path));
        case "search_text": {
          // The mock project's text: the files the demo shows.
          const q = a.query as { pattern: string; case_sensitive: boolean; whole_word: boolean; regex: boolean };
          const texts: Record<string, string> = { "src/client/retry.ts": CURRENT, "src/client/index.ts": "export { fetchJson } from \"./retry\";\n", "README.md": "# acme-api\n\nfetchJson retries transient errors.\n" };
          const body = q.regex ? q.pattern : q.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          let re: RegExp;
          try {
            re = new RegExp(q.whole_word ? `\\b(?:${body})\\b` : body, q.case_sensitive ? "g" : "gi");
          } catch {
            return Promise.reject("That isn't a valid regular expression.");
          }
          const files = Object.entries(texts).flatMap(([rel, text]) => {
            const lines = text.split("\n").flatMap((l, i) => {
              const pieces: { text: string; hit: boolean }[] = [];
              let at = 0;
              for (const m of l.matchAll(re)) {
                if (m.index! > at) pieces.push({ text: l.slice(at, m.index), hit: false });
                pieces.push({ text: m[0], hit: true });
                at = m.index! + m[0].length;
              }
              if (!pieces.length) return [];
              if (at < l.length) pieces.push({ text: l.slice(at), hit: false });
              return [{ line: i + 1, pieces }];
            });
            return lines.length ? [{ path: `${FOLDER}/${rel}`, rel, lines, more: 0 }] : [];
          });
          return new Promise((r) => setTimeout(() => r({ files, truncated: false }), 120));
        }
        case "resolve_files": {
          const files = ["src/client/retry.ts", "src/client/retry.test.ts", "src/client/index.ts", "src/server/app.ts", "src/server/routes.ts", "src/index.ts", "test/retry.e2e.ts", "package.json", "README.md", "tsconfig.json"];
          return (a.mentions as string[]).map((m) => {
            const rel = m.replace(/^\.\//, "").replace(`${FOLDER}/`, "");
            const hit = files.find((f) => f === rel) ?? files.filter((f) => f.endsWith(`/${rel}`)).sort((x, y) => x.length - y.length)[0];
            return hit ? `${FOLDER}/${hit}` : null;
          });
        }
        case "find_files": {
          // A plain subsequence match over the mock project (the real one ranks in Rust).
          const q = String(a.query).toLowerCase().replace(/\s+/g, "");
          const files = ["src/client/retry.ts", "src/client/retry.test.ts", "src/client/index.ts", "src/server/app.ts", "src/server/routes.ts", "src/index.ts", "test/retry.e2e.ts", "package.json", "README.md", "tsconfig.json"];
          return files
            .map((rel) => {
              // In the file name if it all fits there, like the real search; otherwise anywhere in the path.
              const match = (from: number) => {
                const hits: number[] = [];
                let at = from;
                for (const c of q) {
                  const i = rel.toLowerCase().indexOf(c, at);
                  if (i < 0) return null;
                  hits.push(i);
                  at = i + 1;
                }
                return hits;
              };
              const hits = match(rel.lastIndexOf("/") + 1) ?? match(0);
              return hits && { path: `${FOLDER}/${rel}`, rel, hits };
            })
            .filter(Boolean)
            .sort((x, y) => x!.rel.length - y!.rel.length);
        }
        case "read_file":
          return a.path === FILE ? CURRENT : `// ${String(a.path).slice(FOLDER.length + 1)}\nexport {};\n`;
        // &update: a newer Lantern is downloaded and waiting.
        case "update_status":
          return new URLSearchParams(location.search).has("update") ? { version: "0.1.2" } : null;
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}
