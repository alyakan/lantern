import { useEffect, useRef, useState } from "react";

export interface MessageAction {
  label: string;
  title: string;
  onClick: () => void;
}

/**
 * The row under a message: Copy (its markdown as written), then whatever else the message offers. Hidden until the
 * message is hovered or one of the buttons has keyboard focus, so a chat reads clean.
 */
export function MessageActions({ text, align, actions = [] }: { text: string; align: "start" | "end"; actions?: MessageAction[] }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () =>
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  return (
    <div className={`msg-actions ${align}`} role="group" aria-label="Message actions">
      <button className="msg-action" title="Copy the message as markdown" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
      {actions.map((a) => (
        <button key={a.label} className="msg-action" title={a.title} onClick={a.onClick}>
          {a.label}
        </button>
      ))}
    </div>
  );
}
