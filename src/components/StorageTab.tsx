import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api } from "../api";
import { GROUPS, groupOf, idleText, isTicked, kindColour, outcomeText, rowWidth, segments, selection, shareText, sizeText, summaryText, type Segment } from "../lib/storage";
import { relativeTime } from "../lib/time";
import type { StorageItem, StorageKind, StorageView } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";
import { TabEmpty } from "./TabEmpty";

/** The Storage panel's data: loaded when the app opens and again whenever the backend says the scan moved on. */
export function useStorageView(): StorageView | null {
  const [view, setView] = useState<StorageView | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.storageState().then((v) => live && setView(v), () => {});
    load();
    // Outside the app (tests, a browser) there are no events to listen to.
    const unlisten = api.onStorageChanged(load).catch(() => null);
    return () => {
      live = false;
      unlisten.then((f) => f?.());
    };
  }, []);
  return view;
}

/** What Claude marked: how many suggestions the scan has, for the title bar button's badge. */
export const suggestedCount = (view: StorageView | null) => view?.items.filter((i) => i.suggestion !== null).length ?? 0;

/** The message that sends Claude to scan and suggest. */
export const FREE_UP_SPACE_REQUEST = "Free up disk space: scan this Mac with the storage tools, then mark what is safe to delete (storage_suggest) with a short reason each. I'll review it in the Storage panel (the disk button in the title bar) and delete from there.";

const SHOWN = 40;

interface Props {
  view: StorageView | null;
  /** Asks Claude, in this chat, to scan and suggest; null when there's no chat to ask. */
  onAsk: (() => void) | null;
  /** Claude is in the middle of a turn in this chat: a request sent meanwhile waits until it ends. */
  busy?: boolean;
}

