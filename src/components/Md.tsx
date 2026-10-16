import { createContext, memo, useContext, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents, pathBreaks, splitMention, useFileLinks } from "../lib/fileLinks";
import { blockLanguage, CALLOUT_LABEL, filePaths, languageHint, languageName, parsePlanStep, rehypeCallouts, type CalloutKind, type PlanStep } from "../lib/markdown";
import { lineKind } from "../lib/diff";
import { usePrefersDark, useThemeVersion } from "../lib/theme";
import { DocIcon } from "./icons";
import { DiagramLightbox, useDiagram } from "./Diagram";
import { ArchitectureBlock } from "./ArchitectureTab";
import { svgSize } from "../lib/mermaid";

interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HNode[];
  properties?: { className?: string[] | string };
}

const textOf = (n: HNode | undefined): string => (!n ? "" : n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(textOf).join(""));

/** A path in a plan step's `File:` line, a link once it's found in the folder. */
function FilePath({ path }: { path: string }) {
  const links = useFileLinks();
  const mention = splitMention(path);
  const file = mention && links ? links.resolve(mention.path) : null;
  const code = <code>{pathBreaks(path)}</code>;
  if (!file || !links) return code;
  return (
    <button className="file-link" title={`Open ${path}`} onClick={() => links.open(file, mention!.line)}>
      {code}
    </button>
  );
}

