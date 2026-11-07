import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { bodyJson, formatBytes, outline, shortUrl, statusLabel, tone } from "../lib/network";
import { relativeTime } from "../lib/time";
import type { CaptureStatus, NetworkDetail, NetworkItem, NetworkView, NetworkWatch } from "../types";
import { JsonTree } from "./JsonTree";
import { Md } from "./Md";
import { Fold } from "./TestsTab";
import { TabEmpty } from "./TabEmpty";


/** The folder's Network tab data, loaded when the folder opens and again whenever the backend says it changed. */
export function useNetworkView(folder: string | null): NetworkView | null {
  const [view, setView] = useState<NetworkView | null>(null);
  useEffect(() => {
    setView(null);
    if (!folder) return;
    let live = true;
    const load = () => api.networkState(folder).then((v) => live && setView(v), () => {});
    load();
    // Outside the app (tests, a browser) there are no events to listen to.
    const unlisten = api.onNetworkChanged(load).catch(() => null);
    return () => {
      live = false;
      unlisten.then((f) => f?.());
    };
  }, [folder]);
  return view;
}

/** Lantern's capture, loaded when the tab opens and again whenever the backend says the Network tab changed. */
export function useCapture(): [CaptureStatus | null, (s: CaptureStatus) => void] {
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.captureStatus().then((s) => live && setStatus(s), () => {});
    load();
    // Outside the app (tests, a browser) there are no events to listen to.
    const unlisten = api.onNetworkChanged(load).catch(() => null);
    return () => {
      live = false;
      unlisten.then((f) => f?.());
    };
  }, []);
  return [status, setStatus];
}

/**
 * The Network tab before there is anything to list: the capture's switch and how to connect a phone, and how requests
 * get here (Claude saves a watch).
 */
export function NetworkEmpty() {
  const [capture, setCapture] = useCapture();
  return (
    <TabEmpty title="Network">
      <p>
        {capture?.running
          ? "Lantern is capturing. Tell Claude which requests matter (for example, “watch the request that loads the orders list”) and it saves a watch; matching requests show up here, and Claude can summarize their responses."
          : "Lantern can capture a phone's HTTP and HTTPS traffic: start the capture, connect the phone, then tell Claude which requests matter. Claude saves a watch, and the matching requests show up here, with summaries of their responses."}
      </p>
      {capture && (
        <div className="network-capture-empty">
          <CaptureSwitch status={capture} onChange={setCapture} />
        </div>
      )}
      {capture?.error && <p className="network-capture-error">{capture.error}</p>}
      {capture?.running && <ConnectPhone status={capture} open />}
    </TabEmpty>
  );
}

/** The capture's switch: whether it's on, and a button to start or stop it. */
function CaptureSwitch({ status, onChange }: { status: CaptureStatus; onChange: (s: CaptureStatus) => void }) {
  const [busy, setBusy] = useState(false);
  const toggle = () => {
    setBusy(true);
    (status.running ? api.captureStop() : api.captureStart()).then(onChange, () => {}).finally(() => setBusy(false));
  };
  const title = status.running ? `Capturing on this Mac's local network: ${status.captured === 1 ? "1 request" : `${status.captured} requests`} so far` : "Lantern's proxy and WireGuard tunnel are off";
  return (
    <>
      <span className={`network-link ${status.running ? "connected" : "not_running"}`} title={title}>
        <span className="network-link-dot" aria-hidden />
        {status.running ? "Capturing" : "Capture is off"}
      </span>
      <button className="ghost network-capture-toggle" disabled={busy} onClick={toggle}>
        {status.running ? "Stop" : busy ? "Starting…" : "Start capturing"}
      </button>
    </>
  );
}

