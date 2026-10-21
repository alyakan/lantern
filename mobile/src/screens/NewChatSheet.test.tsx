import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import { makeController, renderWith } from "../test/render";
import { NewChatSheet } from "./NewChatSheet";

const projects = [
  { id: "/Users/me/lantern", name: "lantern" },
  { id: "/Users/me/website", name: "website" },
];

async function open(answers: Parameters<typeof attachSession>[1] = { projects, new_chat: { slot: "s9" } }, props: Partial<Parameters<typeof NewChatSheet>[0]> = {}) {
  const { controller } = makeController();
  const session = attachSession(controller, answers);
  const onClose = jest.fn();
  const onStarted = jest.fn();
  await renderWith(<NewChatSheet onClose={onClose} onStarted={onStarted} {...props} />, {}, controller);
  return { onClose, onStarted, ...session };
}

const write = (text: string) => fireEvent.changeText(screen.getByLabelText("What to start with"), text);

describe("while the projects are coming", () => {
  it("shows the shape of the project picker, and then the projects in its place", async () => {
    const { controller } = makeController();
    let release: (v: unknown) => void = () => {};
    controller.sync.onSession({ welcome: { type: "welcome", protocol: 1, app_version: "t", mac_name: "Mac", epoch: 1 }, ask: () => new Promise((r) => (release = r)) } as never);
    await renderWith(<NewChatSheet onClose={jest.fn()} onStarted={jest.fn()} />, {}, controller);
    expect(screen.getByLabelText("Looking at your projects")).toBeTruthy();
    expect(screen.queryByText("Looking at your projects…")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    release(projects);
    await waitFor(() => expect(screen.getByRole("radio", { name: "lantern" })).toBeTruthy());
    expect(screen.queryByLabelText("Looking at your projects")).toBeNull();
  });

  it("has none of it when carrying a chat on: there are no projects to wait for", async () => {
    await open(undefined, { continueChat: { slot: "a", title: "Release 0.1.53" } });
    expect(screen.queryByLabelText("Looking at your projects")).toBeNull();
  });
});

describe("starting a chat from the phone", () => {
  it("says it starts on Ask, offers the projects, and starts in the first one by default", async () => {
    const { lastOf, onStarted } = await open();
    expect(screen.getByText(/starts on Ask/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("radio", { name: "lantern" })).toBeTruthy());
    expect(screen.getByRole("radio", { name: "website" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "lantern" }).props.accessibilityState).toMatchObject({ selected: true });
    await write("Fix the login bug");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("s9"));
    expect(lastOf("new_chat")).toEqual({ op: "new_chat", project: "/Users/me/lantern", text: "Fix the login bug" });
  });

  it("starts in the project that was picked, with the text trimmed", async () => {
    const { lastOf, onStarted } = await open();
    await waitFor(() => screen.getByRole("radio", { name: "website" }));
    await fireEvent.press(screen.getByRole("radio", { name: "website" }));
    expect(screen.getByRole("radio", { name: "website" }).props.accessibilityState).toMatchObject({ selected: true });
    await write("  Update the footer  \n");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(lastOf("new_chat")).toMatchObject({ project: "/Users/me/website", text: "Update the footer" });
  });

  it("can't start without something written, or while it is starting", async () => {
    const { asked } = await open();
    await waitFor(() => screen.getByRole("radio", { name: "lantern" }));
    expect(screen.getByRole("button", { name: "Start the chat" })).toBeDisabled();
    await write("   ");
    expect(screen.getByRole("button", { name: "Start the chat" })).toBeDisabled();
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    expect(asked.filter((r) => r.op === "new_chat")).toEqual([]);
  });

  it("begins from a suggestion's draft and project, which can still be changed", async () => {
    const { lastOf } = await open(undefined, { initialText: "Continue with the release notes", initialProject: "/Users/me/website" });
    await waitFor(() => screen.getByRole("radio", { name: "website" }));
    expect(screen.getByRole("radio", { name: "website" }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByLabelText("What to start with").props.value).toBe("Continue with the release notes");
    await write("Continue with the release notes, short");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(lastOf("new_chat")).toMatchObject({ project: "/Users/me/website", text: "Continue with the release notes, short" }));
  });

  it("falls back to the first project when the draft's isn't one the Mac lists", async () => {
    await open(undefined, { initialProject: "/Users/me/gone" });
    await waitFor(() => screen.getByRole("radio", { name: "lantern" }));
    expect(screen.getByRole("radio", { name: "lantern" }).props.accessibilityState).toMatchObject({ selected: true });
  });

  it("says why when the Mac wouldn't start it, and keeps what was written", async () => {
    const { onStarted } = await open({ projects, new_chat: new Error("This phone has started a lot of chats just now. Try again in a few minutes.") });
    await waitFor(() => screen.getByRole("radio", { name: "lantern" }));
    await write("one more");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(screen.getByText(/started a lot of chats/)).toBeTruthy());
    expect(onStarted).not.toHaveBeenCalled();
    expect(screen.getByLabelText("What to start with").props.value).toBe("one more");
    expect(screen.getByRole("button", { name: "Start the chat" })).not.toBeDisabled();
  });

  it("says so when there are no projects, and when they couldn't be fetched", async () => {
    await open({ projects: [] });
    await waitFor(() => expect(screen.getByText(/No projects yet/)).toBeTruthy());
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByRole("button", { name: "Start the chat" })).toBeDisabled();
  });

  it("shows the Mac's reason when the projects couldn't be fetched", async () => {
    await open({ projects: new Error("Not connected to your Mac.") });
    await waitFor(() => expect(screen.getByText("Not connected to your Mac.")).toBeTruthy());
  });

  describe("carrying on a chat from a suggestion", () => {
    const carry = { slot: "a", title: "Release 0.1.53" };

    it("sends the draft to that chat without asking for a project, and goes into the chat", async () => {
      const { asked, lastOf, onStarted } = await open({}, { continueChat: carry, initialText: "Write the release notes." });
      expect(screen.getByText("Carry on")).toBeTruthy();
      expect(screen.getByText(/Release 0\.1\.53/)).toBeTruthy();
      expect(screen.queryByRole("radio")).toBeNull();
      expect(asked.filter((r) => r.op === "projects")).toEqual([]);
      await write("Write the release notes, short.");
      await fireEvent.press(screen.getByRole("button", { name: "Send" }));
      expect(onStarted).toHaveBeenCalledWith("a");
      await waitFor(() => expect(lastOf("send")).toMatchObject({ op: "send", slot: "a", text: "Write the release notes, short." }));
      expect(asked.filter((r) => r.op === "new_chat")).toEqual([]);
    });

    it("can't send a draft that was emptied", async () => {
      const { asked } = await open({}, { continueChat: carry, initialText: "Write the notes." });
      await write("  ");
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      await fireEvent.press(screen.getByRole("button", { name: "Send" }));
      expect(asked.filter((r) => r.op === "send")).toEqual([]);
    });
  });

  it("closes from Cancel", async () => {
    const { onClose } = await open();
    await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
