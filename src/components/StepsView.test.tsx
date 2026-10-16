import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { initialState, type ChatItem, type State } from "../store";
import type { Flavour } from "../lib/flavour";
import { StepsView, UPDATE_STEP } from "./StepsView";

vi.mock("../api", () => ({ api: { userName: () => Promise.resolve("Ada Lovelace"), changeSummary: () => Promise.resolve([]), exportText: () => Promise.resolve(null) } }));

const items: ChatItem[] = [
  { type: "user", id: "u1", text: "Add slugify", turn: 0 },
  { type: "assistant", id: "a1", text: "# Frame — Add slugify\n\n**Task:** add it." },
  { type: "turn", id: "t1", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 },
  { type: "user", id: "u2", text: "Next", turn: 1 },
  { type: "assistant", id: "a2", text: "# Plan step 1 — Add the function\n\nFile: utils.js" },
  { type: "turn", id: "t2", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 },
];
const state = (extra: Partial<State> = {}): State => ({ ...initialState, folder: "/p", status: "idle", mode: "steps", items, ...extra });
const handlers = (flavour: Flavour | null = "build") => ({ onDecide: () => {}, onOpenFile: () => {}, onNext: vi.fn(), flavour, onPickFlavour: vi.fn(), onPage: vi.fn() });
const current = () => document.querySelector('.step-page[aria-hidden="false"]')!;

