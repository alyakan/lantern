import { useEffect, useRef, useState } from "react";
import { RestartIcon } from "./icons";

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
      <button className="meta-item" title={`Lantern ${version} is ready. Click to restart and update.`} aria-expanded={busy > 0 ? asking : undefined} onClick={() => (busy > 0 ? setAsking(!asking) : onRestart())}>
        <RestartIcon />
        Update ready
      </button>
      {asking && (
        <div className="menu update-menu" role="alertdialog" aria-label={`Update to ${version}`}>
          <p className="update-question">
            {chats} still working. Restarting stops {busy === 1 ? "it" : "them"}; you can resume {busy === 1 ? "it" : "them"} from History.
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
              Restart now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
