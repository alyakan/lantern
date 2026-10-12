import { useMemo } from "react";
import { Md } from "./Md";
import { withFrontMatterAsCode } from "../lib/markdown";

/** A markdown file read as a styled document: the same rendering as Claude's messages, in a column made for reading. */
export default function MarkdownPreview({ text }: { text: string }) {
  const doc = useMemo(() => withFrontMatterAsCode(text), [text]);
  return (
    <div className="md-preview" aria-label="Markdown preview">
      <div className="md-preview-page msg assistant">{doc.trim() ? <Md>{doc}</Md> : <span className="md-preview-empty">This file is empty.</span>}</div>
    </div>
  );
}
