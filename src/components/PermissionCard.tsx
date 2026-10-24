import { useState } from "react";
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
/** Claude's request for approval of one named action (from Lantern's own MCP tool, request_approval). */
export const APPROVAL_TOOL = "Approval";

/** `remember`: an "Always allow…" choice, saved as a rule before the request is answered. */
type Decide = (id: string, allow: boolean, note?: string, answered?: Record<string, unknown>, remember?: NewRule) => void;

export function PermissionCard({ item, onDecide }: { item: PermissionItem; onDecide: Decide }) {
  // Its own kind of card for a chat on another agent than Claude Code, chosen by which agent the chat runs, not by the request.
  if (item.provider && item.provider !== "claude") return <ProviderCard item={item} onDecide={onDecide} />;
  if (item.toolName === PLAN_TOOL) return <PlanCard item={item} onDecide={onDecide} />;
  if (item.toolName === REPRODUCE_TOOL) return <ReproduceCard item={item} onDecide={onDecide} />;
  if (item.toolName === APPROVAL_TOOL) return <ApprovalCard item={item} onDecide={onDecide} />;
  if (item.toolName === QUESTION_TOOL) return <QuestionCard item={item} onDecide={onDecide} />;
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

/** A card whose main text is longer than this is shown cut, says how much is hidden, and can't be allowed until it is all shown. */
const CLIP_LINES = 12;
const CLIP_CHARS = 1500;

const field = (o: Record<string, unknown>, key: string) => (typeof o[key] === "string" ? (o[key] as string) : "");

/** `s` up to its first line, with how many more there are. */
const firstLine = (s: string) => {
  const lines = s.split("\n");
  return lines.length > 1 ? `${lines[0]} (+${lines.length - 1} more lines)` : lines[0] ?? "";
};

// A request from another agent (Codex), as its backend wrote it out: every character that could hide or fake something is
// already an escape, and what it will do is in labelled parts, never one string that could pose as another. Allow stays off
// until all of it has been shown; there is no Always allow…, since a rule here would be one for Claude's tools, not this agent's.
function ProviderCard({ item, onDecide }: { item: PermissionItem; onDecide: Decide }) {
  const [all, setAll] = useState(false);
  const o = (item.input && typeof item.input === "object" ? item.input : {}) as Record<string, unknown>;
  const main = field(o, "command") || field(o, "file_path") || field(o, "permissions");
  const action = field(o, "action");
  if (item.decision !== null) {
    const allowed = item.decision === "allowed";
    return (
      <div className={`permission-done ${item.decision}`}>
        <span className="decision">{allowed ? "✓ Allowed" : "✕ Denied"}</span> {item.toolName}
        <span className="permission-done-detail"> · {firstLine(main || action)}</span>
      </div>
    );
  }
  const lines = main.split("\n");
  const clipped = lines.length > CLIP_LINES || main.length > CLIP_CHARS;
  const shown = clipped && !all ? lines.slice(0, CLIP_LINES).join("\n").slice(0, CLIP_CHARS) : main;
  const unreadable = !main && !action;
  const facts: [string, string][] = [["Runs in", field(o, "cwd")], ["Network", field(o, "network")]];
  const warnings = Array.isArray(o.warnings) ? o.warnings.filter((w): w is string => typeof w === "string") : [];
  const reason = field(o, "description");
  return (
    <div className="permission">
      <div className="permission-title">
        Allow <strong>{item.toolName}</strong>?
      </div>
      {action && <div className="permission-action">{action}</div>}
      {main && <pre className="permission-detail open">{shown}</pre>}
      {clipped && !all && (
        <div className="permission-clipped">
          Shown cut: {lines.length} lines, {main.length} characters in all.{" "}
          <button className="link-button" onClick={() => setAll(true)}>
            Show all
          </button>
        </div>
      )}
      {unreadable && <div className="permission-warning">Codex didn't say what this would do. Deny it.</div>}
      <dl className="permission-facts">
        {facts.filter(([, v]) => v).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {reason && (
        <div className="permission-reason">
          <span>Codex says, and Lantern doesn't check:</span> {reason}
        </div>
      )}
      {warnings.map((w) => (
        <div key={w} className="permission-warning">
          ⚠ {w}
        </div>
      ))}
      <div className="permission-actions">
        <button className="primary" disabled={unreadable || (clipped && !all)} title={clipped && !all ? "Show all of it first" : undefined} onClick={() => onDecide(item.id, true)}>
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

const textOf = (input: unknown, key: string) => (input && typeof input === "object" && typeof (input as Record<string, unknown>)[key] === "string" ? ((input as Record<string, string>)[key]) : "");

// Claude asks before one action that is hard to undo or reaches outside (merging a pull request, pushing a tag). The
// action and details are Claude's own words, shown exactly as written and only as text: never markdown or HTML. Approving
// covers that action alone; nothing is saved, and Lantern doesn't run it.
function ApprovalCard({ item, onDecide }: { item: PermissionItem; onDecide: Decide }) {
  const [note, setNote] = useState("");
  const action = textOf(item.input, "action").trim() || "(no action named)";
  const details = textOf(item.input, "details");
  if (item.decision !== null) {
    return (
      <div className={`permission-done ${item.decision}`}>
        <span className="decision">{item.decision === "allowed" ? "You approved:" : "You declined:"}</span> <span title={item.note ?? undefined}>{action}</span>
        {item.note && <span className="permission-done-detail"> · {item.note.split("\n")[0]}</span>}
      </div>
    );
  }
  const answer = (approved: boolean) => onDecide(item.id, approved, note.trim() || undefined);
  return (
    <div className="permission plan-card approval-card">
      <div className="permission-title">Approval needed</div>
      <div className="approval-action">{action}</div>
      {details && <pre className="permission-detail approval-details">{details}</pre>}
      <textarea
        className="repro-input"
        rows={2}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder="Add a note for Claude (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="permission-actions">
        <button className="primary" onClick={() => answer(true)}>
          Approve
        </button>
        <button onClick={() => answer(false)}>Decline</button>
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