/** How a phone connects: the WireGuard tunnel (every app's traffic), or the Wi-Fi proxy (apps that follow it). */
function ConnectPhone({ status, open = false }: { status: CaptureStatus; open?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);
  if (!status.running) return null;
  const [host, port] = status.proxy?.split(":") ?? [];
  return (
    <Fold title="Connect a phone" open={open}>
      <div className="network-connect">
        {status.wireguardQr && <img className="remote-qr network-qr" alt="WireGuard tunnel for the phone" src={`data:image/svg+xml;utf8,${encodeURIComponent(status.wireguardQr)}`} />}
        <div className="network-connect-steps">
          <div className="tests-heading">WireGuard: every app</div>
          <ol>
            <li>In the WireGuard app, tap +, then Create from QR code, and scan this.</li>
            <li>Turn the tunnel on: all the phone's traffic now comes through this Mac.</li>
            <li>
              Install Lantern's certificate: open <code>{status.setupUrl ?? "the setup page"}</code> in Safari, install the profile, then turn on full trust in Settings → General → About → Certificate Trust Settings.
            </li>
          </ol>
          {host && (
            <>
              <div className="tests-heading">Or the Wi-Fi proxy: apps that follow it</div>
              <p>
                Settings → Wi-Fi → ⓘ → Configure Proxy → Manual: server <code>{host}</code>, port <code>{port}</code>. Then install the certificate the same way.
              </p>
            </>
          )}
          {status.wireguardConfig && (
            <button className="ghost" onClick={() => navigator.clipboard?.writeText(status.wireguardConfig ?? "").then(() => setCopied(true), () => {})}>
              {copied ? "Copied" : "Copy WireGuard config"}
            </button>
          )}
        </div>
      </div>
    </Fold>
  );
}

interface Props {
  folder: string;
  view: NetworkView;
  /** Asks Claude, in this chat, to summarize the request's response; null when there's no chat to ask. */
  onSummarize: ((item: NetworkItem) => void) | null;
  /** Claude is in the middle of a turn in this chat: a Summarize asked meanwhile is working until the turn ends. */
  busy?: boolean;
}

// The requests that match the folder's watches, as Lantern captures them: newest first, the one picked below
// with Claude's summary (or the response's outline until there is one), then the response as a tree and its headers.
export function NetworkTab({ folder, view, onSummarize, busy = false }: Props) {
  const [picked, setPicked] = useState<string | null>(null);
  // The row at the top that the user has seen. Until they pick another, the detail stays on it: a request arriving above
  // must not move what they are reading. What came in since is "N new", which one click brings in.
  const [top, setTop] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    setPicked(null);
    setTop(null);
  }, [folder]);
  // Rows that came in since the last look flash once; the ones there when the tab opened do not.
  const known = useRef<{ folder: string; ids: Set<string> } | null>(null);
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  const ids = view.items.map((i) => i.tx.id).join(",");
  useEffect(() => {
    const now = view.items.map((i) => i.tx.id);
    // Another folder's tab is a first look again.
    const before = known.current?.folder === folder ? known.current.ids : null;
    known.current = { folder, ids: new Set(now) };
    if (!before) return;
    const added = now.filter((id) => !before.has(id));
    if (added.length === 0) return;
    setFlashing((f) => new Set([...f, ...added]));
    // Left to run out by itself even if more rows come in meanwhile: each batch takes its own flash back.
    window.setTimeout(() => setFlashing((f) => new Set([...f].filter((id) => !added.includes(id)))), 1300);
  }, [ids, folder]);
  const first = view.items[0]?.tx.id ?? null;
  const seen = view.items.some((i) => i.tx.id === top) ? top : first;
  useEffect(() => {
    if (seen !== top) setTop(seen);
  }, [seen, top]);
  const fresh = Math.max(0, view.items.findIndex((i) => i.tx.id === seen));
  const current = view.items.find((i) => i.tx.id === picked) ?? view.items.find((i) => i.tx.id === seen) ?? view.items[0] ?? null;
  const [capture, setCapture] = useCapture();
  const showNewest = () => {
    setTop(first);
    setPicked(first);
    list.current?.scrollTo?.({ top: 0 });
  };
  return (
    <>
      <div className="review-bar network-bar">
        {capture && <CaptureSwitch status={capture} onChange={setCapture} />}
        <div className="spacer" />
        {view.items.length > 0 && <span className="position">{view.items.length === 1 ? "1 request" : `${view.items.length} requests`}</span>}
      </div>
      {(capture?.error ?? (view.link.status === "error" ? view.link.message : null)) && (
        <div className="network-link-note" role="status">
          {capture?.error ?? (view.link.status === "error" ? view.link.message : null)}
        </div>
      )}
      <div className="network-body">
        {capture?.running && view.items.length === 0 && <ConnectPhone status={capture} open />}
        {view.watches.length > 0 && <Watches folder={folder} watches={view.watches} />}
        {view.items.length === 0 ? (
          <div className="tests-note network-empty">
            {capture && !capture.running ? "Lantern's capture is off. Start it and connect your phone; matching requests show up here." : "No requests match yet. Use your app, and the ones that match show up here as they happen."}
          </div>
        ) : (
          <div className="network-list-wrap">
          {fresh > 0 && (
            <button className="network-new" onClick={showNewest}>
              {fresh} new ↑
            </button>
          )}
          <ul className="network-list" aria-label="Matching requests" ref={list}>
            {view.items.map((item) => (
              <li key={item.tx.id}>
                <button className={`network-row${item.tx.id === current?.tx.id ? " current" : ""}${flashing.has(item.tx.id) ? " fresh" : ""}`} aria-current={item.tx.id === current?.tx.id} title={item.tx.url} onClick={() => setPicked(item.tx.id)}>
                  <span className={`network-status ${tone(item.tx)}`}>{statusLabel(item.tx)}</span>
                  <span className="network-method">{item.tx.method}</span>
                  <span className="network-url">{shortUrl(item.tx.url)}</span>
                  {item.summary && <span className="network-summarized" title="Claude summarized this one" aria-label="summarized" />}
                  <span className="network-time">{clock(item.tx.started_at)}</span>
                </button>
              </li>
            ))}
          </ul>
          </div>
        )}
        {current && <RequestDetail key={current.tx.id} folder={folder} item={current} onSummarize={onSummarize} busy={busy} />}
      </div>
    </>
  );
}

