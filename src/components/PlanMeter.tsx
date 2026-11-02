import { useEffect, useState } from "react";
import { currentWindow, useProviderUsage } from "../lib/planUsage";
import { weekSentence } from "../lib/weekUsage";
import { providerName } from "../lib/provider";
import { DAY_SECS, HOUR_SECS, windowMarks, type Mark, type Marks } from "../lib/usageMarks";
import { usageLine } from "../lib/cost";
import { modelLine, type ModelShare, type UsageRow, type UsageState } from "../lib/usage";
import { usePopover } from "../lib/usePopover";
import { ChevronIcon } from "./icons";

interface Props {
  /** What the popover lists (computed when it opens), and opening one of the chats. Left out: the meter is only a reading. */
  usage?: { rows: () => UsageRow[]; onOpen: (slot: string) => void; switchToCodex?: () => void };
}

const STATE_LABEL: Record<UsageState, string> = { working: "Working", waiting: "Needs you", idle: "Idle", ended: "Stopped" };

/** Provider account limits, followed by lifetime totals for open chats and teams. */
export function PlanMeter({ usage }: Props) {
  const providers = useProviderUsage();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const { box, button, list, id } = usePopover(open, () => setOpen(false));
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const summaries = [...new Set(["claude", "codex", ...Object.keys(providers)])].map(name => {
    const reading = providers[name];
    const windows = reading?.windows.filter(w => currentWindow(w, now)) ?? [];
    const used = windows.length ? Math.max(...windows.map(w => w.used)) : null;
    return { name, reading, windows, used };
  });
  const label = summaries.map(p => `${providerName(p.name)}: ${p.used === null ? "usage unavailable" : `${pct(p.used)}% used`}`).join(", ");
  return (
    <div className="plan-meter-box" ref={box}>
      <button
        ref={button}
        className="plan-meter"
        title="Usage is separate for each provider. Each number is its fullest reported window."
        aria-label={`Usage by provider. ${label}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {summaries.map(p => (
          <span key={p.name} className={`mini-meter ${usageLevel(p.used)}`}>
            <span>{providerName(p.name)} {p.used === null ? "—" : `${pct(p.used)}%`}</span>
            <span className="mini-meter-track" aria-hidden>
              {p.used !== null && <span className="mini-meter-fill" style={{ width: `${pct(p.used)}%` }} />}
            </span>
          </span>
        ))}
        <ChevronIcon up={open} />
      </button>
      {open && (
        <div id={id} ref={list} className="usage-pop" role="dialog" aria-label="Usage by provider">
          {summaries.map(({ name, reading, windows }) => (
            <section key={name} aria-label={`${providerName(name)} usage`}>
              <p className="usage-heading">{providerName(name)}</p>
              {windows.length === 0 ? <p className="usage-empty">Usage unavailable</p> : windows.map(w => (
                <UsageBar
                  key={w.label}
                  label={w.label}
                  used={w.used}
                  level={usageLevel(w.used)}
                  sentence={w.minutes === 10080
                    ? weekSentence({ used: w.used, resetsAt: w.resets_at }, now)
                    : `${pct(w.used)}% used${w.resets_at ? ` · resets ${new Date(w.resets_at * 1000).toLocaleString()}` : ""}`}
                  marks={w.minutes
                    ? windowMarks(w.resets_at, w.minutes * 60, w.minutes === 10080 ? DAY_SECS : HOUR_SECS, now)
                    : { marks: [], middles: [], pace: null }}
                  unit={w.minutes === 10080 ? "day" : "hour"}
                />
              ))}
              {name === "claude" && windows.some(w => w.used >= .95) && usage?.switchToCodex && (
                <button className="soft" onClick={() => { setOpen(false); usage.switchToCodex!(); }}>Switch this chat to Codex</button>
              )}
              {reading && <p className="usage-note">Last updated {new Date(reading.updated_at * 1000).toLocaleTimeString()}</p>}
            </section>
          ))}
          {usage && <>
            <p className="usage-heading">Open chats and teams</p>
            <UsageList rows={usage.rows()} onOpen={slot => { setOpen(false); usage.onOpen(slot); }} />
            <p className="usage-note">Totals since each chat started, across providers. These do not add up to a subscription percentage.</p>
          </>}
        </div>
      )}
    </div>
  );
}

const usageLevel = (used: number | null): "ok" | "warn" | "stop" => used !== null && used >= .95 ? "stop" : used !== null && used >= .8 ? "warn" : "ok";

const pct = (used: number) => Math.round(Math.min(1, Math.max(0, used)) * 100);

/**
 * One window as a full bar: what is used, a tick where an even pace would have it at the end of each hour (or day), a
 * marker where an even pace would be now, and the sentence on where it stands.
 */
function UsageBar({ label, used, level, sentence, marks, unit }: { label: string; used: number; level: "ok" | "warn" | "stop"; sentence: string; marks: Marks; unit: "hour" | "day" }) {
  const clock = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const tickTitle = (m: Mark) => {
    const when = new Date(m.when * 1000);
    return `${pct(m.at)}% by ${unit === "day" ? `${when.toLocaleDateString([], { weekday: "short" })} ${clock(when)}` : clock(when)} at an even pace`;
  };
  return (
    <section className={`usage-bar ${level}`} aria-label={label}>
      <div className="usage-bar-head">
        <span className="usage-bar-label">{label}</span>
        <span className="usage-bar-pct">{Math.round(used * 100)}%</span>
      </div>
      <div className="usage-bar-track" role="meter" aria-label={`${label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(used)}>
        <span className="usage-bar-fill" style={{ width: `${pct(used)}%` }} />
        {marks.marks.map((m) => (
          <span key={m.when} className="usage-bar-tick" style={{ left: `${m.at * 100}%` }} title={tickTitle(m)} />
        ))}
        {marks.pace !== null && <span className="usage-bar-pace" style={{ left: `${marks.pace * 100}%` }} title={`An even pace would be at ${pct(marks.pace)}% now`} />}
      </div>
      {unit === "day" && marks.middles.length > 0 && (
        <div className="usage-bar-days" aria-hidden>
          {marks.middles.map((m) => (
            <span key={m.when} style={{ left: `${m.at * 100}%` }}>
              {new Date(m.when * 1000).toLocaleDateString([], { weekday: "short" })}
            </span>
          ))}
        </div>
      )}
      <p className="usage-bar-sentence">{sentence}</p>
    </section>
  );
}

function UsageList({ rows, onOpen }: { rows: UsageRow[]; onOpen: (slot: string) => void }) {
  const [shown, setShown] = useState<Set<string>>(new Set());
  const toggle = (slot: string) =>
    setShown((s) => {
      const next = new Set(s);
      if (!next.delete(slot)) next.add(slot);
      return next;
    });
  if (rows.length === 0) return <p className="usage-empty">Nothing open has used any of it yet.</p>;
  return (
    <ul className="usage-list" aria-label="Chats and teams, biggest first">
      {rows.map((r) => (
        <li key={r.slot}>
          <Row row={r} onOpen={onOpen} expanded={r.members ? shown.has(r.slot) : undefined} onToggle={() => toggle(r.slot)} />
          {r.members && shown.has(r.slot) && (
            <ul className="usage-members" aria-label={`${r.name}'s agents`}>
              {r.members.map((m) => (
                <li key={m.slot}>
                  <Row row={m} onOpen={onOpen} member />
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function Row({ row, onOpen, expanded, onToggle, member }: { row: UsageRow; onOpen: (slot: string) => void; expanded?: boolean; onToggle?: () => void; member?: boolean }) {
  const spent = usageLine(row.cost > 0 ? row.cost : null, row.tokens > 0 ? row.tokens : null);
  const agents = row.members ? row.members.length - 1 : 0;
  const where = [!member && !row.members ? row.project : null, row.members ? (agents === 0 ? "Lead only" : `Lead and ${agents} ${agents === 1 ? "agent" : "agents"}`) : null].filter(Boolean).join(" · ");
  return (
    <div className={`usage-row${member ? " member" : ""}`}>
      {expanded === undefined ? (
        <span className="usage-gap" aria-hidden />
      ) : (
        <button className="icon usage-toggle" aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Show"} ${row.name}'s agents`} title={expanded ? "Hide its agents" : "Show its agents"} onClick={onToggle}>
          <ChevronIcon up={expanded} />
        </button>
      )}
      <span className={`node-dot ${row.state}`} aria-hidden />
      <span className="usage-text">
        <button className="usage-name" title={`Open ${row.name}`} onClick={() => onOpen(row.slot)}>
          {row.name}
        </button>
        <span className="usage-sub">
          {where && `${where}${row.models.length > 0 ? " · " : ""}`}
          <Models models={row.models} />
        </span>
      </span>
      <span className="usage-figures">
        <span className="usage-state">{STATE_LABEL[row.state]}</span>
        <span className="usage-spent">{spent ?? "none yet"}</span>
      </span>
    </div>
  );
}

/** "Sonnet 62%, Opus 38%", with Opus (the dear one) in amber. */
function Models({ models }: { models: ModelShare[] }) {
  if (models.length === 0) return null;
  return (
    <span className="usage-models" title={modelLine(models)}>
      {models.map((m, i) => (
        <span key={m.name} className={m.name === "Opus" ? "opus" : undefined}>
          {i > 0 && ", "}
          {modelLine([m])}
        </span>
      ))}
    </span>
  );
}
