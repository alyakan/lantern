import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Status } from "../store";
import type { ModelOption, Mode, RecentFolder, SessionSummary, SlashCommand } from "../types";
import { basename } from "../lib/diff";
import { useShortcut } from "../lib/shortcuts";
import { matchCommands, slashQuery } from "../lib/slash";
import { ArrowUpIcon, BranchIcon, FolderIcon, SparkIcon } from "./icons";
import { ContextMeter } from "./ContextMeter";
import { EFFORT_LEVELS, EffortPicker } from "./EffortPicker";
import { FolderPill } from "./FolderPill";
import { ModeMenu } from "./ModeMenu";
import type { Flavour } from "../lib/flavour";
import { ModelPicker } from "./ModelPicker";
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
  /** What "/" offers: claude's slash commands and skills. */
  commands?: SlashCommand[];
  /** The chat's unsent text, kept while another chat is on screen. */
  draft?: { initial: string; save: (text: string) => void };
  /** A downloaded update of Lantern, shown under the box until it's taken or left for quitting. */
  update?: { version: string; busy: number; onRestart: () => void; onLater: () => void };
}

export function MessageInput({ status, idlePlaceholder, sendAndNext, onSend, onStop, mode, flavour = null, onModeChange, model, branch, hero, folder, onOpenFolder, sessions, folders, models, usage, queue, commands = [], draft, effort, update }: Props) {
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
  const canSend = canType && text.trim() !== "";
  const placeholder =
    status === "no_folder" ? "Open a folder to start" : status === "starting" ? "Starting Claude…" : running ? "Queue a message…" : (idlePlaceholder ?? "Ask Claude…");

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
    const box = el.parentElement;
    if (box) box.style.minHeight = `${box.offsetHeight}px`;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    if (box) box.style.minHeight = "";
  }, [text]);

  useLayoutEffect(() => {
    if (hero && canType) area.current?.focus();
  }, [hero, canType]);

  useShortcut("l", () => area.current?.focus(), canType);
  useShortcut(".", () => stop(), running);

  // The levels the chosen model takes (all of them until claude has listed its models); none hides the picker.
  const modelOption = models?.options?.find((o) => (models.chosen === null ? o.value === "default" : o.value === models.chosen));
  const effortLevels = models?.options?.length ? (modelOption?.effort_levels ?? [...EFFORT_LEVELS]) : [...EFFORT_LEVELS];

  // While Claude works, a message waits in the queue instead of going out.
  const sendText = (t: string) => (running ? setQueued([...queued, t]) : onSend(t));

  const submit = () => {
    if (!canSend) return;
    sendText(text.trim());
    setText("");
  };

  const submitAndNext = () => {
    if (!canSend || !sendAndNext || running) return;
    sendAndNext(text.trim());
    setText("");
  };

  // "/" opens the command menu, filtered by what follows; Escape hides it until the text stops being a command.
  const query = slashQuery(text);
  const [dismissed, setDismissed] = useState(false);
  const [pick, setPick] = useState(0);
  const matches = query !== null && !dismissed && canType ? matchCommands(commands, query) : [];
  useEffect(() => {
    setPick(0);
    if (query === null) setDismissed(false);
  }, [query]);

  /** A command that takes arguments is completed so they can be typed; one that doesn't runs right away. */
  const accept = (c: SlashCommand) => {
    if (c.argument_hint) return setText(`/${c.name} `);
    sendText(`/${c.name}`);
    setText("");
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
    if (next && sendAndNext && !running) sendAndNext(value);
    else sendText(value);
    setText("");
    typed.current = "";
  };

  const onMenuKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length === 0) return false;
    const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (move) setPick((pick + move + matches.length) % matches.length);
    else if (e.key === "Tab") setText(`/${matches[pick].name} `);
    else if (e.key === "Enter" && !e.shiftKey && !composing.current) accept(matches[pick]);
    else if (e.key === "Escape") setDismissed(true);
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
      <div className={`composer-box${running ? " working" : ""}`} onClick={() => area.current?.focus()}>
        {matches.length > 0 && <SlashMenu commands={matches} pick={pick} onPick={accept} onHover={setPick} />}
        <textarea
          ref={area}
          // WebKit otherwise applies macOS's "Capitalize words automatically" and autocorrect to what you type.
          autoCapitalize="off"
          autoCorrect="off"
          rows={hero ? 2 : 1}
          value={text}
          disabled={!canType}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
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
            // Enter sends, unless an input method (Japanese, Chinese…) is composing: then it confirms that. macOS's
            // grey inline predictions also mark the key as composing; Enter doesn't take them (Tab or → does).
            if (e.key === "Enter" && !e.shiftKey && !composing.current) {
              e.preventDefault();
              if ((e.metaKey || e.ctrlKey) && sendAndNext) submitAndNext();
              else submit();
            }
          }}
        />
        <div className="composer-footer">
          {models ? (
            <ModelPicker running={model ?? null} chosen={models.chosen} defaultModel={models.defaultModel} ids={models.ids} options={models.options} onChoose={models.onChoose} disabled={busy} />
          ) : (
            model && (
              <span className="composer-item" title="Model">
                <SparkIcon />
                {model}
              </span>
            )
          )}
          {effort && effortLevels.length > 0 && <EffortPicker chosen={effort.chosen} levels={effortLevels} onChoose={effort.onChoose} disabled={busy} />}
          <div className="spacer" />
          {usage && <ContextMeter used={usage.used} window={usage.window} running={running} lastTurnMs={usage.lastTurnMs} />}
          {running ? (
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

// Opens above the chat box while a command name is being typed.
function SlashMenu({ commands, pick, onPick, onHover }: { commands: SlashCommand[]; pick: number; onPick: (c: SlashCommand) => void; onHover: (i: number) => void }) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.children[pick]?.scrollIntoView?.({ block: "nearest" });
  }, [pick]);
  return (
    <ul className="menu slash-menu" role="listbox" aria-label="Commands" ref={list}>
      {commands.map((c, i) => (
        <li key={c.name} role="option" aria-selected={i === pick}>
          {/* mousedown would take focus from the box; the click still picks. */}
          <button className={`menu-row${i === pick ? " current" : ""}`} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => onHover(i)} onClick={() => onPick(c)}>
            <span className="slash-name">/{c.name}</span>
            {c.argument_hint && <span className="slash-hint">{c.argument_hint}</span>}
            <span className="slash-desc" title={c.description}>
              {c.description}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
