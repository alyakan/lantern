import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { dayOf, dueLabel, dueMs, isOverdue, tomorrowMorning, TITLE_MAX, useTodos, validDue, type Due, type Todo, type TodoEdit } from "../lib/todos";
import { useReorder } from "../lib/useReorder";
import { useDismiss } from "../lib/useDismiss";
import { basename } from "../lib/diff";

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

type SectionId = "overdue" | "today" | "upcoming" | "anytime";
const SECTIONS: { id: SectionId; title: string; draggable: boolean }[] = [
  { id: "overdue", title: "Overdue", draggable: false },
  { id: "today", title: "Today", draggable: true },
  { id: "upcoming", title: "Upcoming", draggable: false },
  { id: "anytime", title: "No date", draggable: true },
];

/** Which section an open item sits in. Overdue and Upcoming are in date order; Today and No date in the user's own order. */
function sectionOf(t: Todo, now: number): SectionId {
  if (!t.due) return "anytime";
  if (isOverdue(t, now)) return "overdue";
  return t.due.date === dayOf(new Date(now)) ? "today" : "upcoming";
}

/**
 * The project's own to-do list (shared by its worktrees), laid out like a reminders list: Overdue, Today, Upcoming and No date,
 * each item a round checkbox and a line, with ▶ and a menu on hover. A new one is typed into the last row. Claude can add and
 * tick items too (they say so); only the user rewords, reopens or deletes.
 */
export function TodosTab({ folder, chats, onStart, onOpenChat }: Props) {
  const { listing, edit } = useTodos(folder);
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  // Items just ticked stay a moment, checked, before they leave the list.
  const [leaving, setLeaving] = useState<string[]>([]);
  const now = useNow();
  const run = (e: TodoEdit) => {
    setError(null);
    return edit(e).catch((err) => {
      setError(String(err));
      throw err;
    });
  };
  const tick = (t: Todo) => {
    if (t.done) return void run({ op: "done", id: t.id, done: false }).catch(() => {});
    setLeaving((l) => [...l, t.id]);
    window.setTimeout(
      () => {
        void run({ op: "done", id: t.id, done: true })
          .catch(() => {})
          .finally(() => setLeaving((l) => l.filter((x) => x !== t.id)));
      },
      reducedMotion() ? 0 : 420,
    );
  };
  const items = listing?.items ?? [];
  const open = items.filter((t) => !t.done);
  const done = items.filter((t) => t.done);
  const bySection = (id: SectionId) => {
    const list = open.filter((t) => sectionOf(t, now) === id);
    return id === "overdue" || id === "upcoming" ? [...list].sort((a, b) => dueMs(a.due!) - dueMs(b.due!)) : list;
  };
  const sections = SECTIONS.map((s) => ({ ...s, items: bySection(s.id) }));
  // A drag moves an item within its section; the list keeps every other item where it was.
  const moveWithin = (ids: string[]) => (id: string, index: number) => {
    const moved = ids.filter((x) => x !== id);
    moved.splice(index, 0, id);
    const slots = open.map((t) => t.id);
    const at = slots.map((x, i) => (ids.includes(x) ? i : -1)).filter((i) => i >= 0);
    at.forEach((slot, k) => (slots[slot] = moved[k]));
    void run({ op: "reorder", ids: slots }).catch(() => {});
  };
  const todayRef = useRef<HTMLUListElement>(null);
  const anyRef = useRef<HTMLUListElement>(null);
  const todayIds = sections[1].items.map((t) => t.id);
  const anyIds = sections[3].items.map((t) => t.id);
  const todayDrag = useReorder(todayIds, todayRef, moveWithin(todayIds));
  const anyDrag = useReorder(anyIds, anyRef, moveWithin(anyIds));
  const drags: Partial<Record<SectionId, { ref: typeof todayRef; drag: typeof todayDrag }>> = { today: { ref: todayRef, drag: todayDrag }, anytime: { ref: anyRef, drag: anyDrag } };

  if (!listing) return <div className="tests-note dash-loading">Loading…</div>;
  return (
    <div className="todos">
      <header className="todos-head">
        <h2 className="todos-project">{basename(listing.key) || "To-dos"}</h2>
        <span className="todos-tally">{open.length === 0 ? "All done" : `${open.length} open`}</span>
      </header>
      {error && (
        <div className="todos-error" role="alert">
          {error}
        </div>
      )}
      <div className="todos-scroll">
        {sections.map((s) => {
          if (s.items.length === 0) return null;
          const d = drags[s.id];
          return (
            <section key={s.id} className={`todos-section ${s.id}`} aria-label={s.title}>
              <h3 className="todos-section-title">
                {s.title}
                <span className="todos-section-count">{s.items.length}</span>
              </h3>
              <ul className="todos-list" aria-label={s.title} ref={d?.ref} onClickCapture={d?.drag.onClickCapture}>
                {s.items.map((t) => (
                  <TodoRow key={t.id} todo={t} now={now} chats={chats} run={run} onTick={tick} ticking={leaving.includes(t.id)} onStart={onStart} onOpenChat={onOpenChat} handle={d ? d.drag.handle(t.id) : undefined} style={d?.drag.styleFor(t.id)} lifted={d?.drag.lifted === t.id} />
                ))}
              </ul>
            </section>
          );
        })}
        <NewTodo onAdd={(title, due) => run({ op: "add", title, due })} empty={open.length === 0} />
        {done.length > 0 && (
          <section className="todos-section done" aria-label="Done">
            <div className="todos-done-head">
              <button className="todos-link" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
                {showDone ? `Hide done (${done.length})` : `Show done (${done.length})`}
              </button>
              {showDone && (
                <button className="todos-link" onClick={() => void run({ op: "clear_done" }).catch(() => {})}>
                  Clear done
                </button>
              )}
            </div>
            {showDone && (
              <ul className="todos-list" aria-label="Done">
                {done.map((t) => (
                  <TodoRow key={t.id} todo={t} now={now} chats={chats} run={run} onTick={tick} onOpenChat={onOpenChat} />
                ))}
              </ul>
            )}
          </section>
        )}
        {items.length === 0 && <p className="todos-hint">Type one above, or send /todo and the text from the message box. A due date reminds you here and on your phone. Claude can read this list, add to it and tick things off when you ask.</p>}
      </div>
    </div>
  );
}

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** The time, ticking each half minute: what is overdue changes on its own. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** The last row: "New to-do", typed into in place. Enter adds it and leaves the row ready for the next one. */
function NewTodo({ onAdd, empty }: { onAdd: (title: string, due: Due | null) => Promise<unknown>; empty: boolean }) {
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
    <div className={`todo-new${empty ? " first" : ""}`}>
      <div className="todo-row">
        <span className="todo-check placeholder" aria-hidden />
        <input className="todo-new-input" aria-label="New to-do" placeholder="New to-do" maxLength={TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className={`todo-chip${date ? " set" : ""}`} aria-label="Due date" aria-expanded={dueOpen} title="Give it a due date: Lantern reminds you then, on this Mac and your phone" onClick={() => setDueOpen(!dueOpen)}>
          {date ? dueLabel({ date, time: time || null }, Date.now()) : "Add date"}
        </button>
        {title.trim() && (
          <button className="todo-add" disabled={!ready} onClick={add}>
            Add
          </button>
        )}
      </div>
      {dueOpen && <DueFields date={date} time={time} onDate={setDate} onTime={setTime} onEnter={add} />}
    </div>
  );
}

