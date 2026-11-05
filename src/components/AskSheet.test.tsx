import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AskSheet } from "./AskSheet";

function setup(children = <textarea aria-label="Say" />) {
  const onClose = vi.fn();
  const opener = document.createElement("button");
  opener.textContent = "Ask";
  document.body.append(opener);
  opener.focus();
  const view = render(<AskSheet onClose={onClose}>{children}</AskSheet>);
  return { onClose, opener, ...view };
}

describe("the Ask sheet", () => {
  it("takes focus into its message box, and gives it back to what had it when it goes", () => {
    const { opener, unmount } = setup();
    expect(screen.getByRole("textbox", { name: "Say" })).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
  });

  it("takes focus itself when it has no message box", () => {
    setup(<p>Nothing to type</p>);
    expect(screen.getByRole("dialog", { name: "Ask across projects" })).toHaveFocus();
  });

  it("keeps Tab inside it, both ways", () => {
    setup(
      <>
        <select aria-label="Send to">
          <option>a</option>
        </select>
        <textarea aria-label="Say" />
        <button>Send</button>
      </>,
    );
    const close = screen.getByRole("button", { name: "Close Ask" });
    const send = screen.getByRole("button", { name: "Send" });
    send.focus();
    fireEvent.keyDown(send, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(send).toHaveFocus();
  });

  it("closes on Escape, but from a dropdown only leaves the dropdown first", () => {
    const { onClose } = setup(
      <>
        <select aria-label="Send to">
          <option>a</option>
        </select>
        <textarea aria-label="Say" />
      </>,
    );
    const to = screen.getByRole("combobox", { name: "Send to" });
    to.focus();
    fireEvent.keyDown(to, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(to).not.toHaveFocus();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Say" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a press behind it or on ×, not on a press inside it, and ignores other keys", () => {
    const { onClose, container } = setup();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    fireEvent.keyDown(window, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(container.ownerDocument.querySelector(".desk-ask-overlay")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close Ask" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
