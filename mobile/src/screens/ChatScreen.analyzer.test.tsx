import "@shopify/flash-list/jestSetup";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { attachSession } from "../test/fakeSession";
import { chat, makeController, renderWith } from "../test/render";
import { resetDrafts } from "../drafts";
import { ChatScreen } from "./ChatScreen";

// iOS 26's newer model (modules/lantern-speech), as a fake that can be made to "hear" with emit.
jest.mock("../../modules/lantern-speech", () => {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    LanternSpeech: {
      supportedLanguage: jest.fn(async (lang: string) => lang),
      start: jest.fn(async () => {}),
      stop: jest.fn(),
      abort: jest.fn(),
      addListener: (name: string, on: (e: unknown) => void) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(on);
        return { remove: () => void listeners.get(name)!.delete(on) };
      },
    },
    emit: (name: string, e: unknown) => listeners.get(name)?.forEach((on) => on(e)),
  };
});
const { LanternSpeech, emit } = jest.requireMock("../../modules/lantern-speech") as {
  LanternSpeech: Record<"supportedLanguage" | "start" | "stop" | "abort", jest.Mock>;
  emit: (name: string, e: unknown) => void;
};
const older = ExpoSpeechRecognitionModule as unknown as Record<"isRecognitionAvailable" | "start" | "stop" | "abort", jest.Mock>;

async function chatWithMic() {
  older.isRecognitionAvailable.mockReturnValue(true);
  const { controller } = makeController();
  attachSession(controller);
  await renderWith(<ChatScreen slot="a" onBack={jest.fn()} onReview={jest.fn()} />, { chats: [chat()], events: { a: [] } }, controller);
  await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
}

const heard = (transcript: string, isFinal = false) => act(async () => emit("result", { transcript, isFinal }));
const box = () => screen.getByLabelText("Message");
const tapMic = () => act(async () => void fireEvent.press(screen.getByRole("button", { name: "Dictate" })));
const tapStop = () => act(async () => void fireEvent.press(screen.getByRole("button", { name: "Stop dictating" })));

beforeEach(() => {
  resetDrafts();
  for (const f of [LanternSpeech.supportedLanguage, LanternSpeech.start, LanternSpeech.stop, LanternSpeech.abort, older.start, older.stop, older.abort]) f.mockClear();
  LanternSpeech.supportedLanguage.mockImplementation(async (lang: string) => lang);
  LanternSpeech.start.mockImplementation(async () => {});
});
afterEach(() => older.isRecognitionAvailable.mockReturnValue(false));

describe("dictating with iOS 26's newer model", () => {
  it("listens with it when it has the language, writing finished phrases and the one in progress", async () => {
    await chatWithMic();
    await tapMic();
    expect(LanternSpeech.start).toHaveBeenCalled();
    expect(older.start).not.toHaveBeenCalled();
    await heard("Fix the login bug.", true);
    await heard("then ship");
    expect(box().props.value).toBe("Fix the login bug. then ship");
    await heard("Then ship it.", true);
    expect(box().props.value).toBe("Fix the login bug. Then ship it.");
    await tapStop();
    expect(LanternSpeech.stop).toHaveBeenCalled();
    await act(async () => emit("end", null));
    expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
    expect(box().props.value).toBe("Fix the login bug. Then ship it.");
  });

  it("uses the older recognizer for a language the newer model doesn't have", async () => {
    LanternSpeech.supportedLanguage.mockResolvedValue(null);
    await chatWithMic();
    await tapMic();
    expect(older.start).toHaveBeenCalled();
    expect(LanternSpeech.start).not.toHaveBeenCalled();
  });

  it("stops once it has started when stop was tapped while its model was still downloading", async () => {
    let started = () => {};
    LanternSpeech.start.mockImplementation(() => new Promise<void>((r) => (started = r)));
    await chatWithMic();
    await tapMic();
    await tapStop();
    expect(LanternSpeech.stop).not.toHaveBeenCalled();
    await act(async () => started());
    expect(LanternSpeech.stop).toHaveBeenCalled();
  });

  it("turns the microphone off once it has started when typing dropped it meanwhile", async () => {
    let started = () => {};
    LanternSpeech.start.mockImplementation(() => new Promise<void>((r) => (started = r)));
    await chatWithMic();
    await tapMic();
    await fireEvent.changeText(box(), "typed instead");
    await act(async () => started());
    expect(LanternSpeech.abort).toHaveBeenCalled();
  });

  it("says what went wrong", async () => {
    await chatWithMic();
    await tapMic();
    await act(async () => {
      emit("error", { error: "audio-capture" });
      emit("end", null);
    });
    expect(screen.getByText("The microphone isn't working right now.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
  });
});
