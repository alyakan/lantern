import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MessageInput } from "./MessageInput";

/** The box with `value` in it and the caret (or the selection) at `from`..`to`. */
const boxWith = (value: string, from = value.length, to = from, props: Partial<Parameters<typeof MessageInput>[0]> = {}) => {
  const onSend = vi.fn();
  render(<MessageInput status="idle" onSend={onSend} onStop={() => {}} {...props} />);
  const box = screen.getByPlaceholderText("Ask Claude…") as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value } });
  box.setSelectionRange(from, to);
  return { box, onSend };
};
const caretIn = (box: HTMLTextAreaElement) => [box.selectionStart, box.selectionEnd];

afterEach(() => {
  // @ts-expect-error jsdom has no execCommand; some tests give it one
  delete document.execCommand;
});

describe("MessageInput lists", () => {
  it("starts the next bullet on Shift+Enter at the end of a list line, and does not send", () => {
    const { box, onSend } = boxWith("- first");
    expect(fireEvent.keyDown(box, { key: "Enter", shiftKey: true })).toBe(false);
    expect(box).toHaveValue("- first\n- ");
    expect(caretIn(box)).toEqual([10, 10]);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("counts on in a numbered list, and keeps typing after the marker", () => {
    const { box } = boxWith("1. one");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    fireEvent.change(box, { target: { value: "1. one\n2. two" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(box).toHaveValue("1. one\n2. two\n3. ");
  });

  it("ends the list on Shift+Enter in an empty item", () => {
    const { box } = boxWith("- a\n- ");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(box).toHaveValue("- a\n");
    expect(caretIn(box)).toEqual([4, 4]);
  });

  it("splits the line at the caret", () => {
    const { box } = boxWith("- abcd", 4);
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(box).toHaveValue("- ab\n- cd");
    expect(caretIn(box)).toEqual([7, 7]);
  });

  it("replaces a selection, then continues the list", () => {
    const { box } = boxWith("- abcd", 3, 5);
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(box).toHaveValue("- a\n- d");
  });

  it("leaves Shift+Enter on a plain line to the browser", () => {
    const { box } = boxWith("just text");
    expect(fireEvent.keyDown(box, { key: "Enter", shiftKey: true })).toBe(true);
    expect(box).toHaveValue("just text");
  });

  it("does not continue a list inside a code fence", () => {
    const { box } = boxWith("```\n- item");
    expect(fireEvent.keyDown(box, { key: "Enter", shiftKey: true })).toBe(true);
    expect(box).toHaveValue("```\n- item");
  });

  it("does not act while an input method is composing", () => {
    const { box } = boxWith("- item");
    expect(fireEvent.keyDown(box, { key: "Enter", shiftKey: true, isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(box, { key: "Enter", shiftKey: true, keyCode: 229 })).toBe(true);
    expect(fireEvent.keyDown(box, { key: "Tab", isComposing: true })).toBe(true);
    expect(box).toHaveValue("- item");
  });

  it("still sends on Enter, with a list in the box", () => {
    const { box, onSend } = boxWith("- a\n- b");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("- a\n- b", expect.anything());
  });

  it("indents a list line with Tab and outdents it with Shift+Tab", () => {
    const { box } = boxWith("- a\n- b");
    expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(false);
    expect(box).toHaveValue("- a\n  - b");
    expect(caretIn(box)).toEqual([9, 9]);
    expect(fireEvent.keyDown(box, { key: "Tab", shiftKey: true })).toBe(false);
    expect(box).toHaveValue("- a\n- b");
    expect(caretIn(box)).toEqual([7, 7]);
  });

  it("keeps Tab moving focus anywhere that is not a list line", () => {
    const { box } = boxWith("plain\n- a\nplain again");
    expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(box, { key: "Tab", shiftKey: true })).toBe(true);
    expect(box).toHaveValue("plain\n- a\nplain again");
  });

  it("keeps the draft up to date with what the list edit typed", () => {
    const save = vi.fn();
    const { box } = boxWith("- a", undefined, undefined, { draft: { initial: "", save } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(save).toHaveBeenLastCalledWith("- a\n- ");
  });

  it("types through execCommand where the browser has it, so undo can take the edit back", () => {
    const { box } = boxWith("- abcd", 4);
    const exec = vi.fn((command: string, _ui?: boolean, text?: string) => {
      if (command === "insertText") {
        box.setRangeText(text!, box.selectionStart, box.selectionEnd, "end");
        fireEvent.input(box);
      }
      return true;
    });
    document.execCommand = exec;
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(exec).toHaveBeenCalledWith("insertText", false, "\n- ");
    expect(box).toHaveValue("- ab\n- cd");
    expect(caretIn(box)).toEqual([7, 7]);
  });

  it("removes an empty marker with execCommand's delete", () => {
    const { box } = boxWith("- a\n- ");
    const exec = vi.fn((command: string) => {
      if (command === "delete") {
        box.setRangeText("", box.selectionStart, box.selectionEnd, "end");
        fireEvent.input(box);
      }
      return true;
    });
    document.execCommand = exec;
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(exec).toHaveBeenCalledWith("delete");
    expect(box).toHaveValue("- a\n");
  });

  it("leaves a shell command alone", () => {
    const { box } = boxWith("!echo - hi", undefined, undefined, { onRun: vi.fn() });
    expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(true);
    expect(box).toHaveValue("echo - hi");
  });
});
