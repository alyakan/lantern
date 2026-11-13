import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import { connectedWith, connectedWithControls, makeController, renderWith } from "../test/render";
import { NewChatSheet } from "./NewChatSheet";
import { loadNewChatPermissions, saveNewChatPermissions } from "../prefs";

// Ask or Auto as last used: Ask (nothing kept) unless a test says otherwise.
jest.mock("../prefs", () => ({ ...jest.requireActual("../prefs"), loadNewChatPermissions: jest.fn(async () => "ask"), saveNewChatPermissions: jest.fn(async () => {}) }));
const loadPermissions = loadNewChatPermissions as jest.Mock;
const savePermissions = saveNewChatPermissions as jest.Mock;
beforeEach(() => {
  loadPermissions.mockReset().mockImplementation(async () => "ask");
  savePermissions.mockReset();
});

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

/** The line that says what it runs on opens its options. */
const openOptions = (summary: string | RegExp = /^Runs on/) => fireEvent.press(screen.getByRole("button", { name: summary }));
const write = (text: string) => fireEvent.changeText(screen.getByLabelText("What to start with"), text);
/** The chip that says which project it starts in (a guess until one is picked), and picking another from it. */
const chip = (name: string) => screen.getByRole("button", { name: new RegExp(`^Project: ${name}`) });
const projectsHere = () => waitFor(() => expect(screen.getByRole("button", { name: /^Project: / })).toBeTruthy());
async function pick(name: string) {
  await fireEvent.press(screen.getByRole("button", { name: /^Project: / }));
  await fireEvent.press(screen.getByRole("radio", { name }));
}

describe("while the projects are coming", () => {
  it("shows the shape of the project chip, and then the project in its place", async () => {
    const { controller } = makeController();
    let release: (v: unknown) => void = () => {};
    controller.sync.onSession({ welcome: { type: "welcome", protocol: 1, app_version: "t", mac_name: "Mac", epoch: 1 }, ask: () => new Promise((r) => (release = r)) } as never);
    await renderWith(<NewChatSheet onClose={jest.fn()} onStarted={jest.fn()} />, {}, controller);
    expect(screen.getByLabelText("Looking at your projects")).toBeTruthy();
    expect(screen.queryByText("Looking at your projects…")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Project: / })).toBeNull();
    release(projects);
    await projectsHere();
    expect(screen.queryByLabelText("Looking at your projects")).toBeNull();
  });

  it("has none of it when carrying a chat on: there are no projects to wait for", async () => {
    await open(undefined, { continueChat: { slot: "a", title: "Release 0.1.53" } });
    expect(screen.queryByLabelText("Looking at your projects")).toBeNull();
  });
});

