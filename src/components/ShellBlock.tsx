import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type UIEvent } from "react";
import type { ShellItem } from "../store";
import { cleanOutput, lastLines } from "../lib/shell";
import { elapsed } from "../lib/time";

/** How many lines a block shows until "Show all". */
export const SHOWN_LINES = 400;
/** How long output has to stop mid-line before the command counts as asking something. */
export const PROMPT_PAUSE_MS = 400;

/** A command the user ran from the chat box, as a little terminal: the command, its output as it comes, how it ended. */
export function ShellBlock({ item, onStop, onInput }: { item: ShellItem; onStop?: (id: string) => void; onInput?: (id: string, text: string) => void }) {
  const [all, setAll] = useState(false);
  const clean = cleanOutput(item.output);
  const shown = all ? { text: clean.replace(/\n$/, ""), hidden: 0 } : lastLines(clean, SHOWN_LINES);
  const running = item.status === "running";

  // Follows the output while it comes, unless you scrolled up in it.
  const pre = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    if (atEnd.current && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [shown.text]);
  const onScroll = (e: UIEvent<HTMLPreElement>) => {
    const el = e.currentTarget;
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  // Asking something: reading a secret, or its output stopped mid-line ("Continue? [y/N] ") for a moment. Answered or
  // dismissed, the dialog waits for the command to print something new.
  const [paused, setPaused] = useState(false);
  const [settledAt, setSettledAt] = useState(-1);
  const [opened, setOpened] = useState(false);
  const midLine = clean !== "" && !clean.endsWith("\n");
  useEffect(() => {
    setPaused(false);
    if (!running || !midLine) return;
    const t = setTimeout(() => setPaused(true), PROMPT_PAUSE_MS);
    return () => clearTimeout(t);
  }, [item.output, running]);
  const asking = !!onInput && running && settledAt !== item.output.length && (!!item.secret || paused);
  const open = !!onInput && running && (asking || opened);
  const settle = () => {
    setSettledAt(item.output.length);
    setOpened(false);
  };

  return (
    <div className={`shell-block ${item.status}`} role="group" aria-label={`Command: ${item.command}`}>
      <div className="shell-head">
        <span className="shell-prompt" aria-hidden>
          $
        </span>
        <span className="shell-command">{item.command}</span>
        {running ? (
          <>
            <span className="spinner" aria-label="Running" />
            {onInput && !open && (
              <button className="shell-stop" onClick={() => setOpened(true)} title="Type something to this command">
                Reply
              </button>
            )}
            {onStop && (
              <button className="shell-stop" onClick={() => onStop(item.id)} title="Stop this command">
                Stop
              </button>
            )}
          </>
        ) : (
          <span className="shell-status">
            {item.status === "stopped" ? "stopped" : item.code === null ? "" : `exit ${item.code}`}
            {item.endedAt !== undefined && item.endedAt - item.startedAt >= 1000 && <span className="shell-time">{elapsed(item.endedAt - item.startedAt)}</span>}
          </span>
        )}
      </div>
      {shown.hidden > 0 && (
        <button className="shell-more" onClick={() => setAll(true)}>
          Show all {shown.hidden + SHOWN_LINES} lines
        </button>
      )}
      {shown.text && (
        <pre className="shell-output" ref={pre} onScroll={onScroll}>
          {shown.text}
        </pre>
      )}
      {open && (
        <ShellAsk
          prompt={midLine ? (clean.split("\n").pop() ?? "").trim() : ""}
          secret={!!item.secret}
          onSend={(text) => {
            onInput!(item.id, text);
            settle();
          }}
          onDismiss={settle}
        />
      )}
    </div>
  );
}

/** What a running command asked, and the field to answer it: a secret one for a password, never kept or shown. */
function ShellAsk({ prompt, secret, onSend, onDismiss }: { prompt: string; secret: boolean; onSend: (text: string) => void; onDismiss: () => void }) {
  const [reply, setReply] = useState("");
  const field = useRef<HTMLInputElement>(null);
  // Into the field when it opens, unless you're typing something elsewhere.
  useEffect(() => {
    const busy = document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement ? document.activeElement.value !== "" : false;
    if (!busy) field.current?.focus();
  }, [secret]);
  const send = (e: FormEvent) => {
    e.preventDefault();
    onSend(`${reply}\r`);
    setReply("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // ⌃D: end of input, for a command reading until you're done.
    if (e.key === "d" && e.ctrlKey) {
      e.preventDefault();
      onSend("\u0004");
      setReply("");
    } else if (e.key === "Escape") {
      e.preventDefault();
      onDismiss();
    }
  };
  return (
    <form className={`shell-ask${secret ? " secret" : ""}`} onSubmit={send}>
      <label className="shell-ask-label">
        <span className="shell-ask-prompt">{secret ? `🔒 ${prompt || "Password"}` : prompt || "Reply to the command"}</span>
        <input
          ref={field}
          className="shell-ask-field"
          type={secret ? "password" : "text"}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={onKey}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label={secret ? "Secret reply" : "Reply"}
        />
      </label>
      <button type="submit" className="shell-ask-send">
        Send
      </button>
      <span className="shell-ask-hint">{secret ? "Goes only to the command: not shown, kept or sent to Claude" : "Enter sends · ⌃D ends input · Esc hides"}</span>
    </form>
  );
}
