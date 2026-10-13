import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import type { McpServer, McpServerSpec, SkillEntry, SlashCommand } from "../types";
import { describeConfig, displayName, groupSkills, iconOf, removable, sourceOf, statusOf, toolsOf, withoutFrontmatter } from "../lib/mcp";
import { setChime, useChimeOn } from "../lib/chime";
import { PAUSE_MS, type NotifyPrefs } from "../lib/notifyPrefs";
import type { Appearance, TextSize } from "../lib/theme";
import { Md } from "./Md";
import { NewSkillForm } from "./SkillForm";
import { HarnessSettings, type HarnessSettingsProps } from "./HarnessSettings";
import { UpdatesPage, type UpdatesPageProps } from "./UpdatesPage";

export type SettingsTab = "general" | "mcp" | "skills" | "harness" | "updates";
const TAB_LABEL: Record<SettingsTab, string> = { general: "General", mcp: "MCP servers", skills: "Skills", harness: "Harness", updates: "Updates" };

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
  /** The running version and how updating is going, for the Updates page. */
  updates?: UpdatesPageProps;
  /** Notifications, appearance and text size, for the General page (App keeps them saved). */
  general?: GeneralSettingsProps;
}

/** Settings: General (notifications, sound, look), MCP servers (status, log in, add, remove) and skills. */
export function SettingsView({ open, onClose, harness, updates, general, ...page }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<SettingsTab>(open ?? "general");
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
              {(["general", "harness", "mcp", "skills", "updates"] as const)
                .filter((t) => (t !== "general" || general) && (t !== "harness" || harness) && (t !== "updates" || updates))
                .map((t) => (
                  <button key={t} className={`mode-guide-tab${t === tab ? " active" : ""}`} aria-current={t === tab ? "page" : undefined} onClick={() => setTab(t)}>
                    {TAB_LABEL[t]}
                  </button>
                ))}
            </div>
          </nav>
          <article className="mode-guide-page settings-page">
            {tab === "general" && general ? (
              <GeneralPage {...general} />
            ) : tab === "harness" && harness ? (
              <HarnessSettings {...harness} />
            ) : tab === "updates" && updates ? (
              <UpdatesPage {...updates} />
            ) : tab === "skills" ? (
              <SkillsPage {...page} />
            ) : (
              <McpPage {...page} />
            )}
            <div className="mode-guide-actions">
              <button onClick={onClose}>Close</button>
            </div>
          </article>
        </div>
      )}
    </dialog>
  );
}

export interface GeneralSettingsProps {
  notify: NotifyPrefs;
  onNotify: (prefs: NotifyPrefs) => void;
  appearance: Appearance;
  onAppearance: (appearance: Appearance) => void;
  textSize: TextSize;
  onTextSize: (size: TextSize) => void;
}

type PageProps = Omit<Props, "open" | "onClose">;

const NOTIFY_EVENTS: { key: "finished" | "waiting" | "failed"; label: string }[] = [
  { key: "finished", label: "A turn finishes" },
  { key: "waiting", label: "Claude needs you (a question, a plan, a permission)" },
  { key: "failed", label: "A turn fails" },
];

