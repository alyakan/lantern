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
    dashboardOptions: vi.fn(),
    dashboardLoadOptions: vi.fn(),
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
const staging = async (value: string) => fireEvent.change(await screen.findByLabelText(/Staging/), { target: { value } });

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
  vi.mocked(api.dashboardCommands).mockResolvedValue([{ form: "org", title: "Create org", kind: "action", command: ["python3", "/Users/me/tools/lumi_staging.py", "create", "--name={name}"], program: "/opt/homebrew/bin/python3", error: null }]);
  // The list kept from the last time the options command ran (it ran two minutes ago); loading runs the command again.
  vi.mocked(api.dashboardOptions).mockResolvedValue({ options: ["approvals", "sso", "testo_sensors"], loaded_at: Date.now() - 120_000 });
  vi.mocked(api.dashboardLoadOptions).mockResolvedValue({ options: ["approvals", "sso", "testo_sensors"], loaded_at: Date.now() });
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
    vi.mocked(api.dashboardCommands).mockResolvedValue([{ form: "org", kind: "action", command: ["nope"], program: null, error: "\"nope\" isn't on the PATH Lantern runs commands with." }]);
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
    // The addons are what the script printed, a moment after the form opened.
    fireEvent.click(await screen.findByLabelText("sso"));
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

  it("waits for the staging, then offers the list kept for it, and does not run the command by opening the form", async () => {
    load([dash()], state());
    // Its own folder name: what a form remembers is kept per folder, so no test leaves a choice for the next.
    render(<DashboardTab folder="/dep1" refreshKey={0} />);
    expect(await screen.findByText("Choose Staging first.")).toBeInTheDocument();
    expect(screen.queryByLabelText("testo_sensors")).toBeNull();
    // Nothing is looked up, and nothing is run, until there is a staging to look up a list for.
    expect(api.dashboardOptions).not.toHaveBeenCalled();
    await staging("7");
    expect(await screen.findByLabelText("testo_sensors")).toBeInTheDocument();
    expect(screen.getByText(/loaded 2m ago/)).toBeInTheDocument();
    expect(screen.getByLabelText("1 of 3 selected")).toBeInTheDocument();
    expect(api.dashboardOptions).toHaveBeenCalledTimes(1);
    expect(api.dashboardOptions).toHaveBeenCalledWith("/dep1", "staging.json", "org", "addons", { staging: "7" });
    expect(api.dashboardLoadOptions).not.toHaveBeenCalled();
    expect(within(screen.getByLabelText(/Staging/)).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose…", "1", "2", "3", "7", "9"]);
  });

  it("says no options are loaded yet for this staging, and Load options runs the command for it", async () => {
    load([dash()], state());
    vi.mocked(api.dashboardOptions).mockResolvedValue(null);
    render(<DashboardTab folder="/dep2" refreshKey={0} />);
    await staging("7");
    expect(await screen.findByText(/No options loaded yet for this choice/)).toBeInTheDocument();
    expect(screen.queryByLabelText("sso")).toBeNull();
    expect(api.dashboardLoadOptions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load options" }));
    expect(await screen.findByLabelText("testo_sensors")).toBeInTheDocument();
    expect(api.dashboardLoadOptions).toHaveBeenCalledWith("/dep2", "staging.json", "org", "addons", { staging: "7" });
    expect(screen.queryByText(/No options loaded yet/)).toBeNull();
  });

  it("says the options are loading while the command runs", async () => {
    load([dash()], state());
    vi.mocked(api.dashboardOptions).mockResolvedValue(null);
    let arrive: (list: { options: string[]; loaded_at: number }) => void = () => {};
    vi.mocked(api.dashboardLoadOptions).mockImplementation(() => new Promise((resolve) => (arrive = resolve)));
    render(<DashboardTab folder="/p" refreshKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load options" }));
    expect(await screen.findByText("Loading options…")).toBeInTheDocument();
    await act(async () => arrive({ options: ["sso"], loaded_at: Date.now() }));
    expect(await screen.findByLabelText("sso")).toBeInTheDocument();
    expect(screen.queryByText("Loading options…")).toBeNull();
  });

  it("says why the command failed, and Retry runs it again", async () => {
    load([dash()], state());
    vi.mocked(api.dashboardOptions).mockResolvedValue(null);
    vi.mocked(api.dashboardLoadOptions).mockRejectedValueOnce("lumi_staging.py failed: no internal login for staging 7");
    render(<DashboardTab folder="/p" refreshKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load options" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the options: lumi_staging.py failed: no internal login for staging 7");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("sso")).toBeInTheDocument();
    expect(api.dashboardLoadOptions).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Couldn't load the options/)).toBeNull();
  });

  it("says when the command printed no options at all", async () => {
    load([dash()], state());
    vi.mocked(api.dashboardOptions).mockResolvedValue({ options: [], loaded_at: Date.now() });
    render(<DashboardTab folder="/p" refreshKey={0} />);
    expect(await screen.findByText("The command printed no options.")).toBeInTheDocument();
  });

  it("runs the options command again when Reload is pressed, so a new addon shows up", async () => {
    load([dash()], state());
    render(<DashboardTab folder="/p" refreshKey={0} />);
    await screen.findByLabelText("testo_sensors");
    expect(api.dashboardLoadOptions).not.toHaveBeenCalled();
    vi.mocked(api.dashboardLoadOptions).mockResolvedValue({ options: ["approvals", "sso", "testo_sensors", "brand_new_addon"], loaded_at: Date.now() });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(await screen.findByLabelText("brand_new_addon")).toBeInTheDocument();
    expect(api.dashboardLoadOptions).toHaveBeenCalledTimes(1);
  });

  it("keeps a chosen value that the loaded list doesn't have visible, so it can be unticked", async () => {
    load([dash()], state());
    // The form's default is "approvals"; the list the command printed for this staging doesn't have it.
    vi.mocked(api.dashboardOptions).mockResolvedValue({ options: ["sso", "testo_sensors"], loaded_at: Date.now() });
    render(<DashboardTab folder="/stale" refreshKey={0} />);
    await staging("7");
    const stale = await screen.findByLabelText(/approvals/);
    expect(stale).toBeChecked();
    expect(screen.getByText("not in the list")).toBeInTheDocument();
    fireEvent.click(stale);
    expect(screen.queryByLabelText(/approvals/)).toBeNull();
    // Run now sends what is left.
    fireEvent.click(screen.getByLabelText("sso"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(api.dashboardPreview).toHaveBeenCalled());
    expect(vi.mocked(api.dashboardPreview).mock.calls[0][3]).toMatchObject({ addons: ["sso"] });
  });

  it("picks up a list that was loaded elsewhere when the backend says something changed", async () => {
    load([dash()], state());
    vi.mocked(api.dashboardOptions).mockResolvedValue(null);
    render(<DashboardTab folder="/p" refreshKey={0} />);
    await screen.findByText(/No options loaded yet/);
    vi.mocked(api.dashboardOptions).mockResolvedValue({ options: ["approvals", "testo_sensors"], loaded_at: Date.now() });
    act(() => changed?.());
    expect(await screen.findByLabelText("testo_sensors")).toBeInTheDocument();
    expect(screen.queryByText(/No options loaded yet/)).toBeNull();
    expect(api.dashboardLoadOptions).not.toHaveBeenCalled();
  });

  const withOptionsCommand = () =>
    vi.mocked(api.dashboardCommands).mockResolvedValue([
      { form: "org", title: "Create org", kind: "action", command: ["python3", "~/tools/lumi_staging.py", "create"], program: "/opt/homebrew/bin/python3", error: null },
      { form: "org", title: "Create org", kind: "options", field: "addons", command: ["python3", "~/tools/lumi_staging.py", "addons", "--json"], program: "/opt/homebrew/bin/python3", error: null },
    ]);

  it("lists a form's options commands on the trust card, apart from its button's, and says when they run", async () => {
    load([dash()], state({ trusted: [] }));
    withOptionsCommand();
    render(<DashboardTab folder="/p" refreshKey={0} />);
    expect(await screen.findByLabelText("Command of Create org")).toHaveTextContent("python3 ~/tools/lumi_staging.py create");
    expect(screen.getByLabelText("Options command of addons in Create org")).toHaveTextContent("python3 ~/tools/lumi_staging.py addons --json");
    expect(screen.getByText(/Loads the options of “addons” in Create org, when you trust the dashboard and when you press Reload/)).toBeInTheDocument();
    expect(screen.getByText(/never just because the tab opened/)).toBeInTheDocument();
    // Nothing is asked of any command before the user trusts the file.
    expect(api.dashboardOptions).not.toHaveBeenCalled();
    expect(api.dashboardLoadOptions).not.toHaveBeenCalled();
  });

  it("runs the options commands that need no choice only once the user has pressed Trust", async () => {
    load([dash()], state({ trusted: [] }));
    withOptionsCommand();
    render(<DashboardTab folder="/p" refreshKey={0} />);
    await screen.findByLabelText("Options command of addons in Create org");
    expect(api.dashboardLoadOptions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Trust this dashboard" }));
    await waitFor(() => expect(api.dashboardLoadOptions).toHaveBeenCalledWith("/p", "staging.json", "org", "addons", {}));
    expect(api.dashboardTrust).toHaveBeenCalledTimes(1);
    expect(api.dashboardLoadOptions).toHaveBeenCalledTimes(1);
  });

  it("does not run an options command that takes a choice when Trust is pressed: there is no value to run it for", async () => {
    load([dash()], state({ trusted: [] }));
    vi.mocked(api.dashboardCommands).mockResolvedValue([
      { form: "org", title: "Create org", kind: "action", command: ["python3", "~/tools/lumi_staging.py", "create"], program: "/opt/homebrew/bin/python3", error: null },
      { form: "org", title: "Create org", kind: "options", field: "addons", depends_on: ["staging"], command: ["python3", "~/tools/lumi_staging.py", "addons", "--staging", "{staging}", "--json"], program: "/opt/homebrew/bin/python3", error: null },
    ]);
    render(<DashboardTab folder="/p" refreshKey={0} />);
    await screen.findByLabelText("Options command of addons in Create org");
    expect(screen.getByText(/for the staging you pick, when you press Load options or Reload/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Trust this dashboard" }));
    await waitFor(() => expect(api.dashboardTrust).toHaveBeenCalledTimes(1));
    expect(api.dashboardLoadOptions).not.toHaveBeenCalled();
  });

  it("does not run the options commands when trusting is refused", async () => {
    load([dash()], state({ trusted: [] }));
    withOptionsCommand();
    vi.mocked(api.dashboardTrust).mockRejectedValue("That dashboard changed since you looked at it. Look at it again.");
    render(<DashboardTab folder="/p" refreshKey={0} />);
    await screen.findByLabelText("Options command of addons in Create org");
    fireEvent.click(screen.getByRole("button", { name: "Trust this dashboard" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed since you looked");
    expect(api.dashboardLoadOptions).not.toHaveBeenCalled();
  });

  /** Each staging has its own list: testo_sensors is on staging 7 only. */
  const perStaging = () => {
    const lists: Record<string, string[]> = { "7": ["approvals", "sso", "testo_sensors"], "9": ["approvals", "sso"] };
    vi.mocked(api.dashboardOptions).mockImplementation(async (_f, _file, _form, _field, values) => (lists[String(values.staging)] ? { options: lists[String(values.staging)], loaded_at: Date.now() } : null));
  };

  it("shows each staging's own list: testo_sensors on staging 7 only, and waiting again when none is chosen", async () => {
    load([dash()], state());
    perStaging();
    render(<DashboardTab folder="/dep3" refreshKey={0} />);
    await staging("7");
    expect(await screen.findByLabelText("testo_sensors")).toBeInTheDocument();
    await staging("9");
    await waitFor(() => expect(screen.queryByLabelText("testo_sensors")).toBeNull());
    expect(screen.getByLabelText("sso")).toBeInTheDocument();
    expect(api.dashboardOptions).toHaveBeenLastCalledWith("/dep3", "staging.json", "org", "addons", { staging: "9" });
    // A staging nobody has loaded a list for has none; none chosen is nothing to show.
    await staging("2");
    expect(await screen.findByText(/No options loaded yet for this choice/)).toBeInTheDocument();
    await staging("");
    expect(await screen.findByText("Choose Staging first.")).toBeInTheDocument();
    expect(screen.queryByLabelText("sso")).toBeNull();
  });

  it("marks what was ticked for one staging as not in the list when another is chosen, so it can be unticked", async () => {
    load([dash()], state());
    perStaging();
    render(<DashboardTab folder="/dep4" refreshKey={0} />);
    await staging("7");
    fireEvent.click(await screen.findByLabelText("testo_sensors"));
    expect(screen.getByLabelText("testo_sensors")).toBeChecked();
    await staging("9");
    const stale = await screen.findByLabelText(/testo_sensors/);
    expect(screen.getByText("not in the list")).toBeInTheDocument();
    fireEvent.click(stale);
    expect(screen.queryByLabelText(/testo_sensors/)).toBeNull();
  });

  it("does not show a list that arrives for a staging the user has already left", async () => {
    load([dash()], state());
    vi.mocked(api.dashboardOptions).mockImplementation(async (_f, _file, _form, _field, values) => (values.staging === "9" ? { options: ["approvals", "sso"], loaded_at: Date.now() } : null));
    let arrive: (list: { options: string[]; loaded_at: number }) => void = () => {};
    vi.mocked(api.dashboardLoadOptions).mockImplementation(() => new Promise((resolve) => (arrive = resolve)));
    render(<DashboardTab folder="/dep5" refreshKey={0} />);
    await staging("7");
    fireEvent.click(await screen.findByRole("button", { name: "Load options" }));
    await staging("9");
    expect(await screen.findByLabelText("sso")).toBeInTheDocument();
    // Staging 7's command finishes now: its list is not staging 9's.
    await act(async () => arrive({ options: ["approvals", "sso", "testo_sensors"], loaded_at: Date.now() }));
    expect(screen.queryByLabelText("testo_sensors")).toBeNull();
    expect(screen.getByLabelText("sso")).toBeInTheDocument();
  });

  it("runs the options command on Reload for the staging chosen only, and not at all with none chosen", async () => {
    load([dash()], state());
    perStaging();
    render(<DashboardTab folder="/dep6" refreshKey={0} />);
    await screen.findByText("Choose Staging first.");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(api.dashboardsList).toHaveBeenCalledTimes(2));
    expect(api.dashboardLoadOptions).not.toHaveBeenCalled();
    await staging("7");
    await screen.findByLabelText("testo_sensors");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(api.dashboardLoadOptions).toHaveBeenCalledTimes(1));
    expect(api.dashboardLoadOptions).toHaveBeenCalledWith("/dep6", "staging.json", "org", "addons", { staging: "7" });
  });

  it("lays short fields out two to a row and everything else across the whole row", async () => {
    load([dash()], state());
    render(<DashboardTab folder="/layout" refreshKey={0} />);
    await screen.findByLabelText(/Users/);
    const cell = (label: RegExp) => screen.getByLabelText(label).closest(".dash-field")!;
    expect(cell(/Users/)).toHaveClass("dash-half");
    expect(cell(/Admins/)).toHaveClass("dash-half");
    expect(screen.getByLabelText("Trial").closest(".dash-field")).toHaveClass("dash-half");
    expect(cell(/Staging/)).toHaveClass("dash-wide");
    expect(cell(/Org name/)).toHaveClass("dash-wide");
    expect(screen.getByRole("group", { name: /Addons on/ })).toHaveClass("dash-wide");
  });

  /** Twelve addons, as the real list is. */
  const twelve = ["approvals", "public_api", "sso", "form_translations", "manual_form_translations", "ai_image_description", "trainings", "webhooks", "word_report_template", "global_sections", "testo_sensors", "all_integrations"];

  it("shows a long list as chips with a count, search, and select all / none", async () => {
    load([dash()], state());
    vi.mocked(api.dashboardOptions).mockResolvedValue({ options: twelve, loaded_at: Date.now() });
    render(<DashboardTab folder="/chips" refreshKey={0} />);
    await staging("7");
    await screen.findByLabelText("sso");
    expect(screen.getByLabelText("1 of 12 selected")).toBeInTheDocument();
    // Search narrows what is shown; selecting acts on what matches.
    const search = screen.getByRole("searchbox", { name: "Search Addons on" });
    fireEvent.change(search, { target: { value: "trans" } });
    expect(screen.getAllByRole("checkbox").map((c) => c.closest("label")?.textContent).filter((t) => t?.includes("translations"))).toEqual(["form_translations", "manual_form_translations"]);
    expect(screen.queryByLabelText("sso")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select matches" }));
    expect(screen.getByLabelText("3 of 12 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear matches" }));
    expect(screen.getByLabelText("1 of 12 selected")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No option matches “zzz”.")).toBeInTheDocument();
    // Without a search, All and None are all of them.
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByLabelText("12 of 12 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(screen.getByLabelText("0 of 12 selected")).toBeInTheDocument();
    // The values sent are what the chips say.
    fireEvent.click(screen.getByLabelText("sso"));
    fireEvent.click(screen.getByLabelText("testo_sensors"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(api.dashboardPreview).toHaveBeenCalled());
    expect(vi.mocked(api.dashboardPreview).mock.calls[0][3]).toMatchObject({ addons: ["sso", "testo_sensors"] });
  });

  it("has no search box for a short list", async () => {
    load([dash()], state());
    render(<DashboardTab folder="/short" refreshKey={0} />);
    await staging("7");
    await screen.findByLabelText("sso");
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("reloads just one list with its own refresh button, not the whole tab", async () => {
    load([dash()], state());
    render(<DashboardTab folder="/refresh" refreshKey={0} />);
    await staging("7");
    await screen.findByLabelText("sso");
    const reads = vi.mocked(api.dashboardsList).mock.calls.length;
    vi.mocked(api.dashboardLoadOptions).mockResolvedValue({ options: ["approvals", "sso", "testo_sensors", "brand_new_addon"], loaded_at: Date.now() });
    fireEvent.click(screen.getByRole("button", { name: "Reload Addons on" }));
    expect(await screen.findByLabelText("brand_new_addon")).toBeInTheDocument();
    expect(api.dashboardLoadOptions).toHaveBeenCalledWith("/refresh", "staging.json", "org", "addons", { staging: "7" });
    expect(vi.mocked(api.dashboardsList).mock.calls.length).toBe(reads);
  });

  it("copies a table row, the whole table, and the JSON of a result", async () => {
    load([dash()], state(), [run()]);
    render(<DashboardTab folder="/copy" refreshKey={0} />);
    await screen.findByRole("table", { name: "users" });
    const write = vi.mocked(navigator.clipboard.writeText);
    fireEvent.click(screen.getByRole("button", { name: "Copy row 2 of users" }));
    expect(write).toHaveBeenLastCalledWith("qa-2@example.com\tOther-secret\tuser");
    fireEvent.click(screen.getByRole("button", { name: "Copy users table" }));
    expect(write).toHaveBeenLastCalledWith("email\tpassword\trole\nqa-1@example.com\tSup3r-secret\tadmin\nqa-2@example.com\tOther-secret\tuser");
    fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
    expect(JSON.parse(String(write.mock.calls[write.mock.calls.length - 1]?.[0]))).toMatchObject({ org: { id: 41872 }, users: [{ email: "qa-1@example.com" }, { email: "qa-2@example.com" }] });
    // Each button that copied says so for a moment.
    expect(await screen.findAllByText("Copied")).toHaveLength(3);
  });

  it("shows how long a run has been going once it is a second or more", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      load([dash()], state({ running: [{ file: "staging.json", form: "org" }] }));
      render(<DashboardTab folder="/timer" refreshKey={0} />);
      expect(await screen.findByRole("button", { name: "Running…" })).toBeDisabled();
      act(() => void vi.advanceTimersByTime(3200));
      expect(screen.getByRole("button", { name: "Running… 3 s" })).toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(62_000));
      expect(screen.getByRole("button", { name: "Running… 1 min 5 s" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("brings a result into view when a run finishes while the tab is open, but not on the first look", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    // Opened with a result already there: no scrolling.
    load([dash()], state(), [run({ id: "old" })]);
    const first = render(<DashboardTab folder="/scroll" refreshKey={0} />);
    await screen.findByRole("table", { name: "users" });
    expect(scroll).not.toHaveBeenCalled();
    first.unmount();
    // Opened with none, then one finishes.
    load([dash()], state());
    render(<DashboardTab folder="/scroll2" refreshKey={0} />);
    await screen.findByText(/Nothing has run yet/);
    load([dash()], state(), [run({ id: "new" })]);
    act(() => changed?.());
    await screen.findByRole("table", { name: "users" });
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
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
