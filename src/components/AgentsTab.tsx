import { useEffect, useRef } from "react";
import type { ModelCost } from "../types";
import type { AgentTree, LogEntry } from "../lib/agents";
import { shortModel } from "../lib/agents";
import { familyOf } from "../lib/harness";
import { effortLabel } from "./EffortPicker";
import { elapsed } from "../lib/time";

const tone = (model: string | null) => familyOf(model) ?? "none";
const clock = (at: number | null) => (at ? new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`);

const STATUS_LABEL = { running: "running", done: "done", error: "failed" } as const;
const CALL_LABEL = { advising: "Advising…", reviewed: "Reviewed", declined: "Declined", unavailable: "Unavailable" } as const;

/** The right pane's Agents tab: which agent and model does what in the latest turn, live while it runs. */
export function AgentsTab({ tree, usage }: { tree: AgentTree; usage: ModelCost[] }) {
  if (!tree.prompt) return <div className="agents-empty">Send a task to see which agent and model does what. Subagents and the advisor show here as they work.</div>;
  const { main, advisor, subagents, back, live } = tree;
  const working = subagents.some((s) => s.status === "running");
  return (
    <div className={`agents${live ? " live" : ""}`}>
      <div className="agents-head">
        <span className={`agents-state${live ? " live" : ""}`}>{live ? "Live" : "Last turn"}</span>
        <span className="agents-prompt" title={tree.prompt}>
          {tree.prompt}
        </span>
      </div>
      <div className="agents-board">
        {(advisor.model || advisor.calls.length > 0) && (
          <aside className={`agents-card advisor tone-${tone(advisor.model)}${advisor.calls.some((c) => c.status === "advising") ? " active" : ""}`} aria-label="Advisor">
            <div className="agents-card-title">
              Advisor <span className="agents-model">{shortModel(advisor.model) ?? "Claude Code's"}</span>
            </div>
            <div className="agents-card-sub">On call: Claude consults it before committing to a plan, when errors repeat, and before it's done.</div>
            {advisor.calls.length === 0 ? (
              <div className="agents-quiet">Not consulted this turn</div>
            ) : (
              <ol className="agents-calls">
                {advisor.calls.map((c) => (
                  <li key={c.id} className={`agents-call ${c.status}`}>
                    <span className="agents-call-moment" title="Inferred from where in the turn it happened">
                      {c.moment}
                    </span>
                    <span className="agents-chip">
                      {CALL_LABEL[c.status]}
                      {c.detail ? ` (${c.detail})` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </aside>
        )}
        <div className="agents-flow">
          <div className={`agents-card main tone-${tone(main.model)}${live && !working ? " active" : ""}`} aria-label="Main session">
            <div className="agents-card-title">
              Main session <span className="agents-model">{shortModel(main.model) ?? "default model"}</span>
              {main.effort && <span className="agents-effort">{effortLabel(main.effort)}</span>}
            </div>
            <div className="agents-now">{main.now ?? (back ? "Reviewed what came back" : "Done")}</div>
          </div>
          {subagents.length > 0 && (
            <>
              <div className={`agents-link${working ? " flowing" : ""}`} aria-hidden />
              <div className="agents-subs">
                {subagents.map((s) => (
                  <div key={s.id} className={`agents-card sub tone-${tone(s.model)} ${s.status}${s.status === "running" ? " active" : ""}`} aria-label={`${s.type}: ${s.description}`}>
                    <div className="agents-card-title">
                      {s.type} <span className="agents-model">{shortModel(s.model) ?? "…"}</span>
                    </div>
                    <div className="agents-card-sub" title={s.description}>
                      {s.description}
                    </div>
                    <div className="agents-now">{s.now}</div>
                    <div className="agents-stats">
                      <span className="agents-chip">{STATUS_LABEL[s.status]}</span>
                      {s.steps > 0 && <span>{s.steps === 1 ? "1 step" : `${s.steps} steps`}</span>}
                      {s.tokens !== null && <span>{tokens(s.tokens)} tokens</span>}
                      {s.ms !== null && s.ms >= 1000 && <span>{elapsed(s.ms)}</span>}
                    </div>
                  </div>
                ))}
              </div>
              <div className={`agents-link${back && live ? " flowing up" : ""}`} aria-hidden />
              <div className={`agents-card back tone-${tone(main.model)}${back ? " reached" : ""}`}>
                <div className="agents-card-title">Back to main</div>
                <div className="agents-now">{back ? "Reviewing what the subagents found" : "Waiting for the subagents"}</div>
              </div>
            </>
          )}
        </div>
      </div>
      <Log entries={tree.log} live={live} />
      {!live && usage.length > 0 && (
        <div className="agents-usage" aria-label="Cost by model">
          {usage.map((u) => (
            <span key={u.model} className={`tone-${tone(u.model)}`}>
              <span className="agents-dot" aria-hidden />
              {shortModel(u.model)} ${u.cost_usd.toFixed(2)} · {tokens(u.output_tokens)} out
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Who did what, newest at the bottom, following the end while it grows. */
function Log({ entries, live }: { entries: LogEntry[]; live: boolean }) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [entries.length]);
  if (entries.length === 0) return null;
  return (
    <ol className="agents-log" ref={list} aria-label="Session log">
      {entries.map((e, i) => (
        <li key={`${e.id}:${i}`} className={`${e.status}${live && i === entries.length - 1 ? " latest" : ""}`}>
          <span className="agents-log-time">{clock(e.at)}</span>
          <span className={`agents-log-agent tone-${tone(e.model)}`}>{e.agent}</span>
          <span className="agents-log-text">{e.text}</span>
          <span className="agents-log-model">{shortModel(e.model)}</span>
        </li>
      ))}
    </ol>
  );
}