/** General: when Lantern tells you about Claude (notifications, a pause), the toasts' sound, and how the window looks. */
function GeneralPage({ notify, onNotify, appearance, onAppearance, textSize, onTextSize }: GeneralSettingsProps) {
  const sound = useChimeOn();
  const paused = notify.pausedUntil > Date.now();
  const set = (patch: Partial<NotifyPrefs>) => onNotify({ ...notify, ...patch });
  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">General</h2>
          <p className="mode-guide-summary">When Lantern tells you about a chat, and how it looks. Saved on this Mac.</p>
        </div>
      </div>
      <section className="general-section" aria-labelledby="general-notify">
        <h3 id="general-notify" className="general-title">
          Notifications
        </h3>
        <label className="general-option">
          <input type="checkbox" checked={notify.on} onChange={(e) => set({ on: e.target.checked })} />
          <span>Tell me in macOS notifications and in the window</span>
        </label>
        <div className="general-indent">
          {NOTIFY_EVENTS.map(({ key, label }) => (
            <label key={key} className="general-option">
              <input type="checkbox" checked={notify[key]} disabled={!notify.on} onChange={(e) => set({ [key]: e.target.checked } as Partial<NotifyPrefs>)} />
              <span>{label}</span>
            </label>
          ))}
          <span className="settings-muted">A turn you stopped counts as finished.</span>
        </div>
        <div className="general-row">
          {paused ? (
            <>
              <span className="settings-muted">Paused until {new Date(notify.pausedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
              <button onClick={() => set({ pausedUntil: 0 })}>Resume</button>
            </>
          ) : (
            <button onClick={() => set({ pausedUntil: Date.now() + PAUSE_MS })} disabled={!notify.on}>
              Pause for 1 hour
            </button>
          )}
        </div>
      </section>
      <section className="general-section" aria-labelledby="general-sound">
        <h3 id="general-sound" className="general-title">
          Sound
        </h3>
        <label className="general-option">
          <input type="checkbox" checked={sound} onChange={(e) => setChime(e.target.checked)} />
          <span>Play a sound with the toasts (the speaker on a toast does the same)</span>
        </label>
      </section>
      <section className="general-section" aria-labelledby="general-look">
        <h3 id="general-look" className="general-title">
          Appearance
        </h3>
        <Choices<Appearance>
          legend="Theme"
          name="appearance"
          value={appearance}
          onChange={onAppearance}
          options={[
            ["system", "Follow macOS"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]}
        />
        <Choices<TextSize>
          legend="Text size"
          name="text-size"
          value={textSize}
          onChange={onTextSize}
          options={[
            ["small", "Small"],
            ["default", "Default"],
            ["large", "Large"],
          ]}
        />
      </section>
    </>
  );
}

/** A row of radio buttons under a legend: one of a few settings. */
function Choices<T extends string>({ legend, name, value, options, onChange }: { legend: string; name: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <fieldset className="general-choices">
      <legend>{legend}</legend>
      <div className="general-choice-row">
        {options.map(([v, label]) => (
          <label key={v} className="general-choice">
            <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

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
  // Servers waiting for a login in the browser, per chat (a login stays with the chat it's for), and whether claude
  // wants the address the browser ends on.
  const [logins, setLogins] = useState<Record<string, Record<string, { callback: boolean }>>>({});
  const loggingIn = slot ? logins[slot] ?? {} : {};
  const [adding, setAdding] = useState(false);
  // The server whose settings are open in the form, and the one whose removal is waiting for a yes.
  const [editing, setEditing] = useState<{ name: string; scope: McpServerSpec["scope"] } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; restart: boolean } | null>(null);

  // Each chat's answers are for that chat: this identity changes with the chat, and a reply from another is dropped. A
  // reply comes back through the closure it was asked from, so one that lands after a switch is checked too.
  const chat = useMemo(() => ({}), [slot, live]);
  const current = useRef(chat);
  const load = () => {
    if (!slot || !live) return Promise.resolve();
    const asked = chat;
    return api.claudeRequest<{ mcpServers?: McpServer[] }>(slot, { subtype: "mcp_status" }).then(
      (r) => {
        if (asked !== current.current) return;
        setServers(r.mcpServers ?? []);
        setError(null);
      },
      (e) => asked === current.current && setError(errText(e)),
    );
  };
  useEffect(() => {
    current.current = chat;
    // The last chat's servers, busy marks, notices, errors and open form don't show under this one.
    setServers(null);
    setBusy({});
    setNotice(null);
    setError(null);
    setAdding(false);
    setEditing(null);
    setConfirmRemove(null);
    void load();
  }, [chat]);

  // Keep looking while a server connects or a login is under way.
  const waiting = (servers ?? []).some((s) => s.status === "pending") || Object.keys(loggingIn).length > 0;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [waiting, slot]);
  // A login is done once the server stops needing one. The list is this chat's only once it has arrived.
  useEffect(() => {
    if (!slot || !servers) return;
    const done = Object.keys(loggingIn).filter((n) => servers.find((s) => s.name === n)?.status !== "needs-auth");
    if (done.length) setLogins((all) => ({ ...all, [slot]: Object.fromEntries(Object.entries(loggingIn).filter(([n]) => !done.includes(n))) }));
  }, [servers]);

  if (!slot) return <Empty title="MCP servers" text="Open a folder to see its MCP servers. Claude Code connects to them when a chat starts." />;
  if (!live) return <Empty title="MCP servers" text="Waiting for Claude to start in this chat…" />;

  // What an ask changes is shown only while its chat is the one open: a reply that lands after a switch is dropped.
  const act = async (s: McpServer, label: string, request: { subtype: string; [k: string]: unknown }) => {
    const asked = chat;
    setBusy((b) => ({ ...b, [s.name]: label }));
    try {
      await api.claudeRequest(slot, { ...request, serverName: s.name });
      await load();
    } catch (e) {
      if (asked === current.current) setError(`${displayName(s)}: ${errText(e)}`);
    } finally {
      if (asked === current.current) setBusy(({ [s.name]: _, ...rest }) => rest);
    }
  };

  const logIn = async (s: McpServer) => {
    const asked = chat;
    setBusy((b) => ({ ...b, [s.name]: "Opening the login page…" }));
    try {
      const r = await api.claudeRequest<AuthReply>(slot, { subtype: "mcp_authenticate", serverName: s.name });
      // The login is in the browser whichever chat is open: it's kept for the chat it was started in.
      if (r?.authUrl) await openUrl(r.authUrl);
      setLogins((all) => ({ ...all, [slot]: { ...all[slot], [s.name]: { callback: !!r?.callbackExpected } } }));
      await load();
    } catch (e) {
      if (asked === current.current) setError(`${displayName(s)}: ${errText(e)}`);
    } finally {
      if (asked === current.current) setBusy(({ [s.name]: _, ...rest }) => rest);
    }
  };

  const remove = async (s: McpServer) => {
    const asked = chat;
    setBusy((b) => ({ ...b, [s.name]: "Removing…" }));
    try {
      await api.mcpRemove(slot, s.name, s.scope ?? null);
      if (asked === current.current) setNotice({ text: `Removed ${displayName(s)}. Claude stops using it when the chat restarts.`, restart: true });
    } catch (e) {
      if (asked === current.current) setError(`${displayName(s)}: ${errText(e)}`);
    } finally {
      if (asked === current.current) setBusy(({ [s.name]: _, ...rest }) => rest);
    }
  };

  // A saved edit always needs a restart: the chat read the old settings when it started.
  const added = async (name: string, edited: boolean) => {
    setAdding(false);
    setEditing(null);
    // Plugins reload re-reads MCP settings in newer Claude Code; otherwise it takes a restart.
    await api.claudeRequest(slot, { subtype: "reload_plugins" }).catch(() => {});
    const r = await api.claudeRequest<{ mcpServers?: McpServer[] }>(slot, { subtype: "mcp_status" }).catch(() => null);
    if (chat !== current.current) return;
    const list = r?.mcpServers ?? servers ?? [];
    setServers(list);
    if (edited) setNotice({ text: `Saved ${name}. Restart the chat to use the change.`, restart: true });
    else setNotice(list.some((s) => s.name === name) ? { text: `Added ${name}.`, restart: false } : { text: `Added ${name}. Restart the chat to connect to it.`, restart: true });
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
        <button
          className="primary"
          onClick={() => {
            setEditing(null);
            setAdding(!adding);
          }}
          aria-expanded={adding}
        >
          Add server
        </button>
      </div>
      {adding && <AddServerForm slot={slot} onAdded={(name) => added(name, false)} onCancel={() => setAdding(false)} />}
      {editing && <AddServerForm key={`${editing.scope}/${editing.name}`} slot={slot} edit={editing} onAdded={(name) => added(name, true)} onCancel={() => setEditing(null)} />}
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
                <McpIcon src={icon} name={displayName(s)} />
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
                    <button onClick={() => void logIn(s)} disabled={!!busy[s.name]}>
                      Connect
                    </button>
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
                      <button
                        onClick={() => {
                          setAdding(false);
                          setEditing({ name: s.name, scope: s.scope as McpServerSpec["scope"] });
                        }}
                        disabled={!!busy[s.name]}
                      >
                        Edit
                      </button>
                    )}
                    {removable(s) && (
                      <button className="danger" onClick={() => setConfirmRemove(s.name)} disabled={!!busy[s.name]}>
                        Remove
                      </button>
                    )}
                  </div>
                  {confirmRemove === s.name && (
                    <div className="skill-confirm mcp-confirm" role="alertdialog" aria-label={`Remove ${displayName(s)}`}>
                      <div>
                        Remove <b>{displayName(s)}</b> from {scopeWords(s.scope)}?
                        {s.scope === "project" && " This rewrites the project's .mcp.json, which is committed, so the removal goes into its next commit."}
                      </div>
                      <div className="skill-confirm-actions">
                        <button onClick={() => setConfirmRemove(null)}>Cancel</button>
                        <button
                          className="danger"
                          onClick={() => {
                            setConfirmRemove(null);
                            void remove(s);
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * A server's icon, or its initial. The window's CSP lets only local images load, so a remote icon that won't load shows
 * the initial instead of an empty box. A failure is kept for that address only: a different icon is tried.
 */
function McpIcon({ src, name }: { src: string | null; name: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return <span className="mcp-icon letter">{name.charAt(0).toUpperCase()}</span>;
  return <img className="mcp-icon" src={src} alt="" onError={() => setFailed(src)} />;
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

/** Where a scope keeps its servers, in words for a confirm. */
const scopeWords = (scope: string | undefined) => (scope === "project" ? "this project's .mcp.json" : scope === "local" ? "your settings for this project" : "your settings, for every project");

const SCOPES: { value: McpServerSpec["scope"]; label: string; hint: string }[] = [
  { value: "local", label: "Just me, this project", hint: "Kept in your own settings for this folder" },
  { value: "user", label: "Just me, every project", hint: "Available in all your folders" },
  { value: "project", label: "Everyone on this project", hint: "Saved in .mcp.json, to commit with the code" },
];

/**
 * A server's settings: a new one (`claude mcp add`), or one being edited (`mcp_edit`, from where it is now). An edit
 * loads the stored settings with their secret values masked: a masked value is kept as it is when saved.
 */
function AddServerForm({ slot, edit, onAdded, onCancel }: { slot: string; edit?: { name: string; scope: McpServerSpec["scope"] }; onAdded: (name: string, edited: boolean) => void; onCancel: () => void }) {
  const [spec, setSpec] = useState<{ name: string; transport: McpServerSpec["transport"]; target: string; scope: McpServerSpec["scope"]; extra: string }>({
    name: edit?.name ?? "",
    transport: "http",
    target: "",
    scope: edit?.scope ?? "local",
    extra: "",
  });
  const [loaded, setLoaded] = useState(!edit);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Saving into the project's .mcp.json, which is committed, asks first.
  const [confirmProject, setConfirmProject] = useState(false);
  const set = (patch: Partial<typeof spec>) => {
    setConfirmProject(false);
    setSpec({ ...spec, ...patch });
  };
  const stdio = spec.transport === "stdio";
  useEffect(() => {
    if (!edit) return;
    let current = true;
    api.mcpForm(slot, edit.name, edit.scope).then(
      (f) => {
        if (!current) return;
        setSpec({ name: f.name, transport: f.transport, target: f.target, scope: f.scope, extra: (f.transport === "stdio" ? f.env : f.headers).join("\n") });
        setLoaded(true);
      },
      (e) => current && setError(errText(e)),
    );
    return () => {
      current = false;
    };
  }, [slot, edit?.name, edit?.scope]);
  const save = async () => {
    if (edit && spec.scope === "project" && !confirmProject) {
      setConfirmProject(true);
      return;
    }
    setSaving(true);
    setError(null);
    const lines = spec.extra.split("\n").map((l) => l.trim()).filter(Boolean);
    const next = { name: spec.name.trim(), transport: spec.transport, target: spec.target, scope: spec.scope, env: stdio ? lines : [], headers: stdio ? [] : lines };
    try {
      if (edit) await api.mcpEdit(slot, edit, next);
      else await api.mcpAdd(slot, next);
      onAdded(next.name, !!edit);
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save();
  };
  return (
    <form className="mcp-add" onSubmit={submit} aria-label={edit ? "Edit an MCP server" : "Add an MCP server"}>
      {edit && <div className="wide settings-muted">{loaded ? "Secret values show as •••. Leave one as it is to keep what's saved." : "Reading the server's settings…"}</div>}
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
      {confirmProject && (
        <div className="skill-confirm wide" role="alertdialog" aria-label="Save to the project">
          <div>This writes the project's .mcp.json, which is committed: everyone who gets the project gets this server, and any secret written here is in the repository.</div>
          <div className="skill-confirm-actions">
            <button type="button" onClick={() => setConfirmProject(false)} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={() => void save()} disabled={saving}>
              Save to .mcp.json
            </button>
          </div>
        </div>
      )}
      <div className="wide mcp-add-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={saving || !loaded || confirmProject}>
          {saving ? (edit ? "Saving…" : "Adding…") : edit ? "Save" : "Add"}
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
  // The file as it is on disk (frontmatter and all), what an edit is checked against; the preview shows it without.
  const [raw, setRaw] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [reloading, setReloading] = useState(false);
  const [adding, setAdding] = useState<"skill" | "command" | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Whether the last save was refused because the file changed on disk: then the text can be kept or discarded.
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  // The file the preview is showing now: an edit that lands after the pick changed is dropped, not shown under the new one.
  const shownPath = useRef<string | null>(null);

  const load = () =>
    api.skillIndex(slot).then(
      (list) => {
        setEntries(list);
        return list;
      },
      (e) => {
        setError(errText(e));
        return null;
      },
    );
  useEffect(() => {
    void load();
  }, [slot]);
  useEffect(() => {
    shownPath.current = picked?.path ?? null;
    setPreview(null);
    setRaw(null);
    setEditing(false);
    setConfirming(false);
    setActionError(null);
    setChangedOnDisk(false);
    // A read of the skill picked before this one lands in its own time: it's dropped rather than shown under this skill.
    let current = true;
    if (picked) {
      api.readSkill(slot, picked.path).then(
        (t) => {
          if (!current) return;
          setRaw(t);
          setPreview(withoutFrontmatter(t));
        },
        (e) => current && setPreview(`Couldn't read it: ${errText(e)}`),
      );
    }
    return () => {
      current = false;
    };
  }, [picked?.path, version]);

  const reload = async (): Promise<SkillEntry[] | null> => {
    setReloading(true);
    try {
      if (slot && live) {
        const r = await api.claudeRequest<{ commands?: { name: string; description?: string; argumentHint?: string }[] }>(slot, { subtype: "reload_plugins" });
        if (r?.commands && onCommands) onCommands(r.commands.map((c) => ({ name: c.name, description: c.description ?? "", argument_hint: c.argumentHint ?? "" })));
      }
      return await load();
    } catch (e) {
      setError(errText(e));
      return null;
    } finally {
      setReloading(false);
    }
  };

  // Only your skills and commands, and the project's, can be changed; a plugin's, claude.ai's and agents are read-only.
  const owned = !!picked && picked.kind !== "agent" && (picked.source === "user" || picked.source === "project") && raw !== null;
  const origin = (e: SkillEntry) =>
    e.kind === "agent" ? "An agent, read-only" : e.source === "user" ? "Your ~/.claude folder" : e.source === "project" ? "This project's .claude folder" : e.source === "synced" ? "From claude.ai, read-only" : `From plugin ${e.plugin}, read-only`;

  const created = async (path: string) => {
    setAdding(null);
    const list = await reload();
    const made = list?.find((e) => e.path === path);
    if (made) setPicked(made);
  };

  const save = async () => {
    if (!picked || raw === null) return;
    const path = picked.path;
    setSaving(true);
    setActionError(null);
    setChangedOnDisk(false);
    try {
      const r = await api.skillSave(slot, path, draft, raw);
      if (shownPath.current !== path) return;
      if (r.status === "saved") {
        setRaw(draft);
        setPreview(withoutFrontmatter(draft));
        setEditing(false);
        await reload();
      } else {
        setChangedOnDisk(true);
        setActionError(
          r.current === null
            ? "It's gone from disk, so nothing was saved. Your text is still here: copy it out before you leave this file."
            : "It changed on disk since you opened it, so nothing was saved. Your text is still here, or discard it to see the file as it is now.",
        );
      }
    } catch (e) {
      if (shownPath.current === path) setActionError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: SkillEntry) => {
    setSaving(true);
    setActionError(null);
    try {
      await api.skillDelete(slot, entry.path);
      setPicked(null);
      await reload();
    } catch (e) {
      setActionError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const q = query.trim().toLowerCase();
  const matches = (entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
  // Agents aren't slash commands, so claude's list can't say whether it has them; only skills and commands are checked.
  const loaded = (e: SkillEntry) => e.kind === "agent" || commands.length === 0 || commands.some((c) => c.name === e.name);
  // Where the folder a skill lives in is: the SKILL.md's folder, or a command's file itself.
  const trashPath = picked?.kind === "skill" ? picked.path.replace(/\/SKILL\.md$/, "") : picked?.path;
  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">Skills</h2>
          <p className="mode-guide-summary">What Claude can do on request: type / in the chat box to use one. Yours are in ~/.claude, the project's in its .claude folder; plugins and claude.ai's come read-only, and so do agents.</p>
        </div>
        <div className="skills-actions">
          <button className="primary" onClick={() => setAdding(adding === "skill" ? null : "skill")} aria-expanded={adding === "skill"}>
            New skill
          </button>
          <button onClick={() => setAdding(adding === "command" ? null : "command")} aria-expanded={adding === "command"}>
            New command
          </button>
          <button onClick={() => void reload()} disabled={reloading} title="Pick up skills and plugins added since the chat started">
            {reloading ? "Reloading…" : "Reload"}
          </button>
        </div>
      </div>
      {adding && <NewSkillForm slot={slot} kind={adding} onCreated={(path) => void created(path)} onCancel={() => setAdding(null)} />}
      <input className="settings-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter skills and commands" aria-label="Filter skills and commands" />
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      <div className="skills-split">
        <div className="skills-list">
          {entries?.length === 0 && <Empty title="" text="No skills yet. Make one with New skill or New command, or install a plugin that brings its own." />}
          {groupSkills(matches).map((g) => (
            <section key={g.title} className="skills-group">
              <h3 className="mode-guide-group-title">{g.title}</h3>
              <ul>
                {g.entries.map((e) => (
                  <li key={e.name}>
                    <button className={`skill-row${picked?.name === e.name ? " active" : ""}`} onClick={() => setPicked(e)}>
                      <span className="skill-name">/{e.name}</span>
                      <span className={`skill-kind ${e.kind}`}>{e.kind}</span>
                      {e.disabled ? (
                        <span className="skill-kind off" title="Its plugin is turned off in Claude Code's settings, so claude doesn't load it">turned off</span>
                      ) : (
                        !loaded(e) && <span className="skill-kind off" title="Claude Code didn't load it in this chat (a plugin that's off here?)">not loaded</span>
                      )}
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
              {!editing && !confirming && <button onClick={() => void revealItemInDir(picked.path)}>Show in Finder</button>}
              {owned && !editing && !confirming && (
                <>
                  <button
                    onClick={() => {
                      setDraft(raw ?? "");
                      setEditing(true);
                    }}
                  >
                    Edit
                  </button>
                  <button className="danger" onClick={() => setConfirming(true)}>
                    Delete
                  </button>
                </>
              )}
            </div>
            <div className="skill-origin settings-muted">{origin(picked)}</div>
            {actionError && (
              <div className="settings-error" role="alert">
                {actionError}
              </div>
            )}
            {confirming && (
              <div className="skill-confirm" role="alertdialog" aria-label={`Delete /${picked.name}`}>
                <div>
                  <code>{trashPath}</code> goes to the Trash. You can put it back from there.
                </div>
                <div className="skill-confirm-actions">
                  <button onClick={() => setConfirming(false)} disabled={saving}>
                    Cancel
                  </button>
                  <button className="danger" onClick={() => void remove(picked)} disabled={saving}>
                    Move to Trash
                  </button>
                </div>
              </div>
            )}
            {editing ? (
              <>
                <textarea className="skill-editor" aria-label={`Edit /${picked.name}`} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
                <div className="skill-editor-actions">
                  <button
                    onClick={() => {
                      setEditing(false);
                      setDraft("");
                      setActionError(null);
                    }}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                  {changedOnDisk && (
                    <button
                      onClick={() => {
                        // Discarding reads the file as it is now, so the next save is checked against that.
                        setVersion((v) => v + 1);
                      }}
                    >
                      Discard my text
                    </button>
                  )}
                  <button className="primary" onClick={() => void save()} disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </>
            ) : (
              /* A skill's text is someone else's, not Claude's: its pictures aren't loaded. */
              <div className="skill-preview-body msg assistant">{preview === null ? <span className="settings-muted">Loading…</span> : <Md images={false}>{preview}</Md>}</div>
            )}
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