describe("starting a chat from the phone", () => {

  it("says it starts on Ask, and starts in the first project by default", async () => {
    const { lastOf, onStarted } = await open();
    expect(screen.getByText(/starts on Ask/)).toBeTruthy();
    await projectsHere();
        expect(chip("lantern")).toBeTruthy();
    await write("Fix the login bug");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("s9"));
    expect(lastOf("new_chat")).toEqual({ op: "new_chat", project: "/Users/me/lantern", text: "Fix the login bug", permissions: null, preset: null, workflow: null });
  });

  it("starts in the project that was picked, with the text trimmed", async () => {
    const { lastOf, onStarted } = await open();
    await projectsHere();
    await pick("website");
    expect(chip("website")).toBeTruthy();
    await write("  Update the footer  \n");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(lastOf("new_chat")).toMatchObject({ project: "/Users/me/website", text: "Update the footer" });
  });

  it("starts in the project a chat belongs to when only its folder's name is known (the Done page's Start something new)", async () => {
    const { lastOf, onStarted } = await open(undefined, { initialProjectName: "website" });
    await waitFor(() => expect(chip("website")).toBeTruthy());
    await write("Add a footer");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(lastOf("new_chat")).toMatchObject({ project: "/Users/me/website", text: "Add a footer" });
  });

  it("falls back to the first project when that name isn't one the Mac lists", async () => {
    await open(undefined, { initialProjectName: "gone" });
    await waitFor(() => expect(chip("lantern")).toBeTruthy());
  });

  it("can't start without something written, or while it is starting", async () => {
    const { asked } = await open();
    await projectsHere();
    expect(screen.getByRole("button", { name: "Start the chat" })).toBeDisabled();
    await write("   ");
    expect(screen.getByRole("button", { name: "Start the chat" })).toBeDisabled();
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    expect(asked.filter((r) => r.op === "new_chat")).toEqual([]);
  });

  it("begins from a suggestion's draft and project, which can still be changed", async () => {
    const { lastOf } = await open(undefined, { initialText: "Continue with the release notes", initialProject: "/Users/me/website" });
    await projectsHere();
    expect(chip("website")).toBeTruthy();
    expect(screen.getByLabelText("What to start with").props.value).toBe("Continue with the release notes");
    await write("Continue with the release notes, short");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(lastOf("new_chat")).toMatchObject({ project: "/Users/me/website", text: "Continue with the release notes, short" }));
  });

  it("falls back to the first project when the draft's isn't one the Mac lists", async () => {
    await open(undefined, { initialProject: "/Users/me/gone" });
    await projectsHere();
    expect(chip("lantern")).toBeTruthy();
  });

  it("says why when the Mac wouldn't start it, and keeps what was written", async () => {
    const { onStarted } = await open({ projects, new_chat: new Error("This phone has started a lot of chats just now. Try again in a few minutes.") });
    await projectsHere();
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
    expect(screen.queryByRole("button", { name: /^Project: / })).toBeNull();
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
      expect(screen.queryByRole("button", { name: /^Project: / })).toBeNull();
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

describe("choosing what a new chat runs on", () => {
  const controls = (allow_auto: boolean) => ({ controls: { allow_auto, presets: [{ id: "balanced", name: "Balanced", summary: "Sonnet" }, { id: "max", name: "Max", summary: "Opus" }] } });
  async function openWithControls(allowAuto: boolean) {
    const { controller } = makeController();
    const session = attachSession(controller, { projects, new_chat: { slot: "s9" }, ...controls(allowAuto) }, ["controls", "workflow"]);
    const onStarted = jest.fn();
    await renderWith(<NewChatSheet onClose={jest.fn()} onStarted={onStarted} />, { connection: connectedWithControls }, controller);
    await projectsHere();
    return { onStarted, ...session };
  }

  it("starts on Ask with the project's own models unless something else is chosen", async () => {
    const { lastOf } = await openWithControls(true);
    // Said in a line first; the options are behind it.
    expect(screen.getByRole("button", { name: "Runs on: Chat · Ask · Project's own" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Auto" })).toBeNull();
    await openOptions();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" })).toBeTruthy());
    expect(screen.getByRole("radio", { name: "Ask" }).props.accessibilityState).toMatchObject({ selected: true });
    await write("Fix it");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(lastOf("new_chat")).toEqual({ op: "new_chat", project: "/Users/me/lantern", text: "Fix it", permissions: "ask", preset: null, workflow: null }));
  });

  it("starts on Auto with a preset when those are chosen and the Mac lets phones use Auto", async () => {
    const { lastOf } = await openWithControls(true);
    await openOptions();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: false }));
    await fireEvent.press(screen.getByRole("radio", { name: "Auto" }));
    expect(screen.getByText(/starts on Auto/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("radio", { name: "Max" }));
    expect(screen.getByRole("button", { name: "Runs on: Chat · Auto · Max" })).toBeTruthy();
    await write("Fix it");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(lastOf("new_chat")).toEqual({ op: "new_chat", project: "/Users/me/lantern", text: "Fix it", permissions: "auto", preset: "max", workflow: null }));
  });

  it("can't pick Auto while the Mac's setting is off, and says where to turn it on", async () => {
    await openWithControls(false);
    // The note is on the screen before anything is opened.
    expect(screen.getByText(/Let paired phones use Auto/)).toBeTruthy();
    await openOptions();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" })).toBeTruthy());
    expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByText(/Let paired phones use Auto/)).toBeTruthy();
  });

  it("starts on Ask or Auto as the last chat was started, whatever the project, and remembers what this one starts on", async () => {
    loadPermissions.mockImplementation(async () => "auto");
    const { lastOf } = await openWithControls(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Runs on: Chat · Auto · Project's own" })).toBeTruthy());
    await pick("website");
    await write("Fix it");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(lastOf("new_chat")).toMatchObject({ project: "/Users/me/website", permissions: "auto" }));
    expect(savePermissions).toHaveBeenCalledWith("auto");
  });

  it("starts a remembered Auto on Ask where the Mac doesn't let phones use Auto, and keeps remembering Auto", async () => {
    loadPermissions.mockImplementation(async () => "auto");
    const { lastOf } = await openWithControls(false);
    await waitFor(() => expect(loadPermissions).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Runs on: Chat · Ask · Project's own" })).toBeTruthy();
    await write("Fix it");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(lastOf("new_chat")).toMatchObject({ permissions: "ask" }));
    expect(savePermissions).not.toHaveBeenCalled();
  });

  it("offers nothing to choose from a Mac that can't say, and starts as before", async () => {
    const { lastOf } = await open();
    await projectsHere();
    expect(screen.queryByRole("radio", { name: "Auto" })).toBeNull();
    await write("Fix it");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(lastOf("new_chat")).toMatchObject({ op: "new_chat", permissions: null, preset: null, workflow: null }));
  });
});

