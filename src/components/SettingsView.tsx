import { useEffect, useRef, useState, type FormEvent } from "react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import type { McpServer, McpServerSpec, SkillEntry, SlashCommand } from "../types";
import { describeConfig, displayName, groupSkills, iconOf, removable, sourceOf, statusOf, toolsOf, withoutFrontmatter } from "../lib/mcp";
import { Md } from "./Md";
import { HarnessSettings, type HarnessSettingsProps } from "./HarnessSettings";

export type SettingsTab = "mcp" | "skills" | "harness";
const TAB_LABEL: Record<SettingsTab, string> = { mcp: "MCP servers", skills: "Skills", harness: "Harness" };

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

interface Props {
  /** The page that's open; null: closed. */
  open: SettingsTab | null;
  onClose: () => void;
  /** The chat whose claude answers (MCP status, reloads); null when none is open. */
  slot: string | null;
  /** Its claude is running, so it can be asked. */
  live: boolean;
  /** The MCP tools its claude has ("mcp__server__tool"). */
  mcpTools: string[];
  /** What claude loaded: skills and commands not in it are marked. */
  commands: SlashCommand[];
  /** The commands claude lists after a reload. */
  onCommands?: (commands: SlashCommand[]) => void;
  /** Restarts the chat's claude, which reads MCP settings when it starts. */
  onRestartChat?: () => void;
  /** The harness presets, for the Harness page. */
  harness?: HarnessSettingsProps;
}

/** Settings: MCP servers (status, log in, add, remove) and skills (yours, the project's, plugins'). */
export function SettingsView({ open, onClose, harness, ...page }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<SettingsTab>(open ?? "mcp");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // jsdom has no showModal or close: there, the attribute alone opens and closes it.
    if (open) {
      setTab(open);
      if (el.open) return;
      if (el.showModal) el.showModal();
      else el.setAttribute("open", "");
    } else if (el.open) {
      if (el.close) el.close();
      else el.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog ref={ref} className="mode-guide settings" aria-label="Settings" onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      {open && (
        <div className="mode-guide-body">
          <nav className="mode-guide-nav" aria-label="Settings">
            <div className="mode-guide-group">
              <div className="mode-guide-group-title">Settings</div>
              {(["harness", "mcp", "skills"] as const)
                .filter((t) => t !== "harness" || harness)
                .map((t) => (
                  <button key={t} className={`mode-guide-tab${t === tab ? " active" : ""}`} aria-current={t === tab ? "page" : undefined} onClick={() => setTab(t)}>
                    {TAB_LABEL[t]}
                  </button>
                ))}
            </div>
          </nav>
          <article className="mode-guide-page settings-page">
            {tab === "harness" && harness ? <HarnessSettings {...harness} /> : tab === "skills" ? <SkillsPage {...page} /> : <McpPage {...page} />}
            <div className="mode-guide-actions">
              <button onClick={onClose}>Close</button>
            </div>
          </article>
        </div>
      )}
    </dialog>
  );
}

type PageProps = Omit<Props, "open" | "onClose">;

interface AuthReply {
  authUrl?: string;
  requiresUserAction?: boolean;
  callbackExpected?: boolean;
}

