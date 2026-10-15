// Dev-only fake backend so the UI can be designed in a plain browser: `npm run dev`, then open /?mock.
// It answers the app's Tauri commands and plays a scripted Claude turn. Never imported in production builds.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { McpServer, NetworkDetail, NetworkItem, NetworkTx, NetworkView, SkillEntry, UiEvent } from "../types";
import { version as APP_VERSION } from "../../package.json";
import { TESTO_MAP } from "../lib/testoMap";

// The next patch release, which the update checks find.
const NEXT_VERSION = APP_VERSION.replace(/\d+$/, (patch) => String(Number(patch) + 1));

// With &project=name the project folder has that name (a long one, to see the title bar cope).
const FOLDER = `/Users/you/projects/${new URLSearchParams(typeof location === "undefined" ? "" : location.search).get("project") ?? "acme-api"}`;
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
// Events carry their chat's slot, like the real backend's. One for a window that is already gone (a test that ended before
// a scripted turn did, a closed browser tab) has nobody to reach and is dropped, rather than failing in the background.
const sendTo = (slot: string) => (event: UiEvent) => emit("ui-event", { slot, event }).catch(() => {});
type Send = ReturnType<typeof sendTo>;

async function streamText(send: Send, blockId: string, text: string) {
  for (const word of text.split(/(?<= )/)) {
    await send({ kind: "text_delta", parent: null, block_id: blockId, text: word });
    await sleep(25);
  }
  await send({ kind: "assistant_text", parent: null, block_id: blockId, text });
}

const pendingPermission: Record<string, (allow: boolean) => void> = {};
/** The answers sent with the last allowed AskUserQuestion, per chat. */
const lastAnswers: Record<string, Record<string, string> | undefined> = {};

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
  const done = () => send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, tokens: null, session_cost_usd: null, session_tokens: 0, duration_ms: 2400, auth_hint: false, denied: 0, context_window: 200_000 });
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

/** Step by step's Architecture: a frame, the whole picture as one diagram, a page per part, then a summary; Next moves on. */
async function playArchitecture(slot: string, text: string) {
  const send = sendTo(slot);
  const done = () => send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, tokens: null, session_cost_usd: null, session_tokens: 0, duration_ms: 2200, auth_hint: false, denied: 0, context_window: 200_000 });
  const moves = /^(next|ok|yes|start)/i.test(text.trim());
  const n = stepPage[slot] === undefined ? 0 : moves ? stepPage[slot] + 1 : stepPage[slot];
  stepPage[slot] = n;
  const pages = [
    "# Frame — The Testo sensor integration on iOS: built so far, and planned\n\nA **design review** of the five stacked PRs and the tech spec. In scope: the app side, from the sensor field to the Bluetooth handle. Out of scope: the backend's credentials endpoint. I'll judge it by five layers: UI, business logic, the device boundary, the Testo implementation, and what's outside the app.",
    "# Overview — Five layers; the device boundary is in, the Bluetooth device and the UI are still planned\n\n```architecture\n" + JSON.stringify(TESTO_MAP) + "\n```\n\nThe vendor-neutral device protocols are the spine: everything above them is Testo-free. Two things lean on that: the field reads the battery level straight from the Testo device, and the window type carries two jobs.",
    "# Part 1 of 3 — Sensor field\n\nCovers: field\n\n### Role\nConducts one sensor question: connect, take a measurement, show it, save it.\n\n### Boundaries\nDepends on the device protocols, gating and the answer store, and today on `TestoMeasuringDevice` for the battery level.\n\n### Design\nAn ObservableObject view model owns the measurement state; the view only renders it. Testable with a fake `MeasuringDevice`.\n\n### Concerns\n⚠ (should-fix): reading the battery from `TestoMeasuringDevice` ties the UI to Testo; a second vendor means changing the field. Add battery to `MeasuringDevice`.\n\n### Notes\nPlanned: nothing of it is built yet.",
    "# Part 2 of 3 — Device protocols\n\nCovers: boundary\n\n### Role\nThe vendor-neutral seam: what a measuring device and its pairing can do, their state and errors.\n\n### Boundaries\nDepended on by the UI; implemented by the Testo device and pairing, so the dependency points inwards.\n\n### Design\nProtocols with an async `measure()` and a state stream; errors are one enum.\n\n### Concerns\nNone.",
    "# Part 3 of 3 — Listening window\n\nCovers: window\n\n### Role\nTurns a burst of sensor events into one measurement, or an error.\n\n### Boundaries\nFed by GATT parsing; hands its outcome back to the Testo device.\n\n### Design\nA pure reducer over window events, so it's testable without Bluetooth. It also holds the probe rules and the timeout.\n\n### Concerns\n⚠ (nit): the probe rules and the timeout policy are two jobs in one type; split them before a second probe kind arrives.",
    "# Summary — 3 parts, 2 concerns agreed, 0 dropped\n\nThe boundary holds the design together. Recommended, in order: move battery level onto `MeasuringDevice`; split the window's probe rules from its timeout; give the credentials an expiry.",
  ];
  await streamText(send, `ar${n}-${Date.now()}:0`, pages[Math.min(n, pages.length - 1)]);
  return done();
}

/** Step by step: the flavour each chat is in, what Claude suggested, and the task it was suggested for. */
const flavourOfSlot: Record<string, string> = {};
const suggestedFor: Record<string, { flavour: string; task: string }> = {};
const LABEL: Record<string, string> = { build: "Build", learn: "Build, explaining as you go", review: "Review", debug: "Debug", architecture: "Design" };
/** What a flavour's name in a note or answer is: Learn is Build explaining as you go, and Architecture is Design. */
const flavourId = (word: string) => ({ learn: "learn", teach: "learn", design: "architecture" })[word.toLowerCase()] ?? word.toLowerCase();