describe("choosing where a new chat runs", () => {
  const claude = { id: "claude", name: "Claude", auto: true, presets: true };
  const ollama = { id: "gateway:ollama", name: "Ollama", auto: false, presets: false };
  const presets = [{ id: "balanced", name: "Balanced", summary: "Sonnet" }, { id: "max", name: "Max", summary: "Opus" }];
  async function openWith(controls: Record<string, unknown>) {
    const { controller } = makeController();
    const session = attachSession(controller, { projects, new_chat: { slot: "s9" }, controls }, ["controls", "workflow"]);
    const onStarted = jest.fn();
    await renderWith(<NewChatSheet onClose={jest.fn()} onStarted={onStarted} />, { connection: connectedWithControls }, controller);
    await projectsHere();
    return { onStarted, ...session };
  }
  const start = async (lastOf: (op: "new_chat") => unknown) => {
    await write("Fix it");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(lastOf("new_chat")).toBeTruthy());
    return lastOf("new_chat");
  };

  it("offers the providers beside the project's own when the Mac has more than Claude, and sends none unless one is chosen", async () => {
    const { lastOf } = await openWith({ allow_auto: true, presets, providers: [claude, ollama] });
    await openOptions();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Ollama" })).toBeTruthy());
    expect(screen.getAllByRole("radio").map((r) => r.props.accessibilityLabel)).toEqual(expect.arrayContaining(["As on your Mac", "Claude", "Ollama"]));
    // Not the same name as the Models group's own, which a screen reader would read twice.
    expect(screen.getAllByRole("radio", { name: "Project's own" })).toHaveLength(1);
    expect(screen.getByText("As on your Mac uses this project’s selected provider.")).toBeTruthy();
    const sent = (await start(lastOf)) as Record<string, unknown>;
    expect("provider" in sent).toBe(false);
  });

  it("starts where it was told to, on Ask, and says Auto and the models don't apply there", async () => {
    const { lastOf } = await openWith({ allow_auto: true, presets, providers: [claude, ollama] });
    await openOptions();
    await fireEvent.press(await screen.findByRole("radio", { name: "Ollama" }));
    expect(screen.getByRole("button", { name: "Runs on: Ollama · Chat · Ask" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByText("Ollama has no Auto mode: it asks before it acts.")).toBeTruthy();
    // The Mac's presets are Claude Code's models: not offered for a provider that runs its own.
    expect(screen.queryByRole("radio", { name: "Max" })).toBeNull();
    expect(await start(lastOf)).toEqual({ op: "new_chat", project: "/Users/me/lantern", text: "Fix it", permissions: "ask", preset: null, workflow: null, provider: "gateway:ollama" });
  });

  it("lets go of Auto and a preset chosen for Claude when the provider changes to one without them, and doesn't bring them back", async () => {
    const { lastOf } = await openWith({ allow_auto: true, presets, providers: [claude, ollama] });
    await openOptions();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: false }));
    await fireEvent.press(screen.getByRole("radio", { name: "Auto" }));
    await fireEvent.press(screen.getByRole("radio", { name: "Max" }));
    expect(screen.getByRole("button", { name: "Runs on: Chat · Auto · Max" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("radio", { name: "Ollama" }));
    expect(screen.getByRole("button", { name: "Runs on: Ollama · Chat · Ask" })).toBeTruthy();
    // Back to Claude: it is Ask and the project's own models, not the Auto and Max that were there before.
    await fireEvent.press(screen.getByRole("radio", { name: "Claude" }));
    expect(screen.getByRole("button", { name: "Runs on: Claude · Chat · Ask · Project's own" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Ask" }).props.accessibilityState).toMatchObject({ selected: true });
    expect(await start(lastOf)).toEqual({ op: "new_chat", project: "/Users/me/lantern", text: "Fix it", permissions: "ask", preset: null, workflow: null, provider: "claude" });
  });

  it("sends neither Auto nor a preset to a provider without them, however the choices were made", async () => {
    const { lastOf } = await openWith({ allow_auto: true, presets, providers: [claude, ollama] });
    await openOptions();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: false }));
    await fireEvent.press(screen.getByRole("radio", { name: "Max" }));
    await fireEvent.press(screen.getByRole("radio", { name: "Ollama" }));
    const sent = (await start(lastOf)) as Record<string, unknown>;
    expect(sent).toMatchObject({ permissions: "ask", preset: null, provider: "gateway:ollama" });
  });

  it.each([
    ["lists only Claude", { allow_auto: true, presets, providers: [claude] }],
    ["lists none", { allow_auto: true, presets, providers: [] }],
    ["is older and doesn't say", { allow_auto: true, presets }],
  ])("offers no provider when the Mac %s", async (_, controls) => {
    const { lastOf } = await openWith(controls);
    await openOptions();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" })).toBeTruthy());
    expect(screen.queryByText("Provider")).toBeNull();
    expect(screen.queryByRole("radio", { name: "Ollama" })).toBeNull();
    // Only the Models group's own "Project's own", as before.
    expect(screen.getAllByRole("radio", { name: "Project's own" })).toHaveLength(1);
    const sent = (await start(lastOf)) as Record<string, unknown>;
    expect("provider" in sent).toBe(false);
  });
});

