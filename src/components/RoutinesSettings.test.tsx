import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RoutinesSettings, type RoutinesSettingsProps } from "./RoutinesSettings";
import { MAX_ROUTINES, type Routine } from "../lib/routines";

const HOUR = 3_600_000;
const PROJECTS = [
  { folder: "/Users/you/dev/app", label: "app" },
  { folder: "/Users/you/dev/site", label: "site" },
];

function routine(patch: Partial<Routine> = {}): Routine {
  return {
    id: "r1",
    name: "Morning TODOs",
    folder: "/Users/you/dev/app",
    prompt: "Check the open TODOs and summarise what changed since yesterday",
    schedule: { kind: "weekdays", at: "09:00" },
    permissions: "ask",
    model: "sonnet",
    enabled: true,
    nextAt: Date.now() + 5 * HOUR,
    pausedUntil: null,
    runs: [],
    ...patch,
  };
}

async function setup(routines: Routine[], patch: Partial<RoutinesSettingsProps> = {}) {
  const props: RoutinesSettingsProps = {
    routines,
    add: vi.fn(() => null),
    edit: vi.fn(() => null),
    remove: vi.fn(),
    enable: vi.fn(),
    pause: vi.fn(),
    runNow: vi.fn(() => null),
    loadProjects: () => Promise.resolve(PROJECTS),
    keepAwake: true,
    onKeepAwake: vi.fn(),
    onOpenChat: vi.fn(),
    ...patch,
  };
  // The projects arrive a moment after the page opens.
  await act(async () => {
    render(<RoutinesSettings {...props} />);
  });
  return props;
}

