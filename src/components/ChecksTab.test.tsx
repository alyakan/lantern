import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PrCheck, PullRequest } from "../types";
import { failureSig, freshLoop, type LoopState, type PrSetting } from "../lib/prChecks";
import type { PrView } from "../lib/usePrChecks";
import { ChecksTab } from "./ChecksTab";

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
  render(<ChecksTab view={v} busy={busy} onSend={onSend} onStop={onStop} />);
  return { onSend, onStop };
}

describe("the Checks tab", () => {
  it("says how the checks stand, with each check and a link to it", () => {
    show(view(MIXED));
    expect(screen.getByRole("status")).toHaveTextContent("Checks: 2 passed, 1 failed, 1 running");
    expect(screen.getByRole("link", { name: "Pull request #57" })).toHaveAttribute("href", "https://github.com/o/r/pull/57");
    const list = screen.getByRole("list", { name: "Checks" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Passedbuild" + "Details", "Passedlint" + "Details", "Failedtest" + "Details", "Runninge2e" + "Details"]);
    expect(screen.getByRole("link", { name: "Open test on GitHub" })).toHaveAttribute("href", "https://github.com/o/r/actions/runs/1/job/test");
  });

  it("explains itself when it is off, when gh can't be used and when there is no pull request", () => {
    const { rerender } = render(<ChecksTab view={view(MIXED, { setting: { mode: "off", tries: 3 } })} busy={false} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByText(/Checks are off for this project/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
    rerender(<ChecksTab view={{ ...view(MIXED), snap: null, access: "no_gh" }} busy={false} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByText(/which isn't installed/)).toBeInTheDocument();
    rerender(<ChecksTab view={{ ...view(MIXED), snap: null, access: "logged_out" }} busy={false} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByText(/gh auth login/)).toBeInTheDocument();
    rerender(<ChecksTab view={{ ...view(MIXED), snap: null }} busy={false} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByText(/show here, once it has one/)).toBeInTheDocument();
    rerender(<ChecksTab view={undefined} busy={false} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByText("Checks")).toBeInTheDocument();
  });

  it("lists every check, however many, and keeps the button in view", () => {
    const many = Array.from({ length: 40 }, (_, i) => check(`job-${i}`, i === 7 ? "fail" : "pass"));
    show(view(many));
    expect(within(screen.getByRole("list", { name: "Checks" })).getAllByRole("listitem")).toHaveLength(40);
    expect(screen.getByRole("status")).toHaveTextContent("Checks: 39 passed, 1 failed");
    expect(screen.getByRole("button", { name: "Send the failure to Claude" })).toBeInTheDocument();
  });

  it("lists the checks of a passing pull request without a button", () => {
    show(view([check("build", "pass")]));
    expect(screen.getByRole("list", { name: "Checks" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send the failure to Claude" })).toBeNull();
  });

  it("leaves out the link of a check that has none", () => {
    show(view([{ ...check("legacy", "pass"), link: null }]));
    expect(screen.queryByRole("link", { name: "Open legacy on GitHub" })).toBeNull();
    expect(screen.getByText("legacy")).toBeInTheDocument();
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
    render(<ChecksTab view={view(MIXED)} busy={false} onSend={onSend} onStop={vi.fn()} />);
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
