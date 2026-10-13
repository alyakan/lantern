import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { ChangedFile } from "../store";
import type { DirEntry, FoundFile, TextResults } from "../types";
import { api } from "../api";
import { useSlot } from "../lib/slot";
import { relativeTo } from "../lib/diff";
import { pathBreaks } from "../lib/fileLinks";
import { discard, stashKey } from "../lib/editStash";
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
  /** A file was saved from the editor. */
  onSaved?: () => void;
}

type SearchMode = "files" | "text";

/** The open folder as a lazily loaded tree. A file opens in the editor; one that's changed has a button for its diff. */
export function FilesTab({ folder, ready, changed, refreshKey, onOpenChange, reveal = null, focusSearch = null, onSaved }: Props) {
  const slot = useSlot();
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLine, setPreviewLine] = useState<number | null>(null);
  // Counts the requests for a line, so the same line asked for again is still a request (see FilePreview).
  const [jump, setJump] = useState(0);
  const showLine = (line: number | null) => {
    setPreviewLine(line);
    setJump((n) => n + 1);
  };
  // Unsaved edits in the open file: leaving it (another file, back to the tree, the search) asks first.
  const [unsaved, setUnsaved] = useState(false);
  const unsavedRef = useRef(false);
  unsavedRef.current = unsaved;
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const leave = (go: () => void) => {
    const open = previewRef.current;
    if (!open || !unsavedRef.current) return go();
    void ask(`Discard your unsaved changes to ${relativeTo(open, folder)}?`, { title: "Unsaved changes", kind: "warning", okLabel: "Discard", cancelLabel: "Keep editing" }).then((sure) => {
      if (!sure) return;
      discard(stashKey(slot, open));
      go();
    });
  };
  useEffect(() => {
    if (!reveal) return;
    // The file that's open, at another line: no need to leave it.
    if (reveal.path === previewRef.current) return showLine(reveal.line);
    leave(() => {
      setPreview(reveal.path);
      showLine(reveal.line);
    });
  }, [reveal?.key]);

  const byPath = useMemo(() => new Map(changed.map((f) => [f.path, f])), [changed]);
  const open = (path: string) => (setPreview(path), setPreviewLine(null));

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
    let frame = 0;
    let gone = false;
    leave(() => {
      if (gone) return;
      setPreview(null);
      setMode(focusSearch.mode);
      // The tab may still be hidden for a frame or two (switching to Files happens after this); keep trying until the
      // box can take focus.
      let tries = 0;
      const focus = () => {
        const el = box.current;
        if (el && el.offsetParent !== null) {
          el.focus();
          el.select();
        } else if (tries++ < 20) frame = requestAnimationFrame(focus);
      };
      frame = requestAnimationFrame(focus);
    });
    return () => {
      gone = true;
      cancelAnimationFrame(frame);
    };
  }, [focusSearch?.key]);
  useEffect(() => {
    const q = query.trim();
    if (mode !== "text" || !q || !ready) return setText({ results: null, error: null });
    let live = true;
    // The last query's matches don't stand for this one: they go until these come back.
    setText({ results: null, error: null });
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
    setFound(null);
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
      (entries) => {
        setChildren((c) => ({ ...c, [dir]: entries }));
        if (dir === folder) setError(null);
      },
      (e) => {
        if (dir === folder) setError(String(e));
        // A folder that has gone (removed outside Lantern) drops out, rather than keeping its old contents.
        else setChildren(({ [dir]: _gone, ...rest }) => rest);
      },
    );

  // A new folder starts from a collapsed tree. Leaving the open file for it asks about its unsaved edits; a new chat
  // keeps them (editStash), as switching chats always has.
  const chat = useRef(slot);
  useEffect(() => {
    const sameChat = chat.current === slot;
    chat.current = slot;
    setChildren({});
    setExpanded(new Set());
    setError(null);
    if (sameChat) leave(() => setPreview(null));
    else setPreview(null);
  }, [folder, slot]);

  // Reload after each edit so files Claude creates show up: every folder read so far, open or not, since a collapsed
  // one's contents are shown again as soon as it's expanded.
  useEffect(() => {
    if (!folder || !ready) return;
    load(folder);
    Object.keys(children).forEach((dir) => dir !== folder && dir.startsWith(folder + "/") && load(dir));
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
        <div className="review-bar files-bar">
          <button className="icon" aria-label="Back to files" title="Back to files" onClick={() => leave(() => setPreview(null))}>
            ‹
          </button>
          <span className="preview-path" title={preview}>
            {pathBreaks(relativeTo(preview, folder))}
          </span>
          {unsaved && <span className="tag unsaved">● unsaved</span>}
          <div className="spacer" />
          {byPath.has(preview) && (
            <button className="ghost" title="See what changed in this file" onClick={() => onOpenChange(preview)}>
              View diff
            </button>
          )}
        </div>
        <Suspense fallback={<div className="empty">Loading…</div>}>
          <FilePreview key={`${slot}:${preview}`} path={preview} line={previewLine} jump={jump} refreshKey={refreshKey} onDirty={setUnsaved} onSaved={onSaved} />
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
              <TextFile key={f.path} file={f} changed={byPath.has(f.path)} onOpen={(line) => (setPreview(f.path), showLine(line))} />
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
