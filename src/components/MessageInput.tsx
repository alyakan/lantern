import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Status } from "../store";
import type { FoundFile, ModelOption, Mode, RecentFolder, SessionSummary, SkillEntry, SlashCommand } from "../types";
import { basename } from "../lib/diff";
import { useShortcut } from "../lib/shortcuts";
import { matchCommands } from "../lib/slash";
import { describeCommands, replaceTrigger, sections as menuSections, triggerAt, type MenuCommand } from "../lib/complete";
import { CompletionMenu, type McpIssue } from "./CompletionMenu";
import { ArrowUpIcon, BranchIcon, FolderIcon, SparkIcon } from "./icons";
import { ContextMeter } from "./ContextMeter";
import { EFFORT_LEVELS, EffortPicker } from "./EffortPicker";
import { FolderPill } from "./FolderPill";
import { ModeMenu } from "./ModeMenu";
import type { Flavour } from "../lib/flavour";
import { ModelPicker } from "./ModelPicker";
import { HarnessPicker } from "./HarnessPicker";
import type { Harness } from "../lib/harness";
import type { OpenChat } from "./HistoryMenu";
import { SessionPill } from "./SessionPill";
import { UpdateButton } from "./UpdateButton";

const MAX_HEIGHT = 200; // about 8 lines


