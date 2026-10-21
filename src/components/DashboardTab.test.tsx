import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DashboardTab } from "./DashboardTab";
import { api } from "../api";
import fixture from "../../src-tauri/tests/fixtures/dashboard.spec.json";
import type { Dashboard, DashboardRun, DashboardSpec, DashboardState } from "../types";

vi.mock("../api", () => ({
  api: {
    dashboardsList: vi.fn(),
    dashboardsState: vi.fn(),
    dashboardTrust: vi.fn(),
    dashboardCommands: vi.fn(),
    dashboardPreview: vi.fn(),
    dashboardRun: vi.fn(),
    dashboardRunDetail: vi.fn(),
    dashboardStop: vi.fn(),
    dashboardDeleteRun: vi.fn(),
    dashboardClearRuns: vi.fn(),
    onDashboardsChanged: vi.fn(),
  },
}));

const spec = fixture as DashboardSpec;
const dash = (over: Partial<Dashboard> = {}): Dashboard => ({ file: "staging.json", hash: "h1", spec, issues: [], ...over });
const state = (over: Partial<DashboardState> = {}): DashboardState => ({ trusted: ["h1"], running: [], runs: [], ...over });
const run = (over: Partial<DashboardRun> = {}): DashboardRun => ({
  id: "r1", file: "staging.json", form: "org", started_at: Date.now() - 60_000, duration_ms: 1800, exit_code: 0, stopped: false, timed_out: false,
  inputs: { staging: "7", users: 2, addons: ["approvals"], name: "QA org" }, args: ["python3", "lumi_staging.py", "--name=QA org"],
  stdout: "making it\n", stderr: "", truncated: false,
  output: { org: { id: 41872 }, users: [{ email: "qa-1@example.com", password: "Sup3r-secret", role: "admin" }, { email: "qa-2@example.com", password: "Other-secret", role: "user" }] }, ...over,
});
const summary = ({ id, file, form, started_at, duration_ms, exit_code, stopped, timed_out, inputs }: DashboardRun) => ({ id, file, form, started_at, duration_ms, exit_code, stopped, timed_out, inputs });

