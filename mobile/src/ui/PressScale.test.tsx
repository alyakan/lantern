import { Text } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { Button } from "./components";
import { motion, PressScale } from "./motion";

afterEach(() => {
  motion.instant = true;
  jest.clearAllMocks();
});

describe("a pressable that gives under the finger", () => {
  it("still presses like any button, and a disabled one doesn't", async () => {
    const onPress = jest.fn();
    await render(
      <>
        <Button label="Go" onPress={onPress} />
        <Button label="Stop" disabled onPress={onPress} />
      </>,
    );
    await fireEvent.press(screen.getByRole("button", { name: "Go" }));
    await fireEvent.press(screen.getByRole("button", { name: "Stop" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  });

  it("taps the phone when pressed, once, a light one for a press and a choice's own for a choice", async () => {
    motion.instant = false;
    await render(
      <>
        <PressScale accessibilityLabel="press" onPress={() => {}}>
          <Text>a</Text>
        </PressScale>
        <PressScale accessibilityLabel="choice" haptic="select" onPress={() => {}}>
          <Text>b</Text>
        </PressScale>
        <PressScale accessibilityLabel="quiet" haptic="none" onPress={() => {}}>
          <Text>c</Text>
        </PressScale>
      </>,
    );
    await fireEvent(screen.getByLabelText("press"), "pressIn");
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    await fireEvent(screen.getByLabelText("choice"), "pressIn");
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
    await fireEvent(screen.getByLabelText("quiet"), "pressIn");
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });

  it("stays quiet where motion is skipped (tests, Reduce Motion): no taps, nothing moving", async () => {
    await render(
      <PressScale accessibilityLabel="press" onPress={() => {}}>
        <Text>a</Text>
      </PressScale>,
    );
    await fireEvent(screen.getByLabelText("press"), "pressIn");
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
  });
});