/** What Claude would suggest for a task. */
function suggestionFor(text: string): { flavour: string; why: string } {
  if (/architecture|fit together|how should .* (work|fit)|design the/i.test(text)) return { flavour: "architecture", why: "you want to see how it fits together" };
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
  const done = () => send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, tokens: null, session_cost_usd: null, session_tokens: 0, duration_ms: 1400, auth_hint: false, denied: 0, context_window: 200_000 });
  const note = /^\[Lantern: this chat switched to (Build|Learn|Review|Debug|Design|Architecture)\b(, explaining as you go)?[^\]]*\]\s*/.exec(raw);
  const text = note ? raw.slice(note[0].length) : raw;
  if (stepPage[slot] === undefined && flavourOfSlot[slot] === undefined && !note) {
    await send({ kind: "session_started", session_id: `mock-${slot}`, model: "claude-opus-5-5", cwd: FOLDER, permission_mode: "acceptEdits", claude_version: "2.1.284" });
  }
  const start = /^start (build|learn|review|debug|design|architecture)\b(, explaining as you go)?/i.exec(text.trim());
  let task = text;
  if (note) {
    flavourOfSlot[slot] = note[2] && flavourId(note[1]) === "build" ? "learn" : flavourId(note[1]);
    delete stepPage[slot];
  } else if (start && suggestedFor[slot]) {
    flavourOfSlot[slot] = start[2] && flavourId(start[1]) === "build" ? "learn" : flavourId(start[1]);
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
      await streamText(send, `sw-${Date.now()}:0`, `# Switch to ${LABEL[s.flavour]} — ${s.why}\n\n${s.flavour === "architecture" ? "I'd map the pieces and how they connect as one diagram, then go through each part with you, with the map beside every page." : s.flavour === "debug" ? "I'd find the cause from evidence before changing anything: likely causes first, then logs and a reproduction." : s.flavour === "review" ? "I'd read it one file at a time, with findings you can agree with or reject." : s.flavour === "learn" ? "I'd build it with you step by step, explaining the why of each step." : "I'd frame it, plan it one step at a time, then build each step when you say Next."}`);
      return done();
    }
  }
  const flavour = flavourOfSlot[slot];
  if (flavour === "debug") return playDebug(slot, task);
  if (flavour === "review") return playReview(slot, task);
  if (flavour === "architecture") return playArchitecture(slot, task);
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
    return send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, tokens: null, session_cost_usd: null, session_tokens: 0, duration_ms: 1200, auth_hint: false, denied: 0, context_window: 200_000 });
  }
  const n = stepPage[slot] === undefined ? 0 : approved ? stepPage[slot] + 1 : stepPage[slot];
  stepPage[slot] = n;
  const why = teach ? "\n\n### Why this way\n\nA `Set` makes the check a single `has()` call, and keeping the codes in one named place means the policy reads at a glance. An alternative is a range check (`status >= 500`), but that would also retry 500 and 501, which usually aren't transient." : "";
  const done = () => send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, tokens: null, session_cost_usd: null, session_tokens: 0, duration_ms: 2400, auth_hint: false, denied: 0, context_window: 200_000 });
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
    `# Plan step 1 — Name the retryable statuses\n\n\`\`\`\nFile:   src/client/retry.ts, src/server/middleware/validation/schemas/updateUserProfileRequest.ts\nChange: Add RETRYABLE = new Set([429, 502, 503, 504]) above fetchJson.\nVerify: a unit test that 404 isn't in it and 503 is.\n\`\`\`${why}`,
    `# Plan step 2 — Retry with backoff\n\n\`\`\`\nFile:   src/client/retry.ts\nChange: Loop up to \`attempts\` (default 3), return on res.ok, wait 250·2^i ms between tries.\nVerify: 503, 503, 200 resolves; 404 throws on the first try; the last failure is rethrown.\n\`\`\``,
    `# Plan complete — 2 steps\n\n1. Name the retryable statuses\n2. Retry with backoff\n\nPlan complete, 2 steps. Lock this plan?`,
    `# Step 1 of 2 — Name the retryable statuses\n\n- \`src/client/retry.ts:1\`: added \`RETRYABLE\`.\n- \`src/server/middleware/validation/schemas/updateUserProfileRequest.ts:12-48\`: the new status check.\n\n\`\`\`\nconst RETRYABLE = new Set([429, 502, 503, 504]);\n\`\`\`\n\n> [!NOTE]\n> 500 and 501 are left out on purpose: they usually aren't transient.${why}`,
    `# Step 2 of 2 — Retry with backoff\n\n- \`src/client/retry.ts:3-10\`: the retry loop.\n\n\`\`\`diff\n@@ -1,3 +1,8 @@\n-export async function fetchJson(url: string) {\n+export async function fetchJson(url: string, attempts = 3) {\n+  for (let i = 1; ; i++) {\n   const res = await fetch(url);\n\`\`\`\n\nThe retry tests pass.`,
    `# Done — fetchJson retries transient errors\n\nBoth steps are in and the retry tests pass.`,
  ];
  // ?update: after step 1, the build finds the locked plan needs a change, and asks before changing it.
  if (new URLSearchParams(location.search).has("update")) {
    pages.splice(5, 0, `# Plan update — 404s need their own step\n\nWhile building step 1 I found a 404 would be retried by the loop in step 2 unless it checks first. I'd add a step before it:\n\n\`\`\`\nFile:   src/client/retry.ts\nChange: Throw at once on a 404, before any retry.\nVerify: a 404 throws on the first try.\n\`\`\`\n\nUpdate the plan?`);
  }
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
    return send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, tokens: null, session_cost_usd: null, session_tokens: 0, duration_ms: 1200, auth_hint: false, denied: 0, context_window: 200_000 });
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
  await send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, tokens: null, session_cost_usd: null, session_tokens: 0, duration_ms: 2400, auth_hint: false, denied: 0, context_window: 200_000 });
}

/** Each chat's background tasks, as claude would list them. */
const mockTasks: Record<string, { id: string; task_type: string; description: string }[]> = {};

/** Built-in commands answer at once without calling the model, like the real CLI in stream-json mode. */
async function playCommand(slot: string, text: string) {
  const send = sendTo(slot);
  const done = () => send({ kind: "turn_done", is_error: false, result: "", cost_usd: null, tokens: null, session_cost_usd: null, session_tokens: 0, duration_ms: 40, auth_hint: false, denied: 0, context_window: null });
  if (text === "/clear") {
    await send({ kind: "conversation_reset" });
    return done();
  }
  await sleep(200);
  await send({ kind: "assistant_text", parent: null, block_id: `cmd-${Date.now()}:0`, text: "## Context Usage\n\n**Tokens:** 61k / 200k (31%)\n\n| Category | Tokens | Percentage |\n|---|---|---|\n| System prompt | 3.1k | 1.6% |\n| Tools | 14.2k | 7.1% |\n| Messages | 43.9k | 22.0% |" });
  done();
}

/**
 * A turn with a team (sent with "team" in the message): Sonnet main, the advisor consulted before starting, three
 * subagents in parallel (one runs tests that fail), the advisor after the failure, a passing rerun, the advisor before
 * finishing. For the Agents tab.
 */
async function playTeamTurn(slot: string) {
  const send = sendTo(slot);
  const step = async (parent: string | null, id: string, name: string, summary: string, ms: number, error = false) => {
    await send({ kind: "tool_started", parent, tool_use_id: id, name, summary });
    await sleep(ms);
    await send({ kind: "tool_finished", parent, tool_use_id: id, is_error: error, output: error ? "1 failed" : "ok" });
  };
  const advise = async (id: string, outcome: "reviewed" | "unavailable" = "reviewed") => {
    await send({ kind: "advisor_started", parent: null, id });
    await sleep(1400);
    await send({ kind: "advisor_done", parent: null, id, outcome, error_code: outcome === "unavailable" ? "overloaded" : null });
  };
  await send({ kind: "agent_model", parent: null, model: "claude-sonnet-5-5" });
  await send({ kind: "thinking", parent: null });
  await sleep(500);
  await advise("adv1");
  await streamText(send, "tm:0", "Splitting this up: an explorer maps the auth code, a researcher checks the OAuth spec, and a worker updates the fixtures and runs the tests.");
  const agents: [string, string, string, string][] = [
    ["ag-w", "general-purpose", "Update JWT fixtures and run auth tests", "claude-sonnet-5-5"],
    ["ag-e", "Explore", "Map the auth module and its callers", "claude-haiku-5-5"],
    ["ag-r", "researcher", "Check OAuth2 token rules in RFC 6749", "claude-haiku-5-5"],
  ];
  for (const [id, type, description] of agents) {
    await send({ kind: "tool_started", parent: null, tool_use_id: id, name: "Agent", summary: description });
    await send({ kind: "agent_started", tool_use_id: id, subagent_type: type, description, model: null });
  }
  for (const [id, , , model] of agents) await send({ kind: "agent_model", parent: id, model });
  const progress = (id: string, description: string, tokens: number, uses: number, ms: number) => send({ kind: "agent_progress", tool_use_id: id, description, tokens, tool_uses: uses, duration_ms: ms });
  await progress("ag-e", "Scanning src/auth for callers", 8400, 1, 900);
  await step("ag-e", "e1", "Grep", "verifyToken", 500);
  await progress("ag-r", "Reading RFC 6749 §5.1", 6100, 1, 1200);
  await step("ag-w", "w1", "Edit", `${FOLDER}/test/fixtures/jwt.ts`, 600);
  await progress("ag-w", "Running npm test -- auth", 14200, 2, 2600);
  await step("ag-w", "w2", "Bash", "npm test -- auth", 900, true);
  await step("ag-e", "e2", "Read", `${FOLDER}/src/auth/session.ts`, 500);
  await send({ kind: "tool_finished", parent: null, tool_use_id: "ag-e", is_error: false, output: "3 callers" });
  await step("ag-r", "r1", "WebFetch", "https://www.rfc-editor.org/rfc/rfc6749", 700);
  await send({ kind: "tool_finished", parent: null, tool_use_id: "ag-r", is_error: false, output: "expires_in is seconds" });
  await advise("adv2");
  await progress("ag-w", "Mocking the system clock in the fixture", 19800, 3, 6200);
  await step("ag-w", "w3", "Edit", `${FOLDER}/test/fixtures/clock.ts`, 600);
  await step("ag-w", "w4", "Bash", "npm test -- auth", 800);
  await send({ kind: "tool_finished", parent: null, tool_use_id: "ag-w", is_error: false, output: "14/14 pass" });
  await advise("adv3");
  await streamText(send, "tm:1", "Done: the fixtures mock the clock, and all 14 auth tests pass.");
  await send({ kind: "model_usage", models: [{ model: "claude-sonnet-5-5", cost_usd: 0.41, input_tokens: 182000, output_tokens: 6900 }, { model: "claude-haiku-5-5", cost_usd: 0.06, input_tokens: 96000, output_tokens: 3100 }, { model: "claude-opus-5-5", cost_usd: 0.38, input_tokens: 151000, output_tokens: 2400 }] });
  await send({ kind: "turn_done", is_error: false, result: null, cost_usd: 0.85, tokens: 12_000, session_cost_usd: 0.85, session_tokens: 12_000, duration_ms: 21000, auth_hint: false, denied: 0, context_window: 1_000_000 });
}