function PlanStepCard({ step }: { step: PlanStep }) {
  return (
    <div className="plan-card">
      {step.title && <div className="plan-card-title">{step.title}</div>}
      <dl>
        {step.fields.map((f, i) => (
          <div key={i} className={`plan-card-row plan-${f.label.toLowerCase()}`}>
            <dt>{f.label}</dt>
            <dd>
              {f.label.startsWith("File") ? (
                <span className="plan-card-files">
                  {filePaths(f.value).map((p) => (
                    <span key={p.path} className="plan-card-file">
                      <DocIcon />
                      <FilePath path={p.path} />
                      {p.note && <span className="plan-card-note">{p.note}</span>}
                    </span>
                  ))}
                </span>
              ) : (
                <Md inline>{f.value}</Md>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A fenced code block with a header: its language and a Copy button. Plan steps become cards instead. */
function Pre({ node, children, ...rest }: ComponentProps<"pre"> & { node?: HNode }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const code = node?.children?.find((c) => c.type === "element" && c.tagName === "code");
  const cls = code?.properties?.className;
  const className = Array.isArray(cls) ? cls.join(" ") : cls;
  const text = textOf(code);
  const named = languageName(className);
  const step = !named || named === "text" ? parsePlanStep(text) : null;
  // A block with no language is coloured as what it looks like (a diff, JSON, shell, the message's own language).
  const hint = useContext(LanguageHint);
  const { id, label: lang } = blockLanguage(className, text, hint);
  // A mermaid block is drawn as a diagram once it can be; until then (and if it can't) it's the code.
  const diagram = useDiagram(named?.toLowerCase() === "mermaid" ? text : "");
  const map = named?.toLowerCase() === "architecture";
  const highlighted = useHighlight(step || id === "diff" || map || named?.toLowerCase() === "mermaid" ? "" : text, id);
  if (step) return <PlanStepCard step={step} />;
  if (map) return <ArchitectureBlock text={text} />;
  const size = diagram.svg ? svgSize(diagram.svg) : null;
  const copy = () =>
    navigator.clipboard?.writeText(text.replace(/\n$/, "")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div className={`code-block${diagram.svg ? " diagram-block" : ""}`}>
      <div className="code-block-head">
        <span className="code-block-lang">{diagram.svg ? "Diagram" : (lang ?? "Code")}</span>
        {diagram.error && <span className="code-block-note">Couldn't draw this diagram</span>}
        {size && (
          <button className="code-block-copy" onClick={() => setExpanded(true)} aria-label="Expand diagram" title="Open it at full size, to zoom and move around">
            Expand
          </button>
        )}
        <button className="code-block-copy" onClick={copy} aria-label={diagram.svg ? "Copy diagram source" : "Copy code"}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {diagram.svg ? (
        // Mermaid's own markup, drawn in its strict security level (scripts off, labels sanitised).
        <>
          <div className="diagram" title={size ? "Click to open it at full size" : undefined} onClick={size ? () => setExpanded(true) : undefined} dangerouslySetInnerHTML={{ __html: diagram.svg }} />
          {expanded && size && <DiagramLightbox svg={diagram.svg} size={size} onClose={() => setExpanded(false)} />}
        </>
      ) : id === "diff" ? (
        // Monaco has no diff colouring: each line is tinted by what it does, as in the diff view.
        <pre {...rest} className="code-block-colored code-block-diff">
          <code>
            {text
              .replace(/\n$/, "")
              .split("\n")
              .map((line, i) => (
                <span key={i} className={`diff-line ${/^(@@|diff |index |--- |\+\+\+ )/.test(line) ? "meta" : lineKind(line)}`}>
                  {line || " "}
                  {"\n"}
                </span>
              ))}
          </code>
        </pre>
      ) : highlighted ? (
        // Monaco's colorize escapes the code; the HTML is only its coloured spans.
        <pre {...rest} className="code-block-colored">
          <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        </pre>
      ) : (
        <pre {...rest}>{children}</pre>
      )}
    </div>
  );
}

/**
 * The code coloured by Monaco (loaded on first use, as the diff view does), or null: while it loads, while the
 * block is still streaming in (it's coloured once it stops changing), or for a language it doesn't know.
 */
function useHighlight(code: string, language: string | null): string | null {
  const dark = usePrefersDark();
  // Another theme has other source colours, so the block is coloured again when the theme changes.
  const look = useThemeVersion();
  const [html, setHtml] = useState<{ code: string; dark: boolean; look: number; html: string } | null>(null);
  useEffect(() => {
    if (!language || !code.trim()) return;
    let live = true;
    const wait = setTimeout(() => {
      import("../monaco")
        .then((m) => m.colorize(code.replace(/\n$/, ""), language, dark))
        .then((h) => live && setHtml({ code, dark, look, html: h }), () => {});
    }, 150);
    return () => {
      live = false;
      clearTimeout(wait);
    };
  }, [code, language, dark, look]);
  return html && html.code === code && html.dark === dark && html.look === look ? html.html : null;
}

const CALLOUT_ICON: Record<CalloutKind, string> = { note: "i", tip: "✦", important: "!", warning: "!", caution: "!" };

/** `> [!NOTE]` and its kin, GitHub-style; a plain quote otherwise. */
function Blockquote({ node: _node, children, ...rest }: ComponentProps<"blockquote"> & { node?: unknown; "data-callout"?: CalloutKind }) {
  const kind = rest["data-callout"];
  if (!kind) return <blockquote {...rest}>{children}</blockquote>;
  return (
    <div className={`callout callout-${kind}`} role="note">
      <div className="callout-title">
        <span className="callout-icon" aria-hidden>
          {CALLOUT_ICON[kind]}
        </span>
        {CALLOUT_LABEL[kind]}
      </div>
      {children}
    </div>
  );
}

/** A table in a box of its own, like a code block: it scrolls sideways in there when it can't fit, not the whole message. */
function Table({ node: _node, ...rest }: ComponentProps<"table"> & { node?: unknown }) {
  return (
    <div className="md-table">
      <table {...rest} />
    </div>
  );
}

/** A cell's content in a box with a widest width (a table cell's own max-width is ignored), so a long text wraps there. */
function Cell({ node: _node, children, ...rest }: ComponentProps<"td"> & { node?: unknown }) {
  return (
    <td {...rest}>
      <div className="md-cell">{children}</div>
    </td>
  );
}
function HeadCell({ node: _node, children, ...rest }: ComponentProps<"th"> & { node?: unknown }) {
  return (
    <th {...rest}>
      <div className="md-cell">{children}</div>
    </th>
  );
}

const components = { ...markdownComponents, pre: Pre, blockquote: Blockquote, table: Table, td: Cell, th: HeadCell };
// For a line of text inside other text (a table cell, a card row): no paragraph around it.
const inlineComponents = { ...components, p: ({ children }: { children?: ReactNode }) => <>{children}</> };
/**
 * An image shown as its description. A file in someone else's project can point at any server, and loading its
 * pictures would tell that server you opened it.
 */
function BlockedImage({ alt }: ComponentProps<"img">) {
  return <span className="md-image-blocked">{alt ? `[Image: ${alt}]` : "[Image]"}</span>;
}
const componentsWithoutImages = { ...components, img: BlockedImage };
const inlineComponentsWithoutImages = { ...inlineComponents, img: BlockedImage };
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeCallouts];

/** The language of the files the message being drawn names: what an untagged code block in it is most likely in. */
const LanguageHint = createContext<string | null>(null);
/**
 * Whether pictures are loaded. Off unless a caller opts in: Claude's text can carry a picture that a prompt injection
 * points at a server it wants data sent to. Markdown drawn inside markdown (a plan step's fields) follows the text around it.
 */
const ImagesAllowed = createContext(false);

/**
 * Claude's markdown: GFM, file links, code block headers, plan step cards and callouts. Pictures aren't loaded unless
 * `images` is set, so a picture shows as its description, whatever text it's in.
 */
export const Md = memo(function Md({ children, inline = false, images }: { children: string; inline?: boolean; images?: boolean }) {
  const hint = useMemo(() => languageHint(children), [children]);
  const inherited = useContext(ImagesAllowed);
  const loadImages = images ?? inherited;
  return (
    <ImagesAllowed.Provider value={loadImages}>
      <LanguageHint.Provider value={hint}>
        <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={loadImages ? (inline ? inlineComponents : components) : inline ? inlineComponentsWithoutImages : componentsWithoutImages}>
          {children}
        </Markdown>
      </LanguageHint.Provider>
    </ImagesAllowed.Provider>
  );
});
