import { Fragment, type ReactNode } from "react";
import { CollapsibleText } from "./CollapsibleText";
import { Md } from "./Md";
import { MessageActions, type MessageAction } from "./MessageActions";
import type { ChatItem, TestRunItem } from "../store";
import type { NewRule } from "../types";
import { groupItems, type Row } from "../lib/activity";
import { draftOf } from "../lib/paste";
import { workingVerb } from "../lib/verbs";
import { ActivityGroup } from "./ActivityGroup";
import { PermissionCard } from "./PermissionCard";
import { ShellBlock } from "./ShellBlock";
import { TurnNote } from "./TurnNote";

type UserRow = Extract<ChatItem, { type: "user" }>;

/** What a sent prompt can do again: Edit puts it back in the box, Retry and Regenerate send it. Only offered when idle. */
export interface ResendHandlers {
  /** The box's draft for the message (see lib/paste.ts), to be put in front of what's typed. */
  onEdit: (draft: string) => void;
  onResend: (prompt: { text: string; draft?: string }) => void;
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
}

// Resending runs the work again, so the tooltip says so.
const REGENERATE_TITLE = "Sends the last prompt again. Files it changes and commands it runs happen again.";

export function ChatStream({ items, folder, sections, live = false, resend, ...handlers }: Props) {
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
  const resendOf = (p: UserRow | null | undefined) => (resend && p ? () => resend.onResend({ text: p.text, draft: p.draft }) : undefined);
  const render = (row: Row): ReactNode => {
    switch (row.type) {
      case "user":
        if (row.auto)
          return (
            <div key={row.id} className="auto-turn" role="note">
              <span className="auto-turn-dot" aria-hidden />
              {row.text}
            </div>
          );
        return (
          <Fragment key={row.id}>
            <div className="msg user">
              <CollapsibleText>{row.text}</CollapsibleText>
            </div>
            <MessageActions text={row.text} align="end" actions={resend ? [{ label: "Edit", title: "Edit and send as a new message", onClick: () => resend.onEdit(row.draft ?? draftOf(row.text)) }] : []} />
          </Fragment>
        );
      case "assistant": {
        const regen = row.id === latest ? resendOf(answering.get(row.id)) : undefined;
        const actions: MessageAction[] = regen ? [{ label: "Regenerate", title: REGENERATE_TITLE, onClick: regen }] : [];
        return (
          <Fragment key={row.id}>
            <div className="msg assistant">
              <Md>
                {row.text}
              </Md>
            </div>
            <MessageActions text={row.text} align="start" actions={actions} />
          </Fragment>
        );
      }
      case "activity":
        return <ActivityGroup key={row.id} steps={row.steps} entries={row.entries} live={row.live} verb={verbFor.get(row.id)} folder={folder} {...handlers} />;
      case "permission":
        return <PermissionCard key={row.id} item={row} onDecide={handlers.onDecide} />;
      case "turn":
        return <TurnNote key={row.id} item={row} onRetry={resendOf(answering.get(row.id))} />;
      case "shell":
        return <ShellBlock key={row.id} item={row} onStop={handlers.onStopShell} onInput={handlers.onShellInput} />;
    }
  };

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
        <section key={first.id} className="turn-section">
          {first.type === "user" && !first.auto ? <div className="turn-head">{render(first)}</div> : render(first)}
          {rest.map(render)}
        </section>
      ))}
    </>
  );
}
