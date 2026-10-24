import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CollapsibleText } from "./CollapsibleText";
import { Md } from "./Md";
import { MessageActions, type MessageAction } from "./MessageActions";
import type { ChatItem, TestRunItem } from "../store";
import type { NewRule } from "../types";
import { groupItems, sameRow, type HookRow, type Row } from "../lib/activity";
import { draftOf } from "../lib/paste";
import { workingVerb } from "../lib/verbs";
import { friendlyNotes } from "../lib/wakeNote";
import { ActivityGroup } from "./ActivityGroup";
import { PermissionCard } from "./PermissionCard";
import { ShellBlock } from "./ShellBlock";
import { TurnNote } from "./TurnNote";

type UserRow = Extract<ChatItem, { type: "user" }>;

/** A line of a note from the agents: two lines of it, and Show more for the rest. */
function NoteLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const line = useRef<HTMLSpanElement>(null);
  // Where there is layout it is measured; where there is none (a test), a long line is taken to be clipped.
  const [clipped, setClipped] = useState(text.length > 200);
  useLayoutEffect(() => {
    const el = line.current;
    if (el && !open) setClipped(el.clientHeight > 0 ? el.scrollHeight > el.clientHeight + 1 : text.length > 200);
  }, [text, open]);
  return (
    <>
      <span ref={line} className={`auto-turn-line${open ? "" : " clamped"}`}>
        {text}
      </span>
      {clipped && (
        <button className="link-button auto-turn-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

/** The post-hook sent after an answer, with what Claude did for it folded away; open while something in it waits for the user. */
function HookCard({ row, render }: { row: HookRow; render: (row: Row) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const shown = open || row.waiting;
  return (
    <div className="hook-card">
      <button type="button" className="hook-card-head" aria-expanded={shown} onClick={() => setOpen(!open)} title={shown ? "Hide what Claude did" : "Show what Claude did"}>
        <span className="auto-turn-dot" aria-hidden />
        <span className="hook-card-text">Post-hook: {row.text}</span>
        <span className="hook-card-toggle">{shown ? "Hide" : "Show"}</span>
      </button>
      {shown && <div className="hook-card-body">{row.rows.map(render)}</div>}
    </div>
  );
}

/** What a sent prompt can do again: Edit puts it back in the box, Retry and Regenerate send it. Only offered when idle. */
export interface ResendHandlers {
  /** The box's draft for the message (see lib/paste.ts), to be put in front of what's typed. */
  onEdit: (draft: string) => void;
  onResend: (prompt: { text: string; draft?: string }) => void;
}

/** "Restore files to here" on a sent message: the project's files go back to how they were before it. */
export interface RestoreHandlers {
  /** The messages (by turn number) the chat has a restore point for. */
  points: ReadonlySet<number>;
  /** Why it can't be done now (Claude is working), or null. */
  blocked: string | null;
  onRestore: (turn: number) => void;
}

export interface StreamHandlers {
  /** `note`: what the user typed on a reproduce card, passed back to Claude; `answered`: AskUserQuestion's input with the answers; `remember`: an "Always allow…" rule to save. */
  onDecide: (id: string, allow: boolean, note?: string, answered?: Record<string, unknown>, remember?: NewRule) => void;
  onOpenFile: (path: string) => void;
  /** The test run a Bash step produced, if any, and how to show it in the Tests tab. */
  testRunFor?: (toolUseId: string) => TestRunItem | undefined;
  onOpenTestRun?: (id: string) => void;
  /** Stops a command the user ran from the chat box. */
  onStopShell?: (id: string) => void;
  /** Types the user's reply into a running command. */
  onShellInput?: (id: string, text: string) => void;
}

interface Props extends StreamHandlers {
  items: ChatItem[];
  folder: string | null;
  /** Main chat only: wrap each prompt and its reply in a section whose prompt sticks to the top while scrolling. */
  sections?: boolean;
  /** The stream is still running, so its last turn's work shows live. */
  live?: boolean;
  /** Edit, Retry and Regenerate, where the chat can send again (not while a turn runs, not in Step by step). */
  resend?: ResendHandlers;
  restore?: RestoreHandlers;
}

// Resending runs the work again, so the tooltip says so.
const RESTORE_TITLE = "Put the project's files back to how they were just before this message";
const REGENERATE_TITLE = "Sends the last prompt again. Files it changes and commands it runs happen again.";

export function ChatStream({ items, folder, sections, live = false, resend, restore, ...handlers }: Props) {
  const rows = groupItems(items, live);
  // Each turn's word ("Pondering…") comes from its prompt, so the live line and the thinking line agree.
  const verbFor = new Map<string, string>();
  // The prompt each reply (and its turn's note) answers: none for a reply Claude started on its own.
  const answering = new Map<string, UserRow | null>();
  let prompt = "start";
  let current: UserRow | null = null;
  // The latest answer: the reply after the last prompt, if nothing was sent since.
  let latest: string | null = null;
  for (const row of rows) {
    if (row.type === "user") {
      prompt = row.id;
      current = row.auto ? null : row;
      latest = null;
    } else if (row.type === "activity") verbFor.set(row.id, workingVerb(prompt));
    else if (row.type === "assistant") latest = row.id;
    if (row.type === "assistant" || row.type === "turn") answering.set(row.id, current);
  }
  // Each row gets what it shows, not closures made here, so one that hasn't changed isn't drawn again while another streams.
  const render = (row: Row): ReactNode => (
    <RowView key={row.id} row={row} folder={folder} verb={verbFor.get(row.id)} latest={row.id === latest} answers={answering.get(row.id)} resend={resend} restore={restore} {...handlers} />
  );

  if (!sections) return <>{rows.map(render)}</>;

  // Like section headers in an iOS list: each prompt stays pinned while its reply scrolls,
  // and the next prompt pushes it away because each sticky header only lives inside its own section.
  const turns: Row[][] = [];
  for (const row of rows) {
    if (row.type === "user" || turns.length === 0) turns.push([row]);
    else turns[turns.length - 1].push(row);
  }
  return (
    <>
      {turns.map(([first, ...rest]) => (
        <section key={first.id} className="turn-section" data-turn={first.id}>
          {first.type === "user" && !first.auto ? <div className="turn-head">{render(first)}</div> : render(first)}
          {rest.map(render)}
        </section>
      ))}
    </>
  );
}

interface RowProps extends StreamHandlers {
  row: Row;
  folder: string | null;
  /** An activity row's word for its turn. */
  verb?: string;
  /** A reply that is the latest answer, so it can be regenerated. */
  latest: boolean;
  /** The prompt a reply or a turn's note answers (null: none, for one Claude started on its own). */
  answers?: UserRow | null;
  resend?: ResendHandlers;
  restore?: RestoreHandlers;
}

/** The same row as before, with the same everything else: nothing to draw again. */
function sameRowProps(a: RowProps, b: RowProps): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof RowProps)[]);
  return [...keys].every((k) => (k === "row" ? sameRow(a.row, b.row) : Object.is(a[k], b[k])));
}

/** One row of the stream. A message streaming in redraws its own row; the hundreds before it stay as they are. */
const RowView = memo(function RowView({ row, folder, verb, latest, answers, resend, restore, ...handlers }: RowProps) {
  const resendOf = (p: UserRow | null | undefined) => (resend && p ? () => resend.onResend({ text: p.text, draft: p.draft }) : undefined);
  switch (row.type) {
    case "user": {
      if (row.auto)
        return (
          <div className="auto-turn" role="note">
            <span className="auto-turn-dot" aria-hidden />
            {/* Notes from a team's agents read as what happened; anything else is shown as it was written. */}
            <span>{friendlyNotes(row.text).map((line, i) => <NoteLine key={i} text={line} />)}</span>
          </div>
        );
      const actions: MessageAction[] = resend ? [{ label: "Edit", title: "Edit and send as a new message", onClick: () => resend.onEdit(row.draft ?? draftOf(row.text)) }] : [];
      const turn = row.turn;
      if (restore && turn !== undefined && restore.points.has(turn)) {
        actions.push({ label: "Restore files to here", title: restore.blocked ?? RESTORE_TITLE, disabled: !!restore.blocked, onClick: () => restore.onRestore(turn) });
      }
      return (
        <>
          <div className="msg user">
            <CollapsibleText>{row.text}</CollapsibleText>
          </div>
          {/* The pictures went to Claude and not here: only that they were sent is known. */}
          {!!row.images && (
            <div className="msg-note" role="note">
              {row.images === 1 ? "1 photo from your phone" : `${row.images} photos from your phone`}
            </div>
          )}
          <MessageActions text={row.text} align="end" actions={actions} />
        </>
      );
    }
    case "assistant": {
      const regen = latest ? resendOf(answers) : undefined;
      const actions: MessageAction[] = regen ? [{ label: "Regenerate", title: REGENERATE_TITLE, onClick: regen }] : [];
      return (
        <>
          <div className="msg assistant">
            <Md>
              {row.text}
            </Md>
          </div>
          <MessageActions text={row.text} align="start" actions={actions} />
        </>
      );
    }
    case "hook":
      return <HookCard row={row} render={(r) => <RowView key={r.id} row={r} folder={folder} latest={false} {...handlers} />} />;
    case "activity":
      return <ActivityGroup steps={row.steps} entries={row.entries} live={row.live} verb={verb} folder={folder} {...handlers} />;
    case "permission":
      return <PermissionCard item={row} onDecide={handlers.onDecide} />;
    case "turn":
      return <TurnNote item={row} onRetry={resendOf(answers)} />;
    case "shell":
      return <ShellBlock item={row} onStop={handlers.onStopShell} onInput={handlers.onShellInput} />;
  }
}, sameRowProps);
