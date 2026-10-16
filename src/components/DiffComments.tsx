import { useEffect, useRef, useState } from "react";
import { basename } from "../lib/diff";
import { clipLine, type CommentControls, type DiffComment } from "../lib/diffComments";

/** "line 42", or "line 41 before" for a removed line, which is numbered in the file as it was. */
export const lineLabel = (c: Pick<DiffComment, "side" | "line">) => (c.side === "old" ? `Line ${c.line} before` : `Line ${c.line}`);

/**
 * The box a comment is written in: Enter adds it, Shift+Enter starts a new line, Escape cancels. Also how one is edited.
 * `label` names it for a screen reader ("Comment on line 42 of retry.ts").
 */
export function CommentBox({ label, initial = "", onSave, onCancel }: { label: string; initial?: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const box = useRef<HTMLTextAreaElement>(null);
  // Focused once it is on screen: an editor draws a note's node a frame after it is given it.
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const focus = () => {
      const el = box.current;
      if (!el) return;
      if (el.isConnected) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      } else if (tries++ < 30) frame = requestAnimationFrame(focus);
    };
    focus();
    return () => cancelAnimationFrame(frame);
  }, []);
  const save = () => text.trim() !== "" && onSave(text.trim());
  return (
    <form
      className="diff-comment-box"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <textarea
        ref={box}
        aria-label={label}
        rows={Math.min(6, Math.max(2, text.split("\n").length))}
        placeholder="Leave a comment for Claude"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className="diff-comment-actions">
        <span className="diff-comment-hint">Enter adds it, Shift+Enter starts a new line</span>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={text.trim() === ""}>
          {initial ? "Save" : "Add comment"}
        </button>
      </div>
    </form>
  );
}

/** A comment as a note under its line: what was written, with Edit and Delete. `where` names the file for a screen reader. */
export function CommentNote({ comment, where, onEdit, onDelete, quote }: { comment: DiffComment; where: string; onEdit: (text: string) => void; onDelete: () => void; quote?: boolean }) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <CommentBox
        label={`Edit your comment on ${lineLabel(comment).toLowerCase()} of ${where}`}
        initial={comment.text}
        onSave={(text) => {
          onEdit(text);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  return (
    <div className={`diff-comment${comment.outdated ? " outdated" : ""}`} role="group" aria-label={`Comment on ${lineLabel(comment).toLowerCase()} of ${where}`}>
      <div className="diff-comment-head">
        <span className="diff-comment-line">{lineLabel(comment)}</span>
        {comment.outdated && (
          <span className="diff-comment-tag" title="Claude changed this line, so the comment no longer sits on it. It stays until you delete it, and is sent with the rest.">
            Outdated
          </span>
        )}
        <span className="spacer" />
        <button className="ghost" aria-label={`Edit comment on ${lineLabel(comment).toLowerCase()} of ${where}`} onClick={() => setEditing(true)}>
          Edit
        </button>
        <button className="ghost" aria-label={`Delete comment on ${lineLabel(comment).toLowerCase()} of ${where}`} onClick={onDelete}>
          Delete
        </button>
      </div>
      {quote && comment.lineText.trim() !== "" && <code className="diff-comment-quote">{clipLine(comment.lineText)}</code>}
      <div className="diff-comment-text">{comment.text}</div>
    </div>
  );
}

/**
 * The bar over the diff once there are comments: how many, and Send to Claude (one message for all of them) or Discard.
 * Discard asks once: the comments are the user's own writing. `sendOff` is why Send isn't there right now.
 */
export function CommentBar({ count, onSend, onDiscard, busy, sendOff }: { count: number; onSend: () => void; onDiscard: () => void; busy?: boolean; sendOff?: string | null }) {
  const [sure, setSure] = useState(false);
  // Whatever changes the count (a comment deleted, all sent) puts the question away.
  useEffect(() => setSure(false), [count]);
  return (
    <div className="review-bar comment-bar" role="group" aria-label="Review comments">
      <span className="comment-bar-count" role="status">
        {count} comment{count === 1 ? "" : "s"}
      </span>
      <div className="spacer" />
      {sure ? (
        <>
          <span className="comment-bar-ask">Discard {count === 1 ? "this comment" : `all ${count}`}?</span>
          <button className="ghost" onClick={() => setSure(false)}>
            Keep
          </button>
          <button className="ghost danger" onClick={onDiscard}>
            Discard
          </button>
        </>
      ) : (
        <>
          <button className="ghost" onClick={() => setSure(true)}>
            Discard
          </button>
          <button className="primary" disabled={!!sendOff} title={sendOff ?? (busy ? "Claude is working: this goes in as soon as it's done" : "Send every comment to Claude as one message")} onClick={onSend}>
            Send to Claude
          </button>
        </>
      )}
    </div>
  );
}

/** Over a file's diff: the comments whose line Claude has since changed, which have no line to sit under. They stay until deleted. */
export function OutdatedNotes({ path, comments }: { path: string; comments: CommentControls }) {
  const items = comments.items.filter((c) => c.path === path && c.outdated);
  if (items.length === 0) return null;
  const where = basename(path);
  return (
    <div className="diff-outdated" role="region" aria-label="Comments on lines that changed">
      <div className="diff-outdated-title">{items.length === 1 ? "This line has changed since you commented on it" : "These lines have changed since you commented on them"}</div>
      {items.map((c) => (
        <CommentNote
          key={c.id}
          comment={c}
          where={where}
          quote
          onEdit={(text) => comments.update((all) => all.map((x) => (x.id === c.id ? { ...x, text } : x)))}
          onDelete={() => comments.update((all) => all.filter((x) => x.id !== c.id))}
        />
      ))}
    </div>
  );
}