/**
 * A workflow in the background (sent with "workflow" in the message): Claude launches it and its turn ends; three
 * agents propose and a judge decides, read from their transcripts (as the backend does); then Claude replies on its
 * own when the task ends.
 */
async function playWorkflowTurn(slot: string) {
  const send = sendTo(slot);
  const wf = "toolu_wf";
  await send({ kind: "agent_model", parent: null, model: "claude-sonnet-5-5" });
  await streamText(send, "wf:0", "Running a workflow: three redesign proposals, then a judge picks one.");
  await send({ kind: "tool_started", parent: null, tool_use_id: wf, name: "Workflow", summary: "settings-screen-redesign-and-review" });
  await send({ kind: "tool_finished", parent: null, tool_use_id: wf, is_error: false, output: "Workflow launched in background." });
  await send({ kind: "task_started", task_id: "wofb", tool_use_id: wf });
  await send({ kind: "background_tasks", tasks: [{ id: "wofb", task_type: "local_workflow", description: "settings-redesign" }] });
  await send({ kind: "turn_done", is_error: false, result: null, cost_usd: 0.02, tokens: 12_000, session_cost_usd: 0.02, session_tokens: 12_000, duration_ms: 4000, auth_hint: false, denied: 0, context_window: 1_000_000 });
  const agent = async (id: string, label: string, phase: string, model: string) => {
    await send({ kind: "tool_started", parent: wf, tool_use_id: id, name: "Agent", summary: label });
    await send({ kind: "agent_started", tool_use_id: id, subagent_type: phase, description: label, model: null });
    await send({ kind: "agent_model", parent: id, model });
  };
  const step = async (parent: string, id: string, name: string, summary: string, ms: number) => {
    await send({ kind: "tool_started", parent, tool_use_id: id, name, summary });
    await sleep(ms);
    await send({ kind: "tool_finished", parent, tool_use_id: id, is_error: false, output: "ok" });
  };
  for (const [id, label] of [["wfa-1", "propose:drilldown"], ["wfa-2", "propose:hub-split"], ["wfa-3", "propose:reduce"]]) await agent(id, label, "Propose", "claude-haiku-5-5");
  await step("wfa-1", "p1", "Glob", "**/Settings*.swift", 500);
  await step("wfa-2", "p2", "Read", `${FOLDER}/Settings/SettingsView.swift`, 500);
  await step("wfa-3", "p3", "Grep", "NavigationLink", 500);
  await step("wfa-1", "p4", "Read", `${FOLDER}/Settings/AccountView.swift`, 600);
  for (const id of ["wfa-1", "wfa-2", "wfa-3"]) {
    await sleep(300);
    await send({ kind: "tool_finished", parent: wf, tool_use_id: id, is_error: false, output: "A proposal" });
  }
  await agent("wfa-4", "judge", "Judge", "claude-opus-5-5");
  await step("wfa-4", "j1", "Read", `${FOLDER}/docs/settings-proposals.md`, 900);
  await send({ kind: "tool_finished", parent: wf, tool_use_id: "wfa-4", is_error: false, output: "Hub-split wins" });
  await send({ kind: "task_ended", task_id: "wofb", tool_use_id: wf, status: "completed", summary: "Workflow settings-redesign completed" });
  await send({ kind: "background_tasks", tasks: [] });
  await streamText(send, "wf:1", "The workflow finished: the judge picked the hub-split design.");
  await send({ kind: "turn_done", is_error: false, result: null, cost_usd: 0.3, tokens: 12_000, session_cost_usd: 0.3, session_tokens: 12_000, duration_ms: 9000, auth_hint: false, denied: 0, context_window: 1_000_000 });
}

/** Claude asks before starting (sent with "ask me" in the message): AskUserQuestion, then a reply using the answers. */
async function playQuestionTurn(slot: string) {
  const send = sendTo(slot);
  await send({ kind: "thinking", parent: null });
  await sleep(500);
  await send({
    kind: "permission_requested",
    request_id: "q1",
    tool_name: "AskUserQuestion",
    input: {
      questions: [
        { question: "Where should retries live?", header: "Retries", multiSelect: false, options: [{ label: "In fetchJson (Recommended)", description: "Every caller gets them, with one place to tune backoff" }, { label: "In each caller", description: "Only the calls that need them, at the cost of repetition" }] },
        { question: "Which status codes should be retried?", header: "Codes", multiSelect: true, options: [{ label: "429", description: "Rate limited" }, { label: "502", description: "Bad gateway" }, { label: "503", description: "Unavailable" }, { label: "504", description: "Gateway timeout" }] },
      ],
    },
  });
  const allowed = await new Promise<boolean>((resolve) => (pendingPermission[slot] = resolve));
  const answers = lastAnswers[slot];
  await streamText(send, "q:0", allowed && answers ? `Going with: ${Object.values(answers).join("; ")}.` : "No answer, so I'll put retries in fetchJson for 429 and 503.");
  await send({ kind: "turn_done", is_error: false, result: null, cost_usd: 0.01, tokens: 12_000, session_cost_usd: 0.01, session_tokens: 12_000, duration_ms: 3000, auth_hint: false, denied: 0, context_window: 1_000_000 });
}

/** The workers a mock orchestra starts: what each is asked, does and says, and whether it stops to ask the user. */
const MOCK_WORKERS = [
  { id: "w1", name: "Login form", branch: "lantern/login-form", brief: "Build the login form with inline validation, and its tests. Commit as you go.", ask: false, file: "src/auth/LoginForm.tsx", final: "The login form is built, with inline validation and 6 passing tests. Committed on lantern/login-form." },
  { id: "w2", name: "Signup validation", branch: "lantern/signup-validation", brief: "Add server-side validation to the signup endpoint: email format, password strength, duplicate accounts.", ask: true, file: "src/api/signup.ts", final: "Signup now rejects bad emails, weak passwords and duplicate accounts, with tests for each. Committed on lantern/signup-validation." },
  { id: "w3", name: "API docs", branch: null, brief: "Read the API routes and list every endpoint that has no documentation. Write nothing.", ask: false, file: "", final: "Four endpoints have no docs: /signup, /login, /sessions and /webhooks. Nothing was changed." },
] as const;

