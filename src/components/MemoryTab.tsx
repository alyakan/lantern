import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api } from "../api";
import { appColours, memoryParts, memoryShare, memoryText, partText, pressureSource, processText, stableOrder, updatedText, type MemoryPart } from "../lib/memory";
import { rowWidth } from "../lib/storage";
import type { MemoryApp, MemorySnapshot } from "../types";
import { TabEmpty } from "./TabEmpty";

/** How often the numbers are read while the tab is on screen. */
export const POLL_MS = 3000;

/**
 * The memory snapshot, read now and then every few seconds, but only while the window is visible: a hidden window, or a tab that isn't
 * showing (this hook isn't mounted then), reads nothing. A read that is still running is not started again.
 */
export function useMemorySnapshot() {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const flight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const load = useCallback(() => {
    if (flight.current) return;
    flight.current = true;
    api
      .memorySnapshot()
      .then(
        (s) => {
          if (!alive.current) return;
          setSnapshot(s);
          setError(null);
          setAt(Date.now());
        },
        (e) => alive.current && setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => {
        flight.current = false;
      });
  }, []);
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  useEffect(() => {
    if (!visible) return;
    load();
    setNow(Date.now());
    const poll = setInterval(load, POLL_MS);
    // The "Updated ..." text counts up between reads.
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [visible, load]);
  return { snapshot, error, at, now, refresh: load };
}

/** What Lantern's own row says it holds. */
const LANTERN_NOTE = "Lantern, the agents it runs (claude, node, vite...) and everything they started. Lantern's web view runs in a macOS process, so it counts under macOS.";
const NOTES: Partial<Record<MemoryApp["kind"], string>> = {
  lantern: LANTERN_NOTE,
  macos: "The system's own processes, and memory no process owns, like the kernel's.",
  other: "Everything outside the biggest apps.",
};

/** The Storage panel's Memory tab: how the RAM is used and by which apps. View only: nothing here quits or stops anything. */
export function MemoryTab() {
  const { snapshot, error, at, now, refresh } = useMemorySnapshot();
  // The order the rows were last drawn in: the next refresh keeps it unless an app has moved far (see stableOrder).
  const drawn = useRef<string[]>([]);
  const apps = useMemo(() => {
    const ordered = snapshot ? stableOrder(drawn.current, snapshot.apps) : [];
    drawn.current = ordered.map((a) => a.name);
    return ordered;
  }, [snapshot]);
  const parts = useMemo(() => (snapshot ? memoryParts(snapshot, apps) : []), [snapshot, apps]);
  const colours = useMemo(() => appColours(apps), [apps]);
  const biggest = Math.max(0, ...apps.map((a) => a.bytes));
  const [hot, setHot] = useState<string | null>(null);

  if (!snapshot) {
    return error ? (
      <TabEmpty title="Memory">
        <p role="alert">Couldn't read memory: {error}</p>
        <p>
          <button onClick={refresh}>Try again</button>
        </p>
      </TabEmpty>
    ) : (
      <TabEmpty title="Memory">Reading memory…</TabEmpty>
    );
  }

  const readout = parts.find((p) => p.key === hot);
  return (
    <>
      <div className="review-bar storage-bar">
        <span className="storage-status">{updatedText(at, now)}</span>
        <div className="spacer" />
        <button className="ghost" onClick={refresh} title="Read the memory again now">
          Refresh
        </button>
      </div>
      {error && (
        <div className="storage-notes" role="alert">
          <p className="storage-failure">Couldn't read memory: {error}. Showing the last reading.</p>
        </div>
      )}
      {snapshot.apps.length === 0 ? (
        <div className="tests-note storage-empty">No apps were found.</div>
      ) : (
        <>
          <div className="storage-chart memory-chart" onPointerLeave={() => setHot(null)}>
            <div className="storage-stack" role="img" aria-label={`Memory by app. ${parts.map(partText).join(". ")}`}>
              {parts.map((p) => (
                <div key={p.key} className={`memory-seg${hot === p.key ? " hot" : ""}${hot && hot !== p.key ? " dim" : ""}`} style={{ width: `${p.width}%`, "--kind": p.colour } as CSSProperties} title={partText(p)} onPointerEnter={() => setHot(p.key)} />
              ))}
            </div>
            <div className="storage-readout" aria-hidden>
              {readout ? partText(readout) : "Hover a colour to read it"}
            </div>
            <Summary snapshot={snapshot} />
            <ul className="storage-legend" aria-label="Memory legend">
              {parts.map((p) => (
                <Legend key={p.key} part={p} dim={!!hot && hot !== p.key} onHot={setHot} />
              ))}
            </ul>
          </div>
          <div className="storage-body memory-body" role="region" aria-label="Memory by app" tabIndex={0}>
            <div className="memory-list-head">Resident memory by app, about</div>
            <ul className="storage-list">
              {apps.map((a) => (
                <Row key={a.name} app={a} biggest={biggest} colour={colours.get(a.name) ?? "var(--muted)"} />
              ))}
            </ul>
            <p className="memory-foot">
              Sizes are resident memory: what each app holds in RAM right now. Shared pages count in every process that uses them, so{" "}
              {snapshot.scaled ? "the apps were scaled down to fit what is used" : "the apps can add up to more than is used (they are scaled down if so)"}. macOS includes memory no process owns.
            </p>
          </div>
        </>
      )}
    </>
  );
}

function Summary({ snapshot }: { snapshot: MemorySnapshot }) {
  const swap = snapshot.swap_used_bytes === null ? "" : `, swap ${memoryText(snapshot.swap_used_bytes)}`;
  return (
    <p className="memory-summary">
      About {memoryText(snapshot.used_bytes)} used of {memoryText(snapshot.total_bytes)}, pressure:{" "}
      <span className={`memory-pressure ${snapshot.pressure}`} title={pressureSource(snapshot)}>
        {snapshot.pressure}
      </span>
      {swap}
    </p>
  );
}

function Legend({ part, dim, onHot }: { part: MemoryPart; dim: boolean; onHot: (key: string | null) => void }) {
  return (
    <li className={`storage-legend-item memory-legend-item${dim ? " dim" : ""}`} style={{ "--kind": part.colour } as CSSProperties} onPointerEnter={() => onHot(part.key)}>
      <span className={`storage-swatch${part.key === "free" ? " empty" : ""}`} aria-hidden />
      <span className="storage-legend-name">{part.title}</span>
      <span className="storage-legend-size">{memoryText(part.bytes)}</span>
      <span className="storage-legend-share">{part.share === 0 ? "<1%" : `${part.share}%`}</span>
    </li>
  );
}

function Row({ app, biggest, colour }: { app: MemoryApp; biggest: number; colour: string }) {
  const note = NOTES[app.kind];
  return (
    <li className={`storage-row memory-row ${app.kind}`} style={{ "--kind": colour } as CSSProperties}>
      <div className="storage-main">
        <div className="storage-line">
          <span className="storage-swatch" aria-hidden />
          <span className="storage-name memory-name">{app.name}</span>
          <span className="memory-count">{processText(app.processes)}</span>
          <span className="storage-size">{memoryText(app.bytes)}</span>
          <span className="storage-legend-share">{memoryShare(app.share)}</span>
        </div>
        {/* Its size against the biggest app's; the numbers above are its text alternative. */}
        <div className="storage-rowbar" aria-hidden>
          <span style={{ width: `${rowWidth(app.bytes, biggest)}%` }} />
        </div>
        {note && <div className="storage-note">{note}</div>}
      </div>
    </li>
  );
}
