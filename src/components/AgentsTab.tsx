import { useEffect, useRef } from "react";
import type { ModelCost } from "../types";
import type { AgentTree, LogEntry } from "../lib/agents";
import { shortModel } from "../lib/agents";
import type { AgentGraph as Graph } from "../lib/agentGraph";
import { familyOf } from "../lib/harness";
import { AgentGraph } from "./AgentGraph";

const tone = (model: string | null) => familyOf(model) ?? "none";
const clock = (at: number | null) => (at ? new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`);

/** The right pane's Agents tab: which agent and model does what in the latest turn, live while it runs. */
export function AgentsTab({ tree, graph, usage }: { tree: AgentTree; graph: Graph; usage: ModelCost[] }) {
  if (!tree.prompt) return <div className="agents-empty">Send a task to see which agent and model does what. Subagents and the advisor show here as they work.</div>;
  const { live } = tree;
  return (
    <div className={`agents${live ? " live" : ""}`}>
      <div className="agents-head">
        <span className={`agents-state${live ? " live" : ""}`}>{live ? "Live" : "Last turn"}</span>
        <span className="agents-prompt" title={tree.prompt}>
          {tree.prompt}
        </span>
      </div>
      <AgentGraph graph={graph} />
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