/** How long a removed watch can be put back. */
const UNDO_MS = 5000;

function Watches({ folder, watches }: { folder: string; watches: NetworkWatch[] }) {
  const [removed, setRemoved] = useState<NetworkWatch | null>(null);
  // The offer goes by itself after a few seconds, or when another watch is removed or the folder changes.
  useEffect(() => {
    if (!removed) return;
    const t = window.setTimeout(() => setRemoved(null), UNDO_MS);
    return () => window.clearTimeout(t);
  }, [removed]);
  useEffect(() => setRemoved(null), [folder]);
  return (
    <div className="network-watches" aria-label="Watches">
      <span className="tests-heading">Watching</span>
      {watches.map((w) => (
        <span key={w.label} className="network-watch" title={`${w.method ?? "Any method"} ${w.url}`}>
          {w.label}
          <button
            className="network-watch-remove"
            aria-label={`Stop watching ${w.label}`}
            title="Stop watching"
            onClick={() => api.networkUnwatch(folder, w.label).then(() => setRemoved(w), () => {})}
          >
            ×
          </button>
        </span>
      ))}
      {removed && (
        <span className="network-undo" role="status">
          Stopped watching {removed.label}.
          <button
            className="ghost"
            onClick={() => {
              api.networkRewatch(folder, removed.label, removed.method, removed.url).catch(() => {});
              setRemoved(null);
            }}
          >
            Undo
          </button>
        </span>
      )}
    </div>
  );
}

