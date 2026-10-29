import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { dayOf, dueLabel, isOverdue, shownOrder, tomorrowMorning, TITLE_MAX, useTodos, validDue, type Due, type Todo, type TodoEdit } from "../lib/todos";
import { useReorder } from "../lib/useReorder";
import { TabEmpty } from "./TabEmpty";

/** An open chat a to-do can be linked to: its title and whether it is working now. */
export interface TodoChat {
  title: string;
  working: boolean;
}

interface Props {
  folder: string;
  /** The chats open now, by slot: an item's linked chat shows its title and opens it, while it is open. */
  chats: Record<string, TodoChat>;
  /** ▶: a new chat in this folder works on the item (absent: Claude isn't set up). */
  onStart?: (todo: Todo) => void;
  onOpenChat: (slot: string) => void;
}

/**
 * The project's own to-do list (shared by its worktrees): add, tick off, reword, give a due date, reorder by dragging, start a
 * chat on an item. Claude can add and tick items too (they say so); only the user rewords, reopens or deletes.
 */
export function TodosTab({ folder, chats, onStart, onOpenChat }: Props) {
  const { listing, edit } = useTodos(folder);
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const now = useNow();
  const run = (e: TodoEdit) => {
    setError(null);
    return edit(e).catch((err) => {
      setError(String(err));
      throw err;
    });
  };
  const items = listing ? shownOrder(listing.items, now) : [];
  const open = items.filter((t) => !t.done);
  const done = items.filter((t) => t.done);
  const list = useRef<HTMLUListElement>(null);
  const openIds = open.map((t) => t.id);
  const reorder = useReorder(openIds, list, (id, index) => {
    const ids = openIds.filter((x) => x !== id);
    ids.splice(index, 0, id);
    void run({ op: "reorder", ids }).catch(() => {});
  });
  if (!listing) return <div className="tests-note dash-loading">Loading…</div>;
  return (
    <div className="todos">
      <AddTodo onAdd={(title, due) => run({ op: "add", title, due })} />
      {error && (
        <div className="tests-note todos-error" role="alert">
          {error}
        </div>
      )}
      {listing.items.length === 0 ? (
        <TodosEmpty />
      ) : (
        <>
          <ul className="todos-list" aria-label="To-dos" ref={list} onClickCapture={reorder.onClickCapture}>
            {open.map((t) => (
              <TodoRow key={t.id} todo={t} now={now} chats={chats} run={run} onStart={onStart} onOpenChat={onOpenChat} handle={reorder.handle(t.id)} style={reorder.styleFor(t.id)} lifted={reorder.lifted === t.id} />
            ))}
          </ul>
          {open.length === 0 && <div className="tests-note">Nothing left to do here.</div>}
          {done.length > 0 && (
            <div className="todos-done">
              <div className="todos-done-head">
                <button className="ghost" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
                  {showDone ? "▾" : "▸"} Done ({done.length})
                </button>
                {showDone && (
                  <button className="ghost" onClick={() => void run({ op: "clear_done" }).catch(() => {})}>
                    Clear done
                  </button>
                )}
              </div>
              {showDone && (
                <ul className="todos-list" aria-label="Done">
                  {done.map((t) => (
                    <TodoRow key={t.id} todo={t} now={now} chats={chats} run={run} onOpenChat={onOpenChat} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The time, ticking each half minute: what is overdue changes on its own. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function AddTodo({ onAdd }: { onAdd: (title: string, due: Due | null) => Promise<unknown> }) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [dueOpen, setDueOpen] = useState(false);
  const due: Due | null = date ? { date, time: time || null } : null;
  const ready = title.trim().length > 0 && (!due || validDue(due));
  const add = () => {
    if (!ready) return;
    onAdd(title, due).then(
      () => {
        setTitle("");
        setDate("");
        setTime("");
        setDueOpen(false);
      },
      () => {},
    );
  };
  return (
    <div className="todos-add">
      <div className="todos-add-row">
        <input className="todos-add-input" aria-label="New to-do" placeholder="Add a to-do" maxLength={TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className={`ghost todos-due-toggle${dueOpen || date ? " on" : ""}`} aria-label="Due date" aria-expanded={dueOpen} title="Give it a due date: Lantern reminds you then, on this Mac and your phone" onClick={() => setDueOpen(!dueOpen)}>
          {date ? dueLabel({ date, time: time || null }, Date.now()) : "Due…"}
        </button>
        <button className="primary" disabled={!ready} onClick={add}>
          Add
        </button>
      </div>
      {dueOpen && <DueFields date={date} time={time} onDate={setDate} onTime={setTime} onEnter={add} />}
    </div>
  );
}

function DueFields({ date, time, onDate, onTime, onEnter }: { date: string; time: string; onDate: (d: string) => void; onTime: (t: string) => void; onEnter?: () => void }) {
  const key = (e: KeyboardEvent) => e.key === "Enter" && onEnter?.();
  return (
    <div className="todos-due-fields">
      <input type="date" aria-label="Due day" value={date} onChange={(e) => onDate(e.target.value)} onKeyDown={key} />
      <input type="time" aria-label="Due time" value={time} disabled={!date} onChange={(e) => onTime(e.target.value)} onKeyDown={key} />
      {date && (
        <button
          className="ghost"
          onClick={() => {
            onDate("");
            onTime("");
          }}
        >
          No date
        </button>
      )}
      <span className="todos-due-hint">{date && !time ? "A day alone reminds you at 9:00." : ""}</span>
    </div>
  );
}

interface RowProps {
  todo: Todo;
  now: number;
  chats: Record<string, TodoChat>;
  run: (e: TodoEdit) => Promise<unknown>;
  onStart?: (todo: Todo) => void;
  onOpenChat: (slot: string) => void;
  handle?: ReturnType<ReturnType<typeof useReorder>["handle"]>;
  style?: React.CSSProperties;
  lifted?: boolean;
}

function TodoRow({ todo: t, now, chats, run, onStart, onOpenChat, handle, style, lifted }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const [note, setNote] = useState(t.note ?? "");
  const [date, setDate] = useState(t.due?.date ?? "");
  const [time, setTime] = useState(t.due?.time ?? "");
  const [noteOpen, setNoteOpen] = useState(false);
  const overdue = isOverdue(t, now);
  const chat = t.chat ? chats[t.chat] : undefined;
  const ignore = () => {};
  const startEdit = () => {
    setTitle(t.title);
    setNote(t.note ?? "");
    setDate(t.due?.date ?? "");
    setTime(t.due?.time ?? "");
    setEditing(true);
  };
  const save = () => {
    const due: Due | null = date ? { date, time: time || null } : null;
    if (!title.trim() || (due && !validDue(due))) return;
    run({ op: "update", id: t.id, patch: { title, note: note.trim() ? note : null, due } }).then(() => setEditing(false), ignore);
  };
  if (editing) {
    return (
      <li className="todo editing">
        <input className="todos-add-input" aria-label="Title" autoFocus maxLength={TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? save() : e.key === "Escape" && setEditing(false))} />
        <textarea className="todo-note-edit" aria-label="Note" placeholder="Note (optional)" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        <DueFields date={date} time={time} onDate={setDate} onTime={setTime} />
        <div className="todo-edit-actions">
          <button
            className="ghost danger"
            onClick={() => void run({ op: "delete", id: t.id }).catch(ignore)}
          >
            Delete
          </button>
          <span className="spacer" />
          <button className="ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button className="primary" onClick={save}>
            Save
          </button>
        </div>
      </li>
    );
  }
  const by = t.done ? (t.done_by === "claude" ? "Done by Claude" : null) : t.created_by === "claude" ? "Added by Claude" : null;
  return (
    <li className={`todo${t.done ? " done" : ""}${overdue ? " overdue" : ""}${lifted ? " lifted" : ""}`} data-reorder-id={t.id} style={style} {...handle}>
      <input type="checkbox" data-no-drag aria-label={t.done ? `Open “${t.title}” again` : `Tick off “${t.title}”`} checked={t.done} onChange={(e) => void run({ op: "done", id: t.id, done: e.target.checked }).catch(ignore)} />
      <div className="todo-body">
        <button className="todo-title" data-no-drag title="Edit" onClick={startEdit}>
          {t.title}
        </button>
        <div className="todo-meta">
          {t.due && !t.done && <span className={`todo-due${overdue ? " overdue" : ""}`}>{overdue ? `Overdue · ${dueLabel(t.due, now)}` : dueLabel(t.due, now)}</span>}
          {t.snoozed_until && !t.done && t.snoozed_until > now && <span className="todo-snoozed">Reminds {dueLabel(dueOfMs(t.snoozed_until), now)}</span>}
          {by && <span className="todo-by">{by}</span>}
          {t.chat &&
            (chat ? (
              <button className="todo-chat" data-no-drag onClick={() => onOpenChat(t.chat!)}>
                {chat.working ? "Working: " : ""}
                {chat.title}
              </button>
            ) : (
              t.chat_title && <span className="todo-chat gone">{t.chat_title}</span>
            ))}
          {t.note && (
            <button className="todo-note-toggle" data-no-drag aria-expanded={noteOpen} onClick={() => setNoteOpen(!noteOpen)}>
              Note
            </button>
          )}
        </div>
        {noteOpen && t.note && <div className="todo-note">{t.note}</div>}
      </div>
      {!t.done && (
        <span className="todo-actions" data-no-drag>
          {overdue && (
            <>
              <button className="ghost" title="Remind me in an hour" onClick={() => void run({ op: "snooze", id: t.id, until: Date.now() + 3_600_000 }).catch(ignore)}>
                1h
              </button>
              <button className="ghost" title="Remind me tomorrow at 9:00" onClick={() => void run({ op: "snooze", id: t.id, until: tomorrowMorning(Date.now()) }).catch(ignore)}>
                Tomorrow
              </button>
            </>
          )}
          {onStart && !chat?.working && (
            <button className="icon" aria-label={`Start a chat on “${t.title}”`} title="Start a chat on this" onClick={() => onStart(t)}>
              ▶
            </button>
          )}
        </span>
      )}
    </li>
  );
}

/** A moment as a due date, for "Reminds …". */
function dueOfMs(ms: number): Due {
  const d = new Date(ms);
  return { date: dayOf(d), time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` };
}

function TodosEmpty() {
  return (
    <TabEmpty title="To-dos">
      <p>Your own list for this project, kept on this Mac (not in the repository) and shared by its worktrees.</p>
      <p>Add one above, or type /todo and the text in the message box. Give it a due date and Lantern reminds you then, here and on your phone. Press ▶ to start a chat on one. Claude can read the list, add to it and tick things off when you ask.</p>
    </TabEmpty>
  );
}

/** Above the message box of a chat started from a to-do, once a turn has finished: is the item done? */
export function TodoDoneBar({ todo, onDone, onNotYet }: { todo: Todo; onDone: () => void; onNotYet: () => void }) {
  return (
    <div className="todo-done-bar" role="status">
      <span className="todo-done-bar-text">
        Working on your to-do <strong>{todo.title}</strong>. Is it done?
      </span>
      <button className="ghost" onClick={onNotYet}>
        Not yet
      </button>
      <button className="primary" onClick={onDone}>
        Mark done
      </button>
    </div>
  );
}
