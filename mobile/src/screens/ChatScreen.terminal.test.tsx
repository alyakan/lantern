import "@shopify/flash-list/jestSetup";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { AppLock, type AuthResult, type LockPlatform, type Strength } from "../lock";
import type { RemoteEvent } from "../protocol/generated/RemoteEvent";
import { LockContext } from "../shell/lockContext";
import { attachSession } from "../test/fakeSession";
import { chat, connectedWith, makeController, renderWith } from "../test/render";
import { ChatScreen } from "./ChatScreen";

/** A phone that can check who holds it as `strength` says, and answers each check from `results` (then "ok"). */
async function phone(strength: Strength, results: AuthResult[] = []) {
  const asked: string[] = [];
  const options: ({ biometricOnly?: boolean } | undefined)[] = [];
  const platform: LockPlatform = {
    strength: async () => strength,
    method: async () => "Face ID",
    authenticate: async (reason, o) => {
      asked.push(reason);
      options.push(o);
      return results.shift() ?? "ok";
    },
  };
  const lock = new AppLock(platform, { load: async () => false, save: async () => {} });
  await lock.start();
  return { lock, asked, options };
}

async function terminal(over: { features?: string[]; strength?: Strength; results?: AuthResult[]; answers?: Parameters<typeof attachSession>[1]; events?: RemoteEvent[]; chatOver?: Parameters<typeof chat>[0] } = {}) {
  const features = over.features ?? ["shell"];
  const { controller } = makeController();
  const session = attachSession(controller, over.answers ?? {}, features);
  const { lock, asked, options } = await phone(over.strength ?? "biometric", over.results);
  await renderWith(
    <LockContext.Provider value={lock}>
      <ChatScreen slot="a" onBack={jest.fn()} onReview={jest.fn()} />
    </LockContext.Provider>,
    { connection: connectedWith(features), chats: [chat(over.chatOver)], events: { a: over.events ?? [] } },
    controller,
  );
  await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
  return { ...session, asked, options, controller };
}

const type = (text: string) => fireEvent.changeText(screen.getByLabelText("Message"), text);
const typeCommand = (text: string) => fireEvent.changeText(screen.getByLabelText("Shell command"), text);
const swipe = () => fireEvent(screen.getByLabelText("Swipe to run"), "accessibilityAction", { nativeEvent: { actionName: "activate" } });

describe("the message box as a terminal", () => {
  it("turns into one when it starts with '!', hiding the '!' and saying where it runs", async () => {
    await terminal();
    await type("!ls -la");
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(screen.getByLabelText("Shell command").props.value).toBe("ls -la");
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
    // It promises nothing about Claude: a message sent from the phone carries none of the output.
    expect(screen.getByText(/Runs on your Mac, outside Claude/)).toBeTruthy();
    expect(screen.queryByText(/Claude sees/)).toBeNull();
  });

  it("is an ordinary message box for words, and for a '!' anywhere but the start", async () => {
    await terminal();
    await type("hello!");
    expect(screen.queryByLabelText("Shell command")).toBeNull();
    expect(screen.getByLabelText("Message").props.value).toBe("hello!");
  });

  it("is an ordinary message box on a Mac that can't run commands: the '!' is just a message", async () => {
    await terminal({ features: [] });
    await type("!ls");
    expect(screen.queryByLabelText("Shell command")).toBeNull();
    expect(screen.getByLabelText("Message").props.value).toBe("!ls");
  });

  it("is left by backspace in an empty terminal, taking the '!' with it", async () => {
    await terminal();
    await type("!");
    await fireEvent(screen.getByLabelText("Shell command"), "keyPress", { nativeEvent: { key: "Backspace" } });
    expect(screen.queryByLabelText("Shell command")).toBeNull();
    expect(screen.getByLabelText("Message").props.value).toBe("");
    // With something typed, backspace is only backspace.
    await type("!l");
    await fireEvent(screen.getByLabelText("Shell command"), "keyPress", { nativeEvent: { key: "Backspace" } });
    expect(screen.getByLabelText("Shell command").props.value).toBe("l");
  });

  it("undoes the keyboard's smart punctuation, which a shell can't read, and keeps one line", async () => {
    await terminal();
    await type("!");
    await typeCommand("git log —oneline “x”\nhead");
    expect(screen.getByLabelText("Shell command").props.value).toBe('git log --oneline "x"head');
  });

  it("can't run an empty command", async () => {
    const { asked, lastOf } = await terminal();
    await type("!   ");
    await fireEvent.press(screen.getByRole("button", { name: "Run" }));
    expect(asked).toEqual([]);
    expect(lastOf("shell")).toBeUndefined();
  });
});

