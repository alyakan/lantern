import { useEffect, useState } from "react";
import { api } from "../api";
import type { Account } from "../types";
import { SettingsHint } from "./SettingsRow";

export interface AccountsSettingsProps {
  /** Where Claude Code is, for signing an account in and out (null: not found yet). */
  claudePath: string | null;
  /** The list changed (one was added or removed): the window asks again, and forgets a removed one. */
  onChanged: (accounts: Account[], removed?: string) => void;
}

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

/** Who each account is signed in as: undefined while it is being asked, null when it isn't signed in. */
type Who = Record<string, string | null | undefined>;

/**
 * Settings → Accounts: a second Claude sign-in. Each account has a Claude folder of its own (so its login and usage are its own),
 * with your CLAUDE.md, skills, plugins, hooks and chat history shared into it. A new chat picks one beside its model.
 */
export function AccountsSettings({ claudePath, onChanged }: AccountsSettingsProps) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [who, setWho] = useState<Who>({});
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = (list: Account[]) => {
    if (!claudePath) return;
    for (const a of list) {
      api.claudeLogin(claudePath, a.id).then(
        (l) => setWho((w) => ({ ...w, [a.id]: l.logged_in ? (l.account ?? "Signed in") : null })),
        () => setWho((w) => ({ ...w, [a.id]: null })),
      );
    }
  };
  useEffect(() => {
    api.listAccounts().then(
      (list) => {
        setAccounts(list);
        ask(list);
      },
      (e) => {
        setAccounts([]);
        setError(errText(e));
      },
    );
  }, [claudePath]);

  if (!accounts) return <div className="settings-loading">Loading…</div>;

  const signIn = (a: Account) => {
    if (!claudePath) return;
    setBusy(a.id);
    setError(null);
    api.accountLogin(claudePath, a.id).then(
      (l) => {
        setBusy(null);
        setWho((w) => ({ ...w, [a.id]: l.logged_in ? (l.account ?? "Signed in") : null }));
      },
      (e) => {
        setBusy(null);
        setError(errText(e));
      },
    );
  };
  const add = () => {
    setBusy("add");
    setError(null);
    api.addAccount(name).then(
      (a) => {
        const list = [...accounts, a];
        setAccounts(list);
        setName("");
        setBusy(null);
        onChanged(list);
        // A new account has no login yet: signing it in is the next step.
        signIn(a);
      },
      (e) => {
        setBusy(null);
        setError(errText(e));
      },
    );
  };
  const remove = (a: Account) => {
    if (!claudePath) return;
    setBusy(a.id);
    setError(null);
    api.removeAccount(claudePath, a.id).then(
      () => {
        const list = accounts.filter((x) => x.id !== a.id);
        setAccounts(list);
        setBusy(null);
        onChanged(list, a.id);
      },
      (e) => {
        setBusy(null);
        setError(errText(e));
      },
    );
  };

  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">Accounts</h2>
          <p className="mode-guide-summary">
            Use a second Claude login (a work and a personal plan, say). Each account keeps its own sign-in and usage limits; your CLAUDE.md, skills, plugins, hooks and chat history are shared into it, so a chat on it works like any other. Pick the account in a new chat, beside the model.
          </p>
        </div>
      </div>
      <SettingsHint>Your own login stays the default. User-level MCP servers live in Claude Code's own login file, so they aren't shared: add them again on an account that needs them. Removing an account signs it out and deletes its folder, never your own setup.</SettingsHint>
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      {!claudePath && <div className="settings-muted">Claude Code wasn't found, so accounts can't be signed in yet.</div>}
      {accounts.length === 0 ? (
        <div className="settings-muted">No accounts yet. Add one to choose it from a new chat.</div>
      ) : (
        <ul className="settings-list">
          {accounts.map((a) => (
            <li key={a.id} className="settings-row account-row">
              <div className="account-who">
                <div>{a.name}</div>
                <span className="settings-row-sub">{who[a.id] === undefined ? "Checking…" : who[a.id] ? `Signed in as ${who[a.id]}` : "Not signed in"}</span>
              </div>
              <div className="endpoint-actions">
                <button type="button" disabled={!claudePath || busy !== null} onClick={() => signIn(a)}>
                  {busy === a.id ? "Waiting for the browser…" : who[a.id] ? "Sign in again" : "Sign in"}
                </button>
                <button type="button" className="link-button" disabled={!claudePath || busy !== null} onClick={() => remove(a)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="endpoint-add account-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && busy === null) add();
        }}
      >
        <input aria-label="Account name" value={name} maxLength={30} placeholder="Name, e.g. Work" onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={!name.trim() || !claudePath || busy !== null}>
          Add and sign in
        </button>
      </form>
    </>
  );
}