describe("choosing a new chat's model", () => {
  const claude = { id: "claude", name: "Claude", auto: true, presets: true };
  const ollama = { id: "gateway:ollama", name: "Ollama", auto: false, presets: false };
  const presets = [{ id: "balanced", name: "Balanced", summary: "Sonnet · Opus advisor · Haiku subagents" }, { id: "max", name: "Max", summary: "Opus · Fable advisor" }];
  const models = [
    { provider: "claude", models: [{ value: "opus", name: "Opus 5.5", effort_levels: ["low", "high", "max"] }, { value: "haiku", name: "Haiku 4.5", effort_levels: [] }] },
    { provider: "gateway:ollama", models: [{ value: "qwen3", name: "qwen3", effort_levels: [] }] },
  ];
  async function openWith(controls: Record<string, unknown>, features = ["controls", "workflow", "newchatmodel"]) {
    const { controller } = makeController();
    const session = attachSession(controller, { projects, new_chat: { slot: "s9" }, controls }, features);
    await renderWith(<NewChatSheet onClose={jest.fn()} onStarted={jest.fn()} />, { connection: connectedWith(features) }, controller);
    await projectsHere();
    return session;
  }
  const start = async (lastOf: (op: "new_chat") => unknown) => {
    await write("Fix it");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(lastOf("new_chat")).toBeTruthy());
    return lastOf("new_chat") as Record<string, unknown>;
  };

  it("offers Claude's models, then the effort the one picked takes, then the presets; and sends the model and effort", async () => {
    const { lastOf } = await openWith({ allow_auto: false, presets, providers: [], models });
    await openOptions();
    await fireEvent.press(await screen.findByRole("radio", { name: "Opus 5.5" }));
    expect(screen.getByText("Presets: a model for each role")).toBeTruthy();
    expect(screen.getAllByRole("radio").map((r) => r.props.accessibilityLabel)).toEqual(expect.arrayContaining(["Its own", "Low", "High", "Max", "Balanced"]));
    await fireEvent.press(screen.getByRole("radio", { name: "High" }));
    expect(screen.getByRole("button", { name: "Runs on: Chat · Ask · Opus 5.5, High" })).toBeTruthy();
    const sent = await start(lastOf);
    expect(sent).toMatchObject({ model: "opus", effort: "high", preset: null });
    expect("provider" in sent).toBe(false);
  });

  it("has no effort for a model that takes none, and a preset lets go of the model (and the other way round)", async () => {
    const { lastOf } = await openWith({ allow_auto: false, presets, providers: [], models });
    await openOptions();
    await fireEvent.press(await screen.findByRole("radio", { name: "Haiku 4.5" }));
    expect(screen.queryByText("Effort")).toBeNull();
    await fireEvent.press(screen.getByRole("radio", { name: "Max" }));
    expect(screen.getByRole("radio", { name: "Haiku 4.5" }).props.accessibilityState).toMatchObject({ selected: false });
    expect(screen.getByRole("button", { name: "Runs on: Chat · Ask · Max" })).toBeTruthy();
    const sent = await start(lastOf);
    expect(sent).toMatchObject({ preset: "max" });
    expect("model" in sent || "effort" in sent).toBe(false);
  });

  it("asks where it runs before offering models when there is more than Claude, then offers that provider's own", async () => {
    const { lastOf } = await openWith({ allow_auto: false, presets, providers: [claude, ollama], models });
    await openOptions();
    await waitFor(() => expect(screen.getByText("Pick where it runs to pick its model.")).toBeTruthy());
    expect(screen.queryByRole("radio", { name: "Opus 5.5" })).toBeNull();
    await fireEvent.press(screen.getByRole("radio", { name: "Ollama" }));
    expect(screen.queryByRole("radio", { name: "Opus 5.5" })).toBeNull();
    expect(screen.queryByText("Presets: a model for each role")).toBeNull();
    await fireEvent.press(screen.getByRole("radio", { name: "qwen3" }));
    expect(await start(lastOf)).toMatchObject({ provider: "gateway:ollama", model: "qwen3", preset: null });
  });

  it("lets go of a model when the provider changes", async () => {
    const { lastOf } = await openWith({ allow_auto: false, presets, providers: [claude, ollama], models });
    await openOptions();
    await fireEvent.press(await screen.findByRole("radio", { name: "Ollama" }));
    await fireEvent.press(screen.getByRole("radio", { name: "qwen3" }));
    await fireEvent.press(screen.getByRole("radio", { name: "Claude" }));
    const sent = await start(lastOf);
    expect(sent).toMatchObject({ provider: "claude" });
    expect("model" in sent).toBe(false);
  });

  it("offers no model to pick from a Mac that can't take one, even if it lists them", async () => {
    const { lastOf } = await openWith({ allow_auto: false, presets, providers: [], models }, ["controls", "workflow"]);
    await openOptions();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Balanced" })).toBeTruthy());
    expect(screen.queryByRole("radio", { name: "Opus 5.5" })).toBeNull();
    expect("model" in (await start(lastOf))).toBe(false);
  });
});

describe("starting a chat as Step by step", () => {
  it("offers Chat and Step by step, a chat unless Step by step is chosen, and sends it", async () => {
    const { controller } = makeController();
    const session = attachSession(controller, { projects, new_chat: { slot: "s9" }, controls: { allow_auto: false, presets: [] } }, ["controls", "workflow"]);
    await renderWith(<NewChatSheet onClose={jest.fn()} onStarted={jest.fn()} />, { connection: connectedWithControls }, controller);
    await projectsHere();
    expect(screen.getByRole("button", { name: "Runs on: Chat · Ask · Project's own" })).toBeTruthy();
    await openOptions();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Step by step" })).toBeTruthy());
    expect(screen.getByRole("radio", { name: "Chat" }).props.accessibilityState).toMatchObject({ selected: true });
    await fireEvent.press(screen.getByRole("radio", { name: "Step by step" }));
    await fireEvent.changeText(screen.getByLabelText("What to start with"), "Build it");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(session.lastOf("new_chat")).toMatchObject({ op: "new_chat", workflow: "steps", permissions: "ask" }));
  });
});