describe("RoutinesSettings", () => {
  it("says plainly that routines run only while Lantern is open and the Mac is awake", async () => {
    await setup([]);
    expect(screen.getByText(/run only while Lantern is open and your Mac is awake/)).toBeTruthy();
    expect(screen.getByText(/not made up/)).toBeTruthy();
    expect(screen.getByText(/No routines yet/)).toBeTruthy();
  });

  it("offers the keep-the-Mac-awake setting", async () => {
    const props = await setup([], { keepAwake: false });
    const box = screen.getByRole("checkbox", { name: /Keep my Mac awake while Claude works/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(props.onKeepAwake).toHaveBeenCalledWith(true);
  });

  it("lists a routine with how often, where, and when it is next", async () => {
    await setup([routine()]);
    const row = screen.getByRole("list", { name: "Routines" });
    expect(within(row).getByText("Morning TODOs")).toBeTruthy();
    expect(within(row).getByText(/Every weekday at 9:00 AM · app/)).toBeTruthy();
    expect(within(row).getByText(/^Next: /)).toBeTruthy();
  });

  it("switches a routine on and off", async () => {
    const props = await setup([routine()]);
    const toggle = screen.getByRole("switch", { name: "Morning TODOs is on" });
    fireEvent.click(toggle);
    expect(props.enable).toHaveBeenCalledWith("r1", false);
  });

  it("shows an off routine as off", async () => {
    await setup([routine({ enabled: false, nextAt: null })]);
    expect(screen.getByText("Off", { selector: ".settings-row-sub" })).toBeTruthy();
  });

  it("starts a run with Run now, and says why when it can't", async () => {
    const runNow = vi.fn<(id: string) => string | null>(() => null);
    await setup([routine()], { runNow });
    fireEvent.click(screen.getByRole("button", { name: "Run Morning TODOs now" }));
    expect(runNow).toHaveBeenCalledWith("r1");
    expect(screen.queryByRole("status")).toBeNull();
    runNow.mockReturnValue("Not started: the plan is at 96%.");
    fireEvent.click(screen.getByRole("button", { name: "Run Morning TODOs now" }));
    expect(screen.getByRole("status").textContent).toBe("Not started: the plan is at 96%.");
  });

  it("shows a missed run once, with Run now beside it", async () => {
    const runNow = vi.fn(() => null);
    const missedAt = new Date();
    missedAt.setHours(9, 0, 0, 0);
    await setup([routine({ runs: [{ at: missedAt.getTime(), outcome: "missed" }] })], { runNow });
    expect(screen.getAllByText(/^Missed /)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Run Morning TODOs now" }));
    expect(runNow).toHaveBeenCalledWith("r1");
    // Opening the details lists it once more, in the history.
    fireEvent.click(screen.getByRole("button", { name: /^Morning TODOs/ }));
    expect(within(screen.getByRole("list", { name: "Last runs of Morning TODOs" })).getAllByText(/^Missed /)).toHaveLength(1);
  });

  it("lists the last runs, how each ended, and opens a run's chat", async () => {
    const at = Date.now() - 2 * HOUR;
    const { onOpenChat } = await setup([
      routine({
        runs: [
          { at, outcome: "done", sessionId: "sess-1" },
          { at: at - HOUR, outcome: "skipped", note: "the plan is at 95%" },
          { at: at - 2 * HOUR, outcome: "failed", note: "its project folder isn't there any more" },
          { at: at - 3 * HOUR, outcome: "skipped", note: "the last run is still going", manual: false },
        ],
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /^Morning TODOs/ }));
    const runs = screen.getByRole("list", { name: "Last runs of Morning TODOs" });
    expect(within(runs).getByText("Finished")).toBeTruthy();
    expect(within(runs).getByText("Skipped: the plan is at 95%")).toBeTruthy();
    expect(within(runs).getByText("Failed: its project folder isn't there any more")).toBeTruthy();
    expect(within(runs).getByText("Skipped: the last run is still going")).toBeTruthy();
    fireEvent.click(within(runs).getByRole("button", { name: /Open the chat/ }));
    expect(onOpenChat).toHaveBeenCalledWith("sess-1", "/Users/you/dev/app");
  });

  it("pauses a routine for an hour, and resumes it", async () => {
    const props = await setup([routine()]);
    fireEvent.click(screen.getByRole("button", { name: /^Morning TODOs/ }));
    fireEvent.click(screen.getByRole("button", { name: "Pause for 1 hour" }));
    expect(props.pause).toHaveBeenCalledWith("r1", true);
  });

  it("says a paused routine is paused, and offers Resume", async () => {
    const props = await setup([routine({ pausedUntil: Date.now() + HOUR })]);
    expect(screen.getByText(/^Paused until /)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Morning TODOs/ }));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(props.pause).toHaveBeenCalledWith("r1", false);
  });

  it("asks twice before deleting", async () => {
    const props = await setup([routine()]);
    fireEvent.click(screen.getByRole("button", { name: /^Morning TODOs/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete routine" }));
    expect(props.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete routine" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete for good" }));
    expect(props.remove).toHaveBeenCalledWith("r1");
  });

  describe("the form", () => {
    it("adds a routine with Ask, Sonnet and the first project, every weekday at 9, unless told otherwise", async () => {
      const props = await setup([]);
      fireEvent.click(screen.getByRole("button", { name: "New routine" }));
      await waitFor(() => expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("/Users/you/dev/app"));
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Tests" } });
      fireEvent.change(screen.getByLabelText("What should Claude do?"), { target: { value: "Run the tests and tell me if anything broke" } });
      expect((screen.getByLabelText("Permissions") as HTMLSelectElement).value).toBe("ask");
      expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("sonnet");
      expect((screen.getByLabelText("At") as HTMLInputElement).value).toBe("09:00");
      fireEvent.click(screen.getByRole("button", { name: "Add routine" }));
      expect(props.add).toHaveBeenCalledWith({
        name: "Tests",
        folder: "/Users/you/dev/app",
        prompt: "Run the tests and tell me if anything broke",
        schedule: { kind: "weekdays", at: "09:00" },
        permissions: "ask",
        model: "sonnet",
      });
      // Saved: the form is gone.
      expect(screen.queryByRole("form", { name: "New routine" })).toBeNull();
    });

    it("builds each kind of schedule from friendly fields", async () => {
      const props = await setup([]);
      fireEvent.click(screen.getByRole("button", { name: "New routine" }));
      await waitFor(() => expect((screen.getByLabelText("Project") as HTMLSelectElement).value).not.toBe(""));
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "X" } });
      fireEvent.change(screen.getByLabelText("What should Claude do?"), { target: { value: "go" } });
      const how = screen.getByLabelText("How often");
      const save = () => {
        fireEvent.click(screen.getByRole("button", { name: "Add routine" }));
        return (props.add as ReturnType<typeof vi.fn>).mock.lastCall![0].schedule;
      };
      (props.add as ReturnType<typeof vi.fn>).mockReturnValue("stay open");
      fireEvent.change(how, { target: { value: "every" } });
      fireEvent.change(screen.getByLabelText("Every"), { target: { value: "30" } });
      fireEvent.change(screen.getByLabelText("Minutes or hours"), { target: { value: "minutes" } });
      expect(save()).toEqual({ kind: "every", every: 30, unit: "minutes" });
      fireEvent.change(how, { target: { value: "daily" } });
      fireEvent.change(screen.getByLabelText("At"), { target: { value: "07:15" } });
      expect(save()).toEqual({ kind: "daily", at: "07:15" });
      fireEvent.change(how, { target: { value: "weekly" } });
      fireEvent.change(screen.getByLabelText("On"), { target: { value: "5" } });
      expect(save()).toEqual({ kind: "weekly", day: 5, at: "07:15" });
    });

    it("warns in plain words when Auto is picked, and not for Ask", async () => {
      await setup([]);
      fireEvent.click(screen.getByRole("button", { name: "New routine" }));
      expect(screen.getByText(/With Ask, Claude stops and asks/)).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Permissions"), { target: { value: "auto" } });
      const warning = screen.getByRole("note");
      expect(warning.textContent).toMatch(/without asking you first/);
      expect(warning.textContent).toMatch(/while you may be away/);
      fireEvent.change(screen.getByLabelText("Permissions"), { target: { value: "ask" } });
      expect(screen.queryByRole("note")).toBeNull();
    });

    it("shows what is wrong and stays open", async () => {
      await setup([], { add: vi.fn(() => "Write what Claude should do.") });
      fireEvent.click(screen.getByRole("button", { name: "New routine" }));
      fireEvent.click(screen.getByRole("button", { name: "Add routine" }));
      expect(screen.getByRole("alert").textContent).toBe("Write what Claude should do.");
      expect(screen.getByRole("form", { name: "New routine" })).toBeTruthy();
    });

    it("closes without saving on Cancel", async () => {
      const props = await setup([]);
      fireEvent.click(screen.getByRole("button", { name: "New routine" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("form", { name: "New routine" })).toBeNull();
      expect(props.add).not.toHaveBeenCalled();
    });

    it("edits a routine: the form holds what it has, and Save sends the change", async () => {
      const props = await setup([routine({ schedule: { kind: "weekly", day: 2, at: "10:30" }, permissions: "auto", model: null })]);
      fireEvent.click(screen.getByRole("button", { name: /^Morning TODOs/ }));
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      const form = screen.getByRole("form", { name: "Edit Morning TODOs" });
      expect((within(form).getByLabelText("On") as HTMLSelectElement).value).toBe("2");
      expect((within(form).getByLabelText("At") as HTMLInputElement).value).toBe("10:30");
      expect((within(form).getByLabelText("Permissions") as HTMLSelectElement).value).toBe("auto");
      expect((within(form).getByLabelText("Model") as HTMLSelectElement).value).toBe("");
      fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Renamed" } });
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
      expect(props.edit).toHaveBeenCalledWith("r1", expect.objectContaining({ name: "Renamed", permissions: "auto", model: null, schedule: { kind: "weekly", day: 2, at: "10:30" } }));
    });

    it("keeps a routine's project in the list when it is no longer one of the sidebar's", async () => {
      await setup([routine({ folder: "/Users/you/old/elsewhere" })]);
      fireEvent.click(screen.getByRole("button", { name: /^Morning TODOs/ }));
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("/Users/you/old/elsewhere");
      expect(within(screen.getByLabelText("Project")).getByRole("option", { name: "elsewhere" })).toBeTruthy();
    });
  });

  it("stops New routine at the most there can be", async () => {
    const many = Array.from({ length: MAX_ROUTINES }, (_, i) => routine({ id: `r${i}`, name: `Routine ${i}` }));
    await setup(many);
    expect((screen.getByRole("button", { name: "New routine" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
