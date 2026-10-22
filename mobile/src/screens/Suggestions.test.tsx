import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import type { Suggestions as Answer } from "../protocol/generated/Suggestions";
import { attachSession } from "../test/fakeSession";
import { chat, makeController, renderWith } from "../test/render";
import { Suggestions } from "./Suggestions";

// What the phone remembers about the suggestions (folded away, dismissed): kept in memory here, not in the Keychain.
let mockPrefs = { collapsed: false, dismissed: [] as string[] };
jest.mock("../prefs", () => ({
  loadSuggestionPrefs: jest.fn(async () => ({ ...mockPrefs })),
  saveSuggestionPrefs: jest.fn(async (p: typeof mockPrefs) => {
    mockPrefs = { ...p };
  }),
}));
beforeEach(() => {
  mockPrefs = { collapsed: false, dismissed: [] };
});

const answer: Answer = {
  generated_at: 1,
  items: [
    { id: "s1", title: "Write the release notes", why: "The release is cut.", message: "Write the notes for 0.1.53.", target: { kind: "continue", slot: "a" } },
    { id: "s2", title: "Check the footer links", why: "A quick tidy.", message: "Fix the broken footer links.", target: { kind: "new_chat", project: "/Users/me/site", project_name: "site" } },
    { id: "s3", title: "Carry on in a chat that went", why: "It's gone.", message: "Hello.", target: { kind: "continue", slot: "gone" } },
  ],
};

async function show(answers: Parameters<typeof attachSession>[1] = { suggest: answer }) {
  const { controller } = makeController();
  const session = attachSession(controller, answers);
  const onPick = jest.fn();
  await renderWith(<Suggestions onPick={onPick} />, { chats: [chat({ slot: "a", title: "Release 0.1.53" })] }, controller);
  return { onPick, ...session };
}

describe("what Claude suggests on Home", () => {
  it("says it is thinking, then shows each suggestion with what it would do, in chats that are still there", async () => {
    await show();
    await waitFor(() => expect(screen.getByRole("button", { name: "Write the release notes. The release is cut." })).toBeTruthy());
    expect(screen.getByText("Carry on · Release 0.1.53")).toBeTruthy();
    expect(screen.getByText("New chat · site")).toBeTruthy();
    expect(screen.getByText("“Write the notes for 0.1.53.”")).toBeTruthy();
    expect(screen.queryByText("Carry on in a chat that went")).toBeNull();
    expect(screen.queryByLabelText("Thinking about what is next")).toBeNull();
  });

  it("shows the skeleton while Claude thinks", async () => {
    const { controller } = makeController();
    let release: (v: unknown) => void = () => {};
    controller.sync.onSession({ welcome: { type: "welcome", protocol: 1, app_version: "t", mac_name: "Mac", epoch: 1 }, ask: () => new Promise((r) => (release = r)) } as never);
    await renderWith(<Suggestions onPick={jest.fn()} />, { chats: [chat()] }, controller);
    expect(screen.getByLabelText("Thinking about what is next")).toBeTruthy();
    expect(screen.getByText("Thinking about what's next…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New ideas" })).toBeNull();
    release({ items: [], generated_at: 1 });
    await waitFor(() => expect(screen.getByRole("button", { name: "New ideas" })).toBeTruthy());
  });

  it("opens the draft of a carry-on, aimed at that chat, with its title", async () => {
    const { onPick } = await show();
    await waitFor(() => screen.getByText("Carry on · Release 0.1.53"));
    await fireEvent.press(screen.getByRole("button", { name: "Write the release notes. The release is cut." }));
    expect(onPick).toHaveBeenCalledWith({ text: "Write the notes for 0.1.53.", continueChat: { slot: "a", title: "Release 0.1.53" } });
  });

  it("opens the draft of a new chat, aimed at its project", async () => {
    const { onPick } = await show();
    await waitFor(() => screen.getByText("New chat · site"));
    await fireEvent.press(screen.getByRole("button", { name: "Check the footer links. A quick tidy." }));
    expect(onPick).toHaveBeenCalledWith({ text: "Fix the broken footer links.", project: "/Users/me/site" });
  });

  it("has no second way to start a chat of its own: that is Home's New chat", async () => {
    await show();
    await waitFor(() => screen.getByRole("button", { name: "New ideas" }));
    expect(screen.queryByRole("button", { name: "Start something new" })).toBeNull();
  });

  it("asks the Mac for new ones when asked", async () => {
    const { asked } = await show();
    await waitFor(() => screen.getByRole("button", { name: "New ideas" }));
    await fireEvent.press(screen.getByRole("button", { name: "New ideas" }));
    await waitFor(() => expect(asked.filter((r) => r.op === "suggest").map((r) => (r as { refresh: boolean }).refresh)).toEqual([false, true]));
  });

  it("says why when Claude couldn't, and can try again", async () => {
    const { asked } = await show({ suggest: new Error("Claude didn't answer in time.") });
    await waitFor(() => expect(screen.getByText("Claude didn't answer in time.")).toBeTruthy());
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(asked.filter((r) => r.op === "suggest")).toHaveLength(2));
  });

  it("says so when nothing comes to mind", async () => {
    await show({ suggest: { items: [], generated_at: 1 } });
    await waitFor(() => expect(screen.getByText(/Nothing in particular comes to mind/)).toBeTruthy());
  });
});