function McpPage({ slot, live, mcpTools, onRestartChat }: PageProps) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  // Servers waiting for a login in the browser, and whether claude wants the address the browser ends on.
  const [loggingIn, setLoggingIn] = useState<Record<string, { callback: boolean }>>({});
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<{ text: string; restart: boolean } | null>(null);

  const load = () => {
    if (!slot || !live) return Promise.resolve();
    return api.claudeRequest<{ mcpServers?: McpServer[] }>(slot, { subtype: "mcp_status" }).then(
      (r) => {
        setServers(r.mcpServers ?? []);
        setError(null);
      },
      (e) => setError(errText(e)),
    );
  };
  useEffect(() => {
    void load();
  }, [slot, live]);

  // Keep looking while a server connects or a login is under way.
  const waiting = (servers ?? []).some((s) => s.status === "pending") || Object.keys(loggingIn).length > 0;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [waiting, slot]);
  // A login is done once the server stops needing one.
  useEffect(() => {
    const done = Object.keys(loggingIn).filter((n) => servers?.find((s) => s.name === n)?.status !== "needs-auth");
    if (done.length) setLoggingIn(Object.fromEntries(Object.entries(loggingIn).filter(([n]) => !done.includes(n))));
  }, [servers]);

  if (!slot) return <Empty title="MCP servers" text="Open a folder to see its MCP servers. Claude Code connects to them when a chat starts." />;
  if (!live) return <Empty title="MCP servers" text="Waiting for Claude to start in this chat…" />;

  const act = async (s: McpServer, label: string, request: { subtype: string; [k: string]: unknown }) => {
    setBusy((b) => ({ ...b, [s.name]: label }));
    try {
      await api.claudeRequest(slot, { ...request, serverName: s.name });
      await load();
    } catch (e) {
      setError(`${displayName(s)}: ${errText(e)}`);
    } finally {
      setBusy(({ [s.name]: _, ...rest }) => rest);
    }
  };

  const logIn = async (s: McpServer) => {
    setBusy((b) => ({ ...b, [s.name]: "Opening the login page…" }));
    try {
      const r = await api.claudeRequest<AuthReply>(slot, { subtype: "mcp_authenticate", serverName: s.name });
      if (r?.authUrl) await openUrl(r.authUrl);
      setLoggingIn((l) => ({ ...l, [s.name]: { callback: !!r?.callbackExpected } }));
      await load();
    } catch (e) {
      setError(`${displayName(s)}: ${errText(e)}`);
    } finally {
      setBusy(({ [s.name]: _, ...rest }) => rest);
    }
  };

  const remove = async (s: McpServer) => {
    setBusy((b) => ({ ...b, [s.name]: "Removing…" }));
    try {
      await api.mcpRemove(slot, s.name, s.scope ?? null);
      setNotice({ text: `Removed ${displayName(s)}. Claude stops using it when the chat restarts.`, restart: true });
    } catch (e) {
      setError(`${displayName(s)}: ${errText(e)}`);
    } finally {
      setBusy(({ [s.name]: _, ...rest }) => rest);
    }
  };

  const added = async (name: string) => {
    setAdding(false);
    // Plugins reload re-reads MCP settings in newer Claude Code; otherwise it takes a restart.
    await api.claudeRequest(slot, { subtype: "reload_plugins" }).catch(() => {});
    const r = await api.claudeRequest<{ mcpServers?: McpServer[] }>(slot, { subtype: "mcp_status" }).catch(() => null);
    const list = r?.mcpServers ?? servers ?? [];
    setServers(list);
    setNotice(list.some((s) => s.name === name) ? { text: `Added ${name}.`, restart: false } : { text: `Added ${name}. Restart the chat to connect to it.`, restart: true });
  };

  const order = (s: McpServer) => (s.scope === "claudeai" ? 2 : s.source === "plugin" ? 1 : 0);
  const list = [...(servers ?? [])].sort((a, b) => order(a) - order(b));
  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">MCP servers</h2>
          <p className="mode-guide-summary">The tools and data Claude can reach beyond this folder. Changes here are Claude Code's own settings, so the terminal sees them too.</p>
        </div>
        <button className="primary" onClick={() => setAdding(!adding)} aria-expanded={adding}>
          Add server
        </button>
      </div>
      {adding && <AddServerForm slot={slot} onAdded={added} onCancel={() => setAdding(false)} />}
      {notice && (
        <div className="settings-notice" role="status">
          {notice.text}
          {notice.restart && onRestartChat && (
            <button
              onClick={() => {
                setNotice(null);
                onRestartChat();
              }}
            >
              Restart chat
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      {servers === null && !error && <div className="settings-loading">Asking Claude Code…</div>}
      {servers?.length === 0 && <Empty title="" text="No MCP servers yet. Add one, or install a plugin that brings its own." />}
      <ul className="settings-list" aria-label="MCP servers">
        {list.map((s) => {
          const st = statusOf(s.status);
          const tools = toolsOf(s.name, mcpTools);
          const open = expanded === s.name;
          const icon = iconOf(s);
          const claudeai = s.scope === "claudeai";
          const http = s.config?.type === "http" || s.config?.type === "sse";
          return (
            <li key={s.name} className={`settings-row mcp-row ${st.tone}`}>
              <button className="settings-row-main" aria-expanded={open} onClick={() => setExpanded(open ? null : s.name)}>
                {icon ? <img className="mcp-icon" src={icon} alt="" /> : <span className="mcp-icon letter">{displayName(s).charAt(0).toUpperCase()}</span>}
                <span className="settings-row-text">
                  <span className="settings-row-name">{displayName(s)}</span>
                  <span className="settings-row-sub">{sourceOf(s)}</span>
                </span>
                <span className={`mcp-status ${st.tone}`}>
                  <span className="mcp-dot" aria-hidden />
                  {busy[s.name] ?? (loggingIn[s.name] ? "Waiting for your login…" : st.label)}
                </span>
              </button>
              <div className="mcp-actions">
                {s.status === "needs-auth" &&
                  (claudeai ? (
                    <button onClick={() => void logIn(s)}>Connect</button>
                  ) : (
                    <button className="primary" onClick={() => void logIn(s)} disabled={!!busy[s.name]}>
                      Log in
                    </button>
                  ))}
                {(s.status === "failed" || s.status === "connected") && (
                  <button onClick={() => void act(s, "Reconnecting…", { subtype: "mcp_reconnect" })} disabled={!!busy[s.name]}>
                    Reconnect
                  </button>
                )}
                {s.status === "disabled" ? (
                  <button onClick={() => void act(s, "Turning on…", { subtype: "mcp_toggle", enabled: true })} disabled={!!busy[s.name]}>
                    Turn on
                  </button>
                ) : (
                  s.status !== "pending" && (
                    <button onClick={() => void act(s, "Turning off…", { subtype: "mcp_toggle", enabled: false })} disabled={!!busy[s.name]}>
                      Turn off
                    </button>
                  )
                )}
              </div>
              {loggingIn[s.name]?.callback && <CallbackField onSubmit={(url) => void act(s, "Finishing the login…", { subtype: "mcp_oauth_callback_url", callbackUrl: url })} />}
              {open && (
                <div className="mcp-details">
                  {s.error && <div className="settings-error">{s.error}</div>}
                  <dl className="mcp-config">
                    {describeConfig(s).map((r) => (
                      <div key={r.label}>
                        <dt>{r.label}</dt>
                        <dd>{r.value}</dd>
                      </div>
                    ))}
                    {s.serverInfo?.version && (
                      <div>
                        <dt>Version</dt>
                        <dd>{s.serverInfo.version}</dd>
                      </div>
                    )}
                  </dl>
                  {tools.length > 0 ? (
                    <div className="mcp-tools">
                      <div className="mcp-tools-title">{tools.length === 1 ? "1 tool" : `${tools.length} tools`}</div>
                      <ul>
                        {tools.map((t) => (
                          <li key={t}>{t.replace(/_/g, " ")}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    s.status === "connected" && <div className="settings-muted">Its tools show here once a chat has started with it.</div>
                  )}
                  <div className="mcp-detail-actions">
                    {claudeai && <button onClick={() => void openUrl("https://claude.ai/settings/connectors")}>Manage on claude.ai</button>}
                    {http && !claudeai && s.status === "connected" && (
                      <button onClick={() => void act(s, "Logging out…", { subtype: "mcp_clear_auth" })} disabled={!!busy[s.name]}>
                        Log out
                      </button>
                    )}
                    {removable(s) && (
                      <button className="danger" onClick={() => void remove(s)} disabled={!!busy[s.name]}>
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** When claude can't catch the login's redirect itself: the address the browser ended on, pasted back. */
function CallbackField({ onSubmit }: { onSubmit: (url: string) => void }) {
  const [url, setUrl] = useState("");
  return (
    <form
      className="mcp-callback"
      onSubmit={(e) => {
        e.preventDefault();
        if (url.trim()) onSubmit(url.trim());
      }}
    >
      <label>
        After logging in, paste the address your browser ended on
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:…/callback?code=…" />
      </label>
      <button type="submit">Finish</button>
    </form>
  );
}

const SCOPES: { value: McpServerSpec["scope"]; label: string; hint: string }[] = [
  { value: "local", label: "Just me, this project", hint: "Kept in your own settings for this folder" },
  { value: "user", label: "Just me, every project", hint: "Available in all your folders" },
  { value: "project", label: "Everyone on this project", hint: "Saved in .mcp.json, to commit with the code" },
];

/** A new server: what to call it, how to reach it, and where it applies. Runs `claude mcp add`. */
function AddServerForm({ slot, onAdded, onCancel }: { slot: string; onAdded: (name: string) => void; onCancel: () => void }) {
  const [spec, setSpec] = useState<{ name: string; transport: McpServerSpec["transport"]; target: string; scope: McpServerSpec["scope"]; extra: string }>({ name: "", transport: "http", target: "", scope: "local", extra: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<typeof spec>) => setSpec({ ...spec, ...patch });
  const stdio = spec.transport === "stdio";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const lines = spec.extra.split("\n").map((l) => l.trim()).filter(Boolean);
    try {
      await api.mcpAdd(slot, { name: spec.name.trim(), transport: spec.transport, target: spec.target, scope: spec.scope, env: stdio ? lines : [], headers: stdio ? [] : lines });
      onAdded(spec.name.trim());
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="mcp-add" onSubmit={submit} aria-label="Add an MCP server">
      <label>
        Name
        <input value={spec.name} onChange={(e) => set({ name: e.target.value })} placeholder="sentry" autoFocus required autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </label>
      <label>
        Type
        <select value={spec.transport} onChange={(e) => set({ transport: e.target.value as McpServerSpec["transport"] })}>
          <option value="http">Web address (HTTP)</option>
          <option value="sse">Web address (SSE)</option>
          <option value="stdio">Command on this Mac</option>
        </select>
      </label>
      <label className="wide">
        {stdio ? "Command" : "Address"}
        <input value={spec.target} onChange={(e) => set({ target: e.target.value })} placeholder={stdio ? "npx -y @modelcontextprotocol/server-postgres postgres://localhost/db" : "https://mcp.sentry.dev/mcp"} required autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </label>
      <label className="wide">
        {stdio ? "Environment variables (KEY=value, one per line)" : "Headers (Name: value, one per line)"}
        <textarea value={spec.extra} onChange={(e) => set({ extra: e.target.value })} rows={2} placeholder={stdio ? "API_KEY=…" : "Authorization: Bearer …"} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </label>
      <fieldset className="wide mcp-scope">
        <legend>Who it's for</legend>
        {SCOPES.map((s) => (
          <label key={s.value} className="mcp-scope-option">
            <input type="radio" name="scope" checked={spec.scope === s.value} onChange={() => set({ scope: s.value })} />
            <span>
              {s.label}
              <span className="settings-muted">{s.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {error && (
        <div className="settings-error wide" role="alert">
          {error}
        </div>
      )}
      <div className="wide mcp-add-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Adding…" : "Add"}
        </button>
      </div>
    </form>
  );
}

function SkillsPage({ slot, live, commands, onCommands }: PageProps) {
  const [entries, setEntries] = useState<SkillEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<SkillEntry | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  const load = () => api.skillIndex(slot).then(setEntries, (e) => setError(errText(e)));
  useEffect(() => {
    void load();
  }, [slot]);
  useEffect(() => {
    setPreview(null);
    if (picked) api.readSkill(slot, picked.path).then((t) => setPreview(withoutFrontmatter(t)), (e) => setPreview(`Couldn't read it: ${errText(e)}`));
  }, [picked?.path]);

  const reload = async () => {
    setReloading(true);
    try {
      if (slot && live) {
        const r = await api.claudeRequest<{ commands?: { name: string; description?: string; argumentHint?: string }[] }>(slot, { subtype: "reload_plugins" });
        if (r?.commands && onCommands) onCommands(r.commands.map((c) => ({ name: c.name, description: c.description ?? "", argument_hint: c.argumentHint ?? "" })));
      }
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setReloading(false);
    }
  };

  const q = query.trim().toLowerCase();
  const shown = (entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
  const loaded = (e: SkillEntry) => commands.length === 0 || commands.some((c) => c.name === e.name);
  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">Skills</h2>
          <p className="mode-guide-summary">What Claude can do on request: type / in the chat box to use one. Skills and commands live in your ~/.claude folder, the project's .claude folder, or come with plugins.</p>
        </div>
        <button onClick={() => void reload()} disabled={reloading} title="Pick up skills and plugins added since the chat started">
          {reloading ? "Reloading…" : "Reload"}
        </button>
      </div>
      <input className="settings-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter skills and commands" aria-label="Filter skills and commands" />
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      <div className="skills-split">
        <div className="skills-list">
          {entries?.length === 0 && <Empty title="" text="No skills yet. Add a folder with a SKILL.md to ~/.claude/skills, or install a plugin." />}
          {groupSkills(shown).map((g) => (
            <section key={g.title} className="skills-group">
              <h3 className="mode-guide-group-title">{g.title}</h3>
              <ul>
                {g.entries.map((e) => (
                  <li key={e.name}>
                    <button className={`skill-row${picked?.name === e.name ? " active" : ""}`} onClick={() => setPicked(e)}>
                      <span className="skill-name">/{e.name}</span>
                      <span className={`skill-kind ${e.kind}`}>{e.kind}</span>
                      {!loaded(e) && <span className="skill-kind off" title="Claude Code didn't load it in this chat (a plugin that's off here?)">not loaded</span>}
                      <span className="skill-desc">{e.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        {picked && (
          <aside className="skill-preview" aria-label={`/${picked.name}`}>
            <div className="skill-preview-head">
              <span className="skill-name">/{picked.name}</span>
              <button onClick={() => void revealItemInDir(picked.path)}>Show in Finder</button>
            </div>
            <div className="skill-preview-body msg assistant">{preview === null ? <span className="settings-muted">Loading…</span> : <Md>{preview}</Md>}</div>
          </aside>
        )}
      </div>
    </>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="settings-empty">
      {title && <h2 className="mode-guide-title">{title}</h2>}
      <p className="mode-guide-summary">{text}</p>
    </div>
  );
}
