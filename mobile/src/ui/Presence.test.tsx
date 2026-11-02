import { useState } from "react";
import { Pressable, Text } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { motion } from "./motion";
import { CrossFade, Rise } from "./Presence";

/** A screen that counts how often it was made: the same screen moved keeps its count, a new one starts again. */
function Counted({ name }: { name: string }) {
  const [n, setN] = useState(0);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${name} ${n}`} onPress={() => setN(n + 1)}>
      <Text>{`${name} ${n}`}</Text>
    </Pressable>
  );
}

const played = () => act(async () => void jest.advanceTimersByTime(1000));

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  motion.instant = true;
  jest.useRealTimers();
});

describe("one screen giving way to the next", () => {
  it("swaps at once when motion is skipped", async () => {
    const view = await render(<CrossFade id="a">{<Text>chat a</Text>}</CrossFade>);
    await view.rerender(<CrossFade id="b">{<Text>chat b</Text>}</CrossFade>);
    expect(screen.getByText("chat b")).toBeTruthy();
    expect(screen.queryByText("chat a", { includeHiddenElements: true })).toBeNull();
  });

  it("keeps the one going on top, as it was and out of reach, until it has faded, with the new one under it", async () => {
    motion.instant = false;
    const view = await render(<CrossFade id="a">{<Counted name="a" />}</CrossFade>);
    await fireEvent.press(screen.getByRole("button", { name: "a 0" }));
    await view.rerender(<CrossFade id="b">{<Counted name="b" />}</CrossFade>);
    expect(screen.getByRole("button", { name: "b 0" })).toBeTruthy();
    // Still drawn as it goes, as it was (the same screen), but not to be touched or read out.
    expect(screen.queryByText("a 1")).toBeNull();
    expect(screen.getByText("a 1", { includeHiddenElements: true })).toBeTruthy();
    await played();
    expect(screen.queryByText("a 1", { includeHiddenElements: true })).toBeNull();
    expect(screen.getByRole("button", { name: "b 0" })).toBeTruthy();
    await view.unmount();
  });

  it("takes one back that is still going: the same screen, whole, not a new one", async () => {
    motion.instant = false;
    const view = await render(<CrossFade id="a">{<Counted name="a" />}</CrossFade>);
    await fireEvent.press(screen.getByRole("button", { name: "a 0" }));
    await view.rerender(<CrossFade id="b">{<Counted name="b" />}</CrossFade>);
    await view.rerender(<CrossFade id="a">{<Counted name="a" />}</CrossFade>);
    await played();
    expect(screen.getByRole("button", { name: "a 1" })).toBeTruthy();
    expect(screen.queryByText(/^b /, { includeHiddenElements: true })).toBeNull();
    await view.unmount();
  });
});

describe("a decision over its chat", () => {
  it("goes back down still saying what it said, and is gone once it has", async () => {
    motion.instant = false;
    const view = await render(
      <Rise testID="rise" shown>
        <Text>Allow?</Text>
      </Rise>,
    );
    await view.rerender(<Rise testID="rise" shown={false}>{null}</Rise>);
    expect(screen.getByText("Allow?", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByText("Allow?")).toBeNull();
    await played();
    expect(screen.queryByTestId("rise", { includeHiddenElements: true })).toBeNull();
    await view.unmount();
  });
});
