import { useEffect, useState } from "react";
import { canvasLink, firstLine, folderName, type WebCard } from "../lib/webClaude";
import { elapsed } from "../lib/time";

export interface WebInboxProps {
  cards: WebCard[];
  /** The projects a Run card may pick from, as [folder, name]. */
  projects: [string, string][];
  onAllow: (id: string, allow: boolean, code: string | null) => Promise<void>;
  onRun: (id: string, run: boolean, folder: string | null) => Promise<void>;
}

/** How long a card's yes stays dead after it appears, as the inbox's Allow does: a click aimed at what was there can't land on it. */
const ARM_MS = 400;

function useArmed() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(t);
  }, []);
  return armed;
}

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

function ConnectRow({ card, now, onAllow }: { card: Extract<WebCard, { kind: "connect" }>; now: number; onAllow: WebInboxProps["onAllow"] }) {
  const armed = useArmed();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const typed = code.replace(/[\s-]/g, "");
  const answer = (allow: boolean) => onAllow(card.id, allow, allow ? typed : null).catch((e) => setError(errText(e)));
  return (
    <li className="inbox-row web-card">
      <span className="node-dot waiting" aria-hidden />
      <span className="inbox-text">
        <span className="inbox-head">
          <span className="inbox-title">{card.client} wants to connect</span>
          <span className="inbox-time">{elapsed(now - card.at)}</span>
        </span>
        <span className="inbox-where">A sign-in to Lantern's connector for web Claude</span>
        <span className="inbox-need">If you just added Lantern in claude.ai, type the code its sign-in page shows. If no page you opened shows one, Deny: anyone who reaches this Mac's address can ask.</span>
        <label className="web-project">
          <span className="settings-muted">Code</span>
          <input
            className="web-code-input"
            value={code}
            maxLength={8}
            autoComplete="off"
            spellCheck={false}
            aria-label="The code on the claude.ai sign-in page"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && armed && typed.length === 6) answer(true);
            }}
          />
        </label>
        {error && <span className="inbox-full settings-error">{error}</span>}
      </span>
      <span className="inbox-actions">
        <button className="primary" aria-label={`Allow ${card.client}`} aria-disabled={!armed || typed.length !== 6} title={typed.length !== 6 ? "Type the six-character code first" : undefined} onClick={() => armed && typed.length === 6 && answer(true)}>
          Allow
        </button>
        <button data-go aria-label={`Deny ${card.client}`} onClick={() => answer(false)}>
          Deny
        </button>
      </span>
    </li>
  );
}

function RunRow({ card, now, projects, onRun }: { card: Extract<WebCard, { kind: "run" }>; now: number; projects: WebInboxProps["projects"]; onRun: WebInboxProps["onRun"] }) {
  const armed = useArmed();
  const [folder, setFolder] = useState<string>(card.folder ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsProject = !card.answer && !card.folder;
  const decide = (run: boolean) => {
    setBusy(true);
    setError(null);
    onRun(card.id, run, needsProject && run ? folder : null).catch((e) => {
      setError(errText(e));
      setBusy(false);
    });
  };
  const where = card.answer ? `An answer for ${card.chat_title ?? "the chat that asked"}` : card.folder ? `From web Claude · ${folderName(card.folder)}` : "From web Claude · pick its project";
  const link = canvasLink(card.canvas);
  return (
    <li className="inbox-row web-card">
      <span className="node-dot waiting" aria-hidden />
      <span className="inbox-text">
        <span className="inbox-head">
          <span className="inbox-title" title={card.canvas}>
            {card.title}
          </span>
          <span className="inbox-time">{elapsed(now - card.at)}</span>
        </span>
        <span className="inbox-where">{where}</span>
        <details className="web-message">
          <summary className="inbox-need">{firstLine(card.message)}</summary>
          <span className="inbox-full">{card.message}</span>
          {link && <span className="inbox-full settings-muted">{link}</span>}
        </details>
        {needsProject && (
          <label className="web-project">
            <span className="settings-muted">Project</span>
            <select value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="The project this canvas belongs to">
              <option value="">Choose…</option>
              {projects.map(([f, name]) => (
                <option key={f} value={f}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <span className="inbox-full settings-error">{error}</span>}
      </span>
      <span className="inbox-actions">
        <button className="primary" aria-label={`Run ${card.title}`} aria-disabled={!armed || busy || (needsProject && !folder)} title={needsProject && !folder ? "Choose its project first" : undefined} onClick={() => armed && !busy && (!needsProject || folder) && decide(true)}>
          Run
        </button>
        <button data-go aria-label={`Decline ${card.title}`} disabled={busy} onClick={() => decide(false)}>
          Decline
        </button>
      </span>
    </li>
  );
}

/** Web Claude's cards, as rows of the title bar's inbox. */
export function WebClaudeRows({ cards, projects, onAllow, onRun, now }: WebInboxProps & { now: number }) {
  return (
    <>
      {cards.map((c) => (c.kind === "connect" ? <ConnectRow key={c.id} card={c} now={now} onAllow={onAllow} /> : <RunRow key={c.id} card={c} now={now} projects={projects} onRun={onRun} />))}
    </>
  );
}
