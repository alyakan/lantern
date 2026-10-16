import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PrCheck, PullRequest } from "../types";
import { failureSig, freshLoop, type LoopState, type PrSetting } from "../lib/prChecks";
import type { PrView } from "../lib/usePrChecks";
import { PrChecksCard } from "./PrChecksCard";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

afterEach(cleanup);

const check = (name: string, bucket: PrCheck["bucket"]): PrCheck => ({ name, state: bucket.toUpperCase(), bucket, link: `https://github.com/o/r/actions/runs/1/job/${name}`, workflow: "CI", run_id: "1" });
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 57, url: "https://github.com/o/r/pull/57", state: "OPEN", branch: "feat/x", base: "main", head_sha: "aaa", ...over });
const view = (checks: PrCheck[], over: { setting?: PrSetting; loop?: Partial<LoopState>; pr?: Partial<PullRequest> } = {}): PrView => ({
  folder: "/p",
  setting: over.setting ?? { mode: "tell", tries: 3 },
  snap: { pr: pr(over.pr), checks },
  access: "ok",
  loop: { ...freshLoop(), ...over.loop },
  needsYou: false,
});
const MIXED = [check("build", "pass"), check("lint", "pass"), check("test", "fail"), check("e2e", "pending")];

function show(v: PrView, busy = false) {
  const onSend = vi.fn(() => Promise.resolve());
  const onStop = vi.fn();
  render(<PrChecksCard view={v} busy={busy} onSend={onSend} onStop={onStop} />);
  return { onSend, onStop };
}

describe("the pull request checks card", () => {
  it("says how the checks stand, with each check and a link to it", () => {
    show(view(MIXED));
    expect(screen.getByRole("status")).toHaveTextContent("Checks: 2 passed, 1 failed, 1 running");
    expect(screen.getByRole("link", { name: "Pull request #57" })).toHaveAttribute("href", "https://github.com/o/r/pull/57");
    const list = screen.getByRole("list", { name: "Checks" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Passedbuild" + "Details", "Passedlint" + "Details", "Failedtest" + "Details", "Runninge2e" + "Details"]);
    expect(screen.getByRole("link", { name: "Open test on GitHub" })).toHaveAttribute("href", "https://github.com/o/r/actions/runs/1/job/test");
  });

  it("shows nothing when it is off or no pull request was found", () => {
    const { container, unmount } = render(<PrChecksCard view={view(MIXED, { setting: { mode: "off", tries: 3 } })} busy={false} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    unmount();
    const none = render(<PrChecksCard view={{ ...view(MIXED), snap: null }} busy={false} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(none.container).toBeEmptyDOMElement();
  });

  it("starts the list folded when everything passed, and opens it on request", () => {
    show(view([check("build", "pass")]));
    expect(screen.queryByRole("list", { name: "Checks" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send the failure to Claude" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show checks" }));
    expect(screen.getByRole("list", { name: "Checks" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide checks" }));
    expect(screen.queryByRole("list", { name: "Checks" })).toBeNull();
  });

  it("sends the failure to Claude on the button, once, and says so after", async () => {
    const v = view(MIXED);
    const { onSend } = show(v);
    fireEvent.click(screen.getByRole("button", { name: "Send the failure to Claude" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send the failure to Claude" })).toBeEnabled());
  });

  it("says Sent once the failure went, instead of offering it again", () => {
    const v = view(MIXED);
    const sig = failureSig(v.snap!);
    show({ ...v, loop: { ...freshLoop(), handled: sig } });
    expect(screen.queryByRole("button", { name: "Send the failure to Claude" })).toBeNull();
    expect(screen.getByText("Sent the failure to Claude.")).toBeInTheDocument();
  });

  it("waits while Claude is busy", () => {
    const { onSend } = show(view(MIXED), true);
    const button = screen.getByRole("button", { name: "Send the failure to Claude" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows why a send failed", async () => {
    const onSend = vi.fn(() => Promise.reject(new Error("The chat has closed.")));
    render(<PrChecksCard view={view(MIXED)} busy={false} onSend={onSend} onStop={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Send the failure to Claude" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The chat has closed.");
  });

  it("Fix it myself: shows the try and a Stop, and holds back the user's button while it waits", () => {
    const { onStop } = show(view(MIXED, { setting: { mode: "fix", tries: 3 }, loop: { tries: 2, status: "waiting" } }));
    expect(screen.getByText("Fixing failed checks: try 2 of 3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send the failure to Claude" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop fixing failed checks" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("Fix it myself: says Out of tries and offers the user's button again", () => {
    show(view(MIXED, { setting: { mode: "fix", tries: 3 }, loop: { tries: 3, status: "out" } }));
    expect(screen.getByText(/Out of tries/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop fixing failed checks" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send the failure to Claude" })).toBeInTheDocument();
  });

  it("Fix it myself: says when the fix didn't land and when it was stopped", () => {
    show(view(MIXED, { setting: { mode: "fix", tries: 3 }, loop: { tries: 1, status: "stalled" } }));
    expect(screen.getByText(/nothing new was pushed/)).toBeInTheDocument();
    cleanup();
    show(view(MIXED, { setting: { mode: "fix", tries: 3 }, loop: { tries: 1, status: "stopped" } }));
    expect(screen.getByText("Fixing failed checks was stopped.")).toBeInTheDocument();
  });

  it("Tell me never shows the fixing line", () => {
    show(view(MIXED, { loop: { tries: 2, status: "waiting" } }));
    expect(screen.queryByText(/Fixing failed checks/)).toBeNull();
  });

  it("says when the pull request was merged or closed, and shows no checks", () => {
    show(view(MIXED, { pr: { state: "MERGED" } }));
    expect(screen.getByRole("status")).toHaveTextContent("Pull request #57 was merged.");
    expect(screen.queryByRole("list")).toBeNull();
    cleanup();
    show(view(MIXED, { pr: { state: "CLOSED" } }));
    expect(screen.getByRole("status")).toHaveTextContent("was closed.");
  });
});