describe("StepsView", () => {
  it("names the stages in the header, with the one you're in lit, earlier ones checked and later ones waiting", () => {
    render(<StepsView state={state()} {...handlers()} />);
    const progress = screen.getByRole("navigation", { name: "Progress" });
    const names = [...progress.querySelectorAll(".steps-phase-name")].map((n) => n.textContent);
    expect(names).toEqual(["Frame", "Plan", "Build", "Done"]);
    const plan = progress.querySelector('[aria-current="step"]')!;
    expect(plan).toHaveTextContent("Plan");
    // Frame is behind: checked, and a way back to its page. Build and Done are not reached.
    const frame = within(progress).getByRole("button", { name: /Frame/ });
    expect(frame).toHaveTextContent("✓");
    expect(within(progress).getByRole("button", { name: /Build/ })).toBeDisabled();
    expect(within(progress).getByRole("button", { name: /Done/ })).toBeDisabled();
    fireEvent.click(frame);
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(progress.querySelector('[aria-current="step"]')).toHaveTextContent("Frame");
  });

  it("keeps a dot for each page of the stage you're in, to move between them", () => {
    const more: ChatItem[] = [...items, { type: "user", id: "u3", text: "Next", turn: 2 }, { type: "assistant", id: "a3", text: "# Plan step 2 — Export it\n\nFile: index.js" }, { type: "turn", id: "t3", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 }];
    render(<StepsView state={state({ items: more })} {...handlers()} />);
    const dots = screen.getAllByRole("tab");
    expect(dots).toHaveLength(2);
    expect(dots[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.click(dots[0]);
    expect(current().querySelector(".step-eyebrow")).toHaveTextContent("Plan step 1");
  });

  it("names the stages of the other flavours", () => {
    const names = (flavour: Flavour) => {
      const view = render(<StepsView state={state()} {...handlers(flavour)} />);
      const found = [...view.container.querySelectorAll(".steps-phase-name")].map((n) => n.textContent);
      view.unmount();
      return found;
    };
    expect(names("debug")).toEqual(["Frame", "Evidence", "Fix", "Done"]);
    expect(names("review")).toEqual(["Frame", "Files", "Summary"]);
    expect(names("architecture")).toEqual(["Frame", "Overview", "Parts", "Summary"]);
  });

  it("ends a Build on the hand-off, and only the Done page has it", () => {
    const done: ChatItem[] = [...items, { type: "user", id: "u3", text: "Next", turn: 2 }, { type: "assistant", id: "a3", text: "# Done — Added slugify\n\nIt is in." }, { type: "turn", id: "t3", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 }];
    const handoff = { slot: "s", summary: null, changed: [], doc: { pages: [], title: "t", folder: "/p" }, running: false, onReviewChanges: vi.fn(), onStartNew: vi.fn() };
    render(<StepsView state={state({ items: done })} {...handlers()} handoff={handoff} />);
    expect(screen.getByRole("region", { name: "What next" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Progress" }).querySelector('[aria-current="step"]')).toHaveTextContent("Done");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(current().querySelector(".step-eyebrow")).toHaveTextContent("Plan step 1");
    expect(current().querySelector(".handoff")).toBeNull();
  });

  it("opens on the newest page, titled by its heading, and tells the Changes pane its turn", () => {
    const h = handlers();
    render(<StepsView state={state()} {...h} />);
    expect(current().querySelector(".step-title")).toHaveTextContent("Add the function");
    expect(current().querySelector(".step-eyebrow")).toHaveTextContent("Plan step 1");
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(h.onPage).toHaveBeenLastCalledWith({ from: 1, to: 1 });
  });

  it("goes back with Previous or ←, and Next on the newest page approves the step", () => {
    const h = handlers();
    render(<StepsView state={state()} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: "← Previous" }));
    expect(current().querySelector(".step-title")).toHaveTextContent("Add slugify");
    expect(current().querySelector(".step-asked")).toHaveTextContent("Add slugify");
    // The Changes pane hears about the page once the slide has ended, not while it runs.
    expect(h.onPage).toHaveBeenLastCalledWith({ from: 1, to: 1 });
    fireEvent.transitionEnd(document.querySelector(".steps-track")!);
    expect(h.onPage).toHaveBeenLastCalledWith({ from: 0, to: 0 });
    // On an older page, Next just moves on.
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    expect(h.onNext).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Next step →" }));
    expect(h.onNext).toHaveBeenCalled();
  });

  it("offers to lock the plan on the Plan complete page, and to approve a change on a Plan update page", () => {
    const withPage = (text: string): ChatItem[] => [...items, { type: "user", id: "u3", text: "Next", turn: 2 }, { type: "assistant", id: "a3", text }, { type: "turn", id: "t3", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 }];
    const h = handlers();
    const view = render(<StepsView state={state({ items: withPage("# Plan complete — 1 step\n\nLock this plan?") })} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: "Lock plan →" }));
    expect(h.onNext).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Next step →" })).toBeNull();
    view.unmount();
    render(<StepsView state={state({ items: withPage("# Plan update — a 404 step\n\nAdd one?") })} {...handlers()} />);
    expect(screen.getByRole("button", { name: "Approve update →" })).toBeInTheDocument();
  });

  it("shows your messages with your name and when you sent them", async () => {
    const at = new Date("2026-09-30T14:02:00").getTime();
    const sent: ChatItem[] = [{ ...(items[0] as Extract<ChatItem, { type: "user" }>), at }, ...items.slice(1)];
    render(<StepsView state={state({ items: sent })} {...handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "← Previous" }));
    const task = current().querySelector(".step-asked")!;
    expect(await screen.findAllByText("Ada Lovelace")).not.toHaveLength(0);
    expect(task.querySelector(".user-avatar")).toHaveTextContent("AL");
    expect(task.querySelector("time")).toHaveAttribute("datetime", new Date(at).toISOString());
    expect(task.querySelector(".user-note-tag")).toHaveTextContent("Task");
  });

  it("marks a built step's page, whose list of changes is numbered, and no other", () => {
    const built: ChatItem[] = [
      ...items,
      { type: "user", id: "u3", text: "Next", turn: 2 },
      { type: "assistant", id: "a3", text: "# Step 1 of 1 — Add the function\n\n- `utils.js:1`: added slugify.\n- `utils.js:9`: exported it." },
      { type: "turn", id: "t3", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 },
    ];
    render(<StepsView state={state({ items: built })} {...handlers()} />);
    expect(current().querySelector(".step-page-body")).toHaveClass("built-step");
    fireEvent.click(screen.getByRole("button", { name: "← Previous" }));
    expect(current().querySelector(".step-eyebrow")).toHaveTextContent("Plan step 1");
    expect(current().querySelector(".step-page-body")).not.toHaveClass("built-step");
  });

  it("opens the page the Summary tab asks for, again when asked again, and ignores a request from before it was drawn", () => {
    const h = handlers();
    const view = <T extends { page: string; key: number } | null>(jump: T) => <StepsView state={state()} {...h} jump={jump} />;
    // A request left over from before this view was drawn (switching back to the chat) doesn't move it.
    const { rerender } = render(view({ page: "u1", key: 1 }));
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    rerender(view({ page: "u1", key: 2 }));
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    // Moved on by hand, asking for the same page again brings it back.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    rerender(view({ page: "u1", key: 3 }));
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    // A page that isn't there (the chat changed under it) is ignored.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    rerender(view({ page: "gone", key: 4 }));
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
  });

  it("keeps a question about the step on its page, with the answer underneath", () => {
    const asked: ChatItem[] = [
      ...items,
      { type: "user", id: "u3", text: "why not a regex?", turn: 2 },
      { type: "assistant", id: "a3", text: "A regex would work too; split reads more plainly." },
      { type: "turn", id: "t3", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 },
    ];
    const h = handlers();
    render(<StepsView state={state({ items: asked })} {...h} />);
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    const thread = current().querySelector(".step-thread")!;
    expect(thread).toHaveTextContent("why not a regex?");
    expect(thread).toHaveTextContent("split reads more plainly");
    expect(h.onPage).toHaveBeenLastCalledWith({ from: 1, to: 2 });
  });

  it("keeps a reply Claude started on its own on the step's page, under a note instead of a question", () => {
    const followed: ChatItem[] = [
      ...items,
      { type: "user", id: "u3", text: "After npx vitest --watch ended", auto: true, at: Date.now() },
      { type: "assistant", id: "a3", text: "The watcher exited: the retry tests still pass." },
      { type: "turn", id: "t3", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 },
    ];
    render(<StepsView state={state({ items: followed })} {...handlers()} />);
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    const thread = current().querySelector(".step-thread")!;
    expect(thread.querySelector(".auto-turn")).toHaveTextContent("After npx vitest --watch ended");
    expect(thread.querySelector(".user-note")).toBeNull();
    expect(thread).toHaveTextContent("the retry tests still pass");
  });

  it("a revision replaces the step, noted in the discussion, and Undo puts the previous version back", () => {
    const turn = (id: string): ChatItem => ({ type: "turn", id, isError: false, stopped: false, result: null, durationMs: 1, denied: 0 });
    const revised: ChatItem[] = [
      ...items,
      { type: "user", id: "u3", text: "why a function?", turn: 2 },
      { type: "assistant", id: "a3", text: "It keeps the call sites short." },
      turn("t3"),
      { type: "user", id: "u4", text: "use a regex instead", turn: 3 },
      { type: "assistant", id: "a4", text: "# Plan step 1 — Add the function\n\nFile: utils.js, with a regex" },
      turn("t4"),
    ];
    render(<StepsView state={state({ items: revised })} {...handlers()} />);
    const page = current();
    expect(page.querySelector(".step-content")).toHaveTextContent("with a regex");
    const thread = page.querySelector(".step-thread")!;
    expect(thread.querySelector(".step-discussion-divider")).toHaveTextContent("Discussion");
    // The answer stays an answer; the change request is a note.
    expect(thread).toHaveTextContent("why a function?");
    expect(thread).toHaveTextContent("It keeps the call sites short.");
    expect(thread).toHaveTextContent("Updated the step above");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(current().querySelector(".step-content")).toHaveTextContent("File: utils.js");
    expect(current().querySelector(".step-content")).not.toHaveTextContent("with a regex");
    fireEvent.click(screen.getByRole("button", { name: "Use this version" }));
    expect(current().querySelector(".step-content")).toHaveTextContent("with a regex");
  });

  it("keeps the step when Claude answers a question under its heading, and can still take it as the step", () => {
    const answered: ChatItem[] = [
      ...items,
      { type: "user", id: "u3", text: "what is the twelve-factor app?", turn: 2 },
      { type: "assistant", id: "a3", text: "# Plan step 1 — Add the function\n\n## The Twelve-Factor App\nA manifesto." },
      { type: "turn", id: "t3", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 },
    ];
    render(<StepsView state={state({ items: answered })} {...handlers()} />);
    expect(current().querySelector(".step-content")).toHaveTextContent("File: utils.js");
    const thread = current().querySelector(".step-thread")!;
    expect(thread).toHaveTextContent("A manifesto.");
    expect(thread).not.toHaveTextContent("Updated the step above");
    fireEvent.click(screen.getByRole("button", { name: "Use this as the step" }));
    expect(current().querySelector(".step-content")).toHaveTextContent("A manifesto.");
  });

  it("offers to work the latest answer into the step", () => {
    const talked: ChatItem[] = [
      ...items,
      { type: "user", id: "u3", text: "maybe use a regex", turn: 2 },
      { type: "assistant", id: "a3", text: "A regex would work too. Want me to update the step with it?" },
      { type: "turn", id: "t3", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 },
    ];
    const onSend = vi.fn();
    render(<StepsView state={state({ items: talked })} {...handlers()} onSend={onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "Update the step with this" }));
    expect(onSend).toHaveBeenCalledWith(UPDATE_STEP);
    expect(onSend.mock.calls[0][0]).toMatch(/whole step again/);
  });

  it("shows a command started in the background as running, then how it ended, and counts it in the header", () => {
    const bash: ChatItem = { type: "tool", id: "toolu_1", name: "Bash", summary: "xcodebuild test -scheme App", status: "done", output: "Command running in background", edit: null, children: [] };
    const ran: ChatItem[] = [...items.slice(0, -1), bash, items[items.length - 1]];
    const running = { backgroundTasks: [{ id: "b1", taskType: "local_bash", description: "xcodebuild test -scheme App", since: Date.now() }], backgroundRuns: { toolu_1: { status: "running" } } };
    const { rerender } = render(<StepsView state={state({ items: ran, ...running })} {...handlers()} />);
    expect(screen.getByText("1 in background")).toBeInTheDocument();
    const line = current().querySelector(".step-command")!;
    expect(line).toHaveClass("running");
    expect(line).toHaveTextContent("in background");
    rerender(<StepsView state={state({ items: ran, backgroundTasks: [], backgroundRuns: { toolu_1: { status: "failed", summary: "Background command failed (exit code 65)" } } })} {...handlers()} />);
    expect(screen.queryByText("1 in background")).toBeNull();
    expect(current().querySelector(".step-command")).toHaveClass("error");
    expect(current().querySelector(".step-command")).toHaveTextContent("failed in background");
  });

  it("lists the commands that changed or checked the project, and has no auto-approve switch of its own", () => {
    const bash = (id: string, summary: string, status: "done" | "error"): ChatItem => ({ type: "tool", id, name: "Bash", summary, status, output: "out", edit: null, children: [] });
    const ran: ChatItem[] = [...items.slice(0, -1), bash("b1", "cat utils.js", "done"), bash("b2", "npm test", "error"), items[items.length - 1]];
    render(<StepsView state={state({ items: ran })} {...handlers()} />);
    const commands = current().querySelector(".step-commands")!;
    expect([...commands.querySelectorAll(".step-command-text")].map((c) => c.textContent)).toEqual(["npm test"]);
    expect(commands.querySelector(".step-command.error")).not.toBeNull();
    // Permissions are the chat's, under the box: nothing in the pages' header switches them.
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText(/Auto-approve/)).toBeNull();
  });

  it("reviews a file a page at a time: finding cards, verdicts sent with Next, and a summary of them", () => {
    const turn = (id: string): ChatItem => ({ type: "turn", id, isError: false, stopped: false, result: null, durationMs: 1, denied: 0 });
    const file =
      "# File 1 of 2 — src/retry.ts (+14 −3)\n\n### What changed\n\n- A retry loop.\n\n### Findings\n\n⚠ line 7 (blocker): network errors aren't retried.\n\n⚠ line 3 (nit): rename `attempts`.\n\n### Notes\n\nChecked the timers.\n\nSay \"Next\" to go on.";
    const reviewed: ChatItem[] = [
      { type: "user", id: "u1", text: "Review PR 128", turn: 0 },
      { type: "assistant", id: "a1", text: "# Frame — Retries (#128)\n\nTwo files." },
      turn("t1"),
      { type: "user", id: "u2", text: "Next", turn: 1 },
      { type: "assistant", id: "a2", text: file },
      turn("t2"),
    ];
    const h = handlers("review");
    const { rerender } = render(<StepsView state={state({ items: reviewed })} {...h} />);
    expect(current().querySelector(".review-file-name")).toHaveTextContent("retry.ts");
    expect([...current().querySelectorAll(".finding")].map((f) => f.className)).toEqual(["finding sev-blocker", "finding sev-nit"]);
    expect(current()).not.toHaveTextContent('Say "Next"');
    const [agree, , , reject] = current().querySelectorAll(".finding-verdict button");
    fireEvent.click(agree);
    fireEvent.click(reject);
    fireEvent.click(screen.getByRole("button", { name: "Next file →" }));
    const sent = "Next. Agreed: line 7. Rejected: line 3.";
    expect(h.onNext).toHaveBeenCalledWith(sent);

    const onSend = vi.fn();
    const summed: ChatItem[] = [...reviewed, { type: "user", id: "u3", text: sent, turn: 2 }, { type: "assistant", id: "a3", text: "# Summary — 1 file reviewed\n\nOne thing to fix." }, turn("t3")];
    rerender(<StepsView state={state({ items: summed })} {...h} onSend={onSend} />);
    // The verdicts Next carried aren't shown as a question on the page.
    expect(current().querySelector(".step-asked")).toBeNull();
    expect([...current().querySelectorAll(".review-table tbody tr")].map((r) => r.lastElementChild!.textContent)).toEqual(["Agreed", "Rejected"]);
    fireEvent.click(screen.getByRole("button", { name: "Write it up" }));
    expect(onSend).toHaveBeenCalledWith(expect.stringMatching(/^Write it up/));
  });

  it("moves on from the first file in a chat switched to Review from Build", () => {
    // Claude kept Build's headings: the file pages still count as files, and Next isn't stuck on "First file".
    const items: ChatItem[] = [
      { type: "user", id: "u1", text: "Add slugify", turn: 0 },
      { type: "assistant", id: "a1", text: "# Done — slugify" },
      { type: "user", id: "u2", text: "Start the review", turn: 1 },
      { type: "assistant", id: "a2", text: "# Frame — Review slugify" },
      { type: "user", id: "u3", text: "Next", turn: 2 },
      { type: "assistant", id: "a3", text: "# Step 1 of 2 — `utils.js`\n\n**utils.js** (+5 −0)\n\n### What changed\nslugify.\n\n### Findings\nNone." },
    ];
    render(<StepsView state={state({ items })} {...handlers("review")} />);
    expect(current().querySelector(".review-file-name")).toHaveTextContent("utils.js");
    expect(screen.getByRole("button", { name: "Next file →" })).toBeEnabled();
  });

  it("doesn't turn pages under an open dialog or menu", () => {
    render(<StepsView state={state()} {...handlers()} />);
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.appendChild(dialog);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    dialog.remove();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
  });

  it("shows Claude working instead of Next while a step runs, and picks a flavour from the header's badge", () => {
    const h = handlers();
    const running = render(<StepsView state={state({ status: "running" })} {...h} />);
    expect(screen.queryByRole("button", { name: "Next step →" })).toBeNull();
    expect(running.container.querySelector(".flavour-badge")).toBeDisabled();
    running.unmount();
    const idle = handlers();
    const { container } = render(<StepsView state={state()} {...idle} />);
    fireEvent.click(container.querySelector(".flavour-badge")!);
    expect(screen.getByRole("menuitemradio", { name: /^Build/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Debug/ }));
    expect(idle.onPickFlavour).toHaveBeenCalledWith("debug");
  });

  it("shows Claude's suggestion as a card: start it, stay, or start another; then how you answered", () => {
    const suggested: ChatItem[] = [
      ...items,
      { type: "user", id: "u3", text: "saving crashes when the title is empty", turn: 2 },
      { type: "assistant", id: "a3", text: "# Switch to Debug — this is a bug, so the cause comes first\n\nI'd find the cause before changing anything." },
      { type: "turn", id: "t3", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 },
    ];
    const onSend = vi.fn();
    const { rerender } = render(<StepsView state={state({ items: suggested })} {...handlers()} onSend={onSend} />);
    const card = screen.getByRole("group", { name: "Claude suggests Debug" });
    expect(card).toHaveTextContent("this is a bug, so the cause comes first");
    expect(current().querySelector(".step-title")).toHaveTextContent("Debug?");
    // The card has the answers, not the Next button.
    expect(screen.queryByRole("button", { name: "Next step →" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stay in Build" }));
    expect(onSend).toHaveBeenLastCalledWith("Stay in Build.");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onSend).toHaveBeenLastCalledWith("Start Review.");
    fireEvent.click(screen.getByRole("button", { name: "Start Debug" }));
    expect(onSend).toHaveBeenLastCalledWith("Start Debug.");

    const started: ChatItem[] = [...suggested, { type: "user", id: "u4", text: "Start Debug.", turn: 3 }, { type: "assistant", id: "a4", text: "# Frame — Empty titles crash the save\n\n1. A null title." }];
    rerender(<StepsView state={state({ items: started })} {...handlers("debug")} onSend={onSend} />);
    // The answer isn't shown as a question on the next page, and the card says how it went.
    expect(current().querySelector(".step-asked")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "← Previous" }));
    expect(screen.getByRole("group", { name: "Claude suggests Debug" })).toHaveTextContent("You started Debug");
  });

  it("suggests Explain as you go with a flavour, and answers with it; a suggestion of Learn reads the same way", () => {
    const asked: ChatItem[] = [
      { type: "user", id: "u1", text: "I'm learning Swift concurrency", turn: 1 },
      { type: "assistant", id: "a1", text: "# Switch to Build, explaining as you go — you want to learn it by building" },
      { type: "turn", id: "t1", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 },
    ];
    const onSend = vi.fn();
    const { rerender } = render(<StepsView state={state({ items: asked })} {...handlers()} onSend={onSend} />);
    expect(screen.getByRole("group", { name: "Claude suggests Build" })).toHaveTextContent("Claude suggests Build, explaining as you go");
    fireEvent.click(screen.getByRole("button", { name: "Start Build, explaining as you go" }));
    expect(onSend).toHaveBeenLastCalledWith("Start Build, explaining as you go.");
    // An older chat's "Switch to Learn" is the same suggestion.
    const old: ChatItem[] = [asked[0], { type: "assistant", id: "a1", text: "# Switch to Learn — you want to learn" }, asked[2]];
    rerender(<StepsView state={state({ items: old })} {...handlers()} onSend={onSend} />);
    expect(screen.getByRole("group", { name: "Claude suggests Build" })).toHaveTextContent("explaining as you go");
  });

  it("shows Explain as you go on the badge, and Design for the Architecture flavour", () => {
    const items: ChatItem[] = [{ type: "user", id: "u1", text: "add x", turn: 1 }, { type: "assistant", id: "a1", text: "# Frame — x" }, { type: "turn", id: "t1", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 }];
    const { rerender } = render(<StepsView state={state({ items })} {...handlers("build")} explain />);
    expect(document.querySelector(".flavour-badge")).toHaveTextContent("explaining");
    rerender(<StepsView state={state({ items })} {...handlers("architecture")} />);
    expect(document.querySelector(".flavour-badge")).toHaveTextContent("Design");
  });
});
