import { render, screen } from "@testing-library/react-native";
import type { Item } from "../sync/reducer";
import { AssistantRow } from "./ChatParts";

const streaming = (text: string): Extract<Item, { kind: "assistant" }> => ({ kind: "assistant", id: "a1", text, streaming: true });

describe("a reply as it streams in", () => {
  it("keeps a block that finished as the same element when the next one starts, and after", async () => {
    // Nothing is cut yet: the code is the last block, still being written as far as anyone knows.
    const start = "```ts\nconst a = 1;\n```";
    await render(<AssistantRow item={streaming(start)} />);
    const code = screen.getByText("ts");
    await screen.rerender(<AssistantRow item={streaming(`${start}\n\nNext`)} />);
    expect(screen.getByText("ts")).toBe(code);
    await screen.rerender(<AssistantRow item={streaming(`${start}\n\nNext paragraph.\n\nAnd another`)} />);
    expect(screen.getByText("ts")).toBe(code);
    expect(screen.getByText(/And another/)).toBeTruthy();
  });

  it("reads the same once it has finished", async () => {
    await render(<AssistantRow item={{ ...streaming("One.\n\nTwo."), streaming: false }} />);
    expect(screen.getByText("One.")).toBeTruthy();
    expect(screen.getByText("Two.")).toBeTruthy();
  });
});
