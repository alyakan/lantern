import "@shopify/flash-list/jestSetup";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { RemoteEvent } from "../protocol/generated/RemoteEvent";
import { attachSession } from "../test/fakeSession";
import { chat, connected, makeController, renderWith } from "../test/render";
import { ChatScreen } from "./ChatScreen";
import { PromptRow } from "./ChatParts";

const handlers = () => ({ slot: "a", onBack: jest.fn(), onReview: jest.fn() });

const turn: RemoteEvent[] = [
  { kind: "user_text", text: "Cut 0.1.53 with the context menu fix.", at: 1_000_000, sent_by: "desktop" },
  { kind: "assistant_text", block_id: "b1", text: "Bumping the version, then **running** the tests." },
  { kind: "tool_started", tool_use_id: "t1", name: "Read", summary: "package.json" },
  { kind: "tool_finished", tool_use_id: "t1", is_error: false },
  { kind: "tool_started", tool_use_id: "t2", name: "Edit", summary: "Cargo.toml" },
  { kind: "file_edited", tool_use_id: "t2", path: "/p/Cargo.toml", created: false, added: 1, removed: 1 },
  { kind: "tool_started", tool_use_id: "t3", name: "Bash", summary: "npm test" },
  { kind: "tests_ran", tool_use_id: "t3", command: "npm test", passed: 412, failed: 0, skipped: 0 },
  { kind: "turn_done", is_error: false, result: "ok", duration_ms: 3100 },
];

const withSession = async (events: RemoteEvent[], over = {}, answers = {}, chatOver = {}) => {
  const { controller } = makeController();
  const session = attachSession(controller, answers);
  const h = handlers();
  const view = await renderWith(<ChatScreen {...h} {...over} />, { chats: [chat(chatOver)], events: { a: events } }, controller);
  // FlashList lays its rows out a tick after it mounts.
  await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
  return { ...view, ...session, h, controller };
};

describe("a chat", () => {
  it("reads as a timeline: your message with its time, Claude's text, a row of chips, and how long it took", async () => {
    await withSession(turn);
    expect(screen.getByText("Release 0.1.53")).toBeTruthy();
    expect(screen.getByText("lantern")).toBeTruthy();
    expect(screen.getByText("Cut 0.1.53 with the context menu fix.")).toBeTruthy();
    expect(screen.getByText(new Date(1_000_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))).toBeTruthy();
    expect(screen.getByText("Bumping the version, then running the tests.")).toBeTruthy();
    expect(screen.getByText("Read 1 file")).toBeTruthy();
    expect(screen.getByText("Edited 1 file +1 −1")).toBeTruthy();
    expect(screen.getByText("412 tests passed")).toBeTruthy();
    expect(screen.getByText("Finished in 3 s")).toBeTruthy();
  });

  it("follows the chat while it is open and lets go when it closes", async () => {
    const { asked, unmount } = await withSession(turn);
    expect(asked).toContainEqual({ op: "subscribe", slot: "a", after: 9, epoch: 1 });
    await unmount();
    expect(asked).toContainEqual({ op: "unsubscribe", slot: "a" });
  });

  it("goes back", async () => {
    const { h } = await withSession(turn);
    await fireEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(h.onBack).toHaveBeenCalled();
  });

  it("sends what is typed, clears the box, and shows the message at once", async () => {
    const { lastOf } = await withSession(turn);
    await fireEvent.changeText(screen.getByLabelText("Message"), "  ship it  ");
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(lastOf("send")).toEqual({ op: "send", slot: "a", text: "ship it", client_id: "m-test" }));
    expect(screen.getByLabelText("Message").props.value).toBe("");
    expect(screen.getByText("ship it")).toBeTruthy();
  });

  it("doesn't send an empty message", async () => {
    const { lastOf } = await withSession(turn);
    expect(screen.getByRole("button", { name: "Send" }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.changeText(screen.getByLabelText("Message"), "   ");
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    expect(lastOf("send")).toBeUndefined();
  });

  it("says why a message didn't go", async () => {
    await withSession(turn, {}, { send: new Error("That chat isn't open on your Mac.") });
    await fireEvent.changeText(screen.getByLabelText("Message"), "hi");
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText("Not sent. That chat isn't open on your Mac.")).toBeTruthy());
  });

  it("stops Claude while it works, and only then offers to", async () => {
    const quiet = await withSession(turn);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    await quiet.unmount();
    const { lastOf } = await withSession(turn, {}, {}, { status: "working" });
    expect(screen.getByText("Claude is working…")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(lastOf("interrupt")).toEqual({ op: "interrupt", slot: "a" }));
  });

  it("wakes a sleeping chat before it can be messaged", async () => {
    const { lastOf } = await withSession(turn, {}, {}, { status: "asleep" });
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(screen.getByText(/asleep to save memory/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Wake this chat" }));
    await waitFor(() => expect(lastOf("wake")).toEqual({ op: "wake", slot: "a" }));
  });

  it("says when it isn't connected, and won't take a message", async () => {
    const { controller } = makeController();
    await renderWith(<ChatScreen {...handlers()} />, { chats: [chat()], events: { a: turn }, connection: { kind: "offline", reason: "x", retryInMs: 1000 } }, controller);
    expect(screen.getByText(/Not connected to your Mac/)).toBeTruthy();
    expect(screen.getByLabelText("Message").props.editable).toBe(false);
  });

  it("says how much a catch-up covered, for a moment", async () => {
    // Set up with real timers (the screen settles on one), then take the clock over for the banner's four seconds.
    const { controller } = await withSession(turn);
    jest.useFakeTimers();
    try {
      await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "reset", slot: "a", seq: 24, page: 0, done: true, hidden: 0, events: turn } }));
      expect(screen.getByText("Caught up on 15 events from while you were away")).toBeTruthy();
      await act(async () => void jest.advanceTimersByTime(4500));
      expect(screen.queryByText(/Caught up on/)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("brings earlier turns when there are some", async () => {
    const { controller, lastOf } = await withSession(turn, {}, { earlier: { events: [{ kind: "user_text", text: "the very first thing", at: 1, sent_by: null }], hidden: 0 } });
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "reset", slot: "a", seq: 9, page: 0, done: true, hidden: 3, events: turn } }));
    await fireEvent.press(screen.getByRole("button", { name: "Show earlier messages (3 turns)" }));
    await waitFor(() => expect(lastOf("earlier")).toEqual({ op: "earlier", slot: "a", hidden: 3 }));
    await waitFor(() => expect(screen.getByText("the very first thing")).toBeTruthy());
  });
});

