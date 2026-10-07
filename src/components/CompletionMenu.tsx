import { useEffect, useRef } from "react";
import type { FoundFile } from "../types";
import { SECTION_TITLE, type CommandKind, type MenuCommand } from "../lib/complete";
import { scrollWithin } from "../lib/scrollWithin";

/** An MCP server that needs something before Claude can use it. */
export interface McpIssue {
  name: string;
  problem: string;
}

interface Props {
  /** "/": skills, commands and MCP prompts, in sections; "@": files. */
  kind: "/" | "@";
  sections: { kind: CommandKind; items: MenuCommand[] }[];
  files: FoundFile[];
  /** Index into everything listed, in order. */
  pick: number;
  onPickCommand: (c: MenuCommand) => void;
  onPickFile: (f: FoundFile) => void;
  onHover: (i: number) => void;
  /** Shown when nothing's listed yet (e.g. "@" before typing). */
  hint?: string;
  issues?: McpIssue[];
  onOpenSettings?: () => void;
}

/** Opens above the chat box while a "/" or "@" word is typed, anywhere in the message. */
export function CompletionMenu({ kind, sections, files, pick, onPickCommand, onPickFile, onHover, hint, issues = [], onOpenSettings }: Props) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const item = list.current?.querySelector(`[data-index="${pick}"]`);
    if (list.current && item instanceof HTMLElement) scrollWithin(list.current, item, "nearest");
  }, [pick]);
  const commands = sections.flatMap((s) => s.items);
  const picked = kind === "/" ? commands[pick] : undefined;
  let index = 0;
  // mousedown would take focus from the box; the click still picks.
  const keep = (e: { preventDefault: () => void }) => e.preventDefault();
  return (
    <div className="menu slash-menu" onMouseDown={keep}>
      {kind === "/" && issues.length > 0 && (
        <button className="slash-issue" onClick={onOpenSettings} title="Open Settings to fix it">
          <span className="slash-issue-dot" aria-hidden />
          <span className="slash-issue-text">{issues.map((i) => `${i.name} ${i.problem}`).join(" · ")}</span>
          <span className="slash-issue-go">Settings</span>
        </button>
      )}
      <ul className="slash-list" role="listbox" aria-label={kind === "/" ? "Commands" : "Files"} ref={list}>
        {kind === "/" &&
          sections.map((s) => (
            <li key={s.kind} role="presentation">
              {sections.length > 1 && <div className="slash-section">{SECTION_TITLE[s.kind]}</div>}
              <ul role="presentation" className="slash-section-items">
                {s.items.map((c) => {
                  const i = index++;
                  return (
                    <li key={c.name} role="option" aria-selected={i === pick} data-index={i}>
                      <button className={`menu-row${i === pick ? " current" : ""}`} onMouseEnter={() => onHover(i)} onClick={() => onPickCommand(c)}>
                        <span className="slash-name">/{c.name}</span>
                        {c.argument_hint && <span className="slash-hint">{c.argument_hint}</span>}
                        <span className="slash-desc">{c.description}</span>
                        <span className="slash-source">{c.source}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        {kind === "@" &&
          files.map((f, i) => (
            <li key={f.path} role="option" aria-selected={i === pick} data-index={i}>
              <button className={`menu-row${i === pick ? " current" : ""}`} onMouseEnter={() => onHover(i)} onClick={() => onPickFile(f)}>
                <span className="slash-name">@{f.rel}</span>
              </button>
            </li>
          ))}
      </ul>
      {hint && <div className="slash-empty">{hint}</div>}
      {picked?.description && (
        <div className="slash-preview" aria-live="polite">
          {picked.description}
        </div>
      )}
    </div>
  );
}
