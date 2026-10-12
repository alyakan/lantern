import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
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

/**
 * What's known about one chat's folder. A switch to another chat or folder makes a new one, so a lookup still in flight
 * for the old one (or its pending batch) writes into a map nothing reads any more.
 */
interface Lookups {
  known: Map<string, string | null>;
  queued: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

/** `epoch`: bump it when files may have appeared (a turn ended), so mentions that weren't files are asked again. */
export function FileLinksProvider({ slot, folder, epoch, onOpen, children }: { slot: string; folder: string | null; epoch: number; onOpen: (path: string, line: number | null) => void; children: ReactNode }) {
  const lookups = useMemo<Lookups>(() => ({ known: new Map(), queued: new Set(), timer: null }), [slot, folder]);
  // The lookups on screen now: results for any other set are dropped.
  const shown = useRef(lookups);
  shown.current = lookups;
  const [version, setVersion] = useState(0);
  const latestOpen = useRef(onOpen);
  latestOpen.current = onOpen;

  useEffect(() => {
    for (const [m, p] of lookups.known) if (p === null) lookups.known.delete(m);
    setVersion((v) => v + 1);
  }, [epoch, lookups]);

  const value = useMemo<FileLinks>(() => {
    const flush = () => {
      lookups.timer = null;
      const batch = [...lookups.queued];
      lookups.queued.clear();
      if (!batch.length || !folder || shown.current !== lookups) return;
      api.resolveFiles(slot, batch).then(
        (paths) => {
          if (shown.current !== lookups) return;
          batch.forEach((m, i) => lookups.known.set(m, paths[i] ?? null));
          setVersion((v) => v + 1);
        },
        () => {
          if (shown.current === lookups) batch.forEach((m) => lookups.known.set(m, null));
        },
      );
    };
    return {
      resolve: (mention) => {
        if (lookups.known.has(mention)) return lookups.known.get(mention);
        if (!folder) return null;
        lookups.queued.add(mention);
        lookups.timer ??= setTimeout(flush, 40);
        return undefined;
      },
      open: (path, line) => latestOpen.current(path, line),
    };
  }, [lookups, slot, folder, version]);

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

/** A link's address decoded for a path; a bad escape (`a%E9.md`) is left as it is, so drawing the message doesn't throw. */
function decodedPath(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

/** A markdown link to a file in the folder opens it; web links open in the browser. */
export function FileAwareLink(props: ComponentProps<"a"> & { node?: unknown }) {
  const links = useContext(Ctx);
  const href = props.href ?? "";
  const mention = links && !/^[a-z][\w+.-]*:/i.test(href) ? splitMention(decodedPath(href.replace(/#L?(\d+).*$/, ":$1"))) : null;
  const path = mention ? links!.resolve(mention.path) : null;
  if (!mention || !path) return <ExternalLink {...props} />;
  return (
    <FileButton path={path} line={mention.line}>
      {props.children}
    </FileButton>
  );
}

/** A path that may break after each folder, so a long one wraps at a slash instead of running out of its box. */
export const pathBreaks = (path: string) =>
  path.split("/").map((part, i, all) => (
    <Fragment key={i}>
      {part}
      {i < all.length - 1 && "/"}
      <wbr />
    </Fragment>
  ));

/** The markdown components for Claude's text. */
export const markdownComponents = { a: FileAwareLink, code: FileCode };
