/**
 * Automatic bullets and numbering in the message box, like a notes app. A list line is indentation, a marker ("-", "*",
 * "•", or digits followed by "." or ")") and at least one space; "-5" and "1.5" are not lists. Pure: the caller
 * applies what comes back (see listKey.ts).
 */

export interface ListEdit {
  value: string;
  /** Where the caret (or the start of the selection) goes. */
  caret: number;
}

const MARKER = /^([ \t]*)(?:([-*•])|(\d{1,9})([.)])) +/;

interface Line {
  start: number;
  end: number;
  text: string;
}

const lineAt = (value: string, at: number): Line => {
  const start = at === 0 ? 0 : value.lastIndexOf("\n", at - 1) + 1;
  const end = value.indexOf("\n", at);
  return { start, end: end < 0 ? value.length : end, text: value.slice(start, end < 0 ? value.length : end) };
};

/** Inside an open ``` fence at `at`: an odd number of fence lines come before the line. */
const inFence = (value: string, line: Line) => (value.slice(0, line.start).match(/^[ \t]*```/gm) ?? []).length % 2 === 1;

/** The marker that starts the line, if it is a list line outside a code fence. */
const markerOf = (value: string, line: Line) => (inFence(value, line) ? null : MARKER.exec(line.text));

/** The same marker for the next item: a bullet repeats, a number counts on. */
const next = (m: RegExpExecArray) => m[0].replace(m[2] ?? m[3], m[2] ?? String(Number(m[3]) + 1));

/**
 * A new line (Shift+Enter) in a list line: the next marker starts it, text after the caret moves down with it, an empty
 * item ends the list instead. A selection is replaced first. Null when there is nothing to do (the browser's newline).
 */
export function continueList(value: string, selStart: number, selEnd: number): ListEdit | null {
  const text = value.slice(0, selStart) + value.slice(selEnd);
  const line = lineAt(text, selStart);
  const m = markerOf(text, line);
  if (!m || selStart - line.start < m[0].length) return null;
  const selected = selEnd > selStart;
  if (!selected && line.text.slice(m[0].length).trim() === "") {
    return { value: text.slice(0, line.start) + text.slice(line.end), caret: line.start };
  }
  const insert = `\n${next(m)}`;
  return { value: text.slice(0, selStart) + insert + text.slice(selStart), caret: selStart + insert.length };
}

/**
 * Tab (or Shift+Tab with `outdent`) in a list line: two more spaces of indentation, or up to two fewer. The selection
 * moves with the line. Null when the caret is not in a list line.
 */
export function indentList(value: string, selStart: number, selEnd: number, outdent = false): (ListEdit & { end: number }) | null {
  const line = lineAt(value, selStart);
  if (!markerOf(value, line)) return null;
  const removed = outdent ? /^(?:\t| {1,2})/.exec(line.text)?.[0].length ?? 0 : 0;
  const change = outdent ? -removed : 2;
  return {
    value: value.slice(0, line.start) + (outdent ? line.text.slice(removed) : `  ${line.text}`) + value.slice(line.end),
    caret: Math.max(line.start, selStart + change),
    end: Math.max(line.start, selEnd + change),
  };
}
