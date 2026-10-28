import { StyleSheet, Text } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Sheet, SHEET_INSET, SHEET_RADIUS } from "./Sheet";

describe("Sheet", () => {
  it("shows what it is given, and closes from the dark behind it or from inside", async () => {
    const onClose = jest.fn();
    let close: () => void = () => {};
    await render(
      <Sheet onClose={onClose}>
        {(c) => {
          close = c;
          return <Text>Inside</Text>;
        }}
      </Sheet>,
    );
    expect(screen.getByText("Inside")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("doesn't slide the system's way, which would carry the dark up with the sheet", async () => {
    await render(<Sheet onClose={jest.fn()}>{() => <Text>Inside</Text>}</Sheet>);
    const find = (n: unknown): Record<string, unknown> | undefined => {
      const node = n as { props?: Record<string, unknown>; children?: unknown[] | null } | null;
      if (!node || typeof node !== "object") return undefined;
      if (node.props && "animationType" in node.props) return node.props;
      for (const c of node.children ?? []) {
        const hit = find(c);
        if (hit) return hit;
      }
      return undefined;
    };
    const props = find(screen.toJSON());
    expect(props).toMatchObject({ animationType: "none", transparent: true, statusBarTranslucent: true });
  });

  it("caps its height with a number, never a percentage: that cut the sheet short, with its Cancel button hanging below", async () => {
    await render(<Sheet onClose={jest.fn()}>{() => <Text>Inside</Text>}</Sheet>);
    let up = screen.getByText("Inside").parent;
    const caps: unknown[] = [];
    while (up) {
      const cap = StyleSheet.flatten(up.props.style)?.maxHeight;
      if (cap !== undefined) caps.push(cap);
      up = up.parent;
    }
    expect(caps).toHaveLength(1);
    expect(typeof caps[0]).toBe("number");
  });

  it("keeps the dark on its own layer over the whole screen, apart from the sheet that moves", async () => {
    await render(<Sheet onClose={jest.fn()}>{() => <Text>Inside</Text>}</Sheet>);
    const dark = screen.getByLabelText("Close").parent!;
    expect(StyleSheet.flatten(dark.props.style)).toMatchObject({ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#00000066" });
    // The sheet is not inside the dark, and the dark is not inside what moves.
    expect(screen.getByText("Inside").parent).not.toBe(dark);
    let up = screen.getByText("Inside").parent;
    while (up) {
      expect(up).not.toBe(dark);
      up = up.parent;
    }
  });

  it("floats in from the screen's edges, round all over, and gives what is in it only a little room at the bottom", async () => {
    const Bottom = () => <Text>{`bottom ${useSafeAreaInsets().bottom}`}</Text>;
    await render(<Sheet onClose={jest.fn()}>{() => <Bottom />}</Sheet>);
    expect(screen.getByText(`bottom ${SHEET_INSET}`)).toBeTruthy();
    // The panel: its corners are all round (not just the top ones).
    let panel: Record<string, unknown> | undefined;
    const find = (n: unknown) => {
      const node = n as { props?: { style?: unknown }; children?: unknown[] | null } | null;
      if (!node || typeof node !== "object" || panel) return;
      const style = StyleSheet.flatten(node.props?.style as never) as Record<string, unknown> | undefined;
      if (style?.borderRadius === SHEET_RADIUS) panel = style;
      for (const c of node.children ?? []) find(c);
    };
    find(screen.toJSON());
    expect(panel).toBeTruthy();
    expect(panel?.borderTopLeftRadius).toBeUndefined();
  });
});
