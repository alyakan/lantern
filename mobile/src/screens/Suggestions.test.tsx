import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import type { Suggestions as Answer } from "../protocol/generated/Suggestions";
import { attachSession } from "../test/fakeSession";
import { chat, makeController, renderWith } from "../test/render";
import { Suggestions } from "./Suggestions";

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
  const onNewChat = jest.fn();
  await renderWith(<Suggestions onPick={onPick} onNewChat={onNewChat} />, { chats: [chat({ slot: "a", title: "Release 0.1.53" })] }, controller);
  return { onPick, onNewChat, ...session };
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
    await renderWith(<Suggestions onPick={jest.fn()} onNewChat={jest.fn()} />, { chats: [chat()] }, controller);
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

  it("starts something new with nothing written, always", async () => {
    const { onNewChat } = await show();
    await fireEvent.press(screen.getByRole("button", { name: "Start something new" }));
    expect(onNewChat).toHaveBeenCalledWith();
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
    expect(screen.getByRole("button", { name: "Start something new" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(asked.filter((r) => r.op === "suggest")).toHaveLength(2));
  });

  it("says so when nothing comes to mind, and still offers to start something", async () => {
    await show({ suggest: { items: [], generated_at: 1 } });
    await waitFor(() => expect(screen.getByText(/Nothing in particular comes to mind/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Start something new" })).toBeTruthy();
  });
});