interface Props {
  status: Status;
  /** Replaces the usual "Ask Claude…" when idle (e.g. on a Step-by-step page). */
  idlePlaceholder?: string;
  /** On a Step-by-step page: ⌘Enter (or the button) sends the message and approves the step, moving on. */
  sendAndNext?: (text: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  /** "!" at the start of the box turns it into a terminal: Enter runs the rest as a shell command in the folder. */
  onRun?: (command: string) => void;
  mode?: Mode;
  /** Step by step's flavour, which the mode chip names too. */
  flavour?: Flavour | null;
  onModeChange?: (mode: Mode) => void;
  model?: string | null;
  branch?: string | null;
  /** Empty conversation: float the composer in the middle with a folder pill above it. */
  hero?: boolean;
  folder?: string | null;
  onOpenFolder?: () => void;
  /** Shown next to the folder pill in the empty state: pick a past session to continue. */
  sessions?: { load: () => Promise<SessionSummary[]>; currentId: string | null; onOpen: (id: string) => void; open?: OpenChat[]; onSwitch?: (slot: string) => void };
  /** The folder capsule's menu: recent folders to switch to. */
  folders?: { load: () => Promise<RecentFolder[]>; onPick: (path: string) => void };
  /** The chat's queued messages; without it the box keeps its own queue. */
  queue?: { items: string[]; set: (next: string[]) => void };
  /** Context use and timing for the footer meter. */
  usage?: { used: number | null; window: number; lastTurnMs: number | null };
  /** The model chip becomes a picker: what the user chose (null = default) and how to change it. */
  models?: { chosen: string | null; onChoose: (model: string | null) => void; defaultModel?: string | null; ids?: Record<string, string>; options?: ModelOption[] };
  /** Thinking effort: the chosen level (null = default) and how to change it. */
  effort?: { chosen: string | null; onChoose: (level: string | null) => void };
  /** The chat's harness (which models do what) and the presets to switch to. */
  harness?: { presets: Harness[]; chosen: string; onChoose: (id: string) => void; onEdit?: () => void };
  /** What "/" offers: claude's slash commands and skills. */
  commands?: SlashCommand[];
  /** The skills and commands on disk, which tell claude's list apart into skills and commands. */
  skillIndex?: SkillEntry[];
  /** What "@" offers: files in the chat's folder matching what's typed. */
  findFiles?: (query: string) => Promise<FoundFile[]>;
  /** MCP servers that need something (a login), shown atop the "/" menu, and where to fix them. */
  mcpIssues?: McpIssue[];
  onOpenSettings?: () => void;
  /** The chat's unsent text, kept while another chat is on screen. */
  draft?: { initial: string; save: (text: string) => void };
  /** A downloaded update of Lantern, shown under the box until it's taken or left for quitting. */
  update?: { version: string; busy: number; onRestart: () => void; onLater: () => void };
}

export function MessageInput({ status, idlePlaceholder, sendAndNext, onSend, onStop, onRun, mode, flavour = null, onModeChange, model, branch, hero, folder, onOpenFolder, sessions, folders, models, usage, queue, commands = [], skillIndex, findFiles, mcpIssues, onOpenSettings, draft, effort, harness, update }: Props) {
  const [text, setTextState] = useState(draft?.initial ?? "");
  const setText = (next: string) => {
    setTextState(next);
    draft?.save(next);
  };
  // Messages typed while Claude is working, sent together when the turn ends (like the CLI's queue).
  // The queue belongs to the chat (App sends it when the turn ends, even in the background); a local one otherwise.
  const [ownQueue, setOwnQueue] = useState<string[]>([]);
  const queued = queue?.items ?? ownQueue;
  const setQueued = queue?.set ?? setOwnQueue;
  const area = useRef<HTMLTextAreaElement>(null);
  const running = status === "running";
  const busy = running || status === "starting";
  const canType = status === "idle" || running;
  // Terminal mode, like Claude Code's: the "!" that starts it isn't shown; the box shows the command after it.
  const terminal = !!onRun && text.startsWith("!");
  const shown = terminal ? text.slice(1) : text;
  const canSend = canType && shown.trim() !== "";
  const placeholder =
    status === "no_folder"
      ? "Open a folder to start"
      : status === "starting"
        ? "Starting Claude…"
        : terminal
          ? `Run a command in ${folder ? basename(folder) : "the folder"}…`
          : running
            ? "Queue a message…"
            : (idlePlaceholder ?? "Ask Claude…");

  // Stop means "not like that": queued messages go back into the box instead of being sent.
  const stop = () => {
    if (queued.length > 0) {
      setText([...queued, text].filter((t) => t.trim()).join("\n\n"));
      setQueued([]);
    }
    onStop();
  };

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    // Measuring means collapsing the box for a moment; the box around it holds its height meanwhile, or the page
    // above would get taller for that moment and the browser would reset its scroll to fit.
    const box = el.closest<HTMLElement>(".composer-box");
    if (box) box.style.minHeight = `${box.offsetHeight}px`;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    if (box) box.style.minHeight = "";
  }, [text]);

  useLayoutEffect(() => {
    if (hero && canType) area.current?.focus();
  }, [hero, canType]);
  // The first message or command moves the box from the middle to the bottom (a new box): keep typing in it, unless
  // something else has focus.
  useLayoutEffect(() => {
    if (canType && (document.activeElement === document.body || !document.activeElement)) area.current?.focus();
  }, []);

  useShortcut("l", () => area.current?.focus(), canType);
  useShortcut(".", () => stop(), running);

  // The levels the chosen model takes (all of them until claude has listed its models); none hides the picker.
  const modelOption = models?.options?.find((o) => (models.chosen === null ? o.value === "default" : o.value === models.chosen));
  const effortLevels = models?.options?.length ? (modelOption?.effort_levels ?? [...EFFORT_LEVELS]) : [...EFFORT_LEVELS];

  // While Claude works, a message waits in the queue instead of going out.
  const sendText = (t: string) => (running ? setQueued([...queued, t]) : onSend(t));

  const submit = () => {
    if (!canSend) return;
    // A command runs now, even while Claude works: it doesn't wait in the queue.
    if (terminal) onRun!(shown.trim());
    else sendText(text.trim());
    setText("");
  };

  const submitAndNext = () => {
    if (!canSend || !sendAndNext || running || terminal) return;
    sendAndNext(text.trim());
    setText("");
  };

  // "/" or "@" starting the word at the caret, anywhere in the message, opens the menu for it; Escape hides it until
  // the caret leaves that word.
  const [caret, setCaret] = useState(text.length);
  const trigger = canType && !terminal ? triggerAt(text, Math.min(caret, text.length)) : null;
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const open = trigger && dismissedAt !== trigger.start ? trigger : null;
  useEffect(() => {
    if (!trigger) setDismissedAt(null);
  }, [trigger?.start]);
  const described = useMemo(() => describeCommands(commands, skillIndex ?? []), [commands, skillIndex]);
  // Each section shows its best few; at the start everything, mid-message only what can be named there.
  const sections =
    open?.kind === "/" ? menuSections(matchCommands(described, open.query, 60), open.atStart).map((s) => ({ ...s, items: s.items.slice(0, s.kind === "command" ? 8 : 6) })) : [];
  const commandItems = sections.flatMap((s) => s.items);
  const [files, setFiles] = useState<FoundFile[]>([]);
  const fileQuery = open?.kind === "@" && !open.query.includes(":") ? open.query : null;
  useEffect(() => {
    setFiles([]);
    if (!fileQuery || !findFiles) return;
    let live = true;
    const t = setTimeout(() => findFiles(fileQuery).then((f) => live && setFiles(f.slice(0, 8)), () => {}), 80);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [fileQuery]);
  const count = open?.kind === "/" ? commandItems.length : open?.kind === "@" ? files.length : 0;
  const issues = open?.kind === "/" ? (mcpIssues ?? []) : [];
  const menuShown = !!open && (count > 0 || issues.length > 0 || (open.kind === "@" && !!findFiles && !open.query.includes(":")));
  const [pick, setPick] = useState(0);
  useEffect(() => setPick(0), [open?.kind, open?.query]);

  // After the menu puts something in the box, the caret goes after it.
  const caretTo = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caretTo.current === null || !area.current) return;
    area.current.setSelectionRange(caretTo.current, caretTo.current);
    setCaret(caretTo.current);
    caretTo.current = null;
  }, [text]);
  const put = (value: string) => {
    if (!open) return;
    const next = replaceTrigger(text, open, value);
    caretTo.current = next.caret;
    setText(next.text);
  };

  /**
   * A command alone at the start runs right away, unless it takes arguments (then it's completed so they can be
   * typed). Everything else, skills included, goes into the text where the "/" was.
   */
  const accept = (c: MenuCommand) => {
    const alone = open?.atStart && text.trim() === text.slice(open.start, open.end).trim();
    if (alone && c.kind === "command" && !c.argument_hint) {
      sendText(`/${c.name}`);
      setText("");
      return;
    }
    put(`/${c.name}`);
  };

  // Between compositionstart and compositionend. macOS shows its grey inline predictions as a composition too; a real
  // input method (Japanese, Chinese…) is told apart by its keys, which arrive with keyCode 229 while it composes.
  const composing = useRef(false);
  const imeKey = useRef(false);
  const predicting = useRef(false);
  // What you typed, without a prediction that's showing: what Enter sends while one is.
  const typed = useRef("");
  // A prediction Enter declined: if WebKit still commits it, it's taken back out.
  const declined = useRef(0);
  useEffect(() => {
    if (!predicting.current) typed.current = text;
  }, [text]);
  const sendDeclining = (next: boolean) => {
    const value = typed.current.trim();
    if (!canSend || !value) return;
    declined.current = Date.now();
    if (terminal) {
      if (value.slice(1).trim()) onRun!(value.slice(1).trim());
    } else if (next && sendAndNext && !running) sendAndNext(value);
    else sendText(value);
    setText("");
    typed.current = "";
  };

  const choose = (i: number, tab = false) => {
    if (open?.kind === "@") return files[i] && put(`@${files[i].rel}`);
    const c = commandItems[i];
    if (c) tab ? put(`/${c.name}`) : accept(c);
  };
  const onMenuKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!menuShown || !open) return false;
    const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (e.key === "Escape") setDismissedAt(open.start);
    else if (count === 0) return false;
    else if (move) setPick((pick + move + count) % count);
    else if (e.key === "Tab") choose(pick, true);
    else if (e.key === "Enter" && !e.shiftKey && !composing.current) choose(pick);
    else return false;
    e.preventDefault();
    return true;
  };

  return (
    <div className={`composer${hero ? " hero" : ""}`}>
      {hero && onOpenFolder && (
        <div className="composer-pills">
          {folders ? (
            <FolderPill folder={folder ?? null} loadRecent={folders.load} onPick={folders.onPick} onBrowse={onOpenFolder} disabled={busy} />
          ) : (
            <button className="pill" onClick={onOpenFolder} disabled={busy} title={folder ?? "Open a folder for Claude to work in"}>
              <FolderIcon />
              <span>{folder ? basename(folder) : "Open folder"}</span>
            </button>
          )}
          {sessions && folder && <SessionPill loadSessions={sessions.load} currentId={sessions.currentId} onOpen={sessions.onOpen} openChats={sessions.open} onSwitch={sessions.onSwitch} disabled={status === "starting"} />}
        </div>
      )}
      {queued.length > 0 && (
        <ul className="queue" aria-label="Queued messages">
          {queued.map((q, i) => (
            <li key={i} className="queue-item">
              <span className="queue-label">Queued</span>
              <span className="queue-text" title={q}>
                {q}
              </span>
              <button className="icon queue-remove" aria-label="Remove queued message" title="Remove" onClick={() => setQueued(queued.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={`composer-box${running ? " working" : ""}${terminal ? " terminal" : ""}`} onClick={() => area.current?.focus()}>
        {menuShown && open && (
          <CompletionMenu
            kind={open.kind}
            sections={sections}
            files={files}
            pick={pick}
            onPickCommand={accept}
            onPickFile={(f) => put(`@${f.rel}`)}
            onHover={setPick}
            hint={open.kind === "@" && count === 0 ? (open.query ? "No files match" : "Type to find a file in this folder") : undefined}
            issues={issues}
            onOpenSettings={onOpenSettings}
          />
        )}
        <div className="composer-line">
          {terminal && (
            <span className="terminal-prompt" aria-hidden>
              $
            </span>
          )}
          <textarea
            ref={area}
            aria-label={terminal ? "Shell command" : undefined}
            spellCheck={!terminal}
            // WebKit otherwise applies macOS's "Capitalize words automatically" and autocorrect to what you type.
            autoCapitalize="off"
            autoCorrect="off"
            rows={hero ? 2 : 1}
            value={shown}
            disabled={!canType}
            placeholder={placeholder}
            onChange={(e) => {
              setText(terminal ? `!${e.target.value}` : e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onCompositionStart={() => {
              composing.current = true;
              predicting.current = !imeKey.current;
            }}
            onCompositionEnd={() => {
              composing.current = false;
              predicting.current = false;
              // Enter just sent the text without the prediction; WebKit committed it anyway: empty the box again.
              if (Date.now() - declined.current < 500) setTimeout(() => setText(""));
            }}
            onKeyDown={(e) => {
              imeKey.current = e.nativeEvent.keyCode === 229;
              // A grey prediction is showing: Enter sends what you typed, without it (Tab or → is for taking it).
              if (e.key === "Enter" && !e.shiftKey && composing.current && predicting.current) {
                e.preventDefault();
                sendDeclining(e.metaKey || e.ctrlKey);
                return;
              }
              if (onMenuKey(e)) return;
              // Backspace in an empty terminal leaves it, taking the "!" away.
              if (terminal && e.key === "Backspace" && shown === "") {
                e.preventDefault();
                setText("");
                return;
              }
              // Enter sends, unless an input method (Japanese, Chinese…) is composing: then it confirms that. macOS's
              // grey inline predictions also mark the key as composing; Enter doesn't take them (Tab or → does).
              if (e.key === "Enter" && !e.shiftKey && !composing.current) {
                e.preventDefault();
                if ((e.metaKey || e.ctrlKey) && sendAndNext && !terminal) submitAndNext();
                else submit();
              }
            }}
          />
        </div>
        <div className="composer-footer">
          {terminal ? (
            <span className="terminal-hint">Claude sees the output with your next message · backspace to leave</span>
          ) : models ? (
            <ModelPicker running={model ?? null} chosen={models.chosen} defaultModel={models.defaultModel} ids={models.ids} options={models.options} onChoose={models.onChoose} disabled={busy} />
          ) : (
            model && (
              <span className="composer-item" title="Model">
                <SparkIcon />
                {model}
              </span>
            )
          )}
          {!terminal && effort && effortLevels.length > 0 && <EffortPicker chosen={effort.chosen} levels={effortLevels} onChoose={effort.onChoose} disabled={busy} />}
          {!terminal && harness && <HarnessPicker {...harness} disabled={busy} />}
          <div className="spacer" />
          {usage && <ContextMeter used={usage.used} window={usage.window} running={running} lastTurnMs={usage.lastTurnMs} />}
          {terminal ? (
            <button className="send run" aria-label="Run" title="Run (Enter)" disabled={!canSend} onClick={submit}>
              <ArrowUpIcon />
            </button>
          ) : running ? (
            <button className="send stop" aria-label="Stop" title="Stop (⌘.)" onClick={stop}>
              <span className="stop-square" />
            </button>
          ) : (
            <>
              {sendAndNext && (
                <button className="ghost send-next" title="Send, then approve this step and go on (⌘Enter)" disabled={!canSend} onClick={submitAndNext}>
                  Send &amp; next
                </button>
              )}
              <button className="send" aria-label="Send" title={sendAndNext ? "Send about this step (Enter)" : "Send (Enter)"} disabled={!canSend} onClick={submit}>
                <ArrowUpIcon />
              </button>
            </>
          )}
        </div>
      </div>
      {(mode || branch || update) && (
        <div className="composer-meta">
          {mode && onModeChange && <ModeMenu mode={mode} flavour={flavour} onChange={onModeChange} disabled={busy} />}
          <div className="spacer" />
          {update && <UpdateButton {...update} />}
          {branch && (
            <span className="meta-item static" title="Git branch">
              <BranchIcon />
              {branch}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