describe("running a command from the phone", () => {
  it("checks who is holding the phone, shows the command back, and runs it only on the swipe, then empties the box", async () => {
    const { asked, options, lastOf } = await terminal();
    await type("!git status");
    await fireEvent.press(screen.getByRole("button", { name: "Run" }));
    // Face ID first, with the app lock off or on: every command, and never the passcode instead.
    await waitFor(() => expect(screen.getByText("Run on your Mac?")).toBeTruthy());
    expect(asked).toEqual(["Run a command on your Mac"]);
    expect(options).toEqual([{ biometricOnly: true }]);
    expect(screen.getByLabelText("Command: git status")).toBeTruthy();
    expect(screen.getByText(/in lantern, outside Claude/)).toBeTruthy();
    // Nothing is sent until the swipe.
    expect(lastOf("shell")).toBeUndefined();
    await swipe();
    await waitFor(() => expect(lastOf("shell")).toMatchObject({ op: "shell", slot: "a", command: "git status", id: expect.stringMatching(/^ph-[a-z0-9]{4,28}$/) }));
    // Run: the box is empty and an ordinary one again.
    await waitFor(() => expect(screen.getByLabelText("Message").props.value).toBe(""));
  });

  it("asks again for the next command: one swipe is one command", async () => {
    const { asked, asked: _ } = await terminal();
    for (const command of ["ls", "pwd"]) {
      await type(`!${command}`);
      await fireEvent.press(screen.getByRole("button", { name: "Run" }));
      await waitFor(() => expect(screen.getByLabelText(`Command: ${command}`)).toBeTruthy());
      await swipe();
      await waitFor(() => expect(screen.getByLabelText("Message").props.value).toBe(""));
      await act(async () => void (await new Promise((r) => setTimeout(r, 600))));
    }
    expect(asked).toEqual(["Run a command on your Mac", "Run a command on your Mac"]);
  });

  it("is not run, and the box keeps the command, when the check is cancelled or fails", async () => {
    const { asked, lastOf } = await terminal({ results: ["cancelled", "failed"] });
    await type("!rm -rf build");
    await fireEvent.press(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(screen.queryByText("Run on your Mac?")).toBeNull();
    expect(screen.getByLabelText("Shell command").props.value).toBe("rm -rf build");
    await fireEvent.press(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText(/nothing was run/)).toBeTruthy());
    expect(screen.queryByText("Run on your Mac?")).toBeNull();
    expect(lastOf("shell")).toBeUndefined();
    expect(screen.getByLabelText("Shell command").props.value).toBe("rm -rf build");
  });

  it("can't be done at all on a phone without Face ID (or a fingerprint), even one with a passcode, and says so", async () => {
    for (const strength of ["none", "passcode"] as const) {
      const { asked, lastOf } = await terminal({ strength });
      await type("!ls");
      await fireEvent.press(screen.getByRole("button", { name: "Run" }));
      await waitFor(() => expect(screen.getByText(/needs Face ID \(or Touch ID\) set up/)).toBeTruthy());
      expect(asked).toEqual([]);
      expect(screen.queryByText("Run on your Mac?")).toBeNull();
      expect(lastOf("shell")).toBeUndefined();
      expect(screen.getByLabelText("Shell command").props.value).toBe("ls");
      screen.unmount();
    }
  });

  it("refuses a command with a character that can't be seen, before anything is asked of the phone or the Mac", async () => {
    const { asked, lastOf } = await terminal();
    await type("!");
    // A right-to-left override, a zero-width space and a carriage return, by their code points (they can't be seen here either).
    for (const hidden of [String.fromCodePoint(0x202e), String.fromCodePoint(0x200b), "\r"]) {
      // In the middle: one at the end is trimmed off like any space, and what is shown is what runs.
      await typeCommand(`echo ${hidden}ok`);
      await fireEvent.press(screen.getByRole("button", { name: "Run" }));
      await waitFor(() => expect(screen.getByText(/character that can't be seen/)).toBeTruthy());
    }
    expect(asked).toEqual([]);
    expect(screen.queryByText("Run on your Mac?")).toBeNull();
    expect(lastOf("shell")).toBeUndefined();
  });

  it("is not run, and the box keeps the command, when the sheet is closed without the swipe", async () => {
    const { lastOf } = await terminal();
    await type("!ls");
    await fireEvent.press(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("Run on your Mac?")).toBeTruthy());
    await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 400))));
    expect(lastOf("shell")).toBeUndefined();
    expect(screen.getByLabelText("Shell command").props.value).toBe("ls");
  });

  it("says why the Mac refused it, and keeps the command in the box", async () => {
    await terminal({ answers: { shell: new Error("This chat is asleep. Wake it first.") } });
    await type("!ls");
    await fireEvent.press(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("Run on your Mac?")).toBeTruthy());
    await swipe();
    await waitFor(() => expect(screen.getByText("This chat is asleep. Wake it first.")).toBeTruthy());
    expect(screen.getByLabelText("Shell command").props.value).toBe("ls");
  });
});

