import { useEffect, useState } from "react";
import { api } from "../api";
import type { RuleEntry } from "../types";
import { HAND_TOOLS, handMatches, handRule, newRule, rulePattern, type HandForm, type HandMatch, type HandTool } from "../lib/permissionRules";

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

const TOOL_LABEL: Record<HandTool, string> = { Bash: "Bash (a command)", Read: "Read (a file)", Edit: "Edit (a file)", Write: "Write (a file)", WebFetch: "WebFetch (a web page)", WebSearch: "WebSearch", other: "Another tool…" };
const MATCH_LABEL: Record<HandMatch, string> = { prefix: "Commands starting with", exact: "This exact command", dir: "Files in a folder", any: "Every call" };
const PLACEHOLDER: Record<HandMatch, string> = { prefix: "npm test", exact: "npm run build", dir: "/Users/you/project/src", any: "" };
const EMPTY_FORM: HandForm = { tool: "Bash", otherName: "", match: "prefix", pattern: "", scope: "folder" };

/** The "Always allow" rules (Settings > Allow rules): this chat's (when one is open) and each folder's. A rule allows a call without a card; Deny still asks. */
export function PermissionRules({ slot }: { slot: string | null }) {
  const [rules, setRules] = useState<RuleEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.listPermissionRules(slot).then(setRules, (e) => setError(errText(e)));
  useEffect(() => {
    api.listPermissionRules(slot).then(setRules, (e) => setError(errText(e)));
  }, [slot]);
  const [form, setForm] = useState<HandForm>(EMPTY_FORM);
  const [confirming, setConfirming] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const made = handRule(form);
  const edit = (patch: Partial<HandForm>) => {
    setForm((f) => {
      const next = { ...f, ...patch };
      // A tool's first way of covering calls is its default, and a pattern for one way isn't for another.
      if (patch.tool && !handMatches(next.tool).includes(next.match)) next.match = handMatches(next.tool)[0];
      if (patch.tool || patch.match) next.pattern = "";
      return next;
    });
    setConfirming(false);
    setAdded(null);
  };
  const add = () => {
    if (!slot || "error" in made) return;
    if (made.broad && !confirming) return setConfirming(true);
    api.addPermissionRule(slot, newRule(form.scope, made.rule)).then(
      () => {
        setError(null);
        setAdded(made.meaning);
        setConfirming(false);
        setForm((f) => ({ ...f, pattern: "" }));
        load();
      },
      (e) => setError(errText(e)),
    );
  };
  const remove = (entry: RuleEntry) => api.removePermissionRule(slot, entry).then(load, (e) => setError(errText(e)));

  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">Allow rules</h2>
          <p className="mode-guide-summary">
            Rules that let Claude run a kind of call without asking. Make one with Always allow… on a permission card, or add one below. This chat's rules end with the chat; a folder's apply to every chat in it. A rule only ever allows: Deny still asks.
          </p>
          <p className="settings-muted">
            A rule checks a file's path when the request arrives. A rule can't see a link that's changed while the command is starting, so a folder rule covers the files you expect, not a sandbox. A build or test rule runs project code (test and build scripts). Rules never cover git, editor, Claude or build config and package files (.git, .claude, .vscode, .cargo, package.json, Cargo.toml and the like), in any letter case, or a file that has a second name (a hard link).
          </p>
        </div>
      </div>
      <form
        className="rule-add"
        aria-label="Add a rule"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <h3 className="general-title">Add a rule</h3>
        <div className="rule-add-fields">
          <label>
            Tool
            <select value={form.tool} onChange={(e) => edit({ tool: e.target.value as HandTool })} disabled={!slot}>
              {HAND_TOOLS.map((t) => (
                <option key={t} value={t}>
                  {TOOL_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          {form.tool === "other" && (
            <label>
              Tool name
              <input value={form.otherName} onChange={(e) => edit({ otherName: e.target.value })} placeholder="mcp__linear__save_issue" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={!slot} />
            </label>
          )}
          {handMatches(form.tool).length > 1 && (
            <label>
              Covers
              <select value={form.match} onChange={(e) => edit({ match: e.target.value as HandMatch })} disabled={!slot}>
                {handMatches(form.tool).map((m) => (
                  <option key={m} value={m}>
                    {MATCH_LABEL[m]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {handMatches(form.tool).includes(form.match) && form.match !== "any" && (
            <label className="rule-add-pattern">
              {form.match === "dir" ? "Folder" : "Command"}
              <input value={form.pattern} onChange={(e) => edit({ pattern: e.target.value })} placeholder={PLACEHOLDER[form.match]} autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={!slot} />
            </label>
          )}
          <label>
            Applies to
            <select value={form.scope} onChange={(e) => edit({ scope: e.target.value as HandForm["scope"] })} disabled={!slot}>
              <option value="folder">This folder</option>
              <option value="chat">This chat</option>
            </select>
          </label>
        </div>
        {slot && "meaning" in made && <p className="rule-add-meaning">{made.meaning}, {form.scope === "chat" ? "in this chat" : "in this folder"}.</p>}
        {slot && "error" in made && form.pattern.trim() !== "" && (
          <p className="rule-add-problem" role="status">
            {made.error}
          </p>
        )}
        {slot && "meaning" in made && made.broad && (
          <p className="rule-add-broad" role="alert">
            {made.broad}
          </p>
        )}
        <div className="rule-add-actions">
          {confirming ? (
            <>
              <button type="submit" className="danger">
                Yes, allow it without asking
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="submit" disabled={!slot || "error" in made}>
              Add rule
            </button>
          )}
          {added && <span className="settings-muted rule-add-done">Added: {added}.</span>}
          {!slot && <span className="settings-muted">Open a chat to add a rule.</span>}
        </div>
      </form>
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
