/** What a message sounds like read aloud: its words, without the marks, and a word for what can't be read out (code, a table). */
import { parseMarkdown, plainText } from "./markdown";

/** The most that is spoken at once (the phone's speech limit is about 4000 characters; this leaves room). */
export const SPOKEN_MAX = 3000;

/** The message as plain sentences, one block to a line; code and tables are named, not read out. Cut at a sentence when it is long. */
export function spokenText(markdown: string): string {
  const lines = parseMarkdown(markdown).flatMap((b): string[] => {
    switch (b.kind) {
      case "heading":
      case "paragraph":
      case "quote":
        return [plainText(b.spans)];
      case "list":
        return b.items.map((item) => plainText(item));
      case "table":
        return ["There is a table here."];
      case "code":
        return [b.lang ? `There is a ${b.lang} code block here.` : "There is a code block here."];
      case "rule":
        return [];
    }
  });
  const text = lines
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  if (text.length <= SPOKEN_MAX) return text;
  const cut = text.slice(0, SPOKEN_MAX);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return `${(end > SPOKEN_MAX / 2 ? cut.slice(0, end + 1) : cut).trim()}\nThere is more in the chat.`;
}
