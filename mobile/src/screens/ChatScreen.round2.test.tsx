import "@shopify/flash-list/jestSetup";
import { Share, StyleSheet } from "react-native";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import type { RemoteEvent } from "../protocol/generated/RemoteEvent";
import { attachSession } from "../test/fakeSession";
import { chat, makeController, renderWith } from "../test/render";
import { resetSeen } from "../seen";
import { ChatScreen } from "./ChatScreen";

jest.mock("../prefs", () => ({
  ...jest.requireActual("../prefs"),
  loadSeen: jest.fn(async () => ({})),
  saveSeen: jest.fn(async () => {}),
}));
beforeEach(() => resetSeen());

const withSession = async (events: RemoteEvent[], chatOver = {}) => {
  const { controller } = makeController();
  const session = attachSession(controller, {});
  await renderWith(<ChatScreen slot="a" onBack={jest.fn()} onReview={jest.fn()} />, { chats: [chat(chatOver)], events: { a: events } }, controller);
  await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
  return session;
};

const asked: RemoteEvent = { kind: "user_text", text: "Fix the login bug", at: 1_000_000, sent_by: "desktop" };
const edited: RemoteEvent[] = [
  { kind: "tool_started", tool_use_id: "t1", name: "Edit", summary: "src/auth.ts" },
  { kind: "file_edited", tool_use_id: "t1", path: "/p/src/auth.ts", created: false, added: 3, removed: 1 },
  { kind: "tool_finished", tool_use_id: "t1", is_error: false },
];
const done: RemoteEvent = { kind: "turn_done", is_error: false, result: "ok", duration_ms: 9000, context_window: null };

describe("your messages", () => {
  it("are on the right, with the corner by the tail on the right too", async () => {
    await withSession([asked]);
    const bubble = StyleSheet.flatten(screen.getByLabelText("You: Fix the login bug").props.style);
    expect(bubble.borderBottomRightRadius).toBe(6);
    expect(bubble.borderBottomLeftRadius).toBeUndefined();
  });

  it("can be shared, and say when they were sent when held down", async () => {
    const share = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction", activityType: undefined });
    await withSession([asked]);
    await fireEvent(screen.getByLabelText("You: Fix the login bug"), "longPress");
    expect(screen.getByText(/^Sent /)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Share" }));
    expect(share).toHaveBeenCalledWith({ message: "Fix the login bug" });
  });
});

describe("while Claude works", () => {
  it("says what it is doing right now", async () => {
    await withSession([asked, { kind: "tool_started", tool_use_id: "t9", name: "Bash", summary: "npm test" }], { status: "working" });
    expect(screen.getByText(/^Running npm test/)).toBeTruthy();
    // The chip of the step still going has a spinner.
    expect(screen.getByTestId("chip-busy")).toBeTruthy();
  });

  it("shows a caret at the end of words still coming in", async () => {
    await withSession([asked, { kind: "text_delta", block_id: "b1", text: "Looking at the" }], { status: "working" });
    expect(screen.getByText("Looking at the ▍")).toBeTruthy();
  });
});

describe("a file the turn edited, named in Claude's words", () => {
  it("opens what changed in it", async () => {
    const session = await withSession([asked, ...edited, { kind: "assistant_text", block_id: "b2", text: "Fixed it in `auth.ts`." }, done]);
    await fireEvent.press(screen.getByRole("link", { name: "auth.ts" }));
    await waitFor(() => expect(session.asked.some((r) => r.op === "diff" && (r as { path?: string }).path === "/p/src/auth.ts")).toBe(true));
  });
});

describe("the post-hook", () => {
  it("is one quiet line after the answer, that opens to what it said", async () => {
    await withSession([asked, { kind: "assistant_text", block_id: "b1", text: "All fixed." }, { kind: "hook_turn", text: "Update the brain if needed" }, { kind: "assistant_text", block_id: "h1", text: "Checked the notes.\n\nThe brain is updated." }, done]);
    expect(screen.getByText("All fixed.")).toBeTruthy();
    expect(screen.queryByText("Checked the notes.")).toBeNull();
    const line = screen.getByRole("button", { name: /^Post-hook: Update the brain if needed\. The brain is updated\./ });
    await fireEvent.press(line);
    expect(screen.getByText("Checked the notes.")).toBeTruthy();
    // The quick replies still answer the answer, not the hook.
  });
});

describe("a turn that failed", () => {
  it("can be tried again, which sends its message once more", async () => {
    const session = await withSession([asked, { kind: "turn_done", is_error: true, result: "rate limited", duration_ms: 1, context_window: null }]);
    expect(screen.getByText("Stopped with an error: rate limited")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(session.asked.some((r) => r.op === "send" && (r as { text?: string }).text === "Fix the login bug")).toBe(true));
  });

  it("offers no Try again once a later turn has come", async () => {
    await withSession([asked, { kind: "turn_done", is_error: true, result: "x", duration_ms: 1, context_window: null }, { kind: "user_text", text: "again", at: 1_000_500, sent_by: "desktop" }, { kind: "assistant_text", block_id: "z", text: "ok" }, done]);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