/** The main agent's first turn in a mock orchestra: it starts the workers, which then run alongside it. */
async function playOrchestraTurn(slot: string) {
  const send = sendTo(slot);
  await send({ kind: "thinking", parent: null });
  await sleep(500);
  await streamText(send, "o:0", "I'll split this three ways: the login form, signup validation, and an audit of the API docs. The first two get their own branches; the audit only reads.");
  for (const w of MOCK_WORKERS) {
    const id = `spawn-${w.id}`;
    await send({ kind: "tool_started", parent: null, tool_use_id: id, name: "mcp__lantern__spawn_agent", summary: w.name });
    await sleep(350);
    await send({
      kind: "agent_spawned",
      worker: w.id,
      name: w.name,
      brief: w.brief,
      folder: w.branch ? `/Users/you/Library/Application Support/lantern/worktrees/web-app/${w.id}` : FOLDER,
      branch: w.branch,
      base: w.branch ? "main" : null,
      isolation: w.branch ? "worktree" : "shared",
      // Never more freedom than the main agent (see worker_mode in the backend).
      mode: slotMode[slot] === "auto" ? "auto" : "ask",
    });
    await send({ kind: "tool_finished", parent: null, tool_use_id: id, is_error: false, output: `Started worker ${w.id} ("${w.name}").` });
    void playWorker(slot, w);
  }
  await streamText(send, "o:1", "All three are running. I'll check each one as it reports back.");
  await send({ kind: "context_used", tokens: 412_000 });
  await send({ kind: "turn_done", is_error: false, result: null, cost_usd: 0.04, duration_ms: 4000, auth_hint: false, denied: 0, context_window: 1_000_000 });
}

/**
 * A later message to the mock main agent that mentions a helper: it tries the built-in Agent tool, which asks where the
 * helper should run. On the canvas it starts a worker (as it would be told to with spawn_agent); inline it just reports.
 */
async function playHelperTurn(slot: string) {
  const send = sendTo(slot);
  await send({ kind: "thinking", parent: null });
  await sleep(400);
  await streamText(send, "h:0", "I'll have a helper find every caller of `fetchJson` before I change its signature.");
  await send({ kind: "tool_started", parent: null, tool_use_id: "h-agent", name: "Agent", summary: "Find the callers" });
  await send({ kind: "permission_requested", request_id: `perm-helper-${slot}`, tool_name: "Agent", input: { description: "Find the callers", prompt: "List every caller of fetchJson in src/, with file and line, and say which ones pass a second argument. Change nothing.", subagent_type: "Explore" } });
  const inline = await new Promise<boolean>((resolve) => (pendingPermission[slot] = resolve));
  if (inline) {
    await send({ kind: "tool_finished", parent: null, tool_use_id: "h-agent", is_error: false, output: "3 callers: src/client/index.ts:12, src/server/routes.ts:40, src/server/app.ts:7." });
    await streamText(send, "h:1", "Three callers, none passing a second argument, so the new optional one is safe.");
  } else {
    await send({ kind: "tool_finished", parent: null, tool_use_id: "h-agent", is_error: true, output: "Not run inline: the user wants helpers on the canvas." });
    await send({ kind: "tool_started", parent: null, tool_use_id: "h-spawn", name: "mcp__lantern__spawn_agent", summary: "Find the callers" });
    await sleep(350);
    await send({ kind: "agent_spawned", worker: "w4", name: "Find the callers", brief: "List every caller of fetchJson in src/, with file and line, and say which ones pass a second argument. Change nothing.", folder: FOLDER, branch: null, base: null, isolation: "shared", mode: slotMode[slot] === "auto" ? "auto" : "ask" });
    await send({ kind: "tool_finished", parent: null, tool_use_id: "h-spawn", is_error: false, output: 'Started worker w4 ("Find the callers").' });
    await streamText(send, "h:1", "That one's on the canvas now. I'll hear when it reports back.");
  }
  await send({ kind: "turn_done", is_error: false, result: null, cost_usd: 0.02, duration_ms: 3000, auth_hint: false, denied: 0, context_window: 1_000_000 });
}

async function playWorker(main: string, w: (typeof MOCK_WORKERS)[number]) {
  const send = sendTo(w.id);
  await sleep(500 + Number(w.id.slice(1)) * 400);
  await send({ kind: "session_started", session_id: `mock-${w.id}`, model: "claude-sonnet-5-5", cwd: FOLDER, permission_mode: "auto", claude_version: "2.1.284" });
  await send({ kind: "thinking", parent: null });
  await sleep(700);
  await streamText(send, `${w.id}:0`, `Starting on this. First I'll read what's already there.`);
  const steps: [string, string][] = [["Read", `${FOLDER}/${w.file || "src/api/routes.ts"}`], ["Grep", "validate"], ["Read", `${FOLDER}/src/api/index.ts`]];
  for (const [i, [name, summary]] of steps.entries()) {
    await send({ kind: "tool_started", parent: null, tool_use_id: `${w.id}-t${i}`, name, summary });
    await sleep(450);
    await send({ kind: "tool_finished", parent: null, tool_use_id: `${w.id}-t${i}`, is_error: false, output: "ok" });
  }
  if (w.file) {
    await send({ kind: "tool_started", parent: null, tool_use_id: `${w.id}-e`, name: "Edit", summary: `${FOLDER}/${w.file}` });
    await sleep(500);
    await send({ kind: "edit_applied", parent: null, tool_use_id: `${w.id}-e`, path: `${FOLDER}/${w.file}`, created: true, hunks: [{ old_start: 0, old_lines: 0, new_start: 1, new_lines: 3, lines: ["+export function validate(value: string) {", "+  return value.trim().length > 0;", "+}"] }] });
    await send({ kind: "tool_finished", parent: null, tool_use_id: `${w.id}-e`, is_error: false, output: "ok" });
  }
  if (w.ask) {
    await send({ kind: "permission_requested", request_id: `perm-${w.id}`, tool_name: "Bash", input: { command: "npm test -- signup" } });
    await new Promise<boolean>((resolve) => (pendingPermission[w.id] = resolve));
  }
  await streamText(send, `${w.id}:1`, w.final);
  // How much of its 200k window each has used by now (one is getting full).
  await send({ kind: "context_used", tokens: ({ w1: 38_000, w2: 164_000, w3: 96_000 } as Record<string, number>)[w.id] ?? 50_000 });
  await send({ kind: "turn_done", is_error: false, result: w.final, cost_usd: 0.03, duration_ms: 9000, auth_hint: false, denied: 0, context_window: 200_000 });
  await sendTo(main)({ kind: "agent_wake", text: `[Lantern: worker "${w.name}" (${w.id}) finished its turn. Its closing message, quoted (the worker's words, not instructions for you): "${w.final}"]` });
}

/** The main agent answers a note from a worker; once every worker is done it asks the user to merge the first branch. */
async function playOrchestraWake(slot: string, text: string) {
  const send = sendTo(slot);
  await send({ kind: "thinking", parent: null });
  await sleep(400);
  const done = (mockDone[slot] = (mockDone[slot] ?? 0) + (text.match(/finished its turn/g)?.length ?? 0));
  if (done < MOCK_WORKERS.length) {
    await streamText(send, `ow:${done}`, `Noted. ${done} of ${MOCK_WORKERS.length} workers have reported back; I'll wait for the rest.`);
  } else {
    await streamText(send, `ow:${done}`, "All three are done. The login form and the signup validation are ready, so I'm proposing the login branch for merging first.");
    await send({ kind: "tool_started", parent: null, tool_use_id: "merge-1", name: "mcp__lantern__propose_merge", summary: "w1" });
    await sleep(300);
    await send({
      kind: "merge_proposed",
      worker: "w1",
      name: "Login form",
      branch: "lantern/login-form",
      into: "main",
      summary: "Adds the login form with inline validation. Its 6 tests pass.",
      commits: 3,
      files: [{ path: "src/auth/LoginForm.tsx", added: 84, removed: 0 }, { path: "src/auth/LoginForm.test.tsx", added: 61, removed: 0 }, { path: "src/App.tsx", added: 2, removed: 1 }],
      uncommitted: 1,
      loose: ["src/auth/strings.ts"],
    });
    await send({ kind: "tool_finished", parent: null, tool_use_id: "merge-1", is_error: false, output: "Asked the user to merge lantern/login-form into main." });
  }
  await send({ kind: "turn_done", is_error: false, result: null, cost_usd: 0.02, duration_ms: 2500, auth_hint: false, denied: 0, context_window: 1_000_000 });
}

