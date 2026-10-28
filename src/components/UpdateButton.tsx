import { useEffect, useRef, useState } from "react";
import { RestartIcon } from "./icons";
import { useMenuInside } from "../lib/useMenuInside";

interface Props {
  version: string;
  /** How many chats are working or waiting on you: restarting would stop them. */
  busy: number;
  onRestart: () => void;
  /** Leave it for when Lantern quits (it installs then). */
  onLater: () => void;
}

// Under the chat box, right side: a downloaded update. With nothing running it restarts straight away; otherwise it
// asks first, since restarting stops every chat's claude.
export function UpdateButton({ version, busy, onRestart, onLater }: Props) {
  const [asking, setAsking] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const inside = useMenuInside(asking);

  useEffect(() => {
    if (!asking) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setAsking(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAsking(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [asking]);

  const chats = busy === 1 ? "1 chat is" : `${busy} chats are`;
  return (
    <div className="model-picker" ref={root}>
      <button className="meta-item" title={`Lantern ${version} is ready. Click to restart and update; your chats come back.`} aria-expanded={busy > 0 ? asking : undefined} onClick={() => (busy > 0 ? setAsking(!asking) : onRestart())}>
        <RestartIcon />
        Update ready
      </button>
      {asking && (
        <div className="menu update-menu" ref={inside.ref} style={inside.style} role="alertdialog" aria-label={`Update to ${version}`}>
          <p className="update-question">
            {chats} still working. Restarting interrupts {busy === 1 ? "it" : "them"}; your chats come back afterwards, ready for your next message.
          </p>
          <div className="update-actions">
            <button
              className="ghost"
              onClick={() => {
                setAsking(false);
                onLater();
              }}
            >
              Update when I quit
            </button>
            <button className="primary" onClick={onRestart}>
              Restart and restore chats
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
