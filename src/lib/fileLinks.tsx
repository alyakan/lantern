import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { api } from "../api";
import { ExternalLink } from "../components/ExternalLink";

/**
 * File mentions in Claude's text (`src/a.ts`, `src/a.ts:42`, `AppDelegate.swift`) become links that open the file in
 * the right pane. Whether a mention is a file is up to the backend, which looks it up in the folder's file list;
 * the answers are asked for in batches and kept.
 */

/** A path with an extension (starting with a letter), and maybe `:line` or `:line:col` / `:start-end`. */
const MENTION = /^(?:\.{1,2}\/|\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z][\w]{0,9}(?::(\d+)(?:[-:]\d+)?)?$/;

export function splitMention(text: string): { path: string; line: number | null } | null {
  const t = text.trim();
  const m = MENTION.exec(t);
  if (!m) return null;
  return { path: m[1] ? t.slice(0, t.indexOf(":")) : t, line: m[1] ? Number(m[1]) : null };
}

interface FileLinks {
  /** The file a mention means: a path, null if it's not a file, undefined while it's being looked up. */
  resolve: (mention: string) => string | null | undefined;
  open: (path: string, line: number | null) => void;
}

const Ctx = createContext<FileLinks | null>(null);

/** `epoch`: bump it when files may have appeared (a turn ended), so mentions that weren't files are asked again. */
export function FileLinksProvider({ slot, folder, epoch, onOpen, children }: { slot: string; folder: string | null; epoch: number; onOpen: (path: string, line: number | null) => void; children: ReactNode }) {
  const known = useRef(new Map<string, string | null>());
  const queued = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [version, setVersion] = useState(0);
  const latestOpen = useRef(onOpen);
  latestOpen.current = onOpen;

  useEffect(() => {
    known.current = new Map();
    setVersion((v) => v + 1);
  }, [slot, folder]);
  useEffect(() => {
    for (const [m, p] of known.current) if (p === null) known.current.delete(m);
    setVersion((v) => v + 1);
  }, [epoch]);

  const value = useMemo<FileLinks>(() => {
    const flush = () => {
      timer.current = null;
      const batch = [...queued.current];
      queued.current.clear();
      if (!batch.length || !folder) return;
      api.resolveFiles(slot, batch).then(
        (paths) => {
          batch.forEach((m, i) => known.current.set(m, paths[i] ?? null));
          setVersion((v) => v + 1);
        },
        () => batch.forEach((m) => known.current.set(m, null)),
      );
    };
    return {
      resolve: (mention) => {
        if (known.current.has(mention)) return known.current.get(mention);
        if (!folder) return null;
        queued.current.add(mention);
        timer.current ??= setTimeout(flush, 40);
        return undefined;
      },
      open: (path, line) => latestOpen.current(path, line),
    };
  }, [slot, folder, version]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Resolving and opening files mentioned in Claude's text; null outside a provider. */
export const useFileLinks = () => useContext(Ctx);

function FileButton({ path, line, children }: { path: string; line: number | null; children: ReactNode }) {
  const links = useContext(Ctx)!;
  return (
    <button className="file-link" title={`Open ${path}${line ? ` at line ${line}` : ""}`} onClick={() => links.open(path, line)}>
      {children}
    </button>
  );
}

/** Inline code that names a file in the folder is a link to it; anything else stays code. */
export function FileCode({ className, children, node: _node, ...rest }: ComponentProps<"code"> & { node?: unknown }) {
  const links = useContext(Ctx);
  const text = typeof children === "string" ? children : Array.isArray(children) && children.every((c) => typeof c === "string") ? children.join("") : null;
  const mention = links && !className && text && !text.includes("\n") ? splitMention(text) : null;
  const path = mention ? links!.resolve(mention.path) : null;
  const code = (
    <code className={className} {...rest}>
      {children}
    </code>
  );
  if (!mention || !path) return code;
  return (
    <FileButton path={path} line={mention.line}>
      {code}
    </FileButton>
  );
}

/** A markdown link to a file in the folder opens it; web links open in the browser. */
export function FileAwareLink(props: ComponentProps<"a"> & { node?: unknown }) {
  const links = useContext(Ctx);
  const href = props.href ?? "";
  const mention = links && !/^[a-z][\w+.-]*:/i.test(href) ? splitMention(decodeURI(href.replace(/#L?(\d+).*$/, ":$1"))) : null;
  const path = mention ? links!.resolve(mention.path) : null;
  if (!mention || !path) return <ExternalLink {...props} />;
  return (
    <FileButton path={path} line={mention.line}>
      {props.children}
    </FileButton>
  );
}

/** The markdown components for Claude's text. */
export const markdownComponents = { a: FileAwareLink, code: FileCode };