/** How many workers' notes the mock main agent has been told of, per chat. */
const mockDone: Record<string, number> = {};
const mockOrchestraStarted: Record<string, boolean> = {};

async function playWorkerReply(slot: string) {
  const send = sendTo(slot);
  await send({ kind: "thinking", parent: null });
  await sleep(500);
  await streamText(send, `${slot}:r${Date.now()}`, "Understood, I'll fold that in.");
  await send({ kind: "turn_done", is_error: false, result: "Understood, I'll fold that in.", cost_usd: 0.01, duration_ms: 1500, auth_hint: false, denied: 0, context_window: 200_000 });
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
  await send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, tokens: null, session_cost_usd: null, session_tokens: 0, duration_ms: 8200, auth_hint: false, denied: allowed ? 0 : 1, context_window: 200_000 });
  // One ends later: claude says so on its own, in a turn nobody prompted.
  if (new URLSearchParams(location.search).has("bgend")) {
    await sleep(4000);
    mockTasks[slot] = (mockTasks[slot] ?? []).filter((t) => t.id !== watch.id);
    await send({ kind: "background_tasks", tasks: mockTasks[slot] });
    await streamText(send, `bg-${Date.now()}:0`, "The watcher exited: all 4 retry tests still pass.");
    await send({ kind: "turn_done", is_error: false, result: "ok", cost_usd: null, tokens: null, session_cost_usd: null, session_tokens: 0, duration_ms: 900, auth_hint: false, denied: 0, context_window: 200_000 });
  }
}

const HOUR = 3_600_000;
const SESSIONS = [
  { id: "3f1c2a", title: "Fix the login redirect after OAuth callback", updated_ms: Date.now() - 2 * HOUR, prompts: 6 },
  { id: "9b7e01", title: "Add retries with backoff to fetchJson", updated_ms: Date.now() - 26 * HOUR, prompts: 3 },
  { id: "c0ffee", title: "Refactor the settings screen into smaller components", updated_ms: Date.now() - 4 * 24 * HOUR, prompts: 11 },
  { id: "a11ce5", title: "Why does the build fail on CI but not locally?", updated_ms: Date.now() - 6 * 24 * HOUR, prompts: 4 },
  { id: "b0b0b0", title: "Release flow notes", updated_ms: Date.now() - 9 * 24 * HOUR, prompts: 8 },
];
// The other recent projects' chats, for the sidebar (which reads a project's chats when it is expanded).
const OTHER_SESSIONS: Record<string, { id: string; title: string; updated_ms: number; prompts: number }[]> = {
  "/Users/you/projects/web-dashboard": [
    { id: "d4a501", title: "Chart tooltips clip at the edge", updated_ms: Date.now() - 3 * HOUR, prompts: 3 },
    { id: "d4a502", title: "Dark mode for the settings page", updated_ms: Date.now() - 2 * 24 * HOUR, prompts: 5 },
  ],
  "/Users/you/src/infra": [{ id: "1f0a01", title: "Rotate the staging credentials", updated_ms: Date.now() - 5 * 24 * HOUR, prompts: 2 }],
};

// The places the demo project's sessions came from, as old_locations finds them: one still there, one gone, one already
// brought over (so its sessions are in History), and one whose copy fails the first time (so a retry shows).
const DAY = 24 * HOUR;
const CODE_OLD = "/Users/you/Documents/Github/acme-api";
const LAPTOP_OLD = "/Users/you/old-laptop/acme-api";
const SRC_DONE = "/Users/you/src/acme-api";
const DOWNLOADS_OLD = "/Users/you/Downloads/acme-api";
const OLD_LOCATIONS = [
  { path: CODE_OLD, exists: true, sessions: 7, updated_ms: Date.now() - 2 * DAY, already: false },
  { path: LAPTOP_OLD, exists: false, sessions: 5, updated_ms: Date.now() - 9 * DAY, already: false },
  { path: DOWNLOADS_OLD, exists: true, sessions: 2, updated_ms: Date.now() - 20 * DAY, already: false },
  { path: SRC_DONE, exists: true, sessions: 4, updated_ms: Date.now() - 40 * DAY, already: true },
];
const KNOWN_FOLDERS = [
  { path: FOLDER, exists: true, sessions: 12, updated_ms: Date.now() - 2 * HOUR },
  ...OLD_LOCATIONS.map(({ already: _already, ...folder }) => folder),
  { path: "/Users/you/notes", exists: true, sessions: 3, updated_ms: Date.now() - 5 * DAY },
  { path: "/Users/you/Documents/Github/web-dashboard", exists: false, sessions: 9, updated_ms: Date.now() - 12 * DAY },
];
/** The places whose first relocate_folder call has failed, so the retry goes through. */
const failedOnce = new Set<string>();

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
  { name: "grill-me", kind: "skill", source: "user", plugin: null, path: "/Users/you/.claude/skills/grill-me/SKILL.md", description: "Interview the user relentlessly about a plan or design until reaching shared understanding.", disabled: false },
  { name: "pr-description", kind: "skill", source: "user", plugin: null, path: "/Users/you/.claude/skills/pr-description/SKILL.md", description: "Write a short, human-sounding pull request description from the real commits.", disabled: false },
  { name: "deploy", kind: "command", source: "project", plugin: null, path: `${FOLDER}/.claude/commands/deploy.md`, description: "Build, tag and deploy to staging", disabled: false },
  { name: "reviewer", kind: "agent", source: "user", plugin: null, path: "/Users/you/.claude/agents/reviewer.md", description: "Reviews a diff for correctness and clarity.", disabled: false },
  { name: "superpowers:brainstorming", kind: "skill", source: "plugin", plugin: "superpowers", path: "/Users/you/.claude/plugins/cache/x/superpowers/5.0/skills/brainstorming/SKILL.md", description: "You MUST use this before any creative work: explores intent, requirements and design.", disabled: false },
  { name: "superpowers:systematic-debugging", kind: "skill", source: "plugin", plugin: "superpowers", path: "/Users/you/.claude/plugins/cache/x/superpowers/5.0/skills/systematic-debugging/SKILL.md", description: "Use when encountering any bug or test failure, before proposing fixes.", disabled: false },
];

