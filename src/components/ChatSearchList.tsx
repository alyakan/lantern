import { Fragment } from "react";
import type { ChatHit, ChatPiece } from "../types";
import { relativeTime } from "../lib/time";

/** Text with what matched marked. Built from text nodes: what a chat said is never read as markup. */
function Marked({ pieces }: { pieces: ChatPiece[] }) {
  return (
    <>
      {pieces.map((p, i) =>
        p.hit ? (
          <mark className="text-hit" key={i}>
            {p.text}
          </mark>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}

interface Props {
  chats: ChatHit[];
  onOpen: (id: string, folder: string) => void;
}

/** The past chats that mention what was searched for, newest first: each with its project, how long ago, and the lines around the match. */
export function ChatSearchList({ chats, onOpen }: Props) {
  return (
    <ul className="menu-list" aria-label="Chats that mention that">
      {chats.map((c) => {
        const title = c.title.map((p) => p.text).join("");
        return (
          <li key={c.id}>
            <button className="menu-row search-hit" title={title} onClick={() => onOpen(c.id, c.folder)}>
              <span className="search-hit-head">
                <span className="menu-row-title">
                  <Marked pieces={c.title} />
                </span>
                <span className="menu-row-meta">{`${c.project} · ${relativeTime(c.updated_ms)}`}</span>
              </span>
              {c.snippets.map((s, i) => (
                <span className="search-snippet" key={i}>
                  <span className="search-role">{s.role === "user" ? "You" : "Claude"}</span>
                  <span className="search-text">
                    <Marked pieces={s.pieces} />
                  </span>
                </span>
              ))}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
