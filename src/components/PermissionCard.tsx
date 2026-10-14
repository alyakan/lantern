import { useState } from "react";
import { api } from "../api";
import { useSlot } from "../lib/slot";
import { Md } from "./Md";
import type { ChatItem } from "../store";
import { QuestionCard } from "./QuestionCard";
import { QUESTION_TOOL } from "../lib/questions";
import { describeRule, newRule, RULE_SCOPES, ruleChoices } from "../lib/permissionRules";
import type { NewRule } from "../types";

type PermissionItem = Extract<ChatItem, { type: "permission" }>;

/** The tool plan mode ends with; its request carries the plan for the user to approve. */
export const PLAN_TOOL = "ExitPlanMode";
/** Debug mode's request to reproduce the bug (from Lantern's own MCP tool). */
export const REPRODUCE_TOOL = "Reproduce";

/** The main agent's built-in tool for a helper that runs inline (named Agent, and Task before that). */
const AGENT_TOOLS = ["Agent", "Task"];
/** What the main agent reads when you send a helper to the canvas: the same words as CANVAS_REFUSAL in bridge.rs. */
export const CANVAS_REFUSAL = 'Not run inline: the user wants helpers on the canvas, as workers with a chat of their own. Start this one with spawn_agent instead, using the same task as its brief (isolation "shared" if it only reads), then carry on or end your turn; you\'ll get a note when it finishes a turn.';

/** `remember`: an "Always allow…" choice, saved as a rule before the request is answered. */
type Decide = (id: string, allow: boolean, note?: string, answered?: Record<string, unknown>, remember?: NewRule) => void;

export function PermissionCard({ item, onDecide }: { item: PermissionItem; onDecide: Decide }) {
  if (item.toolName === PLAN_TOOL) return <PlanCard item={item} onDecide={onDecide} />;
  if (item.toolName === REPRODUCE_TOOL) return <ReproduceCard item={item} onDecide={onDecide} />;
  if (item.toolName === QUESTION_TOOL) return <QuestionCard item={item} onDecide={onDecide} />;
  if (AGENT_TOOLS.includes(item.toolName)) return <AgentCard item={item} onDecide={onDecide} />;
  return <ToolCard item={item} onDecide={onDecide} />;
}

