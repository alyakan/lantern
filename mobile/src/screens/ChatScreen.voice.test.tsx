import "@shopify/flash-list/jestSetup";
import { Linking } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { attachSession } from "../test/fakeSession";
import { chat, makeController, renderWith } from "../test/render";
import { resetDrafts } from "../drafts";
import { SILENCE_MS } from "../ui/useDictation";
import { Composer } from "./ChatParts";
import { ChatScreen } from "./ChatScreen";

// The mock's way of making the recognizer "hear" something (see jest.setup.ts).
const { __emit } = jest.requireMock("expo-speech-recognition") as { __emit: (name: string, e: unknown) => void };
const module = ExpoSpeechRecognitionModule as unknown as Record<"isRecognitionAvailable" | "requestPermissionsAsync" | "getSupportedLocales" | "start" | "stop" | "abort", jest.Mock>;

async function chatWithMic(available = true) {
  module.isRecognitionAvailable.mockReturnValue(available);
  const { controller } = makeController();
  const session = attachSession(controller);
  await renderWith(<ChatScreen slot="a" onBack={jest.fn()} onReview={jest.fn()} />, { chats: [chat()], events: { a: [] } }, controller);
  await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
  return session;
}

const heard = (transcript: string, isFinal = false) => act(async () => __emit("result", { isFinal, results: [{ transcript, confidence: 1 }] }));
const box = () => screen.getByLabelText("Message");
const tapMic = () => act(async () => void fireEvent.press(screen.getByRole("button", { name: "Dictate" })));

beforeEach(() => {
  // A draft left in a chat by one test is not the next one's.
  resetDrafts();
  for (const f of [module.start, module.stop, module.abort, module.requestPermissionsAsync]) f.mockClear();
  module.requestPermissionsAsync.mockResolvedValue({ granted: true });
});
afterEach(() => {
  module.isRecognitionAvailable.mockReturnValue(false);
  jest.useRealTimers();
});

