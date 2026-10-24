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
  /** Why Fetch didn't fill the models in. */
  fetchError: string | null;
  fetching: boolean;
}

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
const parseModels = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];
let nextKey = 0;

const rowOf = (e: Endpoint, keySet: boolean | null): Row => ({ ...e, key: `row-${nextKey++}`, modelsText: e.models.join("\n"), keySet, fetchError: null, fetching: false });
const endpointOf = (r: Row): Endpoint => ({ id: r.id, name: r.name, url: r.url, key_env: r.key_env?.trim() ? r.key_env.trim() : null, models: parseModels(r.modelsText) });

/**
 * Settings → Endpoints: where a chat can run besides Anthropic's. Claude Code is sent to the endpoint (a LiteLLM or OpenRouter
 * URL, a local Ollama or LM Studio), on one of the models listed here. Only the NAME of the variable holding a key is kept.
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
        setRows(list.map((e) => rowOf(e, e.key_set)));
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
    api.fetchEndpointModels(r.url, r.key_env?.trim() ? r.key_env.trim() : null).then(
      (models) => change(r.key, { fetching: false, modelsText: models.join("\n") }),
      (e) => change(r.key, { fetching: false, fetchError: errText(e) }),
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
            Run a chat on a model that isn't Anthropic's: Claude Code is sent to an endpoint that speaks Anthropic's Messages API (/v1/messages), such as LiteLLM, OpenRouter, Ollama or LM Studio. A chat on an endpoint sends nothing to Anthropic, and has no Auto mode, advisor, effort level or price; skills and Lantern's tools stay. Anthropic doesn't support non-Claude models in Claude Code, so some things may not work on every model.
          </p>
        </div>
      </div>
      <p className="settings-muted">Lantern keeps no keys: give the name of the environment variable that holds one, and set it in your shell (~/.zshrc or ~/.zprofile).</p>
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
                {r.key_env && r.keySet !== null && !dirty && <span className="settings-row-sub">{r.keySet ? `${r.key_env} is set in your login shell.` : `${r.key_env} isn't set in your login shell: a chat on this endpoint won't start.`}</span>}
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
