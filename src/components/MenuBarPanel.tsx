import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../api";
import { basename } from "../lib/diff";
import { readStored } from "../lib/layout";
import { diskLevel, percent, pressureLevel, useMenuBar, type Level } from "../lib/menuBar";
import { sizeText } from "../lib/storage";
import { applySaved } from "../lib/theme";
import type { MemorySnapshot, MenuBarChat, MenuBarStats, RecentFolder } from "../types";

/** How often the numbers are read while the panel is open: RAM and disk (cheap), and the apps using the RAM (a process list). */
const STATS_MS = 3000;
const APPS_MS = 8000;
const FOLDER_KEY = "menubar.folder";
const SHOWN_CHATS = 5;
const SHOWN_APPS = 3;
/** The panel's window has this much room round the card, for the card's shadow. */
const FRAME = 24;

/** The panel that opens from the menu bar item: the Mac's memory and disk, the open chats, and a box to start a new one. It is
 * its own window, so it takes the theme itself, follows it when it changes, and only asks the main window to do things. */
export function MenuBarPanel() {
  const settings = useMenuBar();
  const [open, setOpen] = useState(true);
  const [stats, setStats] = useState<MenuBarStats | null>(null);
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [chats, setChats] = useState<MenuBarChat[]>([]);
  const [folders, setFolders] = useState<RecentFolder[]>([]);
  const frame = useRef<HTMLDivElement>(null);

  // The page of a window that is transparent: the theme is on <html> as in the main window, only its background is cleared.
  useEffect(() => {
    document.documentElement.classList.add("menubar-window");
    applySaved();
  }, []);

  const refreshFolders = useCallback(() => {
    api.recentFolders().then((all) => {
      const hidden = readStored<string[]>("sidebar.hidden", []);
      setFolders(all.filter((f) => !hidden.includes(f.path)).slice(0, 12));
    }, () => {});
  }, []);

  // Opened, and closed: the theme is read again each time it opens (it may have changed in Settings), and the numbers are
  // only read while it is open.
  useEffect(() => {
    const opened = () => {
      applySaved();
      setOpen(true);
      refreshFolders();
      void api.askMenubarChats().catch(() => {});
    };
    const closed = () => setOpen(false);
    refreshFolders();
    void api.askMenubarChats().catch(() => {});
    const unlistenShown = api.onMenubarShown(opened).catch(() => null);
    const unlistenChats = api.onMenubarChats(setChats).catch(() => null);
    window.addEventListener("focus", opened);
    window.addEventListener("blur", closed);
    return () => {
      window.removeEventListener("focus", opened);
      window.removeEventListener("blur", closed);
      unlistenShown.then((f) => f?.());
      unlistenChats.then((f) => f?.());
    };
  }, [refreshFolders]);

  // The theme can change while the panel is open (Settings in the main window): the saved choice reaches this window as a
  // storage event.
  useEffect(() => {
    const onStorage = () => applySaved();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!open || settings.mode === "off") return;
    let live = true;
    const read = () => api.menubarStats().then((s) => live && setStats(s), () => {});
    read();
    const timer = window.setInterval(read, STATS_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [open, settings.mode]);

  useEffect(() => {
    if (!open || !settings.panel.memory) return;
    let live = true;
    const read = () => api.memorySnapshot().then((s) => live && setSnapshot(s), () => {});
    read();
    const timer = window.setInterval(read, APPS_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [open, settings.panel.memory]);

  // The window is as tall as the card.
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => void api.menubarFit(Math.ceil(el.getBoundingClientRect().height) + FRAME).catch(() => {});
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    fit();
    return () => watch.disconnect();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") void api.menubarHide().catch(() => {});
  };

  const waiting = chats.filter((c) => c.state === "waiting").length;
  const running = chats.filter((c) => c.state === "running").length;
  const sections = settings.panel;

  return (
    <div className="mb-frame" ref={frame} onKeyDown={onKeyDown as never}>
      <div className="mb-card" role="dialog" aria-label="Lantern">
        <header className="mb-head">
          <span className="mb-glyph" aria-hidden>
            <Lantern />
          </span>
          <span className="mb-title">Lantern</span>
          <span className={`mb-chip${waiting > 0 ? " warn" : running > 0 ? " busy" : ""}`} role="status">
            {waiting > 0 ? `${waiting} ${waiting === 1 ? "needs" : "need"} you` : running > 0 ? `${running} working` : "All quiet"}
          </span>
          <button className="mb-icon" aria-label="Menu bar settings" title="Menu bar settings" onClick={() => void api.menubarAct({ kind: "settings" }).catch(() => {})}>
            <Gear />
          </button>
        </header>

        {sections.memory && <MemorySection stats={stats} snapshot={snapshot} />}
        {sections.disk && <DiskSection stats={stats} />}
        {sections.chats && <ChatsSection chats={chats} />}
        {sections.newChat && <NewChat folders={folders} />}

        <footer className="mb-foot">
          <button className="mb-link" onClick={() => void api.menubarAct({ kind: "open" }).catch(() => {})}>
            Open Lantern
          </button>
        </footer>
      </div>
    </div>
  );
}

const LEVEL_NAME: Record<Level, string> = { ok: "ok", warn: "warn", critical: "critical" };

function Meter({ value, level, label }: { value: number; level: Level; label: string }) {
  return (
    <div className={`mb-meter ${LEVEL_NAME[level]}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
      <div className="mb-meter-fill" style={{ width: `${value}%` }} />
    </div>
  );
}

const PRESSURE_TEXT = { normal: "Normal pressure", warning: "Memory pressure is rising", critical: "Memory pressure is high" } as const;

function MemorySection({ stats, snapshot }: { stats: MenuBarStats | null; snapshot: MemorySnapshot | null }) {
  const ram = stats?.ram ?? null;
  const value = ram ? percent(ram.used_bytes, ram.total_bytes) : 0;
  const apps = (snapshot?.apps ?? []).filter((a) => a.kind !== "other").slice(0, SHOWN_APPS);
  return (
    <section className="mb-section" aria-label="Memory">
      <div className="mb-row">
        <span className="mb-label">Memory</span>
        <span className="mb-big">{ram ? `${value}%` : "…"}</span>
      </div>
      <Meter value={value} level={pressureLevel(ram?.pressure)} label="Memory used" />
      <div className="mb-sub">{ram ? `${sizeText(ram.used_bytes)} of ${sizeText(ram.total_bytes)} used · ${PRESSURE_TEXT[ram.pressure]}` : "Reading memory…"}</div>
      {apps.length > 0 && (
        <ul className="mb-apps" aria-label="Biggest memory users">
          {apps.map((a) => (
            <li key={a.name}>
              <span className="mb-app-name">{a.name}</span>
              <span className="mb-app-size">{sizeText(a.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DiskSection({ stats }: { stats: MenuBarStats | null }) {
  const free = stats?.disk_free ?? null;
  const total = stats?.disk_total ?? null;
  const used = free !== null && total ? percent(total - free, total) : 0;
  return (
    <section className="mb-section" aria-label="Disk">
      <div className="mb-row">
        <span className="mb-label">Disk</span>
        <span className="mb-big">{free !== null ? `${sizeText(free)} free` : "…"}</span>
      </div>
      <Meter value={used} level={diskLevel(free)} label="Disk used" />
      <div className="mb-row">
        <span className="mb-sub">{total ? `${used}% of ${sizeText(total)} used` : "Reading the disk…"}</span>
        <button className="mb-link" onClick={() => void api.menubarAct({ kind: "storage" }).catch(() => {})}>
          Free up space
        </button>
      </div>
    </section>
  );
}

const STATE_TEXT: Record<MenuBarChat["state"], string> = { running: "Working", waiting: "Needs you", draft: "Draft", done: "Done" };

function ChatsSection({ chats }: { chats: MenuBarChat[] }) {
  // What needs you first, then what is working, then the rest, each in the order the sidebar has them.
  const rank = (c: MenuBarChat) => (c.state === "waiting" ? 0 : c.state === "running" ? 1 : 2);
  const shown = [...chats].sort((a, b) => rank(a) - rank(b)).slice(0, SHOWN_CHATS);
  return (
    <section className="mb-section" aria-label="Chats">
      <div className="mb-row">
        <span className="mb-label">Chats</span>
        {chats.length > SHOWN_CHATS && <span className="mb-sub">{chats.length - SHOWN_CHATS} more in Lantern</span>}
      </div>
      {shown.length === 0 ? (
        <div className="mb-sub">No chats open.</div>
      ) : (
        <ul className="mb-chats" aria-label="Open chats">
          {shown.map((c) => (
            <li key={c.slot}>
              <button className="mb-chat" onClick={() => void api.menubarAct({ kind: "chat", slot: c.slot }).catch(() => {})} title={`${c.title}, ${c.project}`}>
                <span className={`mb-dot ${c.state}`} role="img" aria-label={STATE_TEXT[c.state]} />
                <span className="mb-chat-text">
                  <span className="mb-chat-title">{c.title}</span>
                  <span className="mb-chat-project">{c.team ? `Team · ${c.project}` : c.project}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NewChat({ folders }: { folders: RecentFolder[] }) {
  const [folder, setFolder] = useState(() => readStored<string>(FOLDER_KEY, ""));
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The project asked for if it's still among the recent ones, else the most recent.
  const chosen = folders.some((f) => f.path === folder) ? folder : (folders[0]?.path ?? "");
  const start = () => {
    const message = text.trim();
    if (!chosen || !message) return;
    setError(null);
    try {
      localStorage.setItem(FOLDER_KEY, JSON.stringify(chosen));
    } catch {
      // storage unavailable: the project isn't remembered
    }
    api.menubarAct({ kind: "new_chat", folder: chosen, text: message }).then(
      () => setText(""),
      (e) => setError(String(e)),
    );
  };
  return (
    <section className="mb-section" aria-label="New chat">
      <div className="mb-row">
        <span className="mb-label">New chat</span>
        <select className="mb-select" aria-label="Project" value={chosen} onChange={(e) => setFolder(e.target.value)} disabled={folders.length === 0}>
          {folders.length === 0 && <option value="">No projects yet</option>}
          {folders.map((f) => (
            <option key={f.path} value={f.path} title={f.path}>
              {basename(f.path)}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="mb-input"
        aria-label="What should Claude do?"
        placeholder="What should Claude do?"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            start();
          }
        }}
      />
      {error && (
        <div className="mb-error" role="alert">
          {error}
        </div>
      )}
      <div className="mb-row mb-end">
        <span className="mb-sub">Enter to start · Shift+Enter for a new line</span>
        <button className="primary" onClick={start} disabled={!chosen || !text.trim()}>
          Start
        </button>
      </div>
    </section>
  );
}

/** The lantern, in the card's text colour. */
function Lantern() {
  return (
    <svg viewBox="262 215 500 500" width="18" height="18" fill="currentColor" stroke="none">
      <path d="M452 308 a60 60 0 0 1 120 0" fill="none" stroke="currentColor" strokeWidth="42" strokeLinecap="round" />
      <rect x="362" y="326" width="300" height="56" rx="28" />
      <rect x="362" y="676" width="300" height="56" rx="28" />
      <path d="M400 382 V676 M624 382 V676" fill="none" stroke="currentColor" strokeWidth="44" />
      <path d="M512 440 C566 500 580 540 580 580 C580 626 552 650 512 650 C472 650 444 626 444 580 C444 540 458 500 512 440 Z" />
    </svg>
  );
}

function Gear() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
    </svg>
  );
}
