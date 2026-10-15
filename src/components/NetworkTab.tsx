import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { bodyJson, formatBytes, outline, shortUrl, statusLabel, tone } from "../lib/network";
import { relativeTime } from "../lib/time";
import type { NetworkDetail, NetworkItem, NetworkLink, NetworkView, NetworkWatch } from "../types";
import { JsonTree } from "./JsonTree";
import { Md } from "./Md";
import { Fold } from "./TestsTab";

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

interface Props {
  folder: string;
  view: NetworkView;
  /** Asks Claude, in this chat, to summarize the request's response; null when there's no chat to ask. */
  onSummarize: ((item: NetworkItem) => void) | null;
  /** Claude is in the middle of a turn in this chat: a Summarize asked meanwhile is working until the turn ends. */
  busy?: boolean;
}

// The requests that match the folder's watches, as Network Monitor captures them: newest first, the one picked below
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
  const first = view.items[0]?.tx.id ?? null;
  const seen = view.items.some((i) => i.tx.id === top) ? top : first;
  useEffect(() => {
    if (seen !== top) setTop(seen);
  }, [seen, top]);
  const fresh = Math.max(0, view.items.findIndex((i) => i.tx.id === seen));
  const current = view.items.find((i) => i.tx.id === picked) ?? view.items.find((i) => i.tx.id === seen) ?? view.items[0] ?? null;
  const showNewest = () => {
    setTop(first);
    setPicked(first);
    list.current?.scrollTo?.({ top: 0 });
  };
  return (
    <>
      <div className="review-bar network-bar">
        <LinkStatus link={view.link} />
        <div className="spacer" />
        {view.items.length > 0 && <span className="position">{view.items.length === 1 ? "1 request" : `${view.items.length} requests`}</span>}
      </div>
      {view.link.status === "error" && (
        <div className="network-link-note" role="status">
          {view.link.message}
        </div>
      )}
      <div className="network-body">
        {view.watches.length > 0 && <Watches folder={folder} watches={view.watches} />}
        {view.items.length === 0 ? (
          <div className="tests-note network-empty">
            {view.link.status === "not_running" ? "Network Monitor isn't running. Open it and send your app's traffic through it; matching requests show up here." : "No requests match yet. Use your app, and the ones that match show up here as they happen."}
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
                <button className={`network-row${item.tx.id === current?.tx.id ? " current" : ""}`} aria-current={item.tx.id === current?.tx.id} title={item.tx.url} onClick={() => setPicked(item.tx.id)}>
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

function LinkStatus({ link }: { link: NetworkLink }) {
  const [text, title] =
    link.status === "connected" ? ["Network Monitor", "Following Network Monitor's captured traffic"] :
    link.status === "not_running" ? ["Network Monitor isn't running", "Open Network Monitor to capture requests; Lantern finds it on its own"] :
    link.status === "error" ? ["Can't read Network Monitor", link.message] :
    ["Network Monitor", "Not looked for yet"];
  return (
    <span className={`network-link ${link.status}`} title={title}>
      <span className="network-link-dot" aria-hidden />
      {text}
    </span>
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
        <div className="tests-note">{item.summary ? "The response itself is gone: Network Monitor no longer has it." : detail.error}</div>
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
        {body.truncated && <div className="tests-note">Lantern kept only the first 2 MB of this response.</div>}
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
