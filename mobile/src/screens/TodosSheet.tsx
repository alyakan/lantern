import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteProject } from "../protocol/generated/RemoteProject";
import type { RemoteTodoEdit } from "../protocol/generated/RemoteTodoEdit";
import type { RemoteUserTodo } from "../protocol/generated/RemoteUserTodo";
import type { RemoteUserTodos } from "../protocol/generated/RemoteUserTodos";
import { useConnectionState, useController } from "../shell/hooks";
import { Button, Chip, Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { radius, space, useColors } from "../ui/theme";
import { dueText, isProjectToken, shownTodos, tomorrowMorning, validDay } from "../view/todos";

/**
 * The user's own to-do list for a project, kept on the Mac (shared by the project's worktrees): tick things off, add one with an
 * optional due date, and put off a reminder for an overdue one. A reminder's push opens it on its project. Rewording and
 * reordering are on the Mac.
 */
export function TodosSheet({ project: initial, onClose }: { project?: string | null; onClose: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { sync } = useController();
  // A reminder's tap can open the sheet before the app has reached the Mac: it asks once the connection is up.
  const up = useConnectionState().kind === "connected";
  const [projects, setProjects] = useState<RemoteProject[] | null>(null);
  const [project, setProject] = useState<string | null>(initial ?? null);
  const [list, setList] = useState<RemoteUserTodos | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (!up) return;
    sync.projects().then(
      (all) => {
        if (!live.current) return;
        const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
        setProjects(sorted);
        setProject((now) => now ?? sorted[0]?.id ?? null);
      },
      () => live.current && setProjects([]),
    );
  }, [sync, up]);

  const load = useCallback(async () => {
    if (!project || !up) return;
    try {
      const next = await sync.todos(project);
      if (live.current) {
        setList(next);
        setProblem(null);
        // A reminder named the project by its token: from here on it is the folder the Mac said.
        if (isProjectToken(project)) setProject(next.project);
      }
    } catch (e) {
      if (live.current) setProblem((e as Error).message || "Couldn't reach your Mac.");
    }
  }, [sync, project, up]);
  useEffect(() => {
    setList(null);
    void load();
  }, [load]);

  const edit = async (e: RemoteTodoEdit) => {
    if (!project) return false;
    setBusy(true);
    setProblem(null);
    try {
      const next = await sync.todoEdit(project, e);
      if (live.current) setList(next);
      return true;
    } catch (err) {
      if (live.current) setProblem((err as Error).message || "Your Mac didn't take that.");
      return false;
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const dayOk = !day.trim() || validDay(day);
  const timeOk = !time.trim() || /^\d{1,2}:\d{2}$/.test(time.trim());
  const canAdd = !!project && !!title.trim() && dayOk && timeOk && !busy;
  const add = async () => {
    if (!canAdd) return;
    const ok = await edit({ op: "add", title: title.trim(), due_date: day.trim() || null, due_time: (day.trim() && time.trim()) || null });
    if (ok && live.current) {
      setTitle("");
      setDay("");
      setTime("");
    }
  };

  const now = Date.now();
  const items = list ? shownTodos(list.items) : [];
  const open = items.filter((t) => !t.done);
  const done = items.filter((t) => t.done);
  // The project a reminder named may not be among the recent ones: it is still shown, by the name the Mac gave its list.
  const pills = projects && list && !projects.some((p) => p.id === project) ? [...projects, { id: list.project, name: list.name }] : (projects ?? []);
  const field = { backgroundColor: colors.wash, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: colors.ink, fontSize: 15 } as const;

  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={{ padding: space.xl, paddingBottom: insets.bottom + space.xl, gap: 10, flexShrink: 1 }}>
          <Txt variant="heading" accessibilityRole="header">
            To-dos{list ? `: ${list.name}` : ""}
          </Txt>
          {pills.length > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {pills.map((p) => (
                <Chip key={p.id} tone={p.id === project ? "ok" : "plain"} onPress={() => setProject(p.id)}>
                  {p.name}
                </Chip>
              ))}
            </ScrollView>
          )}
          {projects !== null && pills.length === 0 && (
            <Txt variant="body" tone="ink2">
              No projects yet. Open a folder in Lantern on your Mac first.
            </Txt>
          )}
          {project && (
            <View style={{ gap: 8 }}>
              <TextInput accessibilityLabel="New to-do" value={title} onChangeText={setTitle} placeholder="Add a to-do" placeholderTextColor={colors.ink3} maxLength={200} returnKeyType="done" onSubmitEditing={() => void add()} style={field} />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <TextInput accessibilityLabel="Due day" value={day} onChangeText={setDay} placeholder="Due YYYY-MM-DD" placeholderTextColor={colors.ink3} keyboardType="numbers-and-punctuation" maxLength={10} style={[field, { flex: 2 }, !dayOk && { color: colors.stop }]} />
                <TextInput accessibilityLabel="Due time" value={time} onChangeText={setTime} placeholder="HH:MM" placeholderTextColor={colors.ink3} keyboardType="numbers-and-punctuation" maxLength={5} editable={!!day.trim()} style={[field, { flex: 1 }, !timeOk && { color: colors.stop }]} />
                <Button label="Add" disabled={!canAdd} onPress={() => void add()} />
              </View>
            </View>
          )}
          {problem && (
            <Txt variant="small" tone="stop" accessibilityRole="alert">
              {problem}
            </Txt>
          )}
          {project && !list && !problem && (
            <Txt variant="body" tone="ink2">
              {up ? "Asking your Mac…" : "Connecting to your Mac…"}
            </Txt>
          )}
          {list && (
            <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ gap: 2 }} testID="todo-items">
              {open.length === 0 && (
                <Txt variant="body" tone="ink2">
                  {list.items.length === 0 ? "Nothing on this list yet." : "Nothing left to do here."}
                </Txt>
              )}
              {open.map((t) => (
                <TodoRow key={t.id} todo={t} now={now} busy={busy} edit={edit} />
              ))}
              {done.length > 0 && (
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: showDone }} onPress={() => setShowDone(!showDone)} style={{ paddingVertical: 10 }}>
                  <Txt variant="small" tone="ink2" style={{ fontWeight: "700" }}>
                    {showDone ? "▾" : "▸"} Done ({done.length})
                  </Txt>
                </Pressable>
              )}
              {showDone && done.map((t) => <TodoRow key={t.id} todo={t} now={now} busy={busy} edit={edit} />)}
            </ScrollView>
          )}
          <Button label="Close" kind="ghost" onPress={close} />
        </View>
      )}
    </Sheet>
  );
}

