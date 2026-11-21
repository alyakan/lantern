import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { resetDrafts } from "../drafts";
import { Composer, UserRow } from "./ChatParts";

const big = "a line of something long that was pasted\n".repeat(20);

beforeEach(() => resetDrafts());

describe("a long paste in the message box", () => {
  it("is held in a card above the box, not printed in it, and goes out with what was typed", async () => {
    const onSend = jest.fn();
    await render(<Composer onSend={onSend} draftKey="paste-a" />);
    const box = () => screen.getByLabelText("Message");
    await fireEvent.changeText(box(), "Explain this: ");
    await fireEvent.changeText(box(), `Explain this: ${big}`);
    expect(box().props.value).toBe("Explain this: ");
    expect(screen.getByText("PASTED")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith(`${big.trim()}\n\nExplain this:`, undefined);
    expect(screen.queryByText("PASTED")).toBeNull();
  });

  it("can be sent on its own, and taken off with its ×", async () => {
    const onSend = jest.fn();
    await render(<Composer onSend={onSend} draftKey="paste-b" />);
    await fireEvent.changeText(screen.getByLabelText("Message"), big);
    await fireEvent.press(screen.getByRole("button", { name: "Remove pasted text 1" }));
    expect(screen.queryByText("PASTED")).toBeNull();
    await fireEvent.changeText(screen.getByLabelText("Message"), big);
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith(big.trim(), undefined);
  });

  it("leaves short words in the box", async () => {
    await render(<Composer onSend={jest.fn()} draftKey="paste-c" />);
    await fireEvent.changeText(screen.getByLabelText("Message"), "hello there");
    expect(screen.getByLabelText("Message").props.value).toBe("hello there");
    expect(screen.queryByText("PASTED")).toBeNull();
  });
});

describe("a long message in the chat", () => {
  it("is a short card that opens to all of it, not a page of words", async () => {
    await render(<UserRow item={{ kind: "user", id: "u9", text: big, at: null, sentBy: null }} />);
    expect(screen.getByTestId("long-message")).toBeTruthy();
    expect(screen.getByText(/Pasted text · 20 lines/)).toBeTruthy();
    expect(screen.queryByText(big.trim())).toBeNull();
    await act(async () => void fireEvent.press(screen.getByRole("button", { name: /Long message/ })));
    expect(screen.getByText("Pasted text")).toBeTruthy();
  });

  it("leaves an ordinary message as it is", async () => {
    await render(<UserRow item={{ kind: "user", id: "u8", text: "Fix the login bug", at: null, sentBy: null }} />);
    expect(screen.queryByTestId("long-message")).toBeNull();
  });
});
