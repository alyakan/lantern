import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import type { FolderSessions, OldLocation, RelocateOptions, RelocateOutcome, RelocationPreview } from "../types";
import { basename } from "../lib/diff";
import { middleTruncate, tildePath } from "../lib/paths";
import { relativeTime } from "../lib/time";

interface Props {
  /** The project the sessions go to: the folder open in the chat, or where a moved folder probably is. Null: not chosen yet. */
  destination: string | null;
  /** Where a "Moved?" entry's folder was, when its new place wasn't known: it's offered as a place once the project is chosen. */
  from?: string | null;
  /** The native folder picker; null when cancelled. */
  pickFolder: () => Promise<string | null>;
  onClose: () => void;
  /** One place's sessions were brought over: the app carries that folder's saved state along. The dialog stays open. */
  onRelocated: (old: string, next: string, outcome: RelocateOutcome) => void;
  /** Opens the session History. Offered once the sessions are in it, when the project is the one open in the chat. */
  onOpenHistory?: () => void;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A place from the known folders, as a row of this dialog. */
const rowOf = (f: FolderSessions): OldLocation => ({ path: f.path, exists: f.exists, sessions: f.sessions, updated_ms: f.updated_ms, already: false });

/**
 * Brings the sessions that were started in a project's earlier locations (folders with the same name, or places it was
 * brought over from already) into the project. Each checked place is copied in turn; nothing is deleted, and the old
 * session files stay where they are.
 */
export function BringOldSessionsDialog({ destination, from = null, pickFolder, onClose, onRelocated, onOpenHistory }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const choiceGroup = useId();
  const chooseRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [dest, setDest] = useState(destination);
  const [locations, setLocations] = useState<OldLocation[] | null>(null);
  const [known, setKnown] = useState<FolderSessions[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  // The places the user unchecked. Every other place with sessions is checked.
  const [unchecked, setUnchecked] = useState<string[]>([]);
  const [previews, setPreviews] = useState<Record<string, RelocationPreview>>({});
  const [options, setOptions] = useState<RelocateOptions>({ project_settings: true, memory: true });
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [broughtSessions, setBroughtSessions] = useState(0);
  // The places whose preview was asked for, for the project they were asked about.
  const asked = useRef(new Set<string>());

  useEffect(() => {
    const el = ref.current;
    if (!el || el.open) return;
    // jsdom has no showModal: there, the attribute alone opens it.
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
  }, []);

  // A project starts from nothing: its places, choices and previews are its own.
  useEffect(() => {
    setLocations(null);
    setKnown(null);
    setError(null);
    setPicked(null);
    setUnchecked([]);
    setFailures({});
    setPhase("idle");
    setBroughtSessions(0);
    setPreviews({});
    asked.current = new Set();
    if (!dest) return;
    let live = true;
    api.oldLocations(dest).then(
      (found) => live && setLocations(found),
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [dest]);

  // The folders to pick from: when nothing was found under the name, and when a "Moved?" place isn't among what was found.
  const loaded = locations !== null;
  const detected = locations ?? [];
  const needKnown = loaded && (detected.length === 0 || (!!from && !detected.some((l) => l.path === from)));
  // Ready once the places and, when they're needed, the folders to pick from are in.
  const ready = loaded && (!needKnown || known !== null);
  useEffect(() => {
    if (!needKnown || known) return;
    let live = true;
    api.knownFolders().then(
      (all) => live && setKnown(all),
      () => live && setKnown([]),
    );
    return () => {
      live = false;
    };
  }, [needKnown, known]);

  const seeded = from && known && !detected.some((l) => l.path === from) ? known.find((f) => f.path === from) : undefined;
  const chosen = picked && known ? known.find((f) => f.path === picked) : undefined;
  const rows: OldLocation[] = [...detected];
  for (const f of [seeded, chosen]) {
    if (f && !rows.some((r) => r.path === f.path)) rows.push(rowOf(f));
  }
  const isChecked = (row: OldLocation) => !row.already && !unchecked.includes(row.path);
  const bringing = rows.filter(isChecked);
  const total = bringing.reduce((n, r) => n + r.sessions, 0);
  const busy = phase === "running";
  const nothingFound = ready && detected.length === 0 && !seeded;
  const heading = detected.length > 0 || seeded ? `Lantern found chats from earlier locations of "${basename(dest ?? "")}":` : "Chats from the place you chose:";

  // What each checked place would bring besides its sessions, read only, for the Details. Asked once per place.
  const pathsKey = rows
    .filter((r) => !r.already)
    .map((r) => r.path)
    .join("\n");
  useEffect(() => {
    if (!dest || !pathsKey) return;
    for (const path of pathsKey.split("\n")) {
      if (asked.current.has(path)) continue;
      asked.current.add(path);
      api.relocationPreview(path, dest).then(
        (found) => setPreviews((all) => ({ ...all, [path]: found })),
        () => {},
      );
    }
  }, [dest, pathsKey]);
  const checkedPreviews = bringing.map((r) => previews[r.path]).filter((p): p is RelocationPreview => !!p);
  const previewsReady = bringing.length > 0 && checkedPreviews.length === bringing.length;
  const settingsFound = checkedPreviews.some((p) => p.project_entry || p.rules > 0);
  const memoryFound = checkedPreviews.some((p) => p.memory_files > 0);

  useEffect(() => {
    if (!dest) chooseRef.current?.focus();
    else if (phase === "done") primaryRef.current?.focus();
    else if (ready) (nothingFound ? filterRef : primaryRef).current?.focus();
    // Focus goes to the next thing to do when the project or the list it shows changes, not on every render.
  }, [dest, ready, phase]);

  const choose = () => pickFolder().then((picked) => picked && setDest(picked));

  const loadLocations = (folder: string) =>
    api.oldLocations(folder).then(
      (found) => setLocations(found),
      () => {},
    );

  // The checked places, one after another. A place that fails is listed with why; the others are kept, and the next
  // press brings just the ones that failed.
  const bring = async () => {
    if (!dest || busy || total === 0) return;
    setPhase("running");
    setFailures({});
    const failed: Record<string, string> = {};
    let done = 0;
    for (const row of bringing) {
      try {
        const outcome = await api.relocateFolder(row.path, dest, options);
        onRelocated(row.path, dest, outcome);
        done += row.sessions;
      } catch (e) {
        failed[row.path] = String(e);
      }
    }
    setBroughtSessions((n) => n + done);
    setFailures(failed);
    setPhase(Object.keys(failed).length === 0 ? "done" : "idle");
    void loadLocations(dest);
  };

  const toggle = (path: string) => setUnchecked((all) => (all.includes(path) ? all.filter((p) => p !== path) : [...all, path]));
  const matches = (known ?? []).filter((f) => f.path !== dest && f.path.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <dialog
      ref={ref}
      className="revert-dialog bring-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        className="revert-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (phase === "done") return onOpenHistory ? onOpenHistory() : onClose();
          void bring();
        }}
      >
        <div className="revert-title" id={titleId}>
          {dest ? `Bring old chats into ${basename(dest)}` : "Bring old chats into a project"}
        </div>

        {!dest && (
          <>
            <p className="revert-text">Choose the project folder these chats belong to.</p>
            <div className="revert-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="primary" ref={chooseRef} onClick={choose}>
                Choose the project folder…
              </button>
            </div>
          </>
        )}

        {dest && (
          <>
            <div className="bring-dest">
              <span className="bring-dest-name">{basename(dest)}</span>
              <span className="menu-row-path" title={dest}>
                {middleTruncate(tildePath(dest))}
              </span>
            </div>

            {error && (
              <div className="revert-error" role="alert">
                {error}
              </div>
            )}
            {!error && !ready && <div className="menu-empty">Looking for chats…</div>}

            {ready && phase === "done" && (
              <p className="revert-text" role="status">
                Done: {count(broughtSessions, "chat is", "chats are")} in History now.
              </p>
            )}

            {ready && phase !== "done" && rows.length > 0 && (
              <>
                <p className="revert-text">{heading}</p>
                <ul className="menu-list bring-list" aria-label="Places with chats">
                  {rows.map((row) => (
                    <li key={row.path}>
                      <label className={`bring-row${row.already ? " done" : ""}`} title={row.path}>
                        <input type="checkbox" checked={isChecked(row)} disabled={row.already || busy} onChange={() => toggle(row.path)} />
                        <span className="bring-row-text">
                          <span className="bring-row-path">{middleTruncate(tildePath(row.path))}</span>
                          <span className="bring-row-meta">
                            {row.already ? `${count(row.sessions, "chat", "chats")}, already brought over` : `${count(row.sessions, "chat", "chats")}, ${relativeTime(row.updated_ms)}`}
                            {!row.exists && <span className="bring-gone">folder no longer exists</span>}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {ready && phase !== "done" && nothingFound && (
              <>
                <p className="revert-text">No old chats found under the name "{basename(dest)}".</p>
                <p className="bring-heading" id={`${choiceGroup}-heading`}>
                  Where was it before?
                </p>
                <input
                  ref={filterRef}
                  className="menu-search bring-filter"
                  aria-label="Filter folders"
                  placeholder="Type to filter the folders"
                  autoCapitalize="off"
                  autoCorrect="off"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter picks the first folder shown, rather than submitting the dialog.
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    if (matches[0]) setPicked(matches[0].path);
                  }}
                />
                {known === null ? (
                  <div className="menu-empty">Loading folders…</div>
                ) : matches.length === 0 ? (
                  <div className="menu-empty">{known.length <= 1 ? "No other folders have chats." : "No folder matches."}</div>
                ) : (
                  <ul className="menu-list bring-list" role="radiogroup" aria-labelledby={`${choiceGroup}-heading`}>
                    {matches.map((f) => (
                      <li key={f.path}>
                        <label className="bring-row" title={f.path}>
                          <input type="radio" name={choiceGroup} checked={picked === f.path} onChange={() => setPicked(f.path)} />
                          <span className="bring-row-text">
                            <span className="bring-row-path">{middleTruncate(tildePath(f.path))}</span>
                            <span className="bring-row-meta">
                              {`${count(f.sessions, "chat", "chats")}, ${relativeTime(f.updated_ms)}`}
                              {!f.exists && <span className="bring-gone">folder no longer exists</span>}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {ready && phase !== "done" && (
              <>
                <p className="revert-text">Your old chats stay where they are: Lantern copies what's needed.</p>
                <details className="bring-details">
                  <summary>Details</summary>
                  <label className="bring-option">
                    <input type="checkbox" checked={options.project_settings} disabled={busy} onChange={(e) => setOptions({ ...options, project_settings: e.target.checked })} />
                    <span>
                      Also bring this project's MCP servers and permissions, including your "Always allow" choices (Claude Code keeps these per folder)
                      {previewsReady && !settingsFound && <span className="bring-none"> none found</span>}
                    </span>
                  </label>
                  <label className="bring-option">
                    <input type="checkbox" checked={options.memory} disabled={busy} onChange={(e) => setOptions({ ...options, memory: e.target.checked })} />
                    <span>
                      Also bring its memory (notes Claude saved about this project)
                      {previewsReady && !memoryFound && <span className="bring-none"> none found</span>}
                    </span>
                  </label>
                </details>
              </>
            )}

            {Object.keys(failures).length > 0 && (
              <div className="revert-error" role="alert">
                <div>Some chats weren't brought over:</div>
                <ul className="bring-failures">
                  {Object.entries(failures).map(([path, reason]) => (
                    <li key={path} title={path}>
                      {middleTruncate(tildePath(path))}: {reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {dest && (
          <div className="revert-actions">
            {phase === "done" ? (
              <>
                <button type="button" onClick={onClose} className={onOpenHistory ? undefined : "primary"} ref={onOpenHistory ? undefined : primaryRef}>
                  Close
                </button>
                {onOpenHistory && (
                  <button type="submit" className="primary" ref={primaryRef}>
                    Open History
                  </button>
                )}
              </>
            ) : (
              <>
                <button type="button" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button type="submit" className="primary" ref={primaryRef} disabled={!ready || total === 0 || busy}>
                  {busy ? "Bringing chats…" : `Bring ${count(total, "chat", "chats")} here`}
                </button>
              </>
            )}
          </div>
        )}
      </form>
    </dialog>
  );
}
