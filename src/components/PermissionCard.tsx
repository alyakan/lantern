import { useState } from "react";
import { Md } from "./Md";
import type { ChatItem } from "../store";
import { QuestionCard } from "./QuestionCard";
import { QUESTION_TOOL } from "../lib/questions";

type PermissionItem = Extract<ChatItem, { type: "permission" }>;

/** The tool plan mode ends with; its request carries the plan for the user to approve. */
export const PLAN_TOOL = "ExitPlanMode";
/** Debug mode's request to reproduce the bug (from Lantern's own MCP tool). */
export const REPRODUCE_TOOL = "Reproduce";

type Decide = (id: string, allow: boolean, note?: string, answered?: Record<string, unknown>) => void;

export function PermissionCard({ item, onDecide }: { item: PermissionItem; onDecide: Decide }) {
  if (item.toolName === PLAN_TOOL) return <PlanCard item={item} onDecide={onDecide} />;
  if (item.toolName === REPRODUCE_TOOL) return <ReproduceCard item={item} onDecide={onDecide} />;
  if (item.toolName === QUESTION_TOOL) return <QuestionCard item={item} onDecide={onDecide} />;
  const detail = describeInput(item.input);
  if (item.decision !== null) {
    const allowed = item.decision === "allowed";
    return (
      <div className={`permission-done ${item.decision}`}>
        <span className="decision">{allowed ? "✓ Allowed" : "✕ Denied"}</span> {item.toolName}
        <span className="permission-done-detail"> · {detail.split("\n")[0]}</span>
      </div>
    );
  }
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
        <button onClick={() => onDecide(item.id, false)}>Deny</button>
      </div>
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
