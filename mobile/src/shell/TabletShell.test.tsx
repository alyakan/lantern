import { Text } from "react-native";
import { render, screen } from "@testing-library/react-native";
import { TabletShell } from "./TabletShell";

// An animated opacity is a value to read, not a number to compare.
const opacityOf = (id: string) => {
  const style = screen.getByTestId(id, { hidden: true }).props.style;
  const flat = (Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity)) : style) as { opacity: number | { __getValue: () => number } };
  return typeof flat.opacity === "number" ? flat.opacity : flat.opacity.__getValue();
};

const shell = (layout: "overlay" | "split", open: boolean) =>
  render(
    <TabletShell layout={layout} open={open} onOpen={jest.fn()} onClose={jest.fn()} sidebar={<Text>chats</Text>}>
      <Text>chat</Text>
    </TabletShell>,
  );

describe("the chats' column on a tablet", () => {
  // iPadOS keeps a pinned sidebar flat against the content, a hairline between them, and floats it with a shadow only when
  // it slides in over the content.
  it("sits flat beside the chat, with a hairline and no shadow, pinned", async () => {
    await shell("split", false);
    expect(opacityOf("chats-column-shadow")).toBe(0);
    expect(opacityOf("chats-column-rule")).toBe(1);
  });

  it("floats over the chat, with its shadow and no hairline, when it is slid in", async () => {
    await shell("overlay", true);
    expect(opacityOf("chats-column-shadow")).toBe(1);
    expect(opacityOf("chats-column-rule")).toBe(0);
  });
});
