import type { KeyboardEvent } from "react";
import { continueList, indentList, type ListEdit } from "./listEdit";

/**
 * Types `edit` into the box the way the user would, so the browser's undo still takes it back: the text that changed is
 * selected and replaced with execCommand (which fires the input event), or, where that isn't there, with setRangeText and
 * an input event of our own.
 */
function apply(el: HTMLTextAreaElement, edit: ListEdit & { end?: number }) {
  const old = el.value;
  let from = 0;
  while (from < old.length && from < edit.value.length && old[from] === edit.value[from]) from++;
  let tail = 0;
  while (tail < old.length - from && tail < edit.value.length - from && old[old.length - 1 - tail] === edit.value[edit.value.length - 1 - tail]) tail++;
  const to = old.length - tail;
  const inserted = edit.value.slice(from, edit.value.length - tail);
  if (from !== to || inserted) {
    el.setSelectionRange(from, to);
    const done = typeof document.execCommand === "function" && (inserted ? document.execCommand("insertText", false, inserted) : document.execCommand("delete"));
    if (!done) {
      el.setRangeText(inserted, from, to, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  el.setSelectionRange(edit.caret, edit.end ?? edit.caret);
}

/**
 * Shift+Enter and Tab in a list line of a message box: continues or ends the list, indents or outdents the line. Returns
 * whether it took the key (and so stopped the browser's own); `composing` is true while an input method has the key.
 */
export function listKey(e: KeyboardEvent<HTMLTextAreaElement>, composing = e.nativeEvent.isComposing): boolean {
  if (composing || e.metaKey || e.ctrlKey || e.altKey) return false;
  const newline = e.key === "Enter" && e.shiftKey;
  if (!newline && e.key !== "Tab") return false;
  const el = e.currentTarget;
  const { value, selectionStart: from, selectionEnd: to } = el;
  const edit = newline ? continueList(value, from, to) : indentList(value, from, to, e.shiftKey);
  if (!edit) return false;
  e.preventDefault();
  apply(el, edit);
  return true;
}
