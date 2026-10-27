import "@shopify/flash-list/jestSetup";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import { chat, makeController, renderWith } from "../test/render";
import { loadDraft, resetDrafts, saveDraft } from "../drafts";
import { ChatScreen } from "./ChatScreen";
import { DRAFT_SAVE_MS } from "./ChatParts";

// The Keychain, as a map.
const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));

beforeEach(() => {
  mockStore.clear();
  resetDrafts();
});

async function open(slot = "a") {
  const { controller } = makeController();
  const session = attachSession(controller);
  const view = await renderWith(<ChatScreen slot={slot} onBack={jest.fn()} onReview={jest.fn()} />, { chats: [chat({ slot })], events: { [slot]: [] } }, controller);
  await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
  return { ...session, view };
}
const box = () => screen.getByLabelText("Message");

describe("a message not sent yet", () => {
  it("is put back in the box when the chat is opened again", async () => {
    await saveDraft("a", "half a thought");
    await open();
    await waitFor(() => expect(box().props.value).toBe("half a thought"));
  });

  it("is kept as it is typed", async () => {
    await open();
    await fireEvent.changeText(box(), "typing this");
    await waitFor(async () => expect(await loadDraft("a")).toBe("typing this"), { timeout: DRAFT_SAVE_MS + 1500 });
  });

  it("is forgotten once it is sent", async () => {
    const { lastOf } = await open();
    await fireEvent.changeText(box(), "go");
    await waitFor(async () => expect(await loadDraft("a")).toBe("go"), { timeout: DRAFT_SAVE_MS + 1500 });
    await act(async () => void fireEvent.press(screen.getByRole("button", { name: "Send" })));
    expect(lastOf("send")).toBeTruthy();
    await waitFor(async () => expect(await loadDraft("a")).toBe(""), { timeout: 1500 });
  });

  it("is kept when the chat is left before the pause is over", async () => {
    const { view } = await open();
    await fireEvent.changeText(box(), "quick exit");
    await act(async () => view.unmount());
    expect(await loadDraft("a")).toBe("quick exit");
  });

  it("is not put over what was typed meanwhile, and one chat's is not another's", async () => {
    await saveDraft("b", "for chat b");
    await open("a");
    expect(box().props.value).toBe("");
  });
});

describe("a message sent while Claude is busy", () => {
  const events = [
    { kind: "user_text" as const, text: "Start the build.", at: 1_000_000, sent_by: "desktop" },
    { kind: "tool_started" as const, tool_use_id: "t1", name: "Bash", summary: "npm run build" },
    { kind: "user_text" as const, text: "Then run the tests.", at: 1_000_100, sent_by: "desktop" },
  ];

  async function chatWith(status: "working" | "idle") {
    const { controller } = makeController();
    attachSession(controller);
    await renderWith(<ChatScreen slot="a" onBack={jest.fn()} onReview={jest.fn()} />, { chats: [chat({ status })], events: { a: events } }, controller);
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
  }

  it("says it is queued until Claude goes on", async () => {
    await chatWith("working");
    expect(screen.getAllByText(/Queued · Claude reads it after this step/)).toHaveLength(1);
  });

  it("says nothing once the chat is idle", async () => {
    await chatWith("idle");
    expect(screen.queryByText(/Queued/)).toBeNull();
  });
});

describe("a file change waiting inside the chat", () => {
  async function chatWithPrompt(input: unknown, tool = "Edit") {
    const { controller } = makeController();
    attachSession(controller);
    await renderWith(
      <ChatScreen slot="a" onBack={jest.fn()} onReview={jest.fn()} />,
      { chats: [chat({ status: "needs_you" })], events: { a: [{ kind: "permission_requested", request_id: "p1", tool_name: tool, input }] } },
      controller,
    );
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
  }

  it("shows the change, and can be swiped to allow when all of it is shown", async () => {
    await chatWithPrompt({ file_path: "/p/a.ts", old_string: "let a = 1;", new_string: "let a = 2;" });
    expect(screen.getByTestId("diff-preview")).toBeTruthy();
    expect(screen.getByText("let a = 2;")).toBeTruthy();
    expect(screen.getByLabelText("Swipe to allow")).toBeTruthy();
  });

  it("asks to be opened first when the change is longer than the card shows", async () => {
    await chatWithPrompt({ file_path: "/p/a.ts", content: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") }, "Write");
    expect(screen.queryByLabelText("Swipe to allow")).toBeNull();
    expect(screen.getByTestId("read-first")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review the change" })).toBeTruthy();
  });

  it("asks to be opened first when it replaces every place the text appears", async () => {
    await chatWithPrompt({ file_path: "/p/a.ts", old_string: "a", new_string: "b", replace_all: true });
    expect(screen.queryByLabelText("Swipe to allow")).toBeNull();
    expect(screen.getByText(/changes every place this text appears/i)).toBeTruthy();
  });

  it("a command is still swiped to allow as before", async () => {
    await chatWithPrompt({ command: "ls" }, "Bash");
    expect(screen.queryByTestId("diff-preview")).toBeNull();
    expect(screen.getByLabelText("Swipe to allow")).toBeTruthy();
  });
});
