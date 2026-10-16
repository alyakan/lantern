import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Status } from "../store";
import type { FoundFile, ModelOption, RecentFolder, SessionSummary, SkillEntry, SlashCommand } from "../types";
import { basename } from "../lib/diff";
import { useShortcut } from "../lib/shortcuts";
import { matchCommands } from "../lib/slash";
import { decodeDraft, encodeDraft, expandPastes, inUse, isBigPaste, nextNumber, placeholder as pasteToken, tokenBefore, type Pastes } from "../lib/paste";
import { describeCommands, replaceTrigger, sections as menuSections, triggerAt, type MenuCommand } from "../lib/complete";
import { CompletionMenu, type McpIssue } from "./CompletionMenu";
import { ArrowUpIcon, BranchIcon, FolderIcon, SideChatIcon, SparkIcon } from "./icons";
import { ContextMeter } from "./ContextMeter";
import { EFFORT_LEVELS } from "../lib/effort";
import { FolderPill, type RelocateMenu } from "./FolderPill";
import { PermissionsMenu, WorkflowMenu } from "./ModeMenu";
import type { Flavour } from "../lib/flavour";
import type { Permissions, Workflow } from "../lib/workflow";
import { ModelsPicker } from "./ModelsPicker";
import type { Harness } from "../lib/harness";
import { SessionPill } from "./SessionPill";
import { SideChat } from "./SideChat";
import { UpdateButton } from "./UpdateButton";

const MAX_HEIGHT = 200; // about 8 lines


interface Props {
  status: Status;
  /** Replaces the usual "Ask Claude…" when idle (e.g. on a Step-by-step page). */
  idlePlaceholder?: string;
  /** On a Step-by-step page: ⌘Enter (or the button) sends the message and approves the step, moving on. */
  sendAndNext?: (text: string) => void;
  /** `draft`: the box as typed, encoded (see lib/paste.ts), so the message keeps its paste placeholders. */
  onSend: (text: string, draft?: string) => void;
  onStop: () => void;
  /** While Claude starts, a way out: Cancel stops the start. */
  onCancelStart?: () => void;
  /** "!" at the start of the box turns it into a terminal: Enter runs the rest as a shell command in the folder. */
  onRun?: (command: string) => void;
  /** The chat's two settings, as chips under the box: Permissions (Ask or Auto) and Workflow (Chat, Step by step or Team). */
  permissions?: Permissions;
  workflow?: Workflow;
  /** Step by step's flavour, which the Workflow chip names too. */
  flavour?: Flavour | null;
  onPermissionsChange?: (permissions: Permissions) => void;
  onWorkflowChange?: (workflow: Workflow) => void;
  /** A Lead that still has agents: its Workflow stays Team until they are closed. */
  holdsAgents?: boolean;
  model?: string | null;
  branch?: string | null;
  /** Empty conversation: float the composer in the middle with a folder pill above it. */
  hero?: boolean;
  folder?: string | null;
  onOpenFolder?: () => void;
  /** Shown next to the folder pill in the empty state: pick a past session to continue. */
  sessions?: { load: () => Promise<SessionSummary[]>; exclude: string[]; onOpen: (id: string) => void };
  /** The folder capsule's menu: recent folders to switch to. */
  folders?: { load: () => Promise<RecentFolder[]>; onPick: (path: string) => void; relocate?: RelocateMenu };
  /** The chat's queued messages; without it the box keeps its own queue. */
  queue?: { items: string[]; set: (next: string[]) => void };
  /** Context use and timing for the footer meter. */
  usage?: { used: number | null; window: number; lastTurnMs: number | null; actions?: { onCompact: () => void; onClear: () => void }; session?: { cost: number | null; tokens: number } };
  /** The Models chip: the model the user chose (null = default) and how to change it. */
  models?: { chosen: string | null; onChoose: (model: string | null) => void; defaultModel?: string | null; ids?: Record<string, string>; options?: ModelOption[] };
  /** Thinking effort, under the chip's Customize…: the chosen level (null = default) and how to change it. */
  effort?: { chosen: string | null; onChoose: (level: string | null) => void };
  /** The chat's harness (which models do what) and the presets the Models chip lists. */
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
  /** The folder's sent prompts, oldest first, as encoded drafts: ↑ and ↓ recall them. `remember` adds one when sent. */
  history?: { entries: string[]; remember: (entry: string) => void };
}

