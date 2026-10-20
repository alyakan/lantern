/**
 * The little markdown Claude writes in a chat, as blocks and spans a screen can draw: headings, paragraphs, lists, code
 * blocks and quotes; code, bold, italic and links inside text. Not a full markdown: what isn't understood is shown as
 * the text it is.
 */

export type Span = { kind: "text" | "code" | "bold" | "italic"; text: string } | { kind: "link"; text: string; url: string };

export type Block =
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; items: Span[][] }
  | { kind: "quote"; spans: Span[] };

/** Code, **bold**, *italic* and [links](url), in that order of binding; unmatched marks stay as text. */
export function parseInline(s: string): Span[] {
  const out: Span[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", text });
    text = "";
  };
  for (let i = 0; i < s.length; ) {
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      flush();
      out.push({ kind: "code", text: m[1] });
    } else if ((m = /^\*\*([^*\n]+)\*\*/.exec(rest))) {
      flush();
      out.push({ kind: "bold", text: m[1] });
    } else if ((m = /^(?:\*([^*\s][^*\n]*)\*|_([^_\s][^_\n]*)_)/.exec(rest)) && !/\w/.test(s[i - 1] ?? "")) {
      flush();
      out.push({ kind: "italic", text: m[1] ?? m[2] });
    } else if ((m = /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/.exec(rest))) {
      flush();
      out.push({ kind: "link", text: m[1], url: m[2] });
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
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      endParagraph();
      const ordered = !!item[2];
      const items: Span[][] = [parseInline(item[3])];
      while (i + 1 < lines.length) {
        const next = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(lines[i + 1]);
        if (!next || !!next[2] !== ordered) break;
        items.push(parseInline(next[3]));
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
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