function RequestDetail({ folder, item, onSummarize, busy }: { folder: string; item: NetworkItem; onSummarize: Props["onSummarize"]; busy: boolean }) {
  const { tx } = item;
  const [detail, setDetail] = useState<{ value?: NetworkDetail; error?: string } | null>(null);
  // Read again when the request finishes (pending → completed), or Lantern gets hold of its response.
  useEffect(() => {
    let live = true;
    api.networkResponse(folder, tx.id).then(
      (value) => live && setDetail({ value }),
      (e) => live && setDetail({ error: String(e) }),
    );
    return () => {
      live = false;
    };
  }, [folder, tx.id, tx.revision, item.has_response]);
  const json = detail?.value ? bodyJson(detail.value.response_body) : undefined;
  const meta = [tx.duration_ms !== null && `${Math.round(tx.duration_ms)} ms`, tx.state !== "pending" && formatBytes(detail?.value?.response_body.size ?? tx.response_size), tx.response_content_type?.split(";")[0], relativeTime(tx.started_at)].filter(Boolean);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);
  // "Summarizing…" from the click until the summary arrives (a new one replaces an old) or Claude's turn ends.
  const [asked, setAsked] = useState<{ before: number | null; sawBusy: boolean } | null>(null);
  const written = item.summary?.written_at ?? null;
  useEffect(() => {
    if (!asked) return;
    if (written !== asked.before || (asked.sawBusy && !busy)) setAsked(null);
    else if (busy && !asked.sawBusy) setAsked({ ...asked, sawBusy: true });
  }, [asked, written, busy]);
  return (
    <section className="network-detail" aria-label="Request">
      <div className="network-detail-head">
        <span className={`network-status ${tone(tx)}`}>{statusLabel(tx)}</span>
        <span className="network-method">{tx.method}</span>
        <span className="network-detail-url">{tx.url}</span>
      </div>
      <div className="network-detail-meta">
        {meta.join(" · ")}
        {item.watch && <span className="tag">{item.watch}</span>}
      </div>
      <div className="network-actions">
        {onSummarize && (
          <button
            className="ghost"
            disabled={tx.state === "pending" || asked !== null}
            title="Ask Claude in this chat to read the response and summarize it here"
            onClick={() => {
              setAsked({ before: written, sawBusy: busy });
              onSummarize(item);
            }}
          >
            {asked ? "Summarizing…" : item.summary ? "Summarize again" : "Summarize"}
          </button>
        )}
        {json !== undefined && (
          <button
            className="ghost"
            onClick={() => {
              navigator.clipboard?.writeText(JSON.stringify(json, null, 2)).then(() => setCopied(true), () => {});
            }}
          >
            {copied ? "Copied" : "Copy JSON"}
          </button>
        )}
      </div>
      {tx.error && <div className="network-error">{tx.error}</div>}
      {item.summary ? (
        <div className="network-summary">
          <Md>{item.summary.text}</Md>
          <div className="tests-note">Claude's summary, {relativeTime(item.summary.written_at)}</div>
        </div>
      ) : (
        json !== undefined && <Outline value={json} />
      )}
      {!detail ? (
        <div className="tests-note">Loading the response…</div>
      ) : detail.error ? (
        <div className="tests-note">{item.summary ? "The response itself is gone: the capture no longer has it." : detail.error}</div>
      ) : (
        detail.value && <Response detail={detail.value} json={json} />
      )}
    </section>
  );
}

/** The response's shape, until Claude has summarized it. */
function Outline({ value }: { value: unknown }) {
  const rows = outline(value);
  if (rows.length === 0) return null;
  return (
    <div className="network-outline">
      <div className="tests-heading">Outline</div>
      <dl>
        {rows.map((r) => (
          <div key={r.path} className={r.odd ? "odd" : undefined}>
            <dt>{r.path}</dt>
            <dd>{r.text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Response({ detail, json }: { detail: NetworkDetail; json: unknown }) {
  const body = detail.response_body;
  return (
    <>
      <Fold title="Response" open>
        {json !== undefined ? (
          <JsonTree value={json} />
        ) : body.size === 0 ? (
          <div className="tests-note">Empty</div>
        ) : body.encoding === "utf8" ? (
          <pre className="step-output network-text">{body.data.length > 50_000 ? `${body.data.slice(0, 50_000)}\n…` : body.data}</pre>
        ) : (
          <div className="tests-note">Binary, {formatBytes(body.size)}</div>
        )}
        {body.truncated && <div className="tests-note">Lantern kept only the start of this response.</div>}
      </Fold>
      <Fold title="Response headers" count={detail.response_headers.length}>
        <Headers headers={detail.response_headers} />
      </Fold>
      <Fold title="Request headers" count={detail.request_headers.length}>
        <Headers headers={detail.request_headers} />
      </Fold>
      {detail.request_body.size > 0 && (
        <Fold title="Request body">
          <pre className="step-output network-text">{detail.request_body.encoding === "utf8" ? detail.request_body.data.slice(0, 50_000) : `Binary, ${formatBytes(detail.request_body.size)}`}</pre>
        </Fold>
      )}
    </>
  );
}

function Headers({ headers }: { headers: { name: string; value: string }[] }) {
  return (
    <dl className="network-headers">
      {headers.map((h, i) => (
        <div key={`${h.name}-${i}`}>
          <dt>{h.name}</dt>
          <dd>{h.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
