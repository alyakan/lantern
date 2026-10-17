import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useNodeActions } from "../lib/canvasContext";
import type { Status } from "../store";
import { ArrowUpIcon, HudStopIcon } from "./icons";

/**
 * The box under an agent on the canvas: talk to it directly. Slash commands and @ mentions are in the full chat. What is
 * typed and not sent is kept by the app, the same place the full-size chat box keeps it: so it survives zooming out (which
 * swaps the chat for a card), opening the agent full size, and quitting, and counts as unsent text when the chat is left.
 */
export function NodeComposer({ slot, status, queued }: { slot: string; status: Status; queued: string[] }) {
  const actions = useNodeActions();
  const [text, setText] = useState(() => actions.draft(slot));
  const box = useRef<HTMLTextAreaElement>(null);
  const working = status === "running";
  const blocked = status !== "idle" && status !== "running";

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const change = (value: string) => {
    setText(value);
    actions.setDraft(slot, value);
  };

  const submit = () => {
    const message = text.trim();
    if (!message || blocked) return;
    change("");
    // While the agent works the message waits for the end of its turn, like in the full chat.
    if (working) actions.queue(slot, [...queued, message]);
    else actions.send(slot, message);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };

  const placeholder = status === "starting" ? "Starting…" : status === "ended" ? "Stopped" : working ? "Message it (sent when its turn ends)" : "Message this agent";
  return (
    <div className="node-composer">
      {queued.length > 0 && (
        <ul className="node-queue" aria-label="Queued messages">
          {queued.map((q, i) => (
            <li key={`${i}-${q}`}>
              <span title={q}>{q}</span>
              <button className="icon queue-remove" aria-label="Remove queued message" onClick={() => actions.queue(slot, queued.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="node-composer-box">
        <textarea ref={box} rows={1} value={text} disabled={blocked} placeholder={placeholder} aria-label="Message this agent" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => change(e.target.value)} onKeyDown={onKeyDown} />
        {working && (
          <button className="node-send stop" aria-label="Stop" title="Stop this turn" onClick={() => actions.stop(slot)}>
            <HudStopIcon />
          </button>
        )}
        <button className="node-send" aria-label={working ? "Queue message" : "Send"} title={working ? "Queue until its turn ends" : "Send"} disabled={!text.trim() || blocked} onClick={submit}>
          <ArrowUpIcon />
        </button>
      </div>
    </div>
  );
}
