import { Text } from "react-native";
import { render, screen } from "@testing-library/react-native";
import { AnimatedStack, type StackItem } from "./AnimatedStack";
import { motion } from "./motion";

const item = (key: string, kind: StackItem["kind"] = "push"): StackItem => ({ key, kind, element: <Text>{`screen ${key}`}</Text> });

afterEach(() => {
  motion.instant = true;
});

describe("the stack of screens", () => {
  it("has its first screens there at once, with the one beneath hidden from a screen reader", async () => {
    await render(<AnimatedStack items={[item("home"), item("chat")]} />);
    expect(screen.getByText("screen chat")).toBeTruthy();
    // Beneath the top one it can't be reached by touch or read out (the queries leave hidden things out, as a reader does).
    expect(screen.queryByText("screen home")).toBeNull();
    expect(screen.getByText("screen home", { includeHiddenElements: true })).toBeTruthy();
  });

  it("shows a new screen over the one before, which stays mounted beneath it", async () => {
    const view = await render(<AnimatedStack items={[item("home")]} />);
    await view.rerender(<AnimatedStack items={[item("home"), item("chat")]} />);
    expect(screen.getByText("screen chat")).toBeTruthy();
    expect(screen.getByText("screen home", { includeHiddenElements: true })).toBeTruthy();
  });

  it("takes a screen away when it is gone, and Home is the one to touch again", async () => {
    const view = await render(<AnimatedStack items={[item("home"), item("chat")]} />);
    await view.rerender(<AnimatedStack items={[item("home")]} />);
    expect(screen.queryByText("screen chat", { includeHiddenElements: true })).toBeNull();
    expect(screen.getByText("screen home")).toBeTruthy();
  });

  it("keeps a screen that left until its exit has played, out of reach meanwhile", async () => {
    motion.instant = false;
    const view = await render(<AnimatedStack items={[item("home"), item("chat")]} />);
    await view.rerender(<AnimatedStack items={[item("home")]} />);
    // Still drawn, sliding away, but not touchable or readable.
    expect(screen.queryByText("screen chat")).toBeNull();
    expect(screen.getByText("screen chat", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByText("screen home")).toBeTruthy();
    await view.unmount();
  });

  it("slides a decision up from the bottom and a chat in from the right", async () => {
    const view = await render(<AnimatedStack items={[item("home")]} />);
    await view.rerender(<AnimatedStack items={[item("home"), item("decide", "modal")]} />);
    expect(screen.getByText("screen decide")).toBeTruthy();
    await view.rerender(<AnimatedStack items={[item("home"), item("decide", "modal"), item("chat", "push")]} />);
    expect(screen.getByText("screen chat")).toBeTruthy();
  });
});
