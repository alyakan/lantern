import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import type { Insights } from "../../mobile/src/protocol/generated/Insights";
import type { InsightsCompare } from "../../mobile/src/protocol/generated/InsightsCompare";
import type { InsightsRange } from "../../mobile/src/protocol/generated/InsightsRange";
import type { InsightsShare } from "../../mobile/src/protocol/generated/InsightsShare";
import { change, percent, tokens, wait } from "../lib/insights";

const RANGES: { id: InsightsRange; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

function Section({ label, headline, children }: { label: string; headline: string; children: ReactNode }) {
  return (
    <section className="insights-section" aria-label={label}>
      <h3>{label}</h3>
      <p className="insights-headline">{headline}</p>
      {children}
    </section>
  );
}

function Figure({ value, label, compare, lowerIsBetter = true, points = false }: { value: string; label: string; compare?: InsightsCompare; lowerIsBetter?: boolean; points?: boolean }) {
  const d = compare ? change(compare, lowerIsBetter, points) : null;
  return (
    <div className="insights-figure">
      <dd>{value}</dd>
      <dt>{label}</dt>
      {d && <span className={`insights-delta ${d.text === "same" ? "same" : d.good ? "good" : "bad"}`}>{d.text === "same" ? "— same" : d.text}</span>}
    </div>
  );
}

function Shares({ list }: { list: InsightsShare[] }) {
  return (
    <ul className="insights-shares">
      {list.map((s) => (
        <li key={s.name}>
          <span className="name">{s.name}</span>
          <span className="track" aria-hidden="true">
            <span style={{ width: `${Math.max(2, s.share * 100)}%` }} />
          </span>
          <span className="pct">{percent(s.share)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Insights, opened from the title bar's chart button (or the palette): where the usage goes, whether the token savings work,
 * what got done, and how the user works. Each section answers its question in a sentence, then backs it up with one chart or a
 * row of figures. A dialog like Storage: Escape or a press on the backdrop closes it.
 */
export function InsightsPanel({ open, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [range, setRange] = useState<InsightsRange>("week");
  const [shown, setShown] = useState<Partial<Record<InsightsRange, Insights>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // jsdom has no showModal or close: there, the attribute alone opens and closes it.
    if (open) {
      if (el.open) return;
      if (el.showModal) el.showModal();
      else el.setAttribute("open", "");
    } else if (el.open) {
      if (el.close) el.close();
      else el.removeAttribute("open");
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const n = ++asked.current;
    setLoading(true);
    setError(null);
    api.insights(range).then(
      (i) => {
        if (n !== asked.current) return;
        setShown((all) => ({ ...all, [range]: i }));
        setLoading(false);
      },
      (e) => {
        if (n !== asked.current) return;
        setError(String(e));
        setLoading(false);
      },
    );
  }, [open, range]);
  const i = shown[range];
  const top = i ? Math.max(1, ...i.usage.bars.map((b) => b.weighted)) : 1;
  const hoursTop = i ? Math.max(1, ...i.habits.hours) : 1;
  const every = range === "month" ? 5 : range === "today" ? 6 : 1;
  return (
    <dialog ref={ref} className="mode-guide insights-panel" aria-label="Insights" onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      {open && (
        <div className="storage-panel-body">
          <header className="storage-panel-head">
            <h2>Insights</h2>
            <div className="segmented" role="tablist" aria-label="Stretch of time">
              {RANGES.map((r) => (
                <button key={r.id} role="tab" aria-selected={range === r.id} className={range === r.id ? "active" : ""} onClick={() => setRange(r.id)}>
                  {r.label}
                </button>
              ))}
            </div>
            <div className="spacer" />
            {loading && <span className="storage-status">{i ? "Updating…" : "Reading your chats' logs…"}</span>}
            <button onClick={onClose}>Close</button>
          </header>
          <div className="insights-body">
            {error && !loading && <p className="insights-error" role="alert">{error}</p>}
            {i && (
              <>
                <Section label="Usage" headline={i.usage.headline}>
                  <div className="insights-bars" role="img" aria-label={`Usage over time, highest ${tokens(top)} weighted tokens`}>
                    {i.usage.bars.map((b, n) => (
                      <div key={n} className="bar-col" title={`${b.label}: ${tokens(b.weighted)}`}>
                        <span className={`bar${n === i.usage.bars.length - 1 ? " now" : ""}${b.weighted === 0 ? " none" : ""}`} style={{ height: `${Math.max(2, (b.weighted / top) * 100)}%` }} />
                        <span className="label">{n % every === 0 || n === i.usage.bars.length - 1 ? b.label : ""}</span>
                      </div>
                    ))}
                  </div>
                  <p className="insights-note">
                    {tokens(i.usage.weighted)} weighted tokens · {tokens(i.usage.tokens)} sent and received{i.usage.models.length > 1 ? ` · ${i.usage.models.map((m) => `${m.name} ${percent(m.share)}`).join(", ")}` : ""}
                  </p>
                  <div className="insights-two">
                    {i.usage.projects.length > 0 && (
                      <div>
                        <h4>By project</h4>
                        <Shares list={i.usage.projects} />
                      </div>
                    )}
                    {i.usage.heavy.length > 0 && (
                      <div>
                        <h4>Cost the most</h4>
                        <ul className="insights-heavy">
                          {i.usage.heavy.map((h, n) => (
                            <li key={n}>
                              <span className="title">{h.title}</span>
                              <span className="meta">
                                {h.project} · {tokens(h.weighted)}
                              </span>
                              {h.why && <span className="tag">{h.why}</span>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </Section>
                <Section label="Savings" headline={i.savings.headline}>
                  <dl className="insights-figures">
                    <Figure value={tokens(i.savings.per_call.now)} label="context a call" compare={i.savings.per_call} />
                    <Figure value={tokens(i.savings.chat_start.now)} label="a chat's start" compare={i.savings.chat_start} />
                    <Figure value={percent(i.savings.cached.now)} label="from the cache" compare={i.savings.cached} lowerIsBetter={false} points />
                  </dl>
                  <p className="insights-note">
                    Compared with {i.before}.{i.savings.note ? ` ${i.savings.note}` : ""}
                  </p>
                </Section>
                <Section label="Done" headline={i.done.headline}>
                  <dl className="insights-figures">
                    <Figure value={`${i.done.merged}`} label="PRs merged" />
                    <Figure value={`${i.done.releases}`} label="releases" />
                    <Figure value={`${i.done.commits}`} label="commits" />
                    <Figure value={`${i.done.chats}`} label="chats" />
                  </dl>
                  {(i.done.added > 0 || i.done.removed > 0) && (
                    <p className="insights-note">
                      <span className="add">+{i.done.added.toLocaleString()}</span> <span className="del">−{i.done.removed.toLocaleString()}</span> lines in your commits
                    </p>
                  )}
                  {i.done.projects.length > 1 && <Shares list={i.done.projects} />}
                </Section>
                <Section label="Habits" headline={i.habits.headline}>
                  <div className="insights-bars hours" role="img" aria-label="When you write to your chats, by hour">
                    {i.habits.hours.map((n, h) => (
                      <div key={h} className="bar-col" title={`${h}:00, ${n} ${n === 1 ? "message" : "messages"}`}>
                        <span className={`bar${n === hoursTop ? " now" : ""}${n === 0 ? " none" : ""}`} style={{ height: `${Math.max(2, (n / hoursTop) * 100)}%` }} />
                        <span className="label">{h % 6 === 0 ? (h === 0 ? "12 am" : h === 12 ? "noon" : h < 12 ? `${h} am` : `${h - 12} pm`) : ""}</span>
                      </div>
                    ))}
                  </div>
                  <dl className="insights-figures">
                    <Figure value={i.habits.reply_ms === null ? "—" : wait(i.habits.reply_ms)} label="a finished chat waits for you" />
                    <Figure value={percent(i.habits.away)} label="ran while you were away" />
                  </dl>
                </Section>
              </>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}