describe("dictating into the message box", () => {
  it("has no microphone on a phone with no recognizer", async () => {
    await chatWithMic(false);
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
  });

  it("asks for permission, listens in the phone's way, and writes what it hears into the box as it comes", async () => {
    await chatWithMic();
    await tapMic();
    expect(module.requestPermissionsAsync).toHaveBeenCalled();
    expect(module.start).toHaveBeenCalledWith(expect.objectContaining({ interimResults: true, continuous: true, requiresOnDeviceRecognition: true }));
    expect(screen.getByRole("button", { name: "Stop dictating" })).toBeTruthy();
    expect(box().props.placeholder).toBe("Listening…");
    await heard("fix the");
    expect(box().props.value).toBe("fix the");
    await heard("fix the login bug");
    expect(box().props.value).toBe("fix the login bug");
  });

  it("adds to what is already typed", async () => {
    await chatWithMic();
    await fireEvent.changeText(box(), "Please");
    await tapMic();
    await heard("fix the login bug");
    expect(box().props.value).toBe("Please fix the login bug");
  });

  it("stops on a second tap, keeping the words, and the words can be sent", async () => {
    const { lastOf } = await chatWithMic();
    await tapMic();
    await heard("ship it", true);
    await act(async () => void fireEvent.press(screen.getByRole("button", { name: "Stop dictating" })));
    expect(module.stop).toHaveBeenCalled();
    // The recognizer says it has ended: the microphone goes back to being a microphone, the words stay.
    await act(async () => __emit("end", null));
    expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
    expect(box().props.value).toBe("ship it");
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(lastOf("send")).toMatchObject({ op: "send", slot: "a", text: "ship it" }));
  });

  it("sending while it listens turns the microphone off and empties the box", async () => {
    await chatWithMic();
    await tapMic();
    await heard("hello");
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    expect(module.abort).toHaveBeenCalled();
    expect(box().props.value).toBe("");
    expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
    // Nothing the recognizer says afterwards lands in the next message.
    await heard("late words");
    expect(box().props.value).toBe("");
  });

  it("steps aside when the person types by hand", async () => {
    await chatWithMic();
    await tapMic();
    await heard("hello wor");
    await fireEvent.changeText(box(), "hello world!");
    expect(module.abort).toHaveBeenCalled();
    await heard("hello wor again");
    expect(box().props.value).toBe("hello world!");
  });

  it("stops by itself after a stretch of silence", async () => {
    await chatWithMic();
    // The chat is up on real timers (it waits a tick to lay out); the silence is then timed on a fake clock.
    jest.useFakeTimers();
    await tapMic();
    await act(async () => void jest.advanceTimersByTime(SILENCE_MS - 1));
    expect(module.stop).not.toHaveBeenCalled();
    await heard("one more thing");
    await act(async () => void jest.advanceTimersByTime(SILENCE_MS - 1));
    expect(module.stop).not.toHaveBeenCalled();
    await act(async () => void jest.advanceTimersByTime(2));
    expect(module.stop).toHaveBeenCalledTimes(1);
  });

  it("never turns the box into a terminal because of what was said", async () => {
    await chatWithMic();
    await tapMic();
    await heard("! rm everything");
    expect(screen.queryByLabelText("Shell command")).toBeNull();
    expect(box().props.value).toBe("rm everything");
  });

  it("says how to turn the microphone on when it was refused, and opens Settings", async () => {
    const open = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
    module.requestPermissionsAsync.mockResolvedValue({ granted: false });
    await chatWithMic();
    await tapMic();
    expect(module.start).not.toHaveBeenCalled();
    expect(screen.getByText(/Turn on the microphone and speech recognition/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Open Settings" }));
    expect(open).toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Turn on the microphone/)).toBeNull();
    open.mockRestore();
  });

  it("explains a refusal that arrives while listening, and stays quiet when it was only silence", async () => {
    await chatWithMic();
    await tapMic();
    await act(async () => __emit("error", { error: "no-speech", message: "" }));
    expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
    expect(screen.queryByText(/can't hear you|can't turn|isn't working|connection|busy/)).toBeNull();
    await tapMic();
    await act(async () => __emit("error", { error: "language-not-supported", message: "" }));
    expect(screen.getByText(/can't turn this language into text/)).toBeTruthy();
  });

  describe("in the phone's language", () => {
    const phoneSpeaks = (locale: string) => jest.spyOn(Intl, "DateTimeFormat").mockReturnValue({ resolvedOptions: () => ({ locale }) } as unknown as Intl.DateTimeFormat);
    afterEach(() => {
      jest.restoreAllMocks();
      module.getSupportedLocales.mockResolvedValue({ locales: [], installedLocales: [] });
    });

    it("listens in the nearest language it has when the phone's own region isn't one", async () => {
      phoneSpeaks("en-EG");
      module.getSupportedLocales.mockResolvedValue({ locales: ["de-DE", "en-GB", "en-US"], installedLocales: ["de-DE", "en-GB", "en-US"] });
      await chatWithMic();
      await tapMic();
      expect(module.start).toHaveBeenCalledWith(expect.objectContaining({ lang: "en-US" }));
    });

    it("says so, and doesn't blame the microphone, when the language isn't there at all", async () => {
      phoneSpeaks("sw-KE");
      module.getSupportedLocales.mockResolvedValue({ locales: ["de-DE", "en-US"], installedLocales: ["de-DE", "en-US"] });
      await chatWithMic();
      await tapMic();
      expect(module.start).not.toHaveBeenCalled();
      expect(screen.getByText(/can't turn this language into text/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
      expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
    });
  });

  it("turns the microphone off when the box can't be used any more (the Mac went away)", async () => {
    module.isRecognitionAvailable.mockReturnValue(true);
    const props = { onSend: jest.fn(), disabled: false };
    const view = await render(<Composer {...props} />);
    await act(async () => void fireEvent.press(screen.getByRole("button", { name: "Dictate" })));
    expect(module.start).toHaveBeenCalled();
    await view.rerender(<Composer {...props} disabled />);
    expect(module.abort).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Stop dictating" })).toBeNull();
    await view.unmount();
  });

  it("turns the microphone off when the chat goes away", async () => {
    await chatWithMic();
    await tapMic();
    await act(async () => screen.unmount());
    expect(module.abort).toHaveBeenCalled();
  });
});
