import { useEffect, useState } from "react";
import { api } from "../api";
import type { RuleEntry } from "../types";
import { rulePattern } from "../lib/permissionRules";

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

/** The "Always allow" rules (Settings > Allow rules): this chat's (when one is open) and each folder's. A rule allows a call without a card; Deny still asks. */
export function PermissionRules({ slot }: { slot: string | null }) {
  const [rules, setRules] = useState<RuleEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.listPermissionRules(slot).then(setRules, (e) => setError(errText(e)));
  useEffect(() => {
    api.listPermissionRules(slot).then(setRules, (e) => setError(errText(e)));
  }, [slot]);
  const remove = (entry: RuleEntry) => api.removePermissionRule(slot, entry).then(load, (e) => setError(errText(e)));

  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">Allow rules</h2>
          <p className="mode-guide-summary">
            Rules that let Claude run a kind of call without asking. Make one with Always allow… on a permission card. This chat's rules end with the chat; a folder's apply to every chat in it. A rule only ever allows: Deny still asks.
          </p>
          <p className="settings-muted">
            A rule checks a file's path when the request arrives. A rule can't see a link that's changed while the command is starting, so a folder rule covers the files you expect, not a sandbox. A build or test rule runs project code (test and build scripts). Rules never cover git, editor, Claude or build config and package files (.git, .claude, .vscode, .cargo, package.json, Cargo.toml and the like), in any letter case, or a file that has a second name (a hard link).
          </p>
        </div>
      </div>
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      {rules === null && !error && <div className="settings-loading">Loading…</div>}
      {rules?.length === 0 && (
        <div className="settings-empty">
          <p className="mode-guide-summary">
            No rules yet. When Claude asks to run something you'd allow every time, choose Always allow… on its card, then This chat or This folder. A short list of read-only, build and test commands (git status, npm test, cargo build, ls…) can get a rule for their start, with only the flags they're known to take. Anything else gets a rule for that one exact command.
          </p>
          {!slot && <p className="settings-muted">Open a chat to see its rules.</p>}
        </div>
      )}
      <ul className="settings-list" aria-label="Allow rules">
        {rules?.map((r) => (
          <li key={JSON.stringify(r)} className="settings-row rule-row">
            <span className="settings-row-name rule-scope">{r.scope === "chat" ? "This chat" : "This folder"}</span>
            <span className="rule-text" title={`${r.folder ? `${r.folder} · ` : ""}${r.tool} · ${rulePattern(r)}`}>
              {r.folder ? `${r.folder} · ` : ""}
              {r.tool}
              <span className="rule-pattern">{rulePattern(r)}</span>
            </span>
            <button onClick={() => remove(r)} aria-label={`Remove the rule for ${r.tool}, ${rulePattern(r)}`}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