let changed: (() => void) | null = null;
function load(list: Dashboard[], st: DashboardState, runs: DashboardRun[] = []) {
  vi.mocked(api.dashboardsList).mockResolvedValue(list);
  vi.mocked(api.dashboardsState).mockResolvedValue({ ...st, runs: st.runs.length ? st.runs : runs.map(summary) });
  vi.mocked(api.dashboardRunDetail).mockImplementation(async (_f, id) => runs.find((r) => r.id === id) ?? null);
}
beforeEach(() => {
  vi.resetAllMocks();
  changed = null;
  vi.mocked(api.onDashboardsChanged).mockImplementation(async (cb) => {
    changed = cb;
    return () => {};
  });
  vi.mocked(api.dashboardTrust).mockResolvedValue(undefined);
  vi.mocked(api.dashboardRun).mockResolvedValue(run());
  vi.mocked(api.dashboardStop).mockResolvedValue(true);
  vi.mocked(api.dashboardDeleteRun).mockResolvedValue(true);
  vi.mocked(api.dashboardClearRuns).mockResolvedValue(undefined);
  vi.mocked(api.dashboardPreview).mockResolvedValue({ args: ["python3", "lumi_staging.py", "--name=QA org"], confirm: "Creates a real org on staging 7" });
  vi.mocked(api.dashboardCommands).mockResolvedValue([{ form: "org", title: "Create org", command: ["python3", "/Users/me/tools/lumi_staging.py", "create", "--name={name}"], program: "/opt/homebrew/bin/python3", error: null }]);
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("DashboardTab", () => {
  it("explains what a dashboard is, and how to get one, when the folder has none", async () => {
    load([], state());
    render(<DashboardTab folder="/p" refreshKey={0} />);
    expect(await screen.findByText(/small admin screen for this project/)).toBeInTheDocument();
    expect(screen.getByText(/\.lantern\/dashboards\//)).toBeInTheDocument();
  });

  it("lists what is wrong with a file, where, and shows no buttons for it", async () => {
    load([dash({ spec: null, issues: [{ path: "panels[0].action.command[2]", message: "must be a string (the command is a list of strings, not a shell line)" }] })], state());
    render(<DashboardTab folder="/p" refreshKey={0} />);
    expect(await screen.findByText("staging.json has problems")).toBeInTheDocument();
    expect(screen.getByText("panels[0].action.command[2]")).toBeInTheDocument();
    expect(screen.getByText(/must be a string/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Trust/ })).toBeNull();
  });

  it("shows a dashboard that isn't trusted as its commands only, and trusts exactly the file it showed", async () => {
    load([dash()], state({ trusted: [] }));
    render(<DashboardTab folder="/p" refreshKey={0} />);
    expect(await screen.findByText("Trust this dashboard?")).toBeInTheDocument();
    expect(await screen.findByLabelText("Command of Create org")).toHaveTextContent("python3 /Users/me/tools/lumi_staging.py create --name={name}");
    expect(screen.getByText("Runs /opt/homebrew/bin/python3")).toBeInTheDocument();
    expect(screen.getByText(/not the files its commands run/)).toBeInTheDocument();
    // No form, no way to run anything yet.
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    expect(screen.queryByLabelText(/Staging/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Trust this dashboard" }));
    await waitFor(() => expect(api.dashboardTrust).toHaveBeenCalledWith("/p", "staging.json", "h1"));
    expect(api.dashboardRun).not.toHaveBeenCalled();
  });

  it("says why a program can't be found, and says it when trusting is refused", async () => {
    load([dash()], state({ trusted: [] }));
    vi.mocked(api.dashboardCommands).mockResolvedValue([{ form: "org", command: ["nope"], program: null, error: "\"nope\" isn't on the PATH Lantern runs commands with." }]);
    vi.mocked(api.dashboardTrust).mockRejectedValue("That dashboard changed since you looked at it. Look at it again.");
    render(<DashboardTab folder="/p" refreshKey={0} />);
    expect(await screen.findByText(/isn't on the PATH/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Trust this dashboard" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed since you looked");
  });

  it("fills the form from the defaults, asks what the button would run, and runs only after the confirm", async () => {
    load([dash()], state());
    render(<DashboardTab folder="/p" refreshKey={0} />);
    fireEvent.change(await screen.findByLabelText(/Staging/), { target: { value: "7" } });
    fireEvent.click(screen.getByLabelText("sso"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const values = { staging: "7", users: 2, admins: 1, addons: ["approvals", "sso"], name: "QA org", trial: false };
    await waitFor(() => expect(api.dashboardPreview).toHaveBeenCalledWith("/p", "staging.json", "org", values));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Creates a real org on staging 7")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Command")).toHaveTextContent('python3 lumi_staging.py "--name=QA org"');
    expect(api.dashboardRun).not.toHaveBeenCalled();
    // Cancel runs nothing.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.dashboardRun).not.toHaveBeenCalled();
    // Confirm runs it, with the same values.
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Run" }));
    await waitFor(() => expect(api.dashboardRun).toHaveBeenCalledWith("/p", "staging.json", "org", values));
  });

  it("says a wrong value from the preview, in the form, and starts nothing", async () => {
    load([dash()], state());
    vi.mocked(api.dashboardPreview).mockRejectedValue("Staging is required.");
    render(<DashboardTab folder="/p" refreshKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Run" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Staging is required.");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.dashboardRun).not.toHaveBeenCalled();
  });

  it("runs straight away when the form has no confirm, and says when the run couldn't start", async () => {
    load([dash()], state());
    vi.mocked(api.dashboardPreview).mockResolvedValue({ args: ["x"], confirm: null });
    vi.mocked(api.dashboardRun).mockRejectedValue("That form is already running.");
    render(<DashboardTab folder="/p" refreshKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Run" }));
    await waitFor(() => expect(api.dashboardRun).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await screen.findByRole("alert")).toHaveTextContent("already running");
  });

  it("keeps what was typed when the tab is left and come back to", async () => {
    load([dash()], state());
    // Its own folder name: what a form remembers is kept per folder, so it can't reach the other tests.
    const first = render(<DashboardTab folder="/kept" refreshKey={0} />);
    fireEvent.change(await screen.findByLabelText(/Org name/), { target: { value: "My QA org" } });
    first.unmount();
    render(<DashboardTab folder="/kept" refreshKey={0} />);
    expect(await screen.findByLabelText(/Org name/)).toHaveValue("My QA org");
  });

  it("shows a running form as running, locks it, and Stop stops it", async () => {
    load([dash()], state({ running: [{ file: "staging.json", form: "org" }] }));
    render(<DashboardTab folder="/p" refreshKey={0} />);
    expect(await screen.findByRole("button", { name: "Running…" })).toBeDisabled();
    expect(screen.getByLabelText(/Staging/)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(api.dashboardStop).toHaveBeenCalledWith("/p", "staging.json", "org");
  });

  it("shows the last run's JSON as a table with a Copy for each value", async () => {
    load([dash()], state(), [run()]);
    render(<DashboardTab folder="/p" refreshKey={0} />);
    const table = await screen.findByRole("table", { name: "users" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("Sup3r-secret")).toBeInTheDocument();
    fireEvent.click(within(table).getAllByRole("button", { name: "Copy password" })[0]);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Sup3r-secret");
    // The result's status, and the same run's row in the history.
    expect(await screen.findAllByText("done")).toHaveLength(2);
  });

  it("shows what a failed run printed to stderr, without terminal colour codes", async () => {
    load([dash()], state(), [run({ id: "r2", exit_code: 3, output: null, stderr: "\u001b[31mnope: staging 7 refused\u001b[0m\n" })]);
    render(<DashboardTab folder="/p" refreshKey={0} />);
    expect(await screen.findByText("failed (3)")).toBeInTheDocument();
    const errors = await screen.findByLabelText("Errors");
    expect(errors).toHaveTextContent("nope: staging 7 refused");
    expect(errors).not.toHaveTextContent("[31m");
  });

  it("shows everything a file or a script says as plain text", async () => {
    const hostile: DashboardSpec = JSON.parse(JSON.stringify(spec));
    hostile.title = "<b>Staging</b>";
    if (hostile.panels[0].type === "form") hostile.panels[0].fields[4].label = '<img src=x onerror="alert(1)">Org name';
    load([dash({ spec: hostile })], state(), [run({ output: { note: "<img src=x onerror=alert(2)>", link: "https://example.com" }, stdout: "<script>alert(3)</script>" })]);
    const { container } = render(<DashboardTab folder="/p" refreshKey={0} />);
    expect(await screen.findByText("<b>Staging</b>")).toBeInTheDocument();
    expect(await screen.findByText("<img src=x onerror=alert(2)>")).toBeInTheDocument();
    expect(container.querySelector("img, script, b, a")).toBeNull();
  });

  it("lists the history, opens a run's detail, deletes one, and clears all after a confirm", async () => {
    const runs = [run({ id: "r1" }), run({ id: "r2", exit_code: 1, output: null, stdout: "boom\n", started_at: Date.now() - 3_600_000, inputs: { staging: "9" } })];
    load([dash()], state(), runs);
    render(<DashboardTab folder="/p" refreshKey={0} />);
    const history = await screen.findByRole("region", { name: "Past runs" });
    const rows = within(history).getAllByRole("button", { name: /done|failed/ });
    expect(rows[0]).toHaveTextContent("staging 7 · users 2 · addons approvals · name QA org");
    expect(rows[1]).toHaveTextContent("failed (1)");
    fireEvent.click(rows[1]);
    await waitFor(() => expect(api.dashboardRunDetail).toHaveBeenCalledWith("/p", "r2"));
    expect(await within(history).findByText("boom")).toBeInTheDocument();
    fireEvent.click(within(history).getAllByRole("button", { name: "Delete this run" })[1]);
    expect(api.dashboardDeleteRun).toHaveBeenCalledWith("/p", "r2");
    // Clearing asks first.
    fireEvent.click(within(history).getByRole("button", { name: "Clear" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/All 2 runs/)).toBeInTheDocument();
    expect(api.dashboardClearRuns).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));
    expect(api.dashboardClearRuns).toHaveBeenCalledWith("/p", "staging.json", "org");
  });

  it("reads everything again when the backend says it changed, the window is focused, or a turn ended", async () => {
    load([dash()], state());
    const { rerender } = render(<DashboardTab folder="/p" refreshKey={0} />);
    await screen.findByRole("button", { name: "Run" });
    const reads = () => vi.mocked(api.dashboardsList).mock.calls.length;
    const before = reads();
    act(() => changed?.());
    await waitFor(() => expect(reads()).toBe(before + 1));
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(reads()).toBe(before + 2));
    rerender(<DashboardTab folder="/p" refreshKey={1} />);
    await waitFor(() => expect(reads()).toBe(before + 3));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(reads()).toBe(before + 4));
  });

  it("picks between several dashboards, by their titles", async () => {
    const other: DashboardSpec = { title: "Feature flags", panels: [{ type: "result", of: "none" }] };
    load([dash(), dash({ file: "flags.json", hash: "h2", spec: other })], state({ trusted: ["h1", "h2"] }));
    render(<DashboardTab folder="/p" refreshKey={0} />);
    const pick = await screen.findByRole("combobox", { name: "Dashboard" });
    expect(within(pick).getAllByRole("option").map((o) => o.textContent)).toEqual(["Staging data", "Feature flags"]);
    fireEvent.change(pick, { target: { value: "flags.json" } });
    expect(await screen.findByRole("region", { name: "Result" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Staging/)).toBeNull();
  });
});
