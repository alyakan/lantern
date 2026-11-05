import { useState } from "react";
import type { Todo } from "../lib/todos";
import type { RepoStatus } from "../types";
import { Row } from "./DeskCard";

/** Ways in for a project with nothing in flight: each starts a chat that reads before it changes anything. */
export const IDEAS: { label: string; prompt: string }[] = [
  { label: "What is this project?", prompt: "Read through this project and tell me what it does, how it is laid out and how to run it. Don't change anything." },
  { label: "Find what to improve", prompt: "Look through this project for the most worthwhile things to improve next (bugs, missing tests, rough edges) and list them, most valuable first. Don't change anything yet." },
  { label: "Check the tests", prompt: "Run this project's tests and tell me what fails and why. Don't change anything yet." },
  { label: "Sort the TODO comments", prompt: "Find the TODO and FIXME comments in this project and group them by what matters most. Don't change anything." },
];

const CHANGES_PROMPT = "Look at the uncommitted changes in this checkout and tell me what is left to finish before they can be committed. Don't change anything yet.";
const SHOWN_TODOS = 3;

export interface DeskProjectLandingProps {
  label: string;
  /** Its repository as the Mac said: null when it isn't in one. */
  repo: RepoStatus | null;
  /** Its checkout's state, for the uncommitted changes. */
  here: RepoStatus["folders"][number] | undefined;
  /** Its open to-dos, nearest due first; null until they are read. */
  todos: Todo[] | null;
  onStartChat: (first: string) => void;
  onStartTodo: (todo: Todo) => void;
}

/**
 * A project's page when its work board has nothing to show: what is next in it (its to-dos, changes not yet committed), and a way
 * to start a chat, with a few ideas for where to begin. Only what Lantern, git and the to-dos say is offered as next; the ideas
 * are plainly ideas.
 */
export function DeskProjectLanding({ label, repo, here, todos, onStartChat, onStartTodo }: DeskProjectLandingProps) {
  const [text, setText] = useState("");
  const open = todos ?? [];
  const changed = here?.changed ?? 0;
  // A project on the Desk always has a chat open, so that is no sign of something going on.
  const empty = open.length === 0 && changed === 0;
  const start = () => {
    const first = text.trim();
    if (!first) return;
    onStartChat(first);
    setText("");
  };
  return (
    <section className="dp-card dp-landing" aria-label="Start here">
      <div className="dp-landing-hero">
        <h2 className="dp-landing-title">{empty ? `${label} is a clean slate` : `Nothing in flight in ${label}`}</h2>
        <p className="dp-landing-sub">{repo ? "No open pull requests, branches or Linear issues of yours here." : "It isn't in a git repository, so there are no branches or pull requests to follow."}</p>
      </div>
      {(open.length > 0 || changed > 0) && (
        <div className="dp-landing-next">
          <h3 className="dp-landing-head">Next up</h3>
          <ul className="dp-list">
            {changed > 0 && (
              <li className="dp-row">
                <Row
                  title={`${changed} uncommitted change${changed === 1 ? "" : "s"}${here?.branch ? ` on ${here.branch}` : ""}`}
                  aside={
                    <button className="desk-more" onClick={() => onStartChat(CHANGES_PROMPT)}>
                      Review in a chat
                    </button>
                  }
                  meta="Work started here and not committed yet."
                />
              </li>
            )}
            {open.slice(0, SHOWN_TODOS).map((t) => (
              <li key={t.id} className="dp-row">
                <Row
                  title={t.title}
                  aside={
                    <button className="desk-more" aria-label={`Start on ${t.title}`} onClick={() => onStartTodo(t)}>
                      Start
                    </button>
                  }
                  meta={t.due ? `Due ${t.due.date}${t.due.time ? ` ${t.due.time}` : ""}` : "From your to-dos"}
                />
              </li>
            ))}
          </ul>
          {open.length > SHOWN_TODOS && <p className="dp-note dp-foot">and {open.length - SHOWN_TODOS} more to-dos below</p>}
        </div>
      )}
      <form
        className="dp-landing-start"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <h3 className="dp-landing-head">{empty ? "Start with a chat" : "Or start a chat"}</h3>
        <textarea
          aria-label={`What do you want to work on in ${label}?`}
          placeholder="What do you want to work on?"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              start();
            }
          }}
        />
        <div className="dp-landing-actions">
          <button type="submit" disabled={!text.trim()}>
            Start chat
          </button>
          <button type="button" className="desk-more" onClick={() => onStartChat("")}>
            Empty chat
          </button>
        </div>
        <div className="dp-ideas" role="group" aria-label="Ideas to start with">
          {IDEAS.map((i) => (
            <button type="button" key={i.label} className="dp-idea" onClick={() => onStartChat(i.prompt)}>
              {i.label}
            </button>
          ))}
        </div>
      </form>
    </section>
  );
}
