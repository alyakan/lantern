import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";

// These render the whole app against the mock backend, which a loaded CI runner can take longer than
// vitest's default 5 s to do.
vi.setConfig({ testTimeout: 60_000 });
// Their finds and waits take as long on such a runner: the default 1 s is for a component, not the whole app.
configure({ asyncUtilTimeout: 20_000 });

// The editor isn't needed here, and doesn't load in jsdom.
vi.mock("./monaco", () => ({ LIGHT_THEME: "lantern-light", DARK_THEME: "lantern-dark" }));
vi.mock("@monaco-editor/react", () => ({ default: () => null, DiffEditor: () => null, loader: { config: () => {} } }));

const FOLDER = "/Users/you/projects/acme-api";

type Call = [string, Record<string, unknown> | undefined];

/** Opens the app, recording every command it sends to the backend. */
async function launch(ready: RegExp | string): Promise<Call[]> {
  const { installMockBackend } = await import("./dev/mockBackend");
  installMockBackend();
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const calls: Call[] = [];
  const answer = internals.invoke;
  internals.invoke = (cmd, args, options) => {
    calls.push([cmd, args]);
    return answer(cmd, args, options);
  };
  const { default: App } = await import("./App");
  render(<App />);
  await screen.findByRole(typeof ready === "string" ? "heading" : "button", { name: ready });
  return calls;
}

const last = (calls: Call[], cmd: string) => [...calls].reverse().find(([c]) => c === cmd)?.[1];
const settle = () => waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull(), { timeout: 40_000 });

beforeEach(() => {
  vi.resetModules();
  clearMocks();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("the first launch", () => {
  it("shows Open folder…, the recent projects and the claude check, with no side panel and no box until a folder is open", async () => {
    const calls = await launch("Open a folder to start");
    const welcome = within(document.querySelector<HTMLElement>(".welcome")!);
    expect(await welcome.findByText("Claude Code is installed and signed in as sam@acme.dev")).toBeInTheDocument();
    expect(await welcome.findByRole("button", { name: /acme-api/ })).toHaveTextContent("Last used");
    expect(screen.queryByRole("button", { name: /side panel/ })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message to Claude" })).toBeNull();
    expect(screen.queryByText("No changes yet")).toBeNull();
    expect(document.querySelector(".split-right")).toBeNull();
    // A recent project opens, and the panel's toggle comes with it.
    fireEvent.click(welcome.getByRole("button", { name: /acme-api/ }));
    await waitFor(() => expect(last(calls, "start_session")).toMatchObject({ folder: FOLDER }));
    expect(await screen.findByRole("button", { name: /side panel/ })).toBeInTheDocument();
    await settle();
  });

  it("opens the folder picked with Open folder…", async () => {
    const calls = await launch("Open a folder to start");
    fireEvent.click(within(document.querySelector<HTMLElement>(".welcome")!).getByRole("button", { name: /^Open folder…/ }));
    await waitFor(() => expect(last(calls, "start_session")).toMatchObject({ folder: FOLDER }));
    await settle();
  });

  it("says when claude isn't signed in", async () => {
    window.history.replaceState({}, "", "/?login=out");
    await launch("Open a folder to start");
    expect(await screen.findByRole("alert")).toHaveTextContent("not signed in");
  });
});

describe("the end of a Build", () => {
  /** Runs a Build in the mock up to its Done page. */
  async function build(): Promise<Call[]> {
    localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
    // The side panel starts away, so that opening it is something the Done page did.
    localStorage.setItem("review.collapsedByFolder", JSON.stringify({ [FOLDER]: true }));
    const calls = await launch(/^Permissions: /);
    fireEvent.click(await screen.findByRole("button", { name: /^Build/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Workflow: Step by step · Build" })).toBeEnabled());
    const box = screen.getByRole("textbox", { name: "Message to Claude" });
    fireEvent.change(box, { target: { value: "Add retries" } });
    fireEvent.keyDown(box, { key: "Enter" });
    for (let i = 0; i < 12 && !screen.queryByRole("region", { name: "What next" }); i++) {
      await settle();
      const next = await waitFor(() => {
        const b = document.querySelector<HTMLButtonElement>(".steps-nav .primary");
        if (!b || b.disabled) throw new Error("no Next yet");
        return b;
      }, { timeout: 15000 }).catch(() => null);
      if (!next) break;
      await act(async () => void fireEvent.click(next));
      await waitFor(() => expect(document.querySelector(".steps-working")).not.toBeNull(), { timeout: 3000 }).catch(() => {});
    }
    await screen.findByRole("region", { name: "What next" }, { timeout: 15000 });
    await settle();
    return calls;
  }

  it("hands off to the changes, Ship it, the plan's export and a new chat", async () => {
    const calls = await build();
    const handoff = screen.getByRole("region", { name: "What next" });
    expect(within(handoff).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Review the changes (1)", "Ship it…", "Export the plan", "Start something new"]);
    // Named stages: all the earlier ones done, Done lit.
    expect(screen.getByRole("navigation", { name: "Progress" }).querySelector('[aria-current="step"]')).toHaveTextContent("Done");
    expect(screen.getByRole("button", { name: "Show side panel" })).toBeInTheDocument();

    // Review the changes opens the side panel on Changes.
    fireEvent.click(within(handoff).getByRole("button", { name: /^Review the changes/ }));
    expect(await screen.findByRole("button", { name: "Hide side panel" })).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: /^Changes/ })).toHaveAttribute("aria-selected", "true");

    // Ship it… asks first (one dialog, the steps ticked), then sends one message.
    const before = calls.filter(([c]) => c === "send_message").length;
    fireEvent.click(within(handoff).getByRole("button", { name: "Ship it…" }));
    expect(calls.filter(([c]) => c === "send_message")).toHaveLength(before);
    const dialog = await screen.findByRole("dialog", { name: "Ship it" });
    await waitFor(() => expect(within(dialog).queryAllByText("Looking at the repository…")).toHaveLength(0));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Open a pull request" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Ship" }));
    await waitFor(() => expect(last(calls, "send_message")?.text).toMatch(/^Please ship this work/));
    expect(last(calls, "send_message")?.text).toMatch(/1\. Commit the changes[\s\S]*2\. Push the branch `feat\/slugify` to `origin`/);
    expect(last(calls, "send_message")?.text).not.toMatch(/gh pr create/);
    await settle();
  });

  it("opens a pull request through Ship it, and starts a new chat in the project", async () => {
    const calls = await build();
    const handoff = screen.getByRole("region", { name: "What next" });
    fireEvent.click(within(handoff).getByRole("button", { name: "Ship it…" }));
    const dialog = await screen.findByRole("dialog", { name: "Ship it" });
    await waitFor(() => expect(within(dialog).queryAllByText("Looking at the repository…")).toHaveLength(0));
    fireEvent.click(within(dialog).getByRole("button", { name: "Ship" }));
    await waitFor(() => expect(last(calls, "send_message")?.text).toMatch(/3\. Open a pull request from `feat\/slugify` into `main` with `gh pr create`/));
    await settle();
    fireEvent.click(await screen.findByRole("button", { name: "Start something new" }));
    await waitFor(() => expect(calls.filter(([c]) => c === "start_session").length).toBeGreaterThan(1));
    expect(await screen.findByRole("region", { name: "Start" })).toBeInTheDocument();
    await settle();
  });
});