function DueFields({ date, time, onDate, onTime, onEnter }: { date: string; time: string; onDate: (d: string) => void; onTime: (t: string) => void; onEnter?: () => void }) {
  const key = (e: KeyboardEvent) => e.key === "Enter" && onEnter?.();
  const today = new Date();
  const quick = [
    { label: "Today", date: dayOf(today) },
    { label: "Tomorrow", date: dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)) },
    { label: "Next week", date: dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7)) },
  ];
  return (
    <div className="todo-due-fields">
      {quick.map((q) => (
        <button key={q.label} className={`todo-chip${date === q.date ? " set" : ""}`} onClick={() => onDate(q.date)}>
          {q.label}
        </button>
      ))}
      <input type="date" aria-label="Due day" value={date} onChange={(e) => onDate(e.target.value)} onKeyDown={key} />
      <input type="time" aria-label="Due time" value={time} disabled={!date} onChange={(e) => onTime(e.target.value)} onKeyDown={key} />
      {date && (
        <button
          className="todos-link"
          onClick={() => {
            onDate("");
            onTime("");
          }}
        >
          No date
        </button>
      )}
    </div>
  );
}

interface RowProps {
  todo: Todo;
  now: number;
  chats: Record<string, TodoChat>;
  run: (e: TodoEdit) => Promise<unknown>;
  onTick: (t: Todo) => void;
  ticking?: boolean;
  onStart?: (todo: Todo) => void;
  onOpenChat: (slot: string) => void;
  handle?: ReturnType<ReturnType<typeof useReorder>["handle"]>;
  style?: CSSProperties;
  lifted?: boolean;
}

