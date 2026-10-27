import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Endpoint, EndpointStatus } from "../types";

export interface EndpointsSettingsProps {
  /** The list was saved: the window asks again which providers there are. */
  onSaved: () => void;
}

/** A starting point for each common server: where it listens, and the variable its key is usually in. */
const PRESETS: { label: string; url: string; keyEnv: string | null }[] = [
  { label: "Ollama", url: "http://localhost:11434", keyEnv: null },
  { label: "LM Studio", url: "http://localhost:1234", keyEnv: null },
  { label: "LiteLLM", url: "http://localhost:4000", keyEnv: "LITELLM_API_KEY" },
  { label: "OpenRouter", url: "https://openrouter.ai/api", keyEnv: "OPENROUTER_API_KEY" },
];

/** A row being edited: the endpoint, a key of its own for the list, and what the form shows of it. */
interface Row extends Endpoint {
  key: string;
  /** The models as typed (one per line, or separated by commas or spaces). */
  modelsText: string;
  keySet: boolean | null;
  /** A key is saved for it in the Keychain (it wins over the variable). */
  savedKey: boolean;
  /** The address it was saved with: a saved key is only sent there, so Fetch names the endpoint only while the address is that one. */
  savedUrl: string;
  /** A key being typed for it (never kept past Save), and why saving or removing one failed. */
  keyDraft: string;
  keyError: string | null;
  /** Why Fetch didn't fill the models in. */
  fetchError: string | null;
  fetching: boolean;
}

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
const parseModels = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];
let nextKey = 0;

const rowOf = (e: Endpoint, keySet: boolean | null, savedKey = false): Row => ({ ...e, key: `row-${nextKey++}`, modelsText: e.models.join("\n"), keySet, savedKey, savedUrl: e.url, keyDraft: "", keyError: null, fetchError: null, fetching: false });
const endpointOf = (r: Row): Endpoint => ({ id: r.id, name: r.name, url: r.url, key_env: r.key_env?.trim() ? r.key_env.trim() : null, models: parseModels(r.modelsText) });

/**
 * Settings → Endpoints: where a chat can run besides Anthropic's. Claude Code is sent to the endpoint (a LiteLLM or OpenRouter
 * URL, a local Ollama or LM Studio), on one of the models listed here. A key is kept in the Keychain, or only the NAME of the variable holding it.
 */
