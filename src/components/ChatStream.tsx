import type { ReactNode } from "react";
import { Md } from "./Md";
import type { ChatItem, TestRunItem } from "../store";
import { groupItems, type Row } from "../lib/activity";
import { workingVerb } from "../lib/verbs";
import { ActivityGroup } from "./ActivityGroup";
import { PermissionCard } from "./PermissionCard";
import { ShellBlock } from "./ShellBlock";
import { TurnNote } from "./TurnNote";

export interface StreamHandlers {
  /** `note`: what the user typed on a reproduce card, passed back to Claude; `answered`: AskUserQuestion's input with the answers. */
  onDecide: (id: string, allow: boolean, note?: string, answered?: Record<string, unknown>) => void;
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
}

export function ChatStream({ items, folder, sections, live = false, ...handlers }: Props) {
  const rows = groupItems(items, live);
  // Each turn's word ("Pondering…") comes from its prompt, so the live line and the thinking line agree.
  const verbFor = new Map<string, string>();
  let prompt = "start";
  for (const row of rows) {
    if (row.type === "user") prompt = row.id;
    else if (row.type === "activity") verbFor.set(row.id, workingVerb(prompt));
  }
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
          <div key={row.id} className="msg user">
            {row.text}
          </div>
        );
      case "assistant":
        return (
          <div key={row.id} className="msg assistant">
            <Md>
              {row.text}
            </Md>
          </div>
        );
      case "activity":
        return <ActivityGroup key={row.id} steps={row.steps} entries={row.entries} live={row.live} verb={verbFor.get(row.id)} folder={folder} {...handlers} />;
      case "permission":
        return <PermissionCard key={row.id} item={row} onDecide={handlers.onDecide} />;
      case "turn":
        return <TurnNote key={row.id} item={row} />;
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