describe("the card a command fills", () => {
  const id = "ph-abcd1234";
  const started: RemoteEvent[] = [{ kind: "shell_started", id, command: "npm test" }];

  it("shows the command, its output as it comes and how it ended", async () => {
    const { controller } = await terminal({ events: [...started, { kind: "shell_output", id, text: "\u001b[32mok\u001b[0m 3 passed\n" }, { kind: "shell_done", id, code: 1, stopped: false }] });
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.getByText("ok 3 passed")).toBeTruthy();
    expect(screen.getByText("exit 1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    // More output arriving later lands in the same card.
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "event", slot: "a", seq: 9, event: { kind: "shell_output", id, text: "more\n" } } }));
    expect(screen.getByText(/more/)).toBeTruthy();
  });

  it("can tell Claude what it printed: the words go in the message box to be read, not sent", async () => {
    const { lastOf } = await terminal({ events: [...started, { kind: "shell_output", id, text: "1 failed\n" }, { kind: "shell_done", id, code: 1, stopped: false }] });
    await fireEvent.press(screen.getByRole("button", { name: "Tell Claude" }));
    await waitFor(() => expect(screen.getByLabelText("Message").props.value).toContain("$ npm test\n1 failed"));
    expect(screen.getByLabelText("Message").props.value).toContain("I ran this in the terminal on my Mac (exit 1):");
    expect(lastOf("send")).toBeUndefined();
  });

  it("offers nothing to tell while the command runs, or when it printed nothing", async () => {
    await terminal({ events: [...started, { kind: "shell_output", id, text: "working…\n" }] });
    expect(screen.queryByRole("button", { name: "Tell Claude" })).toBeNull();
  });

  it("can be stopped while it runs, and a reply can be typed to it", async () => {
    const { lastOf } = await terminal({ events: [...started, { kind: "shell_output", id, text: "Continue? [y/N] " }] });
    expect(screen.getByLabelText("Running")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Reply" }));
    await fireEvent.changeText(screen.getByLabelText("Reply to the command"), "y");
    await fireEvent.press(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(lastOf("shell_input")).toEqual({ op: "shell_input", slot: "a", id, text: "y" }));
    await fireEvent.press(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(lastOf("shell_stop")).toEqual({ op: "shell_stop", slot: "a", id }));
  });

  it("asks for a password in a hidden field the moment the command reads one", async () => {
    await terminal({ events: [...started, { kind: "shell_output", id, text: "Password: " }, { kind: "shell_secret", id, secret: true }] });
    const field = await screen.findByLabelText("Password for the command");
    expect(field.props.secureTextEntry).toBe(true);
  });
});