export function MessageInput({ status, idlePlaceholder, sendAndNext, onSend, onStop, onCancelStart, onRun, permissions, workflow, flavour = null, onPermissionsChange, onWorkflowChange, holdsAgents, model, branch, hero, folder, onOpenFolder, sessions, folders, models, usage, queue, commands = [], skillIndex, findFiles, mcpIssues, onOpenSettings, draft, effort, harness, update, history }: Props) {
  // A draft with big pastes in it comes back as the box had it: their placeholders, and the text they stand for.
  const [restored] = useState(() => decodeDraft(draft?.initial ?? ""));
  const [text, setTextState] = useState(restored.text);
  const pastes = useRef<Pastes>(restored.pastes);
  const setText = (next: string) => {
    pastes.current = inUse(next, pastes.current);
    setTextState(next);
    draft?.save(encodeDraft(next, pastes.current));
  };
  // What goes out: each placeholder replaced by the text it stands for.
  const expand = (t: string) => expandPastes(t, pastes.current);
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
        : status === "ended"
          ? "Claude stopped — restart to continue"
          : terminal
            ? `Run a command in ${folder ? basename(folder) : "the folder"}…`
            : running
              ? "Queue a message…"
              : (idlePlaceholder ?? "Ask Claude…");

  // A queued message goes out in full (the queue holds the text), but it's remembered as it was in the box: its
  // placeholders, with their pastes kept here so the numbers aren't reused meanwhile. The queue shows and Stop restores that.
  const queuedBox = useRef(new Map<string, { box: string; pastes: Pastes }>());
  const queuedPastes = (): Pastes => Object.assign({}, ...[...queuedBox.current.values()].map((q) => q.pastes));
  useEffect(() => {
    for (const full of queuedBox.current.keys()) if (!queued.includes(full)) queuedBox.current.delete(full);
  }, [queued]);

  // A queued message back in the box to edit: it leaves the queue, and goes in front of what's typed (as Stop does).
  const editQueued = (i: number) => {
    const full = queued[i];
    const kept = queuedBox.current.get(full);
    if (kept) pastes.current = { ...pastes.current, ...kept.pastes };
    setText([kept?.box ?? full, text].filter((t) => t.trim()).join("\n\n"));
    setQueued(queued.filter((_, j) => j !== i));
    area.current?.focus();
  };
  // Send now: that message goes next. Claude's turn is stopped (App's stop, not the one below, which would empty the
  // queue into the box); the queue goes out when the turn ends, with this message first.
  const sendNow = (i: number) => {
    const full = queued[i];
    const rest = queued.filter((_, j) => j !== i);
    if (running) {
      setQueued([full, ...rest]);
      onStop();
    } else {
      setQueued(rest);
      onSend(full);
    }
  };

  // Stop means "not like that": queued messages go back into the box instead of being sent.
  const stop = () => {
    if (queued.length > 0) {
      const back = queued.map((full) => {
        const kept = queuedBox.current.get(full);
        if (!kept) return full;
        pastes.current = { ...pastes.current, ...kept.pastes };
        return kept.box;
      });
      setText([...back, text].filter((t) => t.trim()).join("\n\n"));
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
  // The side chat: a quick question about the chat, answered apart from it, open while Claude works too. Closing it puts
  // the cursor back in the box.
  const [asideOpen, setAsideOpen] = useState(false);
  const sideChatReady = canType && !!folder && !hero && !terminal;
  const closeAside = () => {
    setAsideOpen(false);
    area.current?.focus();
  };
  useShortcut("b", () => (asideOpen ? closeAside() : setAsideOpen(true)), sideChatReady);

  // The levels the chosen model takes (all of them until claude has listed its models); none hides the picker.
  const modelOption = models?.options?.find((o) => (models.chosen === null ? o.value === "default" : o.value === models.chosen));
  const effortLevels = models?.options?.length ? (modelOption?.effort_levels ?? [...EFFORT_LEVELS]) : [...EFFORT_LEVELS];

  // While Claude works, a message waits in the queue instead of going out.
  const sendText = (t: string) => {
    const full = expand(t);
    remember(t);
    if (running) {
      queuedBox.current.set(full, { box: t, pastes: inUse(t, pastes.current) });
      setQueued([...queued, full]);
    } else onSend(full, encodeDraft(t, inUse(t, pastes.current)));
  };

  // A sent prompt joins the folder's history, kept as its draft so ↑ brings the paste placeholders back too.
  const remember = (t: string) => history?.remember(encodeDraft(t, inUse(t, pastes.current)));

  const submit = () => {
    if (!canSend) return;
    // A command runs now, even while Claude works: it doesn't wait in the queue.
    if (terminal) onRun!(shown.trim());
    else sendText(text.trim());
    setText("");
  };

  const submitAndNext = () => {
    if (!canSend || !sendAndNext || running || terminal) return;
    remember(text.trim());
    sendAndNext(expand(text.trim()));
    setText("");
  };

  // ↑ and ↓ recall the folder's prompts: `at` is the one in the box (an index into `history.entries`), `typed` the draft
  // of what was there before, which Escape or ↓ past the newest brings back. Typing or sending ends the recall.
  const [recall, setRecall] = useState<{ at: number; shown: string; typed: string } | null>(null);
  useEffect(() => {
    if (recall && text !== recall.shown) setRecall(null);
  }, [text]);
  const showRecalled = (at: number, typed: string) => {
    const kept = decodeDraft(history!.entries[at]);
    pastes.current = kept.pastes;
    caretTo.current = kept.text.length;
    setRecall({ at, shown: kept.text, typed });
    setText(kept.text);
  };
  const restoreTyped = (typed: string) => {
    const kept = decodeDraft(typed);
    pastes.current = kept.pastes;
    caretTo.current = kept.text.length;
    setRecall(null);
    setText(kept.text);
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
  // The last search that came back, and for what: until the search for the query on screen has, there's nothing to
  // list and no "No files match" to say so.
  const [found, setFound] = useState<{ query: string; files: FoundFile[] } | null>(null);
  const fileQuery = open?.kind === "@" && !open.query.includes(":") ? open.query : null;
  const searching = !!findFiles && fileQuery !== null && found?.query !== fileQuery;
  const files = fileQuery !== null && found?.query === fileQuery ? found.files : [];
  useEffect(() => {
    if (!fileQuery || !findFiles) return;
    let live = true;
    const done = (f: FoundFile[]) => live && setFound({ query: fileQuery, files: f.slice(0, 8) });
    const t = setTimeout(() => findFiles(fileQuery).then(done, () => done([])), 80);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [fileQuery]);
  const count = open?.kind === "/" ? commandItems.length : open?.kind === "@" ? files.length : 0;
  const issues = open?.kind === "/" ? (mcpIssues ?? []) : [];
  const menuShown = !!open && (count > 0 || issues.length > 0 || (open.kind === "@" && !!findFiles && !open.query.includes(":")));
  const [pick, setPick] = useState(0);
  // Whether the user has arrowed into the list: mid-message, a "/" menu takes Enter only then.
  const [arrowed, setArrowed] = useState(false);
  useEffect(() => {
    setPick(0);
    setArrowed(false);
  }, [open?.kind, open?.query]);

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
  // WebKit can deliver the Enter that commits a composition after compositionend, still with keyCode 229: that one
  // confirms the input method, it doesn't send.
  const composingKey = (e: KeyboardEvent<HTMLTextAreaElement>) => composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
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
    } else if (next && sendAndNext && !running) {
      remember(value);
      sendAndNext(expand(value));
    }
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
    // Nothing to pick yet: Enter waits for the search rather than sending "@query" as it is.
    else if (count === 0) {
      if (!searching || e.key !== "Enter") return false;
    } else if (move) {
      setPick((pick + move + count) % count);
      setArrowed(true);
    } else if (e.key === "Tab") choose(pick, true);
    else if (e.key === "Enter" && !e.shiftKey && !composingKey(e)) {
      // A "/" in the middle of a sentence ("re-run the checks on /test") is just text: Enter sends it.
      if (open.kind === "/" && !open.atStart && !arrowed) return false;
      choose(pick);
    } else return false;
    e.preventDefault();
    return true;
  };

  return (
    <div className={`composer${hero ? " hero" : ""}`}>
      {hero && onOpenFolder && (
        <div className="composer-pills">
          {folders ? (
            <FolderPill folder={folder ?? null} loadRecent={folders.load} onPick={folders.onPick} onBrowse={onOpenFolder} disabled={busy} relocate={folders.relocate} />
          ) : (
            <button className="pill" onClick={onOpenFolder} disabled={busy} title={folder ?? "Open a folder for Claude to work in"}>
              <FolderIcon />
              <span>{folder ? basename(folder) : "Open folder"}</span>
            </button>
          )}
          {sessions && folder && <SessionPill loadSessions={sessions.load} exclude={sessions.exclude} onOpen={sessions.onOpen} disabled={status === "starting"} />}
        </div>
      )}
      {queued.length > 0 && (
        <ul className="queue" aria-label="Queued messages">
          {queued.map((q, i) => (
            <li key={i} className="queue-item">
              <span className="queue-label">Queued</span>
              <button className="queue-text" title="Edit: takes it back to the box" onClick={() => editQueued(i)}>
                {queuedBox.current.get(q)?.box ?? q}
              </button>
              <button className="link-button queue-now" title="Stops Claude's turn and sends this next (anything queued after it goes with it)" onClick={() => sendNow(i)}>
                Send now
              </button>
              <button className="icon queue-remove" aria-label="Remove queued message" title="Remove" onClick={() => setQueued(queued.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {asideOpen && (
        <div className="aside-anchor">
          <SideChat onClose={closeAside} />
        </div>
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
            hint={open.kind === "@" && count === 0 && !searching ? (open.query ? "No files match" : "Type to find a file in this folder") : undefined}
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
            aria-label={terminal ? "Shell command" : "Message to Claude"}
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
            onPaste={(e) => {
              // A big paste goes in as a placeholder (its text is kept for sending); a small one as usual.
              if (terminal) return;
              const pasted = e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
              if (!isBigPaste(pasted)) return;
              e.preventDefault();
              const { selectionStart: from, selectionEnd: to } = e.currentTarget;
              const n = nextNumber(text, { ...queuedPastes(), ...pastes.current });
              const token = pasteToken(n, pasted);
              pastes.current = { ...pastes.current, [n]: pasted };
              caretTo.current = from + token.length;
              setText(text.slice(0, from) + token + text.slice(to));
            }}
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
              // ↑ at the start of the box (or in an empty one) recalls the last prompt; ↓ goes forward again.
              if (history && !terminal && !composingKey(e) && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
                const { selectionStart: from, selectionEnd: to } = e.currentTarget;
                if (e.key === "ArrowUp" && (recall || (from === 0 && to === 0))) {
                  const older = recall ? recall.at - 1 : history.entries.length - 1;
                  if (older < 0) return;
                  e.preventDefault();
                  showRecalled(older, recall ? recall.typed : encodeDraft(text, inUse(text, pastes.current)));
                  return;
                }
                if (e.key === "ArrowDown" && recall) {
                  e.preventDefault();
                  if (recall.at + 1 < history.entries.length) showRecalled(recall.at + 1, recall.typed);
                  else restoreTyped(recall.typed);
                  return;
                }
              }
              // Escape takes back a recalled prompt, to what was being typed.
              if (e.key === "Escape" && recall) {
                e.preventDefault();
                restoreTyped(recall.typed);
                return;
              }
              // Backspace right after a placeholder takes all of it away.
              if (e.key === "Backspace" && !terminal && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
                const token = tokenBefore(text, e.currentTarget.selectionStart);
                if (token) {
                  e.preventDefault();
                  caretTo.current = token.start;
                  setText(text.slice(0, token.start) + text.slice(token.end));
                  return;
                }
              }
              // Backspace in an empty terminal leaves it, taking the "!" away.
              if (terminal && e.key === "Backspace" && shown === "") {
                e.preventDefault();
                setText("");
                return;
              }
              // Enter sends, unless an input method (Japanese, Chinese…) is composing: then it confirms that. macOS's
              // grey inline predictions also mark the key as composing; Enter doesn't take them (Tab or → does).
              if (e.key === "Enter" && !e.shiftKey && !composingKey(e)) {
                e.preventDefault();
                // While Claude works, ⌘Enter queues like Enter (the step can't be approved until it's done).
                if ((e.metaKey || e.ctrlKey) && sendAndNext && !terminal && !running) submitAndNext();
                else submit();
              }
            }}
          />
        </div>
        <div className="composer-footer">
          {terminal ? (
            <span className="terminal-hint">Claude sees the output with your next message · backspace to leave</span>
          ) : models ? (
            <ModelsPicker
              running={model ?? null}
              chosen={models.chosen}
              onChoose={models.onChoose}
              defaultModel={models.defaultModel}
              ids={models.ids}
              options={models.options}
              effort={effort && effortLevels.length > 0 ? { ...effort, levels: effortLevels } : undefined}
              presets={harness?.presets}
              preset={harness?.chosen}
              onPreset={harness?.onChoose}
              onEdit={harness?.onEdit}
              disabled={busy}
            />
          ) : (
            model && (
              <span className="composer-item" title="Model">
                <SparkIcon />
                {model}
              </span>
            )
          )}
          <div className="spacer" />
          {sideChatReady && (
            <button type="button" className="ghost side-chat-button" aria-label="Ask a side question" aria-expanded={asideOpen} title="Side chat: a quick question that isn't added to this chat (⌘B)" onClick={() => (asideOpen ? closeAside() : setAsideOpen(true))}>
              <SideChatIcon />
            </button>
          )}
          {usage && <ContextMeter used={usage.used} window={usage.window} running={running} lastTurnMs={usage.lastTurnMs} actions={usage.actions} session={usage.session} />}
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
              {status === "starting" && onCancelStart && (
                <button className="ghost" title="Stop starting Claude" onClick={onCancelStart}>
                  Cancel
                </button>
              )}
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
      {(permissions || branch || update) && (
        <div className="composer-meta">
          {permissions && onPermissionsChange && <PermissionsMenu permissions={permissions} onChange={onPermissionsChange} disabled={busy} />}
          {workflow && onWorkflowChange && <WorkflowMenu workflow={workflow} flavour={flavour} onChange={onWorkflowChange} disabled={busy} holdsAgents={holdsAgents} />}
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