export function EndpointsSettings({ onSaved }: EndpointsSettingsProps) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saved, setSaved] = useState<string>("[]");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fresh = useRef<string | null>(null);

  const load = () =>
    api.listEndpoints().then(
      (list: EndpointStatus[]) => {
        setRows(list.map((e) => rowOf(e, e.key_set, e.saved_key)));
        setSaved(JSON.stringify(list.map((e) => endpointOf(rowOf(e, null)))));
        setError(null);
      },
      (e) => {
        setRows([]);
        setError(errText(e));
      },
    );
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (fresh.current) document.getElementById(fresh.current)?.focus();
    fresh.current = null;
  }, [rows?.length]);

  if (!rows) return <div className="settings-loading">Loading…</div>;
  const dirty = JSON.stringify(rows.map(endpointOf)) !== saved;
  const change = (key: string, patch: Partial<Row>) => setRows((all) => (all ?? []).map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const add = (preset?: (typeof PRESETS)[number]) => {
    const row = rowOf({ id: "", name: preset?.label ?? "", url: preset?.url ?? "", key_env: preset?.keyEnv ?? null, models: [] }, null);
    fresh.current = `endpoint-name-${row.key}`;
    setRows((all) => [...(all ?? []), row]);
  };
  const fetchModels = (r: Row) => {
    change(r.key, { fetching: true, fetchError: null });
    api.fetchEndpointModels(r.url, r.key_env?.trim() ? r.key_env.trim() : null, r.id && r.url.trim() === r.savedUrl ? r.id : null).then(
      (models) => change(r.key, { fetching: false, modelsText: models.join("\n") }),
      (e) => change(r.key, { fetching: false, fetchError: errText(e) }),
    );
  };
  const saveKey = (r: Row) => {
    change(r.key, { keyError: null });
    api.endpointKeySet(r.id, r.keyDraft).then(
      () => change(r.key, { savedKey: true, keyDraft: "" }),
      (e) => change(r.key, { keyError: errText(e) }),
    );
  };
  const removeKey = (r: Row) => {
    change(r.key, { keyError: null });
    api.endpointKeyClear(r.id).then(
      () => change(r.key, { savedKey: false }),
      (e) => change(r.key, { keyError: errText(e) }),
    );
  };
  const save = () => {
    setSaving(true);
    setError(null);
    api.saveEndpoints(rows.map(endpointOf)).then(
      () => {
        setSaving(false);
        void load();
        onSaved();
      },
      (e) => {
        setSaving(false);
        setError(errText(e));
      },
    );
  };

  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">Endpoints</h2>
          <p className="mode-guide-summary">
            Run a chat on a model that isn't Anthropic's: Claude Code is sent to an endpoint that speaks Anthropic's Messages API (/v1/messages), such as LiteLLM, OpenRouter, Ollama or LM Studio. A chat on an endpoint sends its messages to the endpoint, not to Anthropic, and has no Auto mode, advisor, effort level or price; skills and Lantern's tools stay. Anthropic doesn't support non-Claude models in Claude Code, so some things may not work on every model.
          </p>
        </div>
      </div>
      <p className="settings-muted">A key goes either in a field here, kept in your Mac's Keychain and sent only to this endpoint (over https, or to this Mac's own network), or in an environment variable you name and set in your shell (~/.zshrc or ~/.zprofile). A saved key wins over the variable.</p>
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      {rows.length === 0 ? (
        <div className="settings-muted">No endpoints yet. Add one to choose it from a new chat, beside Claude.</div>
      ) : (
        <ul className="settings-list">
          {rows.map((r) => (
            <li key={r.key} className="settings-row endpoint-row">
              <div className="mcp-add endpoint-fields">
                <label>
                  Name
                  <input id={`endpoint-name-${r.key}`} value={r.name} maxLength={40} onChange={(e) => change(r.key, { name: e.target.value })} />
                </label>
                <label>
                  URL
                  <input value={r.url} placeholder="http://localhost:11434" spellCheck={false} onChange={(e) => change(r.key, { url: e.target.value })} />
                </label>
                <label>
                  Key variable <span className="settings-row-sub">(optional)</span>
                  <input value={r.key_env ?? ""} placeholder="OPENROUTER_API_KEY" spellCheck={false} onChange={(e) => change(r.key, { key_env: e.target.value || null, keySet: null })} />
                </label>
                {r.key_env && !r.savedKey && r.keySet !== null && !dirty && <span className="settings-row-sub">{r.keySet ? `${r.key_env} is set in your login shell.` : `${r.key_env} isn't set in your login shell: a chat on this endpoint won't start.`}</span>}
                <div className="endpoint-keybox wide">
                  {!r.id ? (
                    <span className="settings-row-sub">Save the endpoint first, then its key can be added here.</span>
                  ) : r.savedKey ? (
                    <>
                      <span className="settings-row-sub">A key is saved in your Mac's Keychain for this endpoint. It is only sent to this address: changing the address removes it.</span>
                      <button type="button" className="link-button" onClick={() => removeKey(r)}>
                        Remove key
                      </button>
                    </>
                  ) : (
                    <>
                      <input type="password" autoComplete="off" spellCheck={false} aria-label={`API key for ${r.name || "this endpoint"}`} placeholder="API key (optional)" value={r.keyDraft} onChange={(e) => change(r.key, { keyDraft: e.target.value })} />
                      <button type="button" disabled={!r.keyDraft.trim() || dirty} title={dirty ? "Save the endpoint's changes first" : undefined} onClick={() => saveKey(r)}>
                        Save key
                      </button>
                    </>
                  )}
                  {r.keyError && <span className="settings-row-sub endpoint-fetch-error">{r.keyError}</span>}
                </div>
                <label className="wide">
                  Models <span className="settings-row-sub">(one per line; the first is a new chat's)</span>
                  <textarea rows={3} value={r.modelsText} placeholder={"qwen3-coder:30b\nopenai/gpt-5"} spellCheck={false} onChange={(e) => change(r.key, { modelsText: e.target.value })} />
                </label>
                {r.fetchError && <span className="settings-row-sub endpoint-fetch-error">{r.fetchError}</span>}
                <div className="endpoint-actions">
                  <button type="button" disabled={!r.url.trim() || r.fetching} onClick={() => fetchModels(r)} title="Ask the endpoint which models it serves">
                    {r.fetching ? "Fetching…" : "Fetch models"}
                  </button>
                  <button type="button" className="link-button" onClick={() => setRows((all) => (all ?? []).filter((x) => x.key !== r.key))}>
                    Remove
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="endpoint-add">
        <span className="settings-row-sub">Add</span>
        {PRESETS.map((p) => (
          <button key={p.label} type="button" onClick={() => add(p)}>
            {p.label}
          </button>
        ))}
        <button type="button" onClick={() => add()}>
          Other
        </button>
        <span className="endpoint-spacer" />
        <button type="button" className="primary" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </>
  );
}
