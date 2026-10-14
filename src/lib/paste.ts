/**
 * Big pastes in the message box. A paste of more than a few lines goes in as a placeholder, `[Pasted text #1 · 120
 * lines]`, and the text itself is kept aside (`Pastes`, by number) to take its place when the message is sent.
 */

/** The text pasted, by the number in its placeholder. */
export type Pastes = Record<number, string>;

/** A paste is "big" above this many lines or characters. */
export const PASTE_LINES = 5;
export const PASTE_CHARS = 1000;

/** The number of lines in some text: a trailing newline doesn't start another. */
export const lineCount = (text: string) => text.replace(/\n$/, "").split("\n").length;

export const isBigPaste = (text: string) => lineCount(text) > PASTE_LINES || text.length > PASTE_CHARS;

export const placeholder = (n: number, text: string) => `[Pasted text #${n} · ${lineCount(text)} line${lineCount(text) === 1 ? "" : "s"}]`;

const TOKEN = /\[Pasted text #(\d+) · \d+ lines?\]/g;

/** The placeholders in some text, with where each is. */
function tokens(text: string): { n: number; start: number; end: number }[] {
  return [...text.matchAll(TOKEN)].map((m) => ({ n: Number(m[1]), start: m.index!, end: m.index! + m[0].length }));
}

/** The number for the next paste: after every one in the box, and every one kept. */
export function nextNumber(text: string, pastes: Pastes): number {
  return Math.max(0, ...tokens(text).map((t) => t.n), ...Object.keys(pastes).map(Number)) + 1;
}

/** What to send: each placeholder replaced by its text. One whose text isn't kept (it was typed by hand) stays as it is. */
export function expandPastes(text: string, pastes: Pastes): string {
  return text.replace(TOKEN, (whole, n) => pastes[Number(n)] ?? whole);
}

/** Only the pastes that still have a placeholder in the text. */
export function inUse(text: string, pastes: Pastes): Pastes {
  const used = new Set(tokens(text).map((t) => t.n));
  return Object.fromEntries(Object.entries(pastes).filter(([n]) => used.has(Number(n))));
}

/** The placeholder that ends right at the caret, for Backspace to take away whole. */
export function tokenBefore(text: string, caret: number): { n: number; start: number; end: number } | null {
  return tokens(text).find((t) => t.end === caret) ?? null;
}

/** A sent message as the box would have it: a big one comes back as its placeholder, with its text kept. */
export function draftOf(text: string): string {
  return isBigPaste(text) ? encodeDraft(placeholder(1, text), { 1: text }) : text;
}

/**
 * `edit` (an encoded draft) put in front of what's in the box `draft`, a blank line between. Its pastes are renumbered
 * past the box's, so the two never share a number.
 */
export function prependDraft(draft: string, edit: string): string {
  const box = decodeDraft(draft);
  const piece = decodeDraft(edit);
  const base = nextNumber(box.text, box.pastes) - 1;
  const renumber = new Map(
    Object.keys(piece.pastes)
      .map(Number)
      .sort((a, b) => a - b)
      .map((old, i) => [old, base + 1 + i] as const),
  );
  const pieceText = piece.text.replace(TOKEN, (whole, n) => (renumber.has(Number(n)) ? whole.replace(`#${n} `, `#${renumber.get(Number(n))} `) : whole));
  const pastes: Pastes = { ...box.pastes, ...Object.fromEntries([...renumber].map(([old, n]) => [n, piece.pastes[old]])) };
  return encodeDraft([pieceText, box.text].filter((t) => t.trim()).join("\n\n"), pastes);
}

// A draft is saved as one string. With pastes in it, they follow the text after this mark.
const MARK = "⁣⁣pastes⁣⁣";

/** The text and its pastes as the one string a draft is saved as. */
export function encodeDraft(text: string, pastes: Pastes): string {
  const used = inUse(text, pastes);
  return Object.keys(used).length ? `${text}${MARK}${JSON.stringify(used)}` : text;
}

/** The inverse of `encodeDraft`; a draft with nothing after the mark, or something unreadable, is just its text. */
export function decodeDraft(draft: string): { text: string; pastes: Pastes } {
  const at = draft.lastIndexOf(MARK);
  if (at < 0) return { text: draft, pastes: {} };
  try {
    const parsed: unknown = JSON.parse(draft.slice(at + MARK.length));
    if (parsed && typeof parsed === "object") {
      const pastes = Object.fromEntries(Object.entries(parsed).filter(([n, v]) => /^\d+$/.test(n) && typeof v === "string"));
      return { text: draft.slice(0, at), pastes: pastes as Pastes };
    }
  } catch {
    // fall through: not ours
  }
  return { text: draft, pastes: {} };
}