function TodoRow({ todo: t, now, chats, run, onTick, ticking, onStart, onOpenChat, handle, style, lifted }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const overdue = isOverdue(t, now);
  const chat = t.chat ? chats[t.chat] : undefined;
  const ignore = () => {};
  const checked = t.done || !!ticking;
  if (editing) return <EditRow todo={t} run={run} onClose={() => setEditing(false)} />;
  const by = t.done ? (t.done_by === "claude" ? "Done by Claude" : null) : t.created_by === "claude" ? "Added by Claude" : null;
  const snoozed = !t.done && t.snoozed_until && t.snoozed_until > now ? `Reminds ${dueLabel(dueOfMs(t.snoozed_until), now)}` : null;
  const meta = [by, snoozed].filter(Boolean);
  return (
    <li className={`todo${t.done ? " done" : ""}${ticking ? " ticking" : ""}${overdue ? " overdue" : ""}${lifted ? " lifted" : ""}${menu ? " menu-open" : ""}`} data-reorder-id={t.id} style={style} {...handle}>
      <div className="todo-row">
        <button role="checkbox" aria-checked={checked} data-no-drag className="todo-check" aria-label={t.done ? `Open “${t.title}” again` : `Tick off “${t.title}”`} onClick={() => onTick(t)}>
          <svg viewBox="0 0 16 16" aria-hidden>
            <path d="M4 8.4l2.6 2.6L12 5.4" />
          </svg>
        </button>
        <button className="todo-title" data-no-drag title="Edit" onClick={() => setEditing(true)}>
          {t.title}
          {t.note && <span className="todo-has-note" aria-label="Has a note" />}
        </button>
        {chat && (
          <button className="todo-chat" data-no-drag title="Open the chat" onClick={() => onOpenChat(t.chat!)}>
            {chat.working ? "Working: " : ""}
            {chat.title}
          </button>
        )}
        {t.due && !t.done && <span className={`todo-due${overdue ? " overdue" : ""}`}>{dueLabel(t.due, now)}</span>}
        {!t.done && (
          <span className="todo-actions" data-no-drag>
            {onStart && !chat?.working && (
              <button className="todo-act" aria-label={`Start a chat on “${t.title}”`} title="Start a chat on this" onClick={() => onStart(t)}>
                <svg viewBox="0 0 16 16" aria-hidden>
                  <path d="M5 3.5v9l7-4.5z" />
                </svg>
              </button>
            )}
            <RowMenu open={menu} setOpen={setMenu} label={t.title}>
              {overdue && (
                <>
                  <button role="menuitem" className="menu-row" onClick={() => void run({ op: "snooze", id: t.id, until: Date.now() + 3_600_000 }).catch(ignore)}>
                    Remind me in an hour
                  </button>
                  <button role="menuitem" className="menu-row" onClick={() => void run({ op: "snooze", id: t.id, until: tomorrowMorning(Date.now()) }).catch(ignore)}>
                    Remind me tomorrow
                  </button>
                </>
              )}
              <button role="menuitem" className="menu-row" onClick={() => setEditing(true)}>
                Edit…
              </button>
              <button role="menuitem" className="menu-row danger" onClick={() => void run({ op: "delete", id: t.id }).catch(ignore)}>
                Delete
              </button>
            </RowMenu>
          </span>
        )}
      </div>
      {(meta.length > 0 || (t.done && !chat && t.chat_title)) && (
        <div className="todo-meta">
          {meta.map((m) => (
            <span key={m}>{m}</span>
          ))}
          {!chat && t.chat_title && <span className="todo-chat-gone">{t.chat_title}</span>}
        </div>
      )}
      {t.note && (
        <button className="todo-note-toggle" data-no-drag aria-expanded={noteOpen} onClick={() => setNoteOpen(!noteOpen)}>
          {noteOpen ? t.note : firstLine(t.note)}
        </button>
      )}
    </li>
  );
}

function firstLine(text: string): string {
  const line = text.split("\n")[0];
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

/** ⋯ on a row: snooze (when overdue), edit, delete. */
function RowMenu({ open, setOpen, label, children }: { open: boolean; setOpen: (o: boolean) => void; label: string; children: React.ReactNode }) {
  const root = useRef<HTMLSpanElement>(null);
  useDismiss(open, root, () => setOpen(false));
  return (
    <span className="todo-menu-wrap" ref={root}>
      <button className="todo-act" aria-label={`More for “${label}”`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" aria-hidden>
          <circle cx="3.5" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="12.5" cy="8" r="1.3" />
        </svg>
      </button>
      {open && (
        <div className="menu todo-menu" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </span>
  );
}

/** A row opened for editing: title, note and date, in place. */
function EditRow({ todo: t, run, onClose }: { todo: Todo; run: (e: TodoEdit) => Promise<unknown>; onClose: () => void }) {
  const [title, setTitle] = useState(t.title);
  const [note, setNote] = useState(t.note ?? "");
  const [date, setDate] = useState(t.due?.date ?? "");
  const [time, setTime] = useState(t.due?.time ?? "");
  const save = () => {
    const due: Due | null = date ? { date, time: time || null } : null;
    if (!title.trim() || (due && !validDue(due))) return;
    run({ op: "update", id: t.id, patch: { title, note: note.trim() ? note : null, due } }).then(onClose, () => {});
  };
  return (
    <li className="todo editing">
      <input className="todo-edit-title" aria-label="Title" autoFocus maxLength={TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? save() : e.key === "Escape" && onClose())} />
      <textarea className="todo-edit-note" aria-label="Note" placeholder="Notes" rows={3} value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onClose()} />
      <DueFields date={date} time={time} onDate={setDate} onTime={setTime} />
      <div className="todo-edit-actions">
        <button className="todos-link danger" onClick={() => void run({ op: "delete", id: t.id }).catch(() => {})}>
          Delete
        </button>
        <span className="spacer" />
        <button className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" onClick={save}>
          Save
        </button>
      </div>
    </li>
  );
}

/** A moment as a due date, for "Reminds …". */
function dueOfMs(ms: number): Due {
  const d = new Date(ms);
  return { date: dayOf(d), time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` };
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
