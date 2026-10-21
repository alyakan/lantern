import { Keyboard, Platform, StyleSheet, Text } from "react-native";
import { act, render, renderHook, screen } from "@testing-library/react-native";
import { AboveKeyboard, useKeyboardUp } from "./keyboard";

/** Stands in for the keyboard: keeps what was listened for, so a test can say the keyboard came or went. */
function fakeKeyboard() {
  const handlers = new Map<string, (e?: unknown) => void>();
  const removed: string[] = [];
  const spy = jest.spyOn(Keyboard, "addListener").mockImplementation(((name: string, handler: (e?: unknown) => void) => {
    handlers.set(name, handler);
    return { remove: () => removed.push(name) };
  }) as never);
  return { handlers, removed, emit: (name: string, event?: unknown) => act(async () => handlers.get(name)?.(event)), restore: () => spy.mockRestore() };
}

describe("keyboard", () => {
  const original = Platform.OS;
  afterEach(() => {
    Platform.OS = original;
  });

  it("knows when the keyboard is up, on iOS as it starts to move", async () => {
    Platform.OS = "ios";
    const k = fakeKeyboard();
    const { result } = await renderHook(() => useKeyboardUp());
    expect([...k.handlers.keys()].sort()).toEqual(["keyboardWillHide", "keyboardWillShow"]);
    expect(result.current).toBe(false);
    await k.emit("keyboardWillShow");
    expect(result.current).toBe(true);
    await k.emit("keyboardWillHide");
    expect(result.current).toBe(false);
    k.restore();
  });

  it("listens to the events Android has, and stops listening when it goes", async () => {
    Platform.OS = "android";
    const k = fakeKeyboard();
    const { result, unmount } = await renderHook(() => useKeyboardUp());
    expect([...k.handlers.keys()].sort()).toEqual(["keyboardDidHide", "keyboardDidShow"]);
    await k.emit("keyboardDidShow");
    expect(result.current).toBe(true);
    await unmount();
    expect(k.removed.sort()).toEqual(["keyboardDidHide", "keyboardDidShow"]);
    k.restore();
  });

  it("fills its place with what it is given", async () => {
    await render(
      <AboveKeyboard style={{ backgroundColor: "red" }}>
        <Text>Inside</Text>
      </AboveKeyboard>,
    );
    const box = screen.getByText("Inside").parent!;
    expect(StyleSheet.flatten(box.props.style)).toMatchObject({ flex: 1, backgroundColor: "red" });
  });

  it("has the library follow the keyboard, as padding, and paints what is under the content in its own colour", async () => {
    await render(
      <AboveKeyboard style={{ backgroundColor: "red" }}>
        <Text>Inside</Text>
      </AboveKeyboard>,
    );
    // The avoiding view (the library's: it follows the keyboard on the native side) owns the room the keyboard takes,
    // and paints it: no gap to see through at the keyboard's rounded corners.
    const avoiding = screen.getByText("Inside").parent!.parent!;
    expect(avoiding.props.behavior).toBe("padding");
    expect(StyleSheet.flatten(avoiding.props.style)).toMatchObject({ flex: 1, backgroundColor: "red" });
  });

  it("keeps its own padding on a view of its own: the avoiding view would replace the bottom one with the keyboard's height", async () => {
    await render(
      <AboveKeyboard style={{ paddingBottom: 34, paddingTop: 56 }}>
        <Text>Inside</Text>
      </AboveKeyboard>,
    );
    const box = screen.getByText("Inside").parent!;
    expect(StyleSheet.flatten(box.props.style)).toMatchObject({ paddingBottom: 34, paddingTop: 56 });
    // What lifts is outside it, and does not carry that padding itself.
    expect(StyleSheet.flatten(box.parent!.props.style).paddingBottom).not.toBe(34);
  });
});
