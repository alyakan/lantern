import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { ActivitySheet, filtered, filtersFor } from "./ActivitySheet";
import type { ActivityEntry } from "../view/timeline";

const step = (id: string, group: "read" | "edit" | "run" | "test" | "search" | "other", text: string, over: Partial<Extract<ActivityEntry, { kind: "step" }>> = {}): ActivityEntry => ({ key: id, kind: "step", id, group, text, bad: false, running: false, files: [], added: 0, removed: 0, ...over });
const note = (id: string, text: string): ActivityEntry => ({ key: id, kind: "note", text });

const entries: ActivityEntry[] = [
  step("1", "read", "Read a.ts"),
  note("2", "The grouping already exists."),
  step("3", "edit", "Edited a.ts", { files: ["/p/a.ts"], added: 4, removed: 1 }),
  step("4", "run", "Ran npm test", { bad: true }),
];

describe("what the Activity sheet filters", () => {
  it("offers only the kinds there are, and counts them", () => {
    expect(filtersFor(entries).map((f) => `${f.key}:${f.count}`)).toEqual(["all:4", "edits:1", "commands:1", "messages:1", "problems:1"]);
    expect(filtersFor([step("1", "read", "Read a.ts")]).map((f) => f.key)).toEqual(["all"]);
  });

  it("keeps the order things happened in", () => {
    expect(filtered(entries, "all").map((e) => e.key)).toEqual(["1", "2", "3", "4"]);
    expect(filtered(entries, "problems").map((e) => e.key)).toEqual(["4"]);
    expect(filtered(entries, "messages").map((e) => e.key)).toEqual(["2"]);
  });
});

describe("the Activity sheet", () => {
  const open = (props: Partial<Parameters<typeof ActivitySheet>[0]> = {}) => render(<ActivitySheet entries={entries} took="42 s" onFiles={() => {}} onClose={() => {}} {...props} />);

  it("lists every step and message in order, with how long it took", async () => {
    await open();
    for (const t of ["Read a.ts", "The grouping already exists.", "Edited a.ts", "Ran npm test", "Took 42 s"]) expect(screen.getByText(t)).toBeTruthy();
    expect(screen.getByText("+4 −1")).toBeTruthy();
  });

  it("narrows to a filter", async () => {
    await open();
    await fireEvent.press(screen.getByText("Edits 1"));
    expect(screen.getByText("Edited a.ts")).toBeTruthy();
    expect(screen.queryByText("Read a.ts")).toBeNull();
  });

  it("opens a message to its words, and goes back", async () => {
    await open();
    await fireEvent.press(screen.getByRole("button", { name: /^Message: The grouping/ }));
    expect(screen.getByText("Message")).toBeTruthy();
    expect(screen.queryByText("Read a.ts")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByText("Read a.ts")).toBeTruthy();
  });

  it("hands an edit to its diff, and a command to what it printed, once the sheet is away", async () => {
    jest.useFakeTimers();
    const onFiles = jest.fn();
    const onOutput = jest.fn();
    await open({ onFiles, onOutput });
    await fireEvent.press(screen.getByRole("button", { name: "Edited a.ts" }));
    expect(onFiles).not.toHaveBeenCalled();
    await act(async () => void jest.advanceTimersByTime(500));
    expect(onFiles).toHaveBeenCalledWith(["/p/a.ts"]);
    await fireEvent.press(screen.getByRole("button", { name: "Ran npm test" }));
    await act(async () => void jest.advanceTimersByTime(500));
    expect(onOutput).toHaveBeenCalledWith({ id: "4", text: "Ran npm test" });
    jest.useRealTimers();
  });

  it("does not make a row a button when nothing can be opened from it", async () => {
    await open();
    expect(screen.queryByRole("button", { name: "Ran npm test" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Read a.ts" })).toBeNull();
  });
});
