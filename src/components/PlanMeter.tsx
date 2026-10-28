import { useState } from "react";
import { planLevel, planLine, planSentence, usePlanUsage } from "../lib/planUsage";
import { useWeekUsage, WEEK_SECS, weekLevel, weekLine, weekSentence } from "../lib/weekUsage";
import { DAY_SECS, HOUR_SECS, SESSION_SECS, windowMarks, type Mark, type Marks } from "../lib/usageMarks";
import { usageLine } from "../lib/cost";
import { modelLine, type ModelShare, type UsageRow, type UsageState } from "../lib/usage";
import { usePopover } from "../lib/usePopover";
import { ChevronIcon } from "./icons";

interface Props {
  /** What the popover lists (computed when it opens), and opening one of the chats. Left out: the meter is only a reading. */
  usage?: { rows: () => UsageRow[]; onOpen: (slot: string) => void };
}

const STATE_LABEL: Record<UsageState, string> = { working: "Working", waiting: "Needs you", idle: "Idle", ended: "Stopped" };

/**
 * How full the five-hour session and the week are, once claude has said: the session amber from 80%, red from 95% (no new
 * workers then). Pressed, it shows both as bars marked with an even pace, and where the use went: every open chat and
 * team, biggest first.
 */
export function PlanMeter({ usage }: Props) {
  const plan = usePlanUsage();
  const week = useWeekUsage();
  const [open, setOpen] = useState(false);
  const { box, button, list, id } = usePopover(open, () => setOpen(false));
  if (!plan) return null;
  const level = planLevel(plan);
  const title = level === "stop" ? "Nearly used up: no new agents start until it resets." : level === "warn" ? "Getting close to the five-hour session limit." : "The five-hour session and the week, for every chat and team. Press to see both and where the use went.";
  // Each window as a word, its percentage and a thin bar; the week amber when its pace runs it out before the reset.
  const sessionMini = <MiniMeter label="Session" used={plan.used} level={level} />;
  const weekMini = week && <MiniMeter label="Week" used={week.used} level={weekLevel(week)} />;
  if (!usage) {
    return (
      <>
        <span className={`plan-meter ${level}`} role="status" title={title}>
          {sessionMini}
        </span>
        {week && (
          <span className={`plan-meter ${weekLevel(week)}`} role="status" title={weekSentence(week)}>
            {weekMini}
          </span>
        )}
      </>
    );
  }
  const now = Date.now();
  return (
    <div className="plan-meter-box" ref={box}>
      <button
        ref={button}
        className={`plan-meter ${level}`}
        aria-label={[planLine(plan), week && weekLine(week)].filter(Boolean).join(", ")}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        title={title}
        onClick={() => setOpen(!open)}
      >
        {sessionMini}
        {weekMini}
        <ChevronIcon up={open} />
      </button>
      {open && (
        <div id={id} ref={list} className="usage-pop" role="dialog" aria-label="Session and weekly usage">
          <UsageBar label="Session" used={plan.used} level={level} sentence={planSentence(plan, now)} marks={windowMarks(plan.resetsAt, SESSION_SECS, HOUR_SECS, now)} unit="hour" />
          {week && <UsageBar label="Week" used={week.used} level={weekLevel(week, now)} sentence={weekSentence(week, now)} marks={windowMarks(week.resetsAt, WEEK_SECS, DAY_SECS, now)} unit="day" />}
          <p className="usage-heading">Where it went</p>
          <UsageList
            rows={usage.rows()}
            onOpen={(slot) => {
              setOpen(false);
              usage.onOpen(slot);
            }}
          />
          <p className="usage-note">Since each chat or team started, not just this window. Closed ones aren't counted, so it won't add up to the plan's percentage. Models are from each one's latest turn.</p>
        </div>
      )}
    </div>
  );
}

const pct = (used: number) => Math.round(Math.min(1, Math.max(0, used)) * 100);

/** "Session 42%" over a thin bar, for the title bar. */
function MiniMeter({ label, used, level }: { label: string; used: number; level: "ok" | "warn" | "stop" }) {
  return (
    <span className={`mini-meter ${level}`}>
      <span className="mini-meter-text">
        {label} {Math.round(used * 100)}%
      </span>
      <span className="mini-meter-track" aria-hidden>
        <span className="mini-meter-fill" style={{ width: `${pct(used)}%` }} />
      </span>
    </span>
  );
}

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