describe("what waits on you, in a chat", () => {
  const asked: RemoteEvent = { kind: "permission_requested", request_id: "p1", tool_name: "Bash", input: { command: "git push", description: "Push the branch" } };

  const swipeAction = (node = screen.getByLabelText("Swipe to allow")) => fireEvent(node, "accessibilityAction", { nativeEvent: { actionName: "activate" } });

  it("shows something to allow as a card with a swipe to allow it right there, and Expand for the whole screen", async () => {
    const { h } = await withSession([...turn.slice(0, 2), asked]);
    expect(screen.getByText("Push the branch")).toBeTruthy();
    expect(screen.getByLabelText("Swipe to allow")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Expand" }));
    expect(h.onReview).toHaveBeenCalledWith("p1");
  });

  it("allows it from the chat with the swipe, and the bar stays, closed in to the check, until the Mac says so", async () => {
    const { lastOf, h } = await withSession([...turn.slice(0, 2), asked]);
    await act(async () => swipeAction());
    await waitFor(() => expect(lastOf("answer")).toEqual({ op: "answer", slot: "a", request_id: "p1", allow: true, message: null, answers: null }));
    expect(screen.getByLabelText("Allowed")).toBeTruthy();
    expect(screen.queryByLabelText("Swipe to allow")).toBeNull();
    // It does not leave the chat.
    expect(h.onReview).not.toHaveBeenCalled();
  });

  it("allows once, however often it is activated", async () => {
    const { asked: sent } = await withSession([...turn.slice(0, 2), asked]);
    await act(async () => {
      swipeAction();
      swipeAction();
    });
    await waitFor(() => expect(sent.filter((r) => r.op === "answer")).toHaveLength(1));
  });

  it("says why when it couldn't be answered, and brings a fresh bar back to try again", async () => {
    const { lastOf } = await withSession([...turn.slice(0, 2), asked], {}, { answer: new Error("That was answered already, or Claude stopped asking.") });
    await act(async () => swipeAction());
    await waitFor(() => expect(screen.getByText("That was answered already, or Claude stopped asking.")).toBeTruthy());
    expect(screen.getByLabelText("Swipe to allow")).toBeTruthy();
    expect(screen.queryByLabelText("Allowed")).toBeNull();
    expect(lastOf("answer")).toMatchObject({ allow: true });
  });

  it("says it approves, for an approval", async () => {
    await withSession([{ kind: "permission_requested", request_id: "ap", tool_name: "mcp__lantern__request_approval", input: { action: "merge the PR", why: "It is green." } }]);
    expect(screen.getByLabelText("Swipe to approve")).toBeTruthy();
  });

  it("has no swipe for a question: that is answered on the full screen, from Review", async () => {
    const { h } = await withSession([{ kind: "permission_requested", request_id: "q1", tool_name: "AskUserQuestion", input: { questions: [{ question: "Which channel?", header: "", options: [{ label: "Stable", description: "" }], multiSelect: false }] } }]);
    expect(screen.queryByLabelText("Swipe to allow")).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Review" }));
    expect(h.onReview).toHaveBeenCalledWith("q1");
  });

  it("says who answered it afterwards: the Mac, this phone, or another", async () => {
    for (const [by, words] of [["desktop", "Allowed on your Mac"], ["phone-other", "Allowed on another phone"]] as const) {
      const { unmount } = await withSession([...turn.slice(0, 2), asked, { kind: "permission_resolved", request_id: "p1", allow: true, by }]);
      expect(screen.getByText(`Push the branch: ${words}`)).toBeTruthy();
      await unmount();
    }
  });

  it("shows what this phone answered a question with, as the answer, not as JSON or only 'answered'", async () => {
    const item = { kind: "prompt" as const, id: "q1", toolName: "AskUserQuestion", input: { questions: [{ question: "Which channel?", header: "", options: [{ label: "Stable", description: "" }], multiSelect: false }] }, state: "allowed" as const, by: "phone-x", answer: "Stable" };
    await render(<PromptRow item={item} me="phone-x" onReview={() => {}} />);
    expect(screen.getByText("Which channel")).toBeTruthy();
    expect(screen.getByText("Stable")).toBeTruthy();
    expect(screen.queryByText(/Answered/)).toBeNull();
    expect(screen.queryByText(/[{}"]/)).toBeNull();
  });

  it("says Claude stopped asking when it withdraws", async () => {
    await withSession([asked, { kind: "permission_withdrawn", request_id: "p1" }]);
    expect(screen.getByText("Push the branch: Claude stopped asking")).toBeTruthy();
  });

  it("says what only the Mac can answer, instead of hiding it", async () => {
    await withSession([{ kind: "needs_desktop", what: "Builder wants to merge its branch." }]);
    expect(screen.getByText("Answer this on your Mac")).toBeTruthy();
    expect(screen.getByText("Builder wants to merge its branch.")).toBeTruthy();
  });
});

describe("Step by step's pages", () => {
  const page: RemoteEvent[] = [{ kind: "assistant_text", block_id: "pg", text: "# Step 2 of 4 — Bump the version\n\npackage.json and Cargo.toml go from 0.1.52 to 0.1.53." }];

  it("shows a page as a card, with the Mac's own buttons while it is the live one", async () => {
    const { lastOf } = await withSession(page);
    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
    expect(screen.getByText("Bump the version")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Commit, next" }));
    await waitFor(() => expect(lastOf("send")).toMatchObject({ op: "send", text: "Next. Commit this step first." }));
    // Answered: its buttons are gone.
    expect(screen.queryByRole("button", { name: "Commit, next" })).toBeNull();
  });

  it("sends Don't commit as the Mac does", async () => {
    const { lastOf } = await withSession(page);
    await fireEvent.press(screen.getByRole("button", { name: "Don't commit" }));
    await waitFor(() => expect(lastOf("send")).toMatchObject({ text: "Next. Don't commit this step." }));
  });

  it("takes the buttons off a page that has been answered, in the history", async () => {
    await withSession([...page, { kind: "user_text", text: "Next", at: 5, sent_by: "desktop" }, { kind: "assistant_text", block_id: "pg2", text: "# Step 3 of 4 — Open the PR" }]);
    expect(screen.getAllByRole("button", { name: "Commit, next" })).toHaveLength(1);
  });

  it("has no buttons on a Done page", async () => {
    await withSession([{ kind: "assistant_text", block_id: "d", text: "# Done — built it" }]);
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });
});

describe("what a turn changed", () => {
  it("opens the diff of an edited file from its chip, with added and removed lines told apart", async () => {
    const { lastOf } = await withSession(turn, {}, { diff: "--- /p/Cargo.toml\n+++ /p/Cargo.toml\n@@ -3 +3 @@\n-version = \"0.1.52\"\n+version = \"0.1.53\"\n" });
    await fireEvent.press(screen.getByText("Edited 1 file +1 −1"));
    await waitFor(() => expect(screen.getByText("+version = \"0.1.53\"")).toBeTruthy());
    expect(lastOf("diff")).toEqual({ op: "diff", slot: "a", path: "/p/Cargo.toml" });
    expect(screen.getByText("What changed")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText("What changed")).toBeNull());
  });

  it("says why a diff couldn't be read", async () => {
    await withSession(turn, {}, { diff: new Error("That file wasn't changed in this chat.") });
    await fireEvent.press(screen.getByText("Edited 1 file +1 −1"));
    await waitFor(() => expect(screen.getByText("That file wasn't changed in this chat.")).toBeTruthy());
  });
});

it("is a connected chat: the seeded connection is the one the screen reads", async () => {
  const { controller } = makeController();
  await renderWith(<ChatScreen {...handlers()} />, { chats: [chat()] }, controller);
  expect(controller.getConnection()).toEqual(connected);
});
