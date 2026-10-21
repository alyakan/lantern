import { Platform } from "react-native";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import { chat, makeController, renderWith, waiting } from "../test/render";
import { HomeScreen } from "./HomeScreen";

const handlers = () => ({ onOpenChat: jest.fn(), onReview: jest.fn(), onOpenMac: jest.fn(), onCompose: jest.fn(), onNewChat: jest.fn() });

describe("Home", () => {
  it("has a way to start a chat, with nothing written yet", async () => {
    const h = handlers();
    await renderWith(<HomeScreen {...h} />, { chats: [chat()] });
    await fireEvent.press(screen.getByRole("button", { name: "New chat" }));
    expect(h.onNewChat).toHaveBeenCalledWith();
  });

  it("leads with how many things wait on you, and the oldest as a card to review", async () => {
    const h = handlers();
    await renderWith(<HomeScreen {...h} />, { chats: [chat()], waiting: [waiting({ request_id: "late", at: 9, input: { command: "npm publish" } }), waiting({ request_id: "early", at: 2 })] });
    expect(screen.getByText("2 things")).toBeTruthy();
    expect(screen.getByText("waiting on you")).toBeTruthy();
    expect(screen.getByText("Run a command")).toBeTruthy();
    expect(screen.getByText("Push the release branch")).toBeTruthy();
    expect(screen.getByText("git push origin release/0.1.53")).toBeTruthy();
    expect(screen.getByText("Release 0.1.53, in lantern")).toBeTruthy();
    expect(screen.getByText("1 more after this one")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Review" }));
    expect(h.onReview).toHaveBeenCalledWith("a", "early");
    await fireEvent.press(screen.getByRole("button", { name: "Open chat" }));
    expect(h.onOpenChat).toHaveBeenCalledWith("a");
  });

  it("suggests what to do next when nothing waits on you, with one way to start a chat of your own: New chat", async () => {
    const { controller } = makeController();
    const { asked } = attachSession(controller, { suggest: { items: [], generated_at: 1 } });
    const h = handlers();
    await renderWith(<HomeScreen {...h} />, { chats: [chat()], waiting: [] }, controller);
    await waitFor(() => expect(screen.getByText("Claude suggests")).toBeTruthy());
    expect(asked.some((r) => r.op === "suggest")).toBe(true);
    expect(screen.queryByRole("button", { name: "Start something new" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "New chat" })).toHaveLength(1);
  });

  it("doesn't suggest anything, or ask Claude, while something waits on you: that leads", async () => {
    const { controller } = makeController();
    const { asked } = attachSession(controller, { suggest: { items: [], generated_at: 1 } });
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat()], waiting: [waiting()] }, controller);
    expect(screen.queryByText("Claude suggests")).toBeNull();
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
    expect(asked.filter((r) => r.op === "suggest")).toEqual([]);
  });

  it("says nothing waits, and shows no stack", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat()], waiting: [] });
    expect(screen.getByText("Nothing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    expect(screen.queryByText(/more after this one/)).toBeNull();
  });

  it("lists the chats most recent first with their state, and opens one", async () => {
    const h = handlers();
    await renderWith(<HomeScreen {...h} />, {
      chats: [chat({ slot: "old", title: "Network tab filters", project: "network-monitor", status: "asleep", active_at: 1 }), chat({ slot: "w", title: "Mobile gateway design", status: "working" }), chat({ slot: "n", title: "Storage audit", status: "needs_you", active_at: 5 })],
    });
    expect(screen.getByText("Asleep")).toBeTruthy();
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByLabelText("Working")).toBeTruthy();
    const names = screen.getAllByRole("button").map((b) => b.props.accessibilityLabel as string).filter((l) => /lantern|network-monitor/.test(l));
    expect(names[0]).toContain("Mobile gateway design");
    expect(names[names.length - 1]).toContain("Network tab filters");
    await fireEvent.press(screen.getByRole("button", { name: /Network tab filters/ }));
    expect(h.onOpenChat).toHaveBeenCalledWith("old");
  });

  it("says what to do when no chats are open", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [] });
    expect(screen.getByText(/No chats are open on your Mac/)).toBeTruthy();
  });

  it("names the Mac, and opens its sheet", async () => {
    const h = handlers();
    await renderWith(<HomeScreen {...h} />, { chats: [] });
    await fireEvent.press(screen.getByRole("button", { name: "Aly's MacBook Pro, connected" }));
    expect(h.onOpenMac).toHaveBeenCalled();
  });

  it("offers Message a chat on Android, and only there", async () => {
    const h = handlers();
    const original = Platform.OS;
    Platform.OS = "android";
    const view = await renderWith(<HomeScreen {...h} />, { chats: [chat()] });
    await fireEvent.press(screen.getByRole("button", { name: "Message a chat" }));
    expect(h.onCompose).toHaveBeenCalled();
    await view.unmount();
    Platform.OS = "ios";
    await renderWith(<HomeScreen {...h} />, { chats: [chat()] });
    expect(screen.queryByRole("button", { name: "Message a chat" })).toBeNull();
    Platform.OS = original;
  });

  it("shows a question as a question, to review", async () => {
    await renderWith(<HomeScreen {...handlers()} />, { chats: [chat()], waiting: [waiting({ tool_name: "AskUserQuestion", input: { questions: [{ question: "Which channel?", header: "Channel", options: [{ label: "Stable" }] }] } })] });
    expect(screen.getByText("A question")).toBeTruthy();
    expect(screen.getByText("Which channel?")).toBeTruthy();
  });
});
