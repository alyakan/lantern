import { afterEach, describe, expect, it } from "vitest";
import { isTyping } from "./typing";

const put = (html: string) => {
  document.body.innerHTML = html;
  return document.querySelector("textarea, input, div[contenteditable]")!;
};
afterEach(() => (document.body.innerHTML = ""));

describe("isTyping", () => {
  it("is true for fields and for the file editor, so J and K don't switch files while you type", () => {
    expect(isTyping(put("<input />"))).toBe(true);
    expect(isTyping(put("<textarea></textarea>"))).toBe(true);
    expect(isTyping(put('<div class="editable-editor"><div class="monaco-editor"><textarea></textarea></div></div>'))).toBe(true);
  });

  it("is false for the read-only diff's textarea, and for nothing focused", () => {
    expect(isTyping(put('<div class="diff-body"><div class="monaco-editor"><textarea></textarea></div></div>'))).toBe(false);
    expect(isTyping(document.body)).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});
