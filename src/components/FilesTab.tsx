import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { ChangedFile } from "../store";
import type { DirEntry, FoundFile, TextResults } from "../types";
import { api } from "../api";
import { useSlot } from "../lib/slot";
import { relativeTo } from "../lib/diff";
import { Counts } from "./EditLine";
import { DocIcon, FolderIcon, FolderOpenIcon } from "./icons";

const FilePreview = lazy(() => import("./FilePreview"));

interface Props {
  folder: string | null;
  ready: boolean;
  changed: ChangedFile[];
  refreshKey: number;
  onOpenChange: (path: string) => void;
  /** Open this file's preview (at a line); `key` changes for every request. */
  reveal?: { path: string; line: number | null; key: number } | null;
  /** Focus the search box, for file names (⌘P) or text (⌘⇧F); `key` changes for every request. */
  focusSearch?: { mode: SearchMode; key: number } | null;
}

type SearchMode = "files" | "text";

/** The open folder as a lazily loaded tree. Changed files open in the Changes tab; others open a read-only preview. */
export function FilesTab({ folder, ready, changed, refreshKey, onOpenChange, reveal = null, focusSearch = null }: Props) {
  const slot = useSlot();
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLine, setPreviewLine] = useState<number | null>(null);
  useEffect(() => {
    if (!reveal) return;
    setPreview(reveal.path);
    setPreviewLine(reveal.line);
  }, [reveal?.key]);

  const byPath = useMemo(() => new Map(changed.map((f) => [f.path, f])), [changed]);
  const open = (path: string) => (byPath.has(path) ? onOpenChange(path) : (setPreview(path), setPreviewLine(null)));

  // Search: file names, or text inside the files. While it has text, results replace the tree.
  const [mode, setMode] = useState<SearchMode>("files");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<FoundFile[] | null>(null);
  const [pick, setPick] = useState(0);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [text, setText] = useState<{ results: TextResults | null; error: string | null }>({ results: null, error: null });
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSearch === null) return;
    setPreview(null);
    setMode(focusSearch.mode);
    // The tab may still be hidden for a frame or two (switching to Files happens after this); keep trying until the
    // box can take focus.
    let tries = 0;
    let frame = 0;
    const focus = () => {
      const el = box.current;
      if (el && el.offsetParent !== null) {
        el.focus();
        el.select();
      } else if (tries++ < 20) frame = requestAnimationFrame(focus);
    };
    frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [focusSearch?.key]);
  useEffect(() => {
    const q = query.trim();
    if (mode !== "text" || !q || !ready) return setText({ results: null, error: null });
    let live = true;
    setText((t) => ({ ...t, error: null }));
    // Reading every file takes a moment, so wait for a pause in typing; a newer search cancels this one.
    const wait = setTimeout(() => {
      api.searchText(slot, { pattern: query, case_sensitive: caseSensitive, whole_word: wholeWord, regex }).then(
        (results) => live && setText({ results, error: null }),
        (e) => live && String(e) !== "cancelled" && setText({ results: null, error: String(e) }),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(wait);
    };
  }, [mode, query, caseSensitive, wholeWord, regex, ready, slot]);
  useEffect(() => {
    const q = query.trim();
    if (mode !== "files" || !q || !ready) return setFound(null);
    let live = true;
    // A short pause between keystrokes before asking; the backend keeps the file list, so each search is quick.
    const wait = setTimeout(() => {
      api.findFiles(slot, q).then(
        (f) => {
          if (!live) return;
          setFound(f);
          setPick(0);
        },
        () => live && setFound([]),
      );
    }, 60);
    return () => {
      live = false;
      clearTimeout(wait);
    };
  }, [mode, query, ready, slot]);
  // A new folder starts without a search.
  useEffect(() => setQuery(""), [folder, slot]);

  const load = (dir: string) =>
    api.listDir(slot, dir).then(
      (entries) => setChildren((c) => ({ ...c, [dir]: entries })),
      (e) => dir === folder && setError(String(e)),
    );

  // A new folder starts from a collapsed tree.
  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
    setPreview(null);
    setError(null);
  }, [folder, slot]);

  // Reload whatever is visible after each edit so files Claude creates show up.
  useEffect(() => {
    if (!folder || !ready) return;
    load(folder);
    expanded.forEach((dir) => dir.startsWith(folder + "/") && load(dir));
  }, [folder, ready, refreshKey, slot]);

  const toggle = (dir: string) => {
    const next = new Set(expanded);
    if (next.has(dir)) next.delete(dir);
    else {
      next.add(dir);
      if (!children[dir]) load(dir);
    }
    setExpanded(next);
  };

  if (!folder) return <div className="empty">Open a folder to browse its files</div>;

  if (preview) {
    return (
      <>
        <div className="review-bar">
          <button className="icon" aria-label="Back to files" title="Back to files" onClick={() => setPreview(null)}>
            ‹
          </button>
          <span className="picker-path preview-path" title={preview}>
            {relativeTo(preview, folder)}
          </span>
          <span className="tag">read-only</span>
        </div>
        <Suspense fallback={<div className="empty">Loading…</div>}>
          <FilePreview key={`${preview}:${previewLine}`} path={preview} line={previewLine} />
        </Suspense>
      </>
    );
  }

  const search = (
    <div className="file-search">
      <input
        ref={box}
        className="menu-search"
        type="search"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder={mode === "files" ? "Search file names (⌘P)" : "Search in files (⌘⇧F)"}
        aria-label={mode === "files" ? "Search files" : "Search in files"}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (mode === "text") {
            if (e.key === "Escape") {
              setQuery("");
              e.preventDefault();
            }
            return;
          }
          const n = found?.length ?? 0;
          if (e.key === "ArrowDown" && n) setPick((pick + 1) % n);
          else if (e.key === "ArrowUp" && n) setPick((pick - 1 + n) % n);
          else if (e.key === "Enter" && found?.[pick]) open(found[pick].path);
          else if (e.key === "Escape") setQuery("");
          else return;
          e.preventDefault();
        }}
      />
      {mode === "text" && (
        <div className="search-options">
          <SearchToggle label="Aa" title="Match case" on={caseSensitive} set={setCaseSensitive} />
          <SearchToggle label="ab" title="Whole word" on={wholeWord} set={setWholeWord} underline />
          <SearchToggle label=".*" title="Regular expression" on={regex} set={setRegex} />
        </div>
      )}
      <div className="scope-track search-mode" role="radiogroup" aria-label="Search">
        {(["files", "text"] as const).map((m) => (
          <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "active" : ""} title={m === "files" ? "Search file names (⌘P)" : "Search inside files (⌘⇧F)"} onClick={() => setMode(m)}>
            {m === "files" ? "Files" : "Text"}
          </button>
        ))}
      </div>
    </div>
  );

  if (query.trim() && mode === "text") {
    const r = text.results;
    const lines = r ? r.files.reduce((n, f) => n + f.lines.length + f.more, 0) : 0;
    return (
      <>
        {search}
        {text.error ? (
          <div className="empty">{text.error}</div>
        ) : !r ? (
          <div className="empty">Searching…</div>
        ) : r.files.length === 0 ? (
          <div className="empty">Nothing matches “{query}”</div>
        ) : (
          <div className="text-results">
            <div className="text-results-count">
              {lines} {lines === 1 ? "match" : "matches"} in {r.files.length} {r.files.length === 1 ? "file" : "files"}
              {r.truncated && " (stopped there; narrow the search to see the rest)"}
            </div>
            {r.files.map((f) => (
              <TextFile key={f.path} file={f} changed={byPath.has(f.path)} onOpen={(line) => (setPreview(f.path), setPreviewLine(line))} />
            ))}
          </div>
        )}
      </>
    );
  }

  if (query.trim()) {
    return (
      <>
        {search}
        {found === null ? (
          <div className="empty">Searching…</div>
        ) : found.length === 0 ? (
          <div className="empty">No files match “{query.trim()}”</div>
        ) : (
          <ul className="tree file-results" role="listbox" aria-label="Matching files">
            {found.map((f, i) => {
              const change = byPath.get(f.path);
              const slash = f.rel.lastIndexOf("/");
              return (
                <li key={f.path} role="option" aria-selected={i === pick}>
                  <button className={`tree-row result${i === pick ? " picked" : ""}${change ? " changed" : ""}`} title={f.rel} onMouseEnter={() => setPick(i)} onClick={() => open(f.path)}>
                    <span className="tree-icon">
                      <DocIcon />
                    </span>
                    <span className="tree-name">
                      <Marked text={f.rel.slice(slash + 1)} hits={f.hits} from={slash + 1} />
                    </span>
                    {slash > 0 && (
                      <span className="result-dir">
                        <Marked text={f.rel.slice(0, slash)} hits={f.hits} from={0} />
                      </span>
                    )}
                    {change?.created && <span className="tag">new</span>}
                    {change && <Counts added={change.added} removed={change.removed} />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </>
    );
  }

  if (error) return <div className="empty">{error}</div>;
  const root = children[folder];
  if (!root) return <div className="empty">Loading…</div>;

  const hasChanges = (dir: string) => changed.some((f) => f.path.startsWith(dir + "/"));

  // Nested lists, so a folder's contents can slide open: once loaded, they stay mounted and collapse to zero height.
  const rows = (entries: DirEntry[], depth: number): ReactElement[] =>
    entries.map((e) => {
      const indent = { paddingLeft: 8 + depth * 14 };
      if (e.dir) {
        const open = expanded.has(e.path);
        const kids = children[e.path];
        return (
          <li key={e.path} role="treeitem" aria-expanded={open}>
            <button className="tree-row" style={indent} aria-expanded={open} onClick={() => toggle(e.path)}>
              <span className="chev" aria-hidden />
              <span className="tree-icon">{open ? <FolderOpenIcon /> : <FolderIcon />}</span>
              <span className="tree-name">{e.name}</span>
              {!open && hasChanges(e.path) && <span className="tree-dot" aria-label="Contains changes" />}
            </button>
            {kids && (
              <div className={`tree-group${open ? " open" : ""}`} inert={!open}>
                <ul role="group">{rows(kids, depth + 1)}</ul>
              </div>
            )}
          </li>
        );
      }
      const change = byPath.get(e.path);
      return (
        <li key={e.path} role="treeitem">
          <button className={change ? "tree-row changed" : "tree-row"} style={indent} onClick={() => open(e.path)}>
            <span className="chev-space" aria-hidden />
            <span className="tree-icon">
              <DocIcon />
            </span>
            <span className="tree-name">{e.name}</span>
            {change?.created && <span className="tag">new</span>}
            {change && <Counts added={change.added} removed={change.removed} />}
          </button>
        </li>
      );
    });

  return (
    <>
      {search}
      <ul className="tree" role="tree" aria-label="Files">
        {root.length ? rows(root, 0) : <li className="empty">This folder is empty</li>}
      </ul>
    </>
  );
}

/** `text` with the characters the search matched (positions in the whole path, `text` starting at `from`) marked. */
function Marked({ text, hits, from }: { text: string; hits: number[]; from: number }) {
  const at = new Set(hits.map((h) => h - from));
  const chars = [...text];
  return (
    <>
      {chars.map((c, i) =>
        at.has(i) ? (
          <mark key={i} className="hit">
            {c}
          </mark>
        ) : (
          c
        ),
      )}
    </>
  );
}

function SearchToggle({ label, title, on, set, underline }: { label: string; title: string; on: boolean; set: (on: boolean) => void; underline?: boolean }) {
  return (
    <button className={`search-toggle${on ? " on" : ""}${underline ? " underline" : ""}`} aria-pressed={on} aria-label={title} title={title} onClick={() => set(!on)}>
      {label}
    </button>
  );
}

// One file's matches: its name, then each matching line with its number; a line opens the file there.
function TextFile({ file, changed, onOpen }: { file: TextResults["files"][number]; changed: boolean; onOpen: (line: number) => void }) {
  const [open, setOpen] = useState(true);
  const slash = file.rel.lastIndexOf("/");
  return (
    <div className="text-file">
      <button className={`tree-row text-file-head${changed ? " changed" : ""}`} aria-expanded={open} title={file.rel} onClick={() => setOpen(!open)}>
        <span className="chev" aria-hidden />
        <span className="tree-icon">
          <DocIcon />
        </span>
        <span className="tree-name">{file.rel.slice(slash + 1)}</span>
        {slash > 0 && <span className="result-dir">{file.rel.slice(0, slash)}</span>}
        <span className="text-file-count">{file.lines.length + file.more}</span>
      </button>
      {open && (
        <ul className="text-lines">
          {file.lines.map((l) => (
            <li key={l.line}>
              <button className="text-line" title={`Line ${l.line}`} onClick={() => onOpen(l.line)}>
                <span className="text-line-number">{l.line}</span>
                <span className="text-line-text">
                  {l.pieces.map((p, i) =>
                    p.hit ? (
                      <mark key={i} className="text-hit">
                        {p.text}
                      </mark>
                    ) : (
                      <span key={i}>{i === 0 ? p.text.trimStart() : p.text}</span>
                    ),
                  )}
                </span>
              </button>
            </li>
          ))}
          {file.more > 0 && <li className="text-more">{file.more} more in this file</li>}
        </ul>
      )}
    </div>
  );
}
