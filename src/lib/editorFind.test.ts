import { describe, expect, it, vi } from "vitest";
import { openFind, registerFindable } from "./editorFind";

function fakeEditor(shown: boolean) {
  const node = document.createElement("div");
  if (shown) document.body.appendChild(node);
  // jsdom lays nothing out: an attached node stands for one on screen.
  Object.defineProperty(node, "offsetParent", { get: () => (node.isConnected ? document.body : null) });
  node.getClientRects = () => (node.isConnected ? ([{}] as unknown as DOMRectList) : ([] as unknown as DOMRectList));
  let dispose = () => {};
  const run = vi.fn();
  const editor = { focus: vi.fn(), getDomNode: () => node, getAction: () => ({ run }), onDidDispose: (l: () => void) => (dispose = l) };
  return { editor, run, dispose: () => dispose(), node };
}

describe("openFind", () => {
  it("opens find on the newest editor on screen, and forgets disposed ones", () => {
    expect(openFind()).toBe(false);
    const diff = fakeEditor(true);
    const hidden = fakeEditor(false);
    registerFindable(diff.editor);
    registerFindable(hidden.editor);
    expect(openFind()).toBe(true);
    expect(diff.run).toHaveBeenCalled();
    expect(diff.editor.focus).toHaveBeenCalled();
    expect(hidden.run).not.toHaveBeenCalled();

    const preview = fakeEditor(true);
    registerFindable(preview.editor);
    openFind();
    expect(preview.run).toHaveBeenCalledTimes(1);
    preview.dispose();
    preview.node.remove();
    openFind();
    expect(diff.run).toHaveBeenCalledTimes(2);
  });
});