function TodoRow({ todo: t, now, busy, edit }: { todo: RemoteUserTodo; now: number; busy: boolean; edit: (e: RemoteTodoEdit) => Promise<boolean> }) {
  const colors = useColors();
  const due = t.due_date && !t.done ? dueText(t.due_date, t.due_time, now) : null;
  const by = t.by_claude ? (t.done ? "Done by Claude" : "Added by Claude") : null;
  return (
    <View testID={`todo-${t.id}`} style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 9 }}>
      <PressScale
        accessibilityRole="checkbox"
        accessibilityLabel={t.title}
        accessibilityState={{ checked: t.done, disabled: busy }}
        accessibilityHint={t.done ? "Opens it again" : "Ticks it off"}
        disabled={busy}
        onPress={() => void edit({ op: "done", id: t.id, done: !t.done })}
        haptic="select"
        scaleTo={0.9}
        style={{ width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: t.done ? colors.go : t.overdue ? colors.stop : colors.ink3, backgroundColor: t.done ? colors.go : "transparent", alignItems: "center", justifyContent: "center", marginTop: 1 }}
      >
        {t.done ? (
          <Txt variant="small" tone="white" style={{ fontWeight: "800" }}>
            ✓
          </Txt>
        ) : null}
      </PressScale>
      <View style={{ flex: 1, gap: 3 }}>
        <Txt variant="body" tone={t.done ? "ink3" : "ink"} style={t.done ? { textDecorationLine: "line-through" } : undefined}>
          {t.title}
        </Txt>
        {(due || by) && (
          <Txt variant="tiny" tone={t.overdue ? "stop" : "ink3"} style={t.overdue ? { fontWeight: "700" } : undefined}>
            {[t.overdue && due ? `Overdue · ${due}` : due, by].filter(Boolean).join(" · ")}
          </Txt>
        )}
        {t.overdue && !t.done && (
          <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
            <Chip onPress={() => void edit({ op: "snooze", id: t.id, until: Date.now() + 3_600_000 })}>In 1 hour</Chip>
            <Chip onPress={() => void edit({ op: "snooze", id: t.id, until: tomorrowMorning(Date.now()) })}>Tomorrow</Chip>
          </View>
        )}
      </View>
      {t.done && (
        <PressScale accessibilityRole="button" accessibilityLabel={`Delete “${t.title}”`} disabled={busy} onPress={() => void edit({ op: "delete", id: t.id })} haptic="select" style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.pill }}>
          <Txt variant="small" tone="ink3">
            ✕
          </Txt>
        </PressScale>
      )}
    </View>
  );
}
