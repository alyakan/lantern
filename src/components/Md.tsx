import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents, splitMention, useFileLinks } from "../lib/fileLinks";
import { CALLOUT_LABEL, filePaths, languageName, monacoLanguage, parsePlanStep, rehypeCallouts, type CalloutKind, type PlanStep } from "../lib/markdown";
import { usePrefersDark } from "../lib/theme";
import { DocIcon } from "./icons";

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
  const code = <code>{path}</code>;
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
  const code = node?.children?.find((c) => c.type === "element" && c.tagName === "code");
  const cls = code?.properties?.className;
  const className = Array.isArray(cls) ? cls.join(" ") : cls;
  const text = textOf(code);
  const lang = languageName(className);
  const step = !lang || lang === "text" ? parsePlanStep(text) : null;
  const highlighted = useHighlight(step ? "" : text, monacoLanguage(className));
  if (step) return <PlanStepCard step={step} />;
  const copy = () =>
    navigator.clipboard?.writeText(text.replace(/\n$/, "")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-block-lang">{lang ?? "Code"}</span>
        <button className="code-block-copy" onClick={copy} aria-label="Copy code">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {highlighted ? (
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
  const [html, setHtml] = useState<{ code: string; dark: boolean; html: string } | null>(null);
  useEffect(() => {
    if (!language || !code.trim()) return;
    let live = true;
    const wait = setTimeout(() => {
      import("../monaco")
        .then((m) => m.colorize(code.replace(/\n$/, ""), language, dark))
        .then((h) => live && setHtml({ code, dark, html: h }), () => {});
    }, 150);
    return () => {
      live = false;
      clearTimeout(wait);
    };
  }, [code, language, dark]);
  return html && html.code === code && html.dark === dark ? html.html : null;
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

const components = { ...markdownComponents, pre: Pre, blockquote: Blockquote };
// For a line of text inside other text (a table cell, a card row): no paragraph around it.
const inlineComponents = { ...components, p: ({ children }: { children?: ReactNode }) => <>{children}</> };
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeCallouts];

/** Claude's markdown: GFM, file links, code block headers, plan step cards and callouts. */
export function Md({ children, inline = false }: { children: string; inline?: boolean }) {
  return (
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={inline ? inlineComponents : components}>
      {children}
    </Markdown>
  );
}