// Any other tool: Allow or Deny, and Always allow… for a rule that covers this kind of call from now on.
function ToolCard({ item, onDecide }: { item: PermissionItem; onDecide: Decide }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const detail = describeInput(item.input);
  if (item.decision !== null && item.autoRule) {
    return (
      <div className="permission-done allowed auto">
        <span className="decision">Allowed by your rule:</span> {describeRule(item.autoRule.rule)}
        <span className="permission-done-detail"> · {detail.split("\n")[0]}</span>
      </div>
    );
  }
  if (item.decision !== null) {
    const allowed = item.decision === "allowed";
    return (
      <div className={`permission-done ${item.decision}`}>
        <span className="decision">{allowed ? "✓ Allowed" : "✕ Denied"}</span> {item.toolName}
        <span className="permission-done-detail"> · {detail.split("\n")[0]}</span>
      </div>
    );
  }
  const choices = ruleChoices(item.toolName, item.input);
  return (
    <div className="permission">
      <div className="permission-title">
        Allow <strong>{item.toolName}</strong>?
      </div>
      <pre className="permission-detail">{detail}</pre>
      <div className="permission-actions">
        <button className="primary" onClick={() => onDecide(item.id, true)}>
          Allow
        </button>
        {choices.length > 0 && (
          <button aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
            Always allow…
          </button>
        )}
        <button onClick={() => onDecide(item.id, false)}>Deny</button>
      </div>
      {menuOpen && (
        <div className="always-menu">
          {RULE_SCOPES.map(([scope, heading]) => (
            <div key={scope} role="group" aria-label={heading} className="always-group">
              <div className="always-heading">{heading}</div>
              {choices.map((rule) => (
                <button key={describeRule(rule)} onClick={() => onDecide(item.id, true, undefined, undefined, newRule(scope, rule))}>
                  {describeRule(rule)}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const text = (input: unknown, key: string) => (input && typeof input === "object" && typeof (input as Record<string, unknown>)[key] === "string" ? ((input as Record<string, string>)[key] ?? "").trim() : "");

// The main agent wants to run a helper inline. Helpers belong on the canvas, where they get a card, a chat and a worktree,
// so you choose where this one goes (and, ticked, where they all go in this chat).
function AgentCard({ item, onDecide }: { item: PermissionItem; onDecide: Decide }) {
  const slot = useSlot();
  const [same, setSame] = useState(true);
  const what = text(item.input, "description") || "A helper";
  const kind = text(item.input, "subagent_type");
  if (item.decision !== null) {
    return (
      <div className={`permission-done ${item.decision}`}>
        <span className="decision">{item.decision === "allowed" ? "✓ Ran inline" : "→ Sent to the canvas"}</span> {what}
      </div>
    );
  }
  const choose = (inline: boolean) => {
    const answer = () => onDecide(item.id, inline, inline ? undefined : CANVAS_REFUSAL);
    if (!same) return answer();
    // Saved first, so the chat's next helper is answered by it; if it can't be saved this one is still answered.
    api.setAgentChoice(slot, inline ? "inline" : "canvas").catch(() => {}).then(answer);
  };
  return (
    <div className="permission">
      <div className="permission-title">
        Run this helper on the canvas? <strong>{what}</strong>
        {kind && <span className="permission-kind">{kind}</span>}
      </div>
      {text(item.input, "prompt") && <pre className="permission-detail">{text(item.input, "prompt")}</pre>}
      <div className="permission-actions">
        <button className="primary" title="It becomes a worker with a card, a chat and, if it writes, a branch of its own" onClick={() => choose(false)}>
          Run on canvas
        </button>
        <button title="It runs inside the main agent's chat, shown only in the Agents tab" onClick={() => choose(true)}>
          Run inline
        </button>
      </div>
      <label className="permission-same">
        <input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} />
        Same for the rest of this chat
      </label>
    </div>
  );
}

const planOf = (input: unknown) => (input && typeof input === "object" && typeof (input as { plan?: unknown }).plan === "string" ? (input as { plan: string }).plan : "");

// Plan mode's result: the plan, and whether to go ahead with it. Once answered it folds to one line that reopens.
function PlanCard({ item, onDecide }: { item: PermissionItem; onDecide: Decide }) {
  const [open, setOpen] = useState(false);
  const plan = (
    <div className="plan-body">
      <Md>
        {planOf(item.input) || "_Claude didn't include the plan._"}
      </Md>
    </div>
  );
  if (item.decision !== null) {
    return (
      <div className="plan-card done">
        <button className="activity-line" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="chev" aria-hidden />
          <span className="activity-text">{item.decision === "allowed" ? "Plan approved" : "Kept planning"}</span>
        </button>
        {open && plan}
      </div>
    );
  }
  return (
    <div className="permission plan-card">
      <div className="permission-title">Plan ready</div>
      {plan}
      <div className="permission-actions">
        <button className="primary" onClick={() => onDecide(item.id, true)}>
          Approve plan
        </button>
        <button onClick={() => onDecide(item.id, false)}>Keep planning</button>
      </div>
    </div>
  );
}

const stepsOf = (input: unknown) => (input && typeof input === "object" && typeof (input as { steps?: unknown }).steps === "string" ? (input as { steps: string }).steps : "");

// Debug mode: Claude has its logging in place and waits while you trigger the bug. What you type (often the logs you
// saw) goes back to it with your answer.
function ReproduceCard({ item, onDecide }: { item: PermissionItem; onDecide: Decide }) {
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const steps = (
    <div className="plan-body">
      <Md>
        {stepsOf(item.input) || "_Reproduce the bug the way you found it._"}
      </Md>
    </div>
  );
  if (item.decision !== null) {
    return (
      <div className="plan-card done">
        <button className="activity-line" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="chev" aria-hidden />
          <span className="activity-text">{item.decision === "allowed" ? "You reproduced it" : "Couldn't reproduce"}</span>
        </button>
        {open && (
          <>
            {steps}
            {item.note && <pre className="permission-detail repro-note">{item.note}</pre>}
          </>
        )}
      </div>
    );
  }
  const answer = (reproduced: boolean) => onDecide(item.id, reproduced, note.trim() || undefined);
  return (
    <div className="permission plan-card">
      <div className="permission-title">Reproduce the bug</div>
      {steps}
      <textarea
        className="repro-input"
        rows={3}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder="What did you see? Paste the [lantern-debug] logs or anything odd (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="permission-actions">
        <button className="primary" onClick={() => answer(true)}>
          I've reproduced it
        </button>
        <button onClick={() => answer(false)}>Couldn't reproduce</button>
      </div>
    </div>
  );
}

export function describeInput(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const key of ["command", "file_path", "url", "query"]) if (typeof o[key] === "string") return o[key] as string;
  }
  return JSON.stringify(input, null, 2);
}
