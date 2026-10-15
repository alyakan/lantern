import { useState } from "react";
import { planLevel, planLine, planSentence, usePlanUsage } from "../lib/planUsage";
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
 * How full the plan's five-hour window is, once claude has said: amber from 80%, red from 95% (no new workers then).
 * Pressed, it lists where the use went: every open chat and team, biggest first.
 */
export function PlanMeter({ usage }: Props) {
  const plan = usePlanUsage();
  const [open, setOpen] = useState(false);
  const { box, button, list, id } = usePopover(open, () => setOpen(false));
  if (!plan) return null;
  const level = planLevel(plan);
  const title = level === "stop" ? "Nearly used up: no new agents start until it resets." : level === "warn" ? "Getting close to the plan's five-hour limit." : "The plan's five-hour window, for every chat and team. Press to see where it went.";
  if (!usage) {
    return (
      <span className={`plan-meter ${level}`} role="status" title={title}>
        {planLine(plan)}
      </span>
    );
  }
  return (
    <div className="plan-meter-box" ref={box}>
      <button ref={button} className={`plan-meter ${level}`} aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined} title={title} onClick={() => setOpen(!open)}>
        {planLine(plan)}
      </button>
      {open && (
        <div id={id} ref={list} className="usage-pop" role="dialog" aria-label="Where the plan's usage went">
          <p className="usage-plan">{planSentence(plan)}</p>
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
