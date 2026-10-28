/**
 * The markdown Claude writes in a chat, as blocks and spans a screen can draw: headings, paragraphs, lists (nested, loose,
 * with task boxes), tables, rules, code blocks and quotes; code, bold, italic, strikethrough and links inside text. Not a
 * full markdown: what isn't understood is shown as the text it is.
 */

/** Bold, italic and strikethrough hold what is marked in `text`, and in `spans` too when it has marks of its own (`**`code`**`). */
export type Span =
  | { kind: "text" | "code"; text: string }
  | { kind: "bold" | "italic" | "strike"; text: string; spans?: Span[] }
  | { kind: "link"; text: string; url: string };

export type Align = "left" | "center" | "right";

/** One item of a list: how deep it sits, the mark before it, and whether it is a task box (null: not one). */
export interface ListMeta {
  depth: number;
  marker: string;
  checked: boolean | null;
}

export type Block =
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; items: Span[][]; meta: ListMeta[] }
  | { kind: "quote"; spans: Span[] }
  | { kind: "table"; align: Align[]; head: Span[][]; rows: Span[][][] }
  | { kind: "rule" };

/** What a run of spans reads as, without its marks (for measuring it). */
export function plainText(spans: Span[]): string {
  return spans.map((s) => s.text).join("");
}

function marked(kind: "bold" | "italic" | "strike", inner: string): Span {
  const spans = parseInline(inner);
  return spans.length === 1 && spans[0].kind === "text" ? { kind, text: inner } : { kind, text: inner, spans };
}

/** Code, **bold**, *italic*, ~~strikethrough~~, [links](url) and bare links, in that order of binding; unmatched marks stay as text. */
export function parseInline(s: string): Span[] {
  const out: Span[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", text });
    text = "";
  };
  for (let i = 0; i < s.length; ) {
    const rest = s.slice(i);
    const before = s[i - 1] ?? "";
    let m: RegExpExecArray | null;
    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      flush();
      out.push({ kind: "code", text: m[1] });
    } else if ((m = /^(?:\*\*([^*\n]+)\*\*|__([^_\n]+)__)/.exec(rest)) && (m[1] !== undefined || !/\w/.test(before))) {
      flush();
      out.push(marked("bold", m[1] ?? m[2]));
    } else if ((m = /^~~([^~\n]+)~~/.exec(rest))) {
      flush();
      out.push(marked("strike", m[1]));
    } else if ((m = /^(?:\*([^*\s][^*\n]*)\*|_([^_\s][^_\n]*)_)/.exec(rest)) && !/\w/.test(before)) {
      flush();
      out.push(marked("italic", m[1] ?? m[2]));
    } else if ((m = /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/.exec(rest))) {
      flush();
      out.push({ kind: "link", text: m[1], url: m[2] });
    } else if ((m = /^https?:\/\/[^\s<>]+/.exec(rest)) && !/\w/.test(before)) {
      // A bare link: what ends the sentence around it (a full stop, a closing bracket) is not part of it.
      const url = m[0].replace(/[.,;:!?)\]'"]+$/, "");
      if (url.length <= "https://".length) {
        text += s[i];
        i += 1;
        continue;
      }
      flush();
      out.push({ kind: "link", text: url, url });
      i += url.length;
      continue;
    } else {
      text += s[i];
      i += 1;
      continue;
    }
    i += m[0].length;
  }
  flush();
  return out;
}

/** The cells of a table row: split at the bars that aren't escaped or inside `code`, the outer bars dropped. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (c === "`") {
      inCode = !inCode;
      cell += c;
    } else if (c === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const alignOf = (cell: string): Align => (/^:-*:$/.test(cell) ? "center" : /-:$/.test(cell) ? "right" : "left");

const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const BULLETS = ["•", "◦", "▪"];
/** How far a line is indented (a tab counts as two spaces). */
const indentOf = (s: string) => /^[ \t]*/.exec(s)![0].replace(/\t/g, "  ").length;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const endParagraph = () => {
    if (para.length) blocks.push({ kind: "paragraph", spans: parseInline(para.join(" ")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line.trim());
    if (fence) {
      endParagraph();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i].trim()); i++) code.push(lines[i]);
      blocks.push({ kind: "code", lang: fence[1], text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      endParagraph();
      blocks.push({ kind: "heading", level: heading[1].length, spans: parseInline(heading[2]) });
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      endParagraph();
      blocks.push({ kind: "rule" });
      continue;
    }
    // A table: a row, then the line of dashes under it that says which columns there are. Until that line has come (a
    // message still streaming in) it is just the text it is.
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("-") && SEPARATOR.test(lines[i + 1])) {
      const head = splitRow(line);
      const seps = splitRow(lines[i + 1]);
      if (head.length === seps.length && head.length > 0) {
        endParagraph();
        const rows: Span[][][] = [];
        let j = i + 2;
        for (; j < lines.length && lines[j].trim() && lines[j].includes("|"); j++) {
          const cells = splitRow(lines[j]);
          rows.push(head.map((_, c) => parseInline(cells[c] ?? "")));
        }
        blocks.push({ kind: "table", align: seps.map(alignOf), head: head.map((h) => parseInline(h)), rows });
        i = j - 1;
        continue;
      }
    }
    const first = LIST_ITEM.exec(line);
    if (first) {
      endParagraph();
      const ordered = !!first[3];
      const items: Span[][] = [];
      const meta: ListMeta[] = [];
      const base = indentOf(first[1]);
      let at = i;
      for (;;) {
        const m = LIST_ITEM.exec(lines[at])!;
        const depth = Math.min(3, Math.floor(Math.max(0, indentOf(m[1]) - base) / 2));
        let body = m[4];
        let checked: boolean | null = null;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
        if (task) {
          checked = task[1] !== " ";
          body = task[2];
        }
        // What is indented under an item, and isn't an item itself, goes on with it.
        while (at + 1 < lines.length && lines[at + 1].trim() && !LIST_ITEM.test(lines[at + 1]) && indentOf(lines[at + 1]) > indentOf(m[1])) {
          body += ` ${lines[++at].trim()}`;
        }
        items.push(parseInline(body));
        meta.push({ depth, marker: m[3] ? `${m[3]}.` : BULLETS[depth % BULLETS.length], checked });
        // The next item may come after blank lines (a loose list); anything else ends the list.
        let next = at + 1;
        while (next < lines.length && !lines[next].trim()) next++;
        const n = next < lines.length ? LIST_ITEM.exec(lines[next]) : null;
        if (!n) break;
        const nDepth = Math.max(0, indentOf(n[1]) - base);
        // A different kind of item at the list's own level starts another list.
        if (nDepth < 2 && !!n[3] !== ordered) break;
        at = next;
      }
      blocks.push({ kind: "list", ordered, items, meta });
      i = at;
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      endParagraph();
      const q = [quote[1]];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) q.push(lines[++i].replace(/^>\s?/, ""));
      blocks.push({ kind: "quote", spans: parseInline(q.join(" ")) });
      continue;
    }
    if (!line.trim()) endParagraph();
    else para.push(line.trim());
  }
  endParagraph();
  return blocks;
}
