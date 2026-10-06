import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { initialState, type ChatItem, type State } from "../store";
import { StepsView, UPDATE_STEP } from "./StepsView";

vi.mock("../api", () => ({ api: { userName: () => Promise.resolve("Ada Lovelace") } }));

const items: ChatItem[] = [
  { type: "user", id: "u1", text: "Add slugify", turn: 0 },
  { type: "assistant", id: "a1", text: "# Frame — Add slugify\n\n**Task:** add it." },
  { type: "turn", id: "t1", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 },
  { type: "user", id: "u2", text: "Next", turn: 1 },
  { type: "assistant", id: "a2", text: "# Plan step 1 — Add the function\n\nFile: utils.js" },
  { type: "turn", id: "t2", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 },
];
const state = (extra: Partial<State> = {}): State => ({ ...initialState, folder: "/p", status: "idle", mode: "steps", items, ...extra });
const handlers = () => ({ onDecide: () => {}, onOpenFile: () => {}, onNext: vi.fn(), onFlavour: vi.fn(), onPage: vi.fn() });
const current = () => document.querySelector('.step-page[aria-hidden="false"]')!;

describe("StepsView", () => {
  it("opens on the newest page, titled by its heading, and tells the Changes pane its turn", () => {
    const h = handlers();
    render(<StepsView state={state()} {...h} />);
    expect(current().querySelector(".step-title")).toHaveTextContent("Add the function");
    expect(current().querySelector(".step-eyebrow")).toHaveTextContent("Plan step 1");
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
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
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Next step →" }));
    expect(h.onNext).toHaveBeenCalled();
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

  it("keeps a question about the step on its page, with the answer underneath", () => {
    const asked: ChatItem[] = [
      ...items,
      { type: "user", id: "u3", text: "why not a regex?", turn: 2 },
      { type: "assistant", id: "a3", text: "A regex would work too; split reads more plainly." },
      { type: "turn", id: "t3", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 },
    ];
    const h = handlers();
    render(<StepsView state={state({ items: asked })} {...h} />);
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
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
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
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

  it("lists the commands that changed or checked the project, and switches auto-approve", () => {
    const bash = (id: string, summary: string, status: "done" | "error"): ChatItem => ({ type: "tool", id, name: "Bash", summary, status, output: "out", edit: null, children: [] });
    const ran: ChatItem[] = [...items.slice(0, -1), bash("b1", "cat utils.js", "done"), bash("b2", "npm test", "error"), items[items.length - 1]];
    const onAutoApprove = vi.fn();
    render(<StepsView state={state({ items: ran })} {...handlers()} autoApprove={false} onAutoApprove={onAutoApprove} />);
    const commands = current().querySelector(".step-commands")!;
    expect([...commands.querySelectorAll(".step-command-text")].map((c) => c.textContent)).toEqual(["npm test"]);
    expect(commands.querySelector(".step-command.error")).not.toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: /Auto-approve/ }));
    expect(onAutoApprove).toHaveBeenCalledWith(true);
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
    const h = handlers();
    const { rerender } = render(<StepsView state={state({ mode: "review", items: reviewed })} {...h} />);
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
    rerender(<StepsView state={state({ mode: "review", items: summed })} {...h} onSend={onSend} />);
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
    render(<StepsView state={state({ mode: "review", items })} {...handlers()} />);
    expect(current().querySelector(".review-file-name")).toHaveTextContent("utils.js");
    expect(screen.getByRole("button", { name: "Next file →" })).toBeEnabled();
  });

  it("shows Claude working instead of Next while a step runs, and switches Build and Learn", () => {
    const h = handlers();
    render(<StepsView state={state({ status: "running" })} {...h} />);
    expect(screen.queryByRole("button", { name: "Next step →" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Learn" })).toBeDisabled();
    const { container } = render(<StepsView state={state()} {...handlers()} onFlavour={h.onFlavour} />);
    fireEvent.click(container.querySelector('[role="radio"][aria-checked="false"]')!);
    expect(h.onFlavour).toHaveBeenCalledWith("teach");
  });
});