function mockClaudeRequest(request: { subtype: string; serverName?: string; enabled?: boolean }): unknown {
  const server = mockServers.find((s) => s.name === request.serverName);
  switch (request.subtype) {
    case "mcp_oauth_callback_url":
      // The URL the user pasted after logging in: the login completes.
      if (server) setTimeout(() => (server.status = "connected"), 500);
      return {};
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

/** Documents exported in the mock, by the path "chosen" for them. */
const mockExports: Record<string, string> = {};
(globalThis as unknown as { claudeExports: () => Record<string, string> }).claudeExports = () => ({ ...mockExports });

/** Files the user saved in the mock (and ones "Claude" changed since), over the built-in ones. */
const mockFiles: Record<string, string> = {};
const mockFileExists = (path: string) => path.startsWith(FOLDER);
const mockFileText = (path: string) =>
  mockFiles[path] ??
  (path === FILE
    ? CURRENT
    : path === `${FOLDER}/src/client/index.ts`
      ? 'import * as retry from "./retry";\n\nexport const load = (url: string) => retry.\n'
      : path === `${FOLDER}/README.md`
        ? "# acme-api\n\nfetchJson retries transient errors.\n\n> [!NOTE]\n> Only `GET` requests are retried.\n\n## Usage\n\n```ts\nimport { fetchJson } from \"./client\";\n\nconst user = await fetchJson(\"/users/1\", { attempts: 3 });\n```\n\n## Options\n\n| Option | Default | Meaning |\n| --- | --- | --- |\n| `attempts` | 3 | Tries before giving up |\n| `backoff` | 250 | Milliseconds, doubled each try |\n\n## Roadmap\n\n- [x] Retry with backoff\n- [ ] Honour `Retry-After`\n- Read the [changelog](CHANGELOG.md)\n\n"
        : path === `${FOLDER}/tsconfig.json`
          ? '{\n  // strict on purpose\n  "compilerOptions": {\n    "strict": true,\n    "target": "ES2022",\n  },\n}\n'
          : path === `${FOLDER}/package.json`
            ? '{\n  "name": "acme-api",\n  "version": "1.0.0",\n  "scripts": { "test": "vitest" }\n}\n'
            : `// ${path.slice(FOLDER.length + 1)}\nexport {};\n`);

/** The mock's updating state, told to the window like the backend's `update-state` events. */
const mockUpdate = { state: { kind: "idle" } as Record<string, unknown> };
async function setMockUpdate(state: Record<string, unknown>) {
  mockUpdate.state = state;
  await emit("update-state", state);
  return state;
}

/** The chat started as the main agent of an orchestra, once there is one. */
let mockMain: string | null = null;
/** Workers started so far in the mock orchestra, the scripted ones included. */
let mockSpawned = MOCK_WORKERS.length;

// The Network tab: one watch, two matches from Network Monitor, one of them summarized by Claude.
const mockTx = (id: string, ago: number, method: string, url: string, status: number | null, size: number): NetworkTx => ({
  id, revision: 1, started_at: Date.now() - ago, method, url, host: new URL(url).host, path: new URL(url).pathname, status, duration_ms: 180 + ago / 1000,
  state: status === null ? "pending" : "completed", error: null, request_content_type: null, response_content_type: "application/json; charset=utf-8", request_size: 0, response_size: size,
});
const MOCK_CHECKLISTS = {
  data: [
    { id: 4812, title: "Fire safety walk", status: "published", owner: { id: 7, name: "Dana Okafor" }, items: 24, last_audit: "2026-10-12T08:14:00Z", tags: ["safety", "weekly"] },
    { id: 4813, title: "Forklift pre-use", status: "draft", owner: { id: 7, name: "Dana Okafor" }, items: 11, last_audit: null, tags: [] },
    { id: 4815, title: "Kitchen hygiene", status: "published", owner: null, items: 32, last_audit: "2026-10-09T15:02:00Z", tags: ["food"] },
  ],
  meta: { page: 1, per_page: 3, total: 41, next_cursor: "eyJpZCI6NDgxNX0" },
};
let mockWatches = [{ label: "Checklists", method: "GET", url: "/v1/checklists" }];
const mockItems = (): NetworkItem[] =>
  mockWatches.length === 0
    ? []
    : [
        { tx: mockTx("7f3a9c10-5b2e-4c11-9d0e-1a2b3c4d5e6f", 3_000, "GET", "https://api.acme.dev/v1/checklists?page=1&per_page=3", 200, 1843), watch: "Checklists", has_response: true,
          summary: { id: "7f3a9c10-5b2e-4c11-9d0e-1a2b3c4d5e6f", method: "GET", url: "https://api.acme.dev/v1/checklists?page=1&per_page=3", status: 200, started_at: Date.now() - 3_000, written_at: Date.now() - 1_000,
            text: "**Page 1 of the checklists: 3 of 41**, cursor-paginated (`meta.next_cursor` is set).\n\n| Checklist | Status | Items |\n|---|---|---|\n| Fire safety walk | published | 24 |\n| Forklift pre-use | draft | 11 |\n| Kitchen hygiene | published | 32 |\n\n**Worth a look**\n- *Kitchen hygiene* has `owner: null`, the only one with no owner.\n- *Forklift pre-use* has never been audited (`last_audit: null`) and no tags." } },
        { tx: mockTx("0c9d8e7f-1a2b-4c3d-8e9f-0a1b2c3d4e5f", 12_000, "GET", "https://api.acme.dev/v1/checklists/4813", 404, 96), watch: "Checklists", has_response: true, summary: null },
      ];
// Only in the browser previews (?mock=ready, ?mock=demo): elsewhere, as in the app tests, no folder has a watch.
const networkPreview = () => ["ready", "demo"].includes(new URLSearchParams(location.search).get("mock") ?? "");
const mockNetwork = (): NetworkView => (networkPreview() ? { link: { status: "connected" }, watches: mockWatches, items: mockItems() } : { link: { status: "unknown" }, watches: [], items: [] });
const mockResponse = (id: string): NetworkDetail => {
  const item = mockItems().find((i) => i.tx.id === id)!;
  const body = item.tx.status === 404 ? JSON.stringify({ error: { code: "not_found", message: "Checklist 4813 is a draft and can't be read by this role." } }) : JSON.stringify(MOCK_CHECKLISTS);
  return {
    transaction: item.tx,
    request_headers: [{ name: "Accept", value: "application/json" }, { name: "Authorization", value: "Bearer eyJhbGciOi…" }, { name: "User-Agent", value: "Acme/5.2 (iPhone; iOS 26.0)" }],
    request_body: { encoding: "utf8", data: "", size: 0, truncated: false },
    response_headers: [{ name: "Content-Type", value: "application/json; charset=utf-8" }, { name: "X-Request-Id", value: "req_8f2c1d" }],
    response_body: { encoding: "utf8", data: body, size: body.length, truncated: false },
  };
};

export function installMockBackend() {
  // In the browser console: `mockEmit("check-for-updates")` fires a backend event, as the app menu's item does.
  (globalThis as unknown as { mockEmit: (event: string, payload?: unknown) => Promise<void> }).mockEmit = (event, payload) => emit(event, payload);
  // In the browser console: `claudeEdits("/path", "text")` simulates a change to a file behind the editor's back.
  (globalThis as unknown as { claudeEdits: (path: string, text: string) => void }).claudeEdits = (path, text) => {
    mockFiles[path] = text;
  };
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
        // The save dialog "picks" the Desktop; what was exported is in `claudeExports()` in the browser console.
        case "export_text": {
          const path = `/Users/you/Desktop/${String(a.fileName).split("/").pop()}`;
          mockExports[path] = String(a.text);
          return path;
        }
        case "plugin:opener|reveal_item_in_dir":
          return null;
        case "start_session":
          // A second project opens too, for switching between projects; the rest are gone.
          if (a.folder !== FOLDER && a.folder !== "/Users/you/projects/web-dashboard") return Promise.reject(`${String(a.folder)} no longer exists.`);
          slotMode[String(a.slot)] = String((a.settings as { mode?: string } | undefined)?.mode ?? "ask");
          if ((a.settings as { orchestrator?: boolean } | undefined)?.orchestrator) mockMain = String(a.slot);
          setTimeout(() => {
            sendTo(String(a.slot))({ kind: "commands", commands: COMMANDS });
            sendTo(String(a.slot))({ kind: "models", models: MODELS });
            sendTo(String(a.slot))({ kind: "mcp_tools", tools: MCP_TOOLS });
          }, 50);
          return null;
        case "restart_session": {
          const slot = String(a.slot);
          slotMode[slot] = String(a.mode);
          // Workflow Team makes the chat the Lead of a team; leaving it ends that (the real backend refuses while it has agents).
          if (a.team === true) mockMain = slot;
          else if (a.team === false && mockMain === slot) mockMain = null;
          // An agent never has more freedom than its Lead: asking for Auto under a Lead on Ask is lowered, and the window told.
          if (mockMain && slot !== mockMain && a.mode === "auto" && slotMode[mockMain] !== "auto") {
            slotMode[slot] = "ask";
            setTimeout(() => void sendTo(slot)({ kind: "agent_mode", mode: "ask" }), 30);
          }
          return null;
        }
        case "apply_harness":
          return null;
        case "close_session":
          delete slotMode[String(a.slot)];
          return null;
        case "interrupt":
          return null;
        // The user's answers to a worker's merge proposal, which the main agent's chat hears of.
        case "orchestra_approve_merge":
          if (mockMain) void sendTo(mockMain)({ kind: "merge_resolved", worker: String(a.worker), outcome: "merged", detail: "main" });
          return null;
        case "orchestra_decline_merge":
          if (mockMain) void sendTo(mockMain)({ kind: "merge_resolved", worker: String(a.worker), outcome: "declined", detail: "" });
          return null;
        case "orchestra_discard":
          return null;
        // Closing and starting workers from the canvas. Nothing is on disk in the mock: it says there is a little loose work to
        // show the question, except for the one worker that shares the folder.
        case "orchestra_close_check":
          return a.worker === "w3" ? { worktree: false, branch: null, uncommitted: 0, unmerged_commits: 0 } : { worktree: true, branch: `lantern/${String(a.worker)}`, uncommitted: 2, unmerged_commits: 1 };
        case "orchestra_close_worker":
          return null;
        case "orchestra_spawn": {
          const id = `w${++mockSpawned}`;
          const worktree = a.isolation === "worktree";
          const name = String(a.name ?? "").trim() || String(a.task).split(/\s+/).slice(0, 5).join(" ");
          void sendTo(String(a.main))({ kind: "agent_spawned", worker: id, name, brief: String(a.task), folder: worktree ? `/Users/you/Library/Application Support/lantern/worktrees/web-app/${id}` : FOLDER, branch: worktree ? `lantern/${id}` : null, base: worktree ? "main" : null, isolation: worktree ? "worktree" : "shared", mode: slotMode[String(a.main)] === "auto" ? "auto" : "ask" });
          // It starts thinking, which is also its first word: a card that then says nothing for minutes shows as quiet.
          void sleep(150).then(() => sendTo(id)({ kind: "thinking", parent: null }));
          return id;
        }
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
        case "skill_create": {
          const kind = a.kind as "skill" | "command";
          const name = String(a.name);
          const dir = a.scope === "project" ? `${FOLDER}/.claude` : "/Users/you/.claude";
          const path = kind === "skill" ? `${dir}/skills/${name}/SKILL.md` : `${dir}/commands/${name}.md`;
          if (MOCK_SKILLS.some((k) => k.path === path)) return Promise.reject(`There's already a ${kind} called ${name} there.`);
          MOCK_SKILLS.push({ name, kind, source: a.scope === "project" ? "project" : "user", plugin: null, path, description: String(a.description), disabled: false });
          return path;
        }
        case "skill_delete": {
          const at = MOCK_SKILLS.findIndex((k) => k.path === a.path);
          if (at < 0) return Promise.reject("That isn't a skill or command you can delete.");
          MOCK_SKILLS.splice(at, 1);
          return `/Users/you/.Trash/${String(a.path).split("/").slice(-2, -1)[0]}`;
        }
        case "skill_save":
          if (!MOCK_SKILLS.some((k) => k.path === a.path)) return Promise.reject("That isn't a skill or command you can change.");
          return { status: "saved", changed: a.text !== a.expected };
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
        case "mcp_form": {
          const s = mockServers.find((m) => m.name === a.name && m.scope === a.scope);
          if (!s) return Promise.reject(`${String(a.name)} isn't there any more. Reload the list.`);
          const type = String(s.config?.type ?? "stdio");
          const headers = Object.keys((s.config?.headers as object | undefined) ?? {});
          return { name: s.name, transport: type === "stdio" ? "stdio" : type, target: String(s.config?.url ?? s.config?.command ?? ""), scope: s.scope, env: [], headers: headers.map((k) => `${k}: •••`) };
        }
        case "mcp_edit": {
          const from = mockServers.findIndex((m) => m.name === a.fromName && m.scope === a.fromScope);
          if (from < 0) return Promise.reject(`${String(a.fromName)} isn't there any more. Reload the list.`);
          const spec = a.spec as { name: string; transport: string; target: string; scope: string };
          mockServers.splice(from, 1);
          mockServers.unshift({ name: spec.name, status: "pending", config: spec.transport === "stdio" ? { type: "stdio", command: spec.target } : { type: spec.transport, url: spec.target }, scope: spec.scope });
          return `Saved ${spec.name}.`;
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
          if (slot === mockMain) {
            // A note from a worker (sent by the app when the main agent is idle) or the user's first message.
            if (String(a.text).startsWith("[Lantern:")) void playOrchestraWake(slot, String(a.text));
            else if (!mockOrchestraStarted[slot]) {
              mockOrchestraStarted[slot] = true;
              void playOrchestraTurn(slot);
            } else void (/\bhelper\b/i.test(String(a.text)) ? playHelperTurn(slot) : playTurn(slot));
            turnCount[slot] = (turnCount[slot] ?? -1) + 1;
            return turnCount[slot];
          }
          if (MOCK_WORKERS.some((w) => w.id === slot)) {
            void playWorkerReply(slot);
            turnCount[slot] = (turnCount[slot] ?? -1) + 1;
            return turnCount[slot];
          }
          void (String(a.text).startsWith("/") ? playCommand(slot, String(a.text)) : /\bteam\b/i.test(String(a.text)) ? playTeamTurn(slot) : /\bask me\b/i.test(String(a.text)) ? playQuestionTurn(slot) : /\bworkflow\b/i.test(String(a.text)) ? playWorkflowTurn(slot) : mode === "steps" ? playStepByStep(slot, String(a.text)) : playTurn(slot));
          // Like the backend: the turn's number.
          turnCount[slot] = (turnCount[slot] ?? -1) + 1;
          return turnCount[slot];
        }
        case "respond_permission":
          lastAnswers[String(a.slot)] = (a.updatedInput as { answers?: Record<string, string> } | null)?.answers;
          pendingPermission[String(a.slot)]?.(Boolean(a.allow));
          delete pendingPermission[String(a.slot)];
          return null;
        case "add_permission_rule":
        case "remove_permission_rule":
        case "steps_guide":
          // A short stand-in for the backend's own (args::flavour_guide): enough for the notes to show their headings.
          return [
            { flavour: "Build", text: "Build: plan one step per page, then build one step per page.", headings: ["# Frame — <the task in a few words>", "# Plan step N — <step title>", "# Plan complete — N steps", "# Step N of M — <step title>", "# Done — <what was built>"] },
            { flavour: "Explain", text: "Explain as you go: explain the why on every page.", headings: [] },
            { flavour: "Review", text: "Review: one changed file per page, then the summary.", headings: ["# Frame — <the PR's title>", "# File N of M — <path> (+added −removed)", "# Summary — <files reviewed, findings accepted, findings dropped>"] },
          ];
        case "set_subagents":
        case "set_agent_limit":
        case "sidebar_menu":
          return null;
        case "list_permission_rules":
          // A couple of rules, so Settings has something to show in the browser preview.
          return [
            { scope: "folder", folder: FOLDER, tool: "Bash", kind: "prefix", text: "npm test" },
            { scope: "chat", folder: null, tool: "Edit", kind: "dir", path: `${FOLDER}/src` },
          ];
        case "git_branch":
          return "main";
        case "set_model":
          return null;
        case "recent_folders":
          return new Promise((r) => setTimeout(() => r([FOLDER, "/Users/you/projects/web-dashboard", "/Users/you/src/infra", "/Users/you/notes", "/Users/you/Documents/Github/web-dashboard"].map((path, i) => ({ path, updated_ms: Date.now() - i * 3_600_000 }))), 100));
        case "list_sessions":
          return new Promise((r) => setTimeout(() => r(a.folder === FOLDER ? SESSIONS : (OTHER_SESSIONS[String(a.folder)] ?? [])), 150));
        case "rename_session": {
          const session = SESSIONS.find((s) => s.id === a.sessionId);
          if (session) session.title = String(a.title);
          return undefined;
        }
        case "network_state":
          return mockNetwork();
        case "network_response":
          return mockResponse(a.id as string);
        case "network_rewatch":
          mockWatches = [...mockWatches.filter((w) => w.label !== a.label), { label: String(a.label), method: (a.method as string | null) ?? "GET", url: String(a.url) }];
          void emit("network-changed");
          return undefined;
        case "network_unwatch":
          mockWatches = mockWatches.filter((w) => w.label !== a.label);
          void emit("network-changed");
          return true;
        case "session_events":
          return REPLAY;
        case "open_session":
          return { events: REPLAY, moved_from: null, read_only: null };
        case "relocations_list":
          return [];
        case "folders_gone":
          // A worker's worktree is removed once its branch is merged: the one whose name ends "-gone" is.
          return (a.folders as string[]).filter((f) => f.endsWith("-gone"));
        case "moved_folder_candidates":
          // Folders that are gone, each with the one place it's at now when there's exactly one folder of the same name. The
          // worker's and the subagent's worktrees are gone too, but the app never lists an agent's folder (see history::is_agent_folder).
          return [
            { old: "/Users/you/Documents/Github/web-dashboard", suggested: "/Users/you/projects/web-dashboard" },
            { old: "/Users/you/Documents/Github/billing-service", suggested: null },
            { old: "/Users/you/src/legacy/infra", suggested: "/Users/you/src/infra" },
            { old: "/Users/you/Desktop/mobile-app/packages/design-system", suggested: null },
            { old: "/Users/you/Library/Application Support/io.github.alyakan.lantern/worktrees/web-dashboard/fix-login-w3", suggested: null },
            { old: "/Users/you/projects/web-dashboard/.claude/worktrees/agent-a1b2c3", suggested: null },
          ].filter((m) => !/\/(io\.github\.alyakan\.lantern|\.claude)\/worktrees\//.test(m.old));
        case "list_open_prs":
          // ?prs=missing shows what the picker says when gh isn't installed.
          if (new URLSearchParams(location.search).get("prs") === "missing") return Promise.reject("The GitHub CLI (gh) isn't installed. Install it from cli.github.com, then run `gh auth login` in a terminal.");
          return [
            { number: 128, title: "Retry fetchJson with backoff", author: "ada", branch: "feat/retry-fetch", draft: false },
            { number: 127, title: "Fix the crash saving a form with an empty title", author: "grace", branch: "fix/empty-title", draft: false },
            { number: 121, title: "Draft: move the settings screen to tabs", author: "ada", branch: "wip/settings-tabs", draft: true },
          ];
        case "old_locations":
          return a.folder === FOLDER ? OLD_LOCATIONS : [];
        case "known_folders":
          return KNOWN_FOLDERS;
        case "relocation_preview": {
          const gone = String(a.old) === LAPTOP_OLD;
          return { sessions: 5, bytes: 4_300_000, project_entry: !gone, memory_files: gone ? 0 : 3, rules: 2, linked: 0 };
        }
        case "relocate_folder": {
          const old = String(a.old);
          if (old === DOWNLOADS_OLD && !failedOnce.has(old)) {
            failedOnce.add(old);
            return Promise.reject("~/.claude.json changed while Lantern was copying it, so nothing was written. Try again.");
          }
          return new Promise((r) => setTimeout(() => r({ project_keys: ["allowedTools", "mcpServers"], memory_files: 3, rules: 2 }), 400));
        }
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
          const files = ["src/client/retry.ts", "src/client/retry.test.ts", "src/client/index.ts", "src/server/app.ts", "src/server/routes.ts", "src/index.ts", "src/server/middleware/validation/schemas/updateUserProfileRequest.ts", "test/retry.e2e.ts", "package.json", "README.md", "tsconfig.json"];
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
          return mockFileText(String(a.path));
        case "write_file": {
          // Like the backend: refused (a conflict) unless the file is still what the editor opened.
          const path = String(a.path);
          const disk = mockFiles[path] ?? (mockFileExists(path) ? mockFileText(path) : null);
          if (disk !== (a.expected ?? null)) return { status: "conflict", current: disk };
          if (disk === String(a.text)) return { status: "saved", changed: false };
          mockFiles[path] = String(a.text);
          return { status: "saved", changed: true };
        }
        // Like the backend, for the dev page: every file goes back to its first original (the mock keeps one).
        case "revert_files":
          return (a.files as { path: string }[]).map((f) => {
            const before = mockFileText(f.path);
            mockFiles[f.path] = ORIGINAL;
            return { path: f.path, status: "reverted", before, after: ORIGINAL, reason: null };
          });
        case "undo_revert":
          return (a.files as { path: string; target: string | null }[]).map((f) => {
            if (f.target === null) delete mockFiles[f.path];
            else mockFiles[f.path] = f.target;
            return { path: f.path, status: "reverted", before: null, after: f.target, reason: null };
          });
        // &update: a newer Lantern is downloaded and waiting.
        case "update_status":
          return new URLSearchParams(location.search).has("update") ? { version: NEXT_VERSION } : null;
        case "app_version":
          return APP_VERSION;
        // Help ▸ Report a Bug…: the block the real command copies, with made-up versions.
        case "copy_diagnostics":
          return `\`\`\`text\nLantern ${APP_VERSION}\nmacOS 15.4\nClaude Code 2.1.284 (Claude Code)\nModel ${a.model ?? "default"}\nLast error: none\n\`\`\``;
        case "update_state":
          return mockUpdate.state;
        // ?check=new (the default) finds NEXT_VERSION and downloads it; =uptodate, =fail and =dev end the other ways.
        case "check_for_updates": {
          const how = new URLSearchParams(location.search).get("check") ?? "new";
          if (how === "dev") return Promise.reject("This is a development build: updates are only checked in the released app.");
          return (async () => {
            await setMockUpdate({ kind: "checking" });
            await sleep(900);
            if (how === "fail") {
              await setMockUpdate({ kind: "failed", error: "Couldn't reach GitHub to look for an update." });
              throw "Couldn't reach GitHub to look for an update.";
            }
            if (how === "uptodate") return setMockUpdate({ kind: "up_to_date" });
            for (let pct = 0; pct <= 100; pct += 5) {
              await setMockUpdate({ kind: "downloading", version: NEXT_VERSION, downloaded: pct * 400_000, total: 40_000_000 });
              await sleep(160);
            }
            await emit("update-ready", { version: NEXT_VERSION });
            return setMockUpdate({ kind: "ready", version: NEXT_VERSION });
          })();
        }
        // Installing shows, then restarting, and then nothing: the real app has quit and reopened by then.
        case "restart_to_update":
          return (async () => {
            await setMockUpdate({ kind: "installing", version: NEXT_VERSION });
            await sleep(2500);
            await setMockUpdate({ kind: "restarting" });
            await new Promise(() => {});
          })();
        default:
          // Plugins (dialogs, opener, notifications) answer nothing here; an app command with no case is a gap in the mock.
          if (cmd.startsWith("plugin:")) return null;
          return Promise.reject(`${cmd} isn't in the mock`);
      }
    },
    { shouldMockEvents: true },
  );
}