describe("hiding and dismissing suggestions", () => {
  it("dismisses one for good: it goes, the others stay, and it isn't offered again", async () => {
    await show();
    await waitFor(() => screen.getByRole("button", { name: "Write the release notes. The release is cut." }));
    await fireEvent.press(screen.getByRole("button", { name: "Dismiss Write the release notes" }));
    expect(screen.queryByRole("button", { name: "Write the release notes. The release is cut." })).toBeNull();
    expect(screen.getByRole("button", { name: "Check the footer links. A quick tidy." })).toBeTruthy();
    expect(mockPrefs.dismissed).toEqual(["Write the release notes|Write the notes for 0.1.53."]);
    // Home opened again later: the same suggestion comes from the Mac, and stays gone.
    await show();
    await waitFor(() => screen.getAllByRole("button", { name: "Check the footer links. A quick tidy." }));
    expect(screen.queryByRole("button", { name: "Write the release notes. The release is cut." })).toBeNull();
  });

  it("says so when every one is dismissed, and New ideas is still there", async () => {
    await show();
    await waitFor(() => screen.getByRole("button", { name: "Check the footer links. A quick tidy." }));
    await fireEvent.press(screen.getByRole("button", { name: "Dismiss Write the release notes" }));
    await fireEvent.press(screen.getByRole("button", { name: "Dismiss Check the footer links" }));
    expect(screen.getByText("Those are dismissed. New ideas has more.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New ideas" })).toBeTruthy();
  });

  it("folds away and comes back, and remembers it", async () => {
    await show();
    await waitFor(() => screen.getByRole("button", { name: "Check the footer links. A quick tidy." }));
    await fireEvent.press(screen.getByRole("button", { name: "Hide suggestions" }));
    expect(screen.queryByRole("button", { name: "Check the footer links. A quick tidy." })).toBeNull();
    expect(screen.queryByRole("button", { name: "New ideas" })).toBeNull();
    expect(mockPrefs.collapsed).toBe(true);
    await fireEvent.press(screen.getByRole("button", { name: "Show suggestions" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Check the footer links. A quick tidy." })).toBeTruthy());
    expect(mockPrefs.collapsed).toBe(false);
  });

  it("asks the Mac for nothing while folded away, since each ask costs usage, and asks once it is opened", async () => {
    mockPrefs = { collapsed: true, dismissed: [] };
    const { asked } = await show();
    await new Promise((r) => setTimeout(r, 50));
    expect(asked.some((r) => r.op === "suggest")).toBe(false);
    expect(screen.getByRole("button", { name: "Show suggestions" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Show suggestions" }));
    await waitFor(() => expect(asked.some((r) => r.op === "suggest")).toBe(true));
  });
});