export function StorageTab({ view, onAsk, busy = false }: Props) {
  // What the user ticked or unticked, by item id: it beats what the scan or Claude ticked, and outlives a rescan.
  const [touched, setTouched] = useState<Map<string, boolean>>(new Map());
  const [open, setOpen] = useState<Set<StorageKind>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<ReturnType<typeof outcomeText> | null>(null);
  // The kind the pointer or keyboard is on in the bar or its legend: it stands out, and the readout names it.
  const [hot, setHot] = useState<StorageKind | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const parts = useMemo(() => segments(view?.items ?? []), [view]);
  const biggest = useMemo(() => Math.max(0, ...(view?.items ?? []).map((i) => i.bytes)), [view]);
  const items = useMemo(() => view?.items ?? [], [view]);
  const sel = useMemo(() => selection(items, touched), [items, touched]);
  const total = useMemo(() => GROUPS.reduce((n, g) => n + groupOf(items, g.kind).bytes, 0), [items]);
  const working = deleting || !!view?.deleting;
  // What the confirmation names: ticked items that need a judgement (review risk) or that only Claude's suggestion ticked.
  const look = useMemo(() => {
    const ticked = new Set(sel.ids);
    return items.filter((i) => ticked.has(i.id) && (i.risk === "review" || (i.suggestion !== null && !i.ticked)));
  }, [items, sel]);

  if (!view) return <TabEmpty title="Storage">Looking at the disk…</TabEmpty>;
  const goTo = (kind: StorageKind) => body.current?.querySelector(`[data-kind="${kind}"]`)?.scrollIntoView?.({ behavior: "smooth", block: "start" });

  const set = (ids: string[], on: boolean) => setTouched((t) => new Map([...t, ...ids.map((id) => [id, on] as const)]));
  const scan = () => {
    setResult(null);
    api.storageScan().catch(() => {});
  };
  const doDelete = () => {
    setDeleting(true);
    api
      .storageDelete(sel.ids)
      .then((out) => setResult(outcomeText(out, items)))
      .catch((e) => setResult({ text: String(e), failures: [] }))
      .finally(() => {
        setDeleting(false);
        setConfirming(false);
      });
  };
  const suggested = suggestedCount(view);
  const onlyClaudes = () => setTouched(new Map(items.map((i) => [i.id, i.suggestion !== null] as const)));

  if (view.scanned_at === null && !view.scanning) {
    return (
      <TabEmpty title="Storage">
        <p>
          {view.free_bytes !== null ? `${sizeText(view.free_bytes)} free. ` : ""}
          Scan this Mac for what can be cleared to get space back: git worktrees, stale projects, build output, caches, simulators and the Trash. Nothing is deleted until you tick it and press Delete.
        </p>
        <p>
          <button className="primary" onClick={scan}>
            Scan this Mac
          </button>{" "}
          {onAsk && (
            <button onClick={onAsk} disabled={busy} title={busy ? "Claude is working: this is sent when it's done" : undefined}>
              Ask Claude to scan and suggest
            </button>
          )}
        </p>
      </TabEmpty>
    );
  }

  return (
    <>
      <div className="review-bar storage-bar">
        <span className="storage-free" title="Free space on this Mac's disk">
          {view.free_bytes !== null ? `${sizeText(view.free_bytes)} free` : "Free space unknown"}
        </span>
        <span className="storage-status" role="status">
          {view.scanning ? view.progress || "Scanning…" : view.scanned_at !== null ? `Scanned ${relativeTime(view.scanned_at)}` : ""}
        </span>
        <div className="spacer" />
        {onAsk && (
          <button className="ghost" onClick={onAsk} disabled={busy || view.scanning} title="Claude scans, then ticks what it thinks is safe and says why">
            Ask Claude
          </button>
        )}
        {suggested > 0 && (
          <button className="ghost" onClick={onlyClaudes} title="Tick only what Claude suggested">
            Claude's picks ({suggested})
          </button>
        )}
        {view.scanning ? (
          <button className="ghost" onClick={() => api.storageCancel()}>
            Stop
          </button>
        ) : (
          <button className="ghost" onClick={scan} disabled={working}>
            Rescan
          </button>
        )}
      </div>
      {(view.snapshots > 0 || view.notes.length > 0) && (
        <div className="storage-notes">
          {view.snapshots > 0 && <p>{view.snapshots === 1 ? "A local Time Machine snapshot exists" : `${view.snapshots} local Time Machine snapshots exist`}: macOS keeps what they hold until it needs the room, so free space can lag behind what you delete.</p>}
          {view.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
      {result && (
        <div className="storage-result" role="status">
          <p>{result.text}</p>
          {result.failures.map((f) => (
            <p key={f.name} className="storage-failure">
              {f.name}: {f.error}
            </p>
          ))}
        </div>
      )}
      {parts.length > 0 && <Distribution parts={parts} hot={hot} onHot={setHot} onPick={goTo} />}
      <div className="storage-body" ref={body}>
        {items.length === 0 && !view.scanning && <div className="tests-note storage-empty">Nothing to clear was found.</div>}
        {GROUPS.map(({ kind, title, hint }) => {
          const g = groupOf(items, kind);
          if (g.items.length === 0) return null;
          const all = open.has(kind);
          const rows = all ? g.items : g.items.slice(0, SHOWN);
          const safe = g.items.filter((i) => i.risk === "safe").map((i) => i.id);
          return (
            <section key={kind} className={`storage-group${hot === kind ? " hot" : ""}`} aria-label={title} data-kind={kind} style={{ "--kind": kindColour(kind) } as CSSProperties}>
              <header className="storage-group-head">
                <span className="storage-swatch" aria-hidden />
                <span className="storage-group-title">{title}</span>
                <span className="storage-group-size">{sizeText(g.bytes)}</span>
                <span className="storage-group-hint" title={hint}>
                  {hint}
                </span>
                <button className="ghost" disabled={working} onClick={() => set(safe, true)} title="Tick every safe item in this group">
                  Tick safe
                </button>
                <button className="ghost" disabled={working} onClick={() => set(g.items.map((i) => i.id), false)}>
                  Clear
                </button>
              </header>
              <ul className="storage-list">
                {rows.map((item) => (
                  <Row key={item.id} item={item} biggest={biggest} ticked={isTicked(item, touched)} disabled={working} onTick={(on) => set([item.id], on)} />
                ))}
              </ul>
              {g.items.length > SHOWN && (
                <button className="ghost storage-more" onClick={() => setOpen((o) => new Set(all ? [...o].filter((k) => k !== kind) : [...o, kind]))}>
                  {all ? "Show fewer" : `Show all ${g.items.length}`}
                </button>
              )}
            </section>
          );
        })}
      </div>
      <div className="storage-actions">
        <span className="storage-selected" aria-live="polite">
          {summaryText(total, sel)}
          {sel.ids.length > 0 && ` · ${sel.ids.length} ticked`}
        </span>
        <div className="spacer" />
        <button className="danger" disabled={sel.ids.length === 0 || working || view.scanning} onClick={() => setConfirming(true)}>
          {working ? "Deleting…" : "Delete…"}
        </button>
      </div>
      {confirming && (
        <ConfirmDialog title={`Delete ${sel.ids.length} item${sel.ids.length === 1 ? "" : "s"}?`} confirmLabel="Delete" busyLabel="Deleting…" busy={deleting} onConfirm={doDelete} onCancel={() => setConfirming(false)}>
          <p>
            {sel.permanent > 0 && `${sel.permanent} will be deleted for good. `}
            {sel.toTrash > 0 && `${sel.toTrash} (${sizeText(sel.toTrashBytes)}) will be moved to the Trash, which frees nothing until you delete the Trash items too. `}
            Each one is checked again just before it goes: anything with unsaved work in it is left alone and listed here.
          </p>
          {look.length > 0 && (
            <>
              <p>Look at these first: you ticked them yourself or Claude suggested them, and they aren't plain regenerable files.</p>
              <ul className="storage-confirm-list">
                {look.slice(0, 8).map((i) => (
                  <li key={i.id}>
                    <strong>{i.name}</strong> ({sizeText(i.bytes)}): {i.suggestion ? `Claude: ${i.suggestion}` : i.warning}
                  </li>
                ))}
                {look.length > 8 && <li>and {look.length - 8} more</li>}
              </ul>
            </>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}

/** The whole scan as one bar split by kind, with its legend: hover or focus a kind to read it, press it to go to its list. */
function Distribution({ parts, hot, onHot, onPick }: { parts: Segment[]; hot: StorageKind | null; onHot: (kind: StorageKind | null) => void; onPick: (kind: StorageKind) => void }) {
  const text = (p: Segment) => `${p.title}: ${sizeText(p.bytes)} (${shareText(p.share)})`;
  const readout = parts.find((p) => p.kind === hot);
  return (
    <div className="storage-chart" onPointerLeave={() => onHot(null)}>
      <div className="storage-stack" role="img" aria-label={`Storage by kind. ${parts.map(text).join(". ")}`}>
        {parts.map((p) => (
          <div
            key={p.kind}
            className={`storage-seg${hot === p.kind ? " hot" : ""}${hot && hot !== p.kind ? " dim" : ""}`}
            data-kind={p.kind}
            style={{ width: `${p.width}%`, "--kind": kindColour(p.kind) } as CSSProperties}
            title={text(p)}
            onPointerEnter={() => onHot(p.kind)}
            onClick={() => onPick(p.kind)}
          />
        ))}
      </div>
      <div className="storage-readout" aria-hidden>
        {readout ? text(readout) : "Hover a colour to read it, press it to go to its list"}
      </div>
      <ul className="storage-legend" aria-label="Storage kinds">
        {parts.map((p) => (
          <li key={p.kind}>
            <button
              className={`storage-legend-item${hot && hot !== p.kind ? " dim" : ""}`}
              style={{ "--kind": kindColour(p.kind) } as CSSProperties}
              title={`Go to ${p.title}`}
              onPointerEnter={() => onHot(p.kind)}
              onFocus={() => onHot(p.kind)}
              onBlur={() => onHot(null)}
              onClick={() => onPick(p.kind)}
            >
              <span className="storage-swatch" aria-hidden />
              <span className="storage-legend-name">{p.title}</span>
              <span className="storage-legend-size">{sizeText(p.bytes)}</span>
              <span className="storage-legend-share">{shareText(p.share)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Row({ item, biggest, ticked, disabled, onTick }: { item: StorageItem; biggest: number; ticked: boolean; disabled: boolean; onTick: (on: boolean) => void }) {
  const blocked = item.risk === "blocked";
  const idle = idleText(item.idle_days);
  return (
    <li className={`storage-row risk-${item.risk}${ticked ? " ticked" : ""}`}>
      <label className="storage-check">
        <input type="checkbox" checked={ticked} disabled={blocked || disabled} aria-label={`Delete ${item.name}`} onChange={(e) => onTick(e.target.checked)} />
      </label>
      <div className="storage-main">
        <div className="storage-line">
          <span className="storage-name" title={item.path}>
            {item.name}
          </span>
          <span className="storage-size">{sizeText(item.bytes)}</span>
        </div>
        {/* Its size against the biggest item of the scan; the number above is its text alternative. */}
        <div className="storage-rowbar" aria-hidden>
          <span style={{ width: `${rowWidth(item.bytes, biggest)}%` }} />
        </div>
        <div className="storage-meta">
          {[idle, item.removal === "trash" ? "goes to the Trash" : item.removal === "permanent" ? "deleted for good" : null, item.within ? "inside another item" : null].filter(Boolean).join(" · ")}
        </div>
        {item.warning && <div className={`storage-warn risk-${item.risk}`}>{blocked ? `Can't be deleted: ${item.warning}` : item.warning}</div>}
        <div className="storage-note">{item.note}</div>
        {item.suggestion && <div className="storage-claude">Claude: {item.suggestion}</div>}
      </div>
    </li>
  );
}
