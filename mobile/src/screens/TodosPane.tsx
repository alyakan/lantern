import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActionSheetIOS, Alert, Animated, Keyboard, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteProject } from "../protocol/generated/RemoteProject";
import type { RemoteTodoEdit } from "../protocol/generated/RemoteTodoEdit";
import type { RemoteUserTodo } from "../protocol/generated/RemoteUserTodo";
import type { RemoteUserTodos } from "../protocol/generated/RemoteUserTodos";
import { useConnectionState, useController } from "../shell/hooks";
import { useAccent } from "../ui/accent";
import { Button, Txt } from "../ui/components";
import { PressScale, run } from "../ui/motion";
import { SwipeRow, type TrayButton } from "../ui/SwipeRow";
import { radius, space, useColors } from "../ui/theme";
import { dayOf, dueText, isProjectToken, monthWeeks, quickDays, todoSections, tomorrowMorning } from "../view/todos";
import { FloatIcon } from "./ChangesPane";

/** How long a ticked item takes to fade out of its section, as on the Mac. */
const TICK_MS = 420;
/** The times a new to-do's day can be given with one tap. */
const TIMES = ["09:00", "13:00", "17:00", "20:00"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface TodosPaneProps {
  /** The project to show (its folder, or the token a reminder named it by); none starts on `projectName`'s, else the first. */
  project?: string | null;
  /** Opened from a chat: its project's folder name, picked once the projects are known. */
  projectName?: string | null;
  onHide: () => void;
  /** What the button that puts it away says. */
  hideLabel?: string;
  /** In a sheet over the chat (which starts below the clock already), not the tablet's pane. */
  inSheet?: boolean;
  /** Over the project's name: a menu of what the chat's sheet can show. Without it, the project's name is the heading. */
  title?: ReactNode;
  /** A tablet's pane can float over the chat as a card, and go back. */
  float?: { floating: boolean; onToggle: () => void };
}

/**
 * The user's own to-do list for a project, kept on the Mac (shared by the project's worktrees), laid out as the Mac's Todos tab:
 * Overdue, Today, Upcoming and No date, a round check that ticks an item off and fades it out, and a New To-Do row at the bottom
 * with Today, Tomorrow and Next week, a month to pick a day from, and a time. A row swiped left puts an overdue one off (an hour,
 * tomorrow) or deletes it. The project's name switches to another. Rewording and reordering are on the Mac.
 */
export function TodosPane({ project: initial, projectName, onHide, hideLabel = "Hide", inSheet = false, title, float }: TodosPaneProps) {
  const colors = useColors();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const { sync } = useController();
  // A reminder's tap can open it before the app has reached the Mac: it asks once the connection is up.
  const up = useConnectionState().kind === "connected";
  const [projects, setProjects] = useState<RemoteProject[] | null>(null);
  const [project, setProject] = useState<string | null>(initial ?? null);
  const [list, setList] = useState<RemoteUserTodos | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDone, setShowDone] = useState(false);
  // The row whose buttons are laid out (one at a time).
  const [tray, setTray] = useState<string | null>(null);
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
        setProject((now) => now ?? sorted.find((p) => !!projectName && p.name === projectName)?.id ?? sorted[0]?.id ?? null);
      },
      () => live.current && setProjects([]),
    );
  }, [sync, up, projectName]);

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
    setTray(null);
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

  // The project a reminder named may not be among the recent ones: it is still offered, by the name the Mac gave its list.
  const choices = projects && list && !projects.some((p) => p.id === project) ? [...projects, { id: list.project, name: list.name }] : (projects ?? []);
  const pickProject = () => {
    if (choices.length < 2) return;
    const names = choices.map((p) => p.name);
    const chose = (i: number) => i >= 0 && i < choices.length && setProject(choices[i].id);
    if (Platform.OS === "ios") ActionSheetIOS.showActionSheetWithOptions({ title: "To-dos of", options: [...names, "Cancel"], cancelButtonIndex: names.length }, chose);
    else Alert.alert("To-dos of", undefined, [...choices.slice(0, 2).map((p, i) => ({ text: p.name, onPress: () => chose(i) })), { text: "Cancel", style: "cancel" as const }]);
  };

  const now = Date.now();
  const items = list?.items ?? [];
  const sections = todoSections(items, now);
  const done = items.filter((t) => t.done);
  const openCount = items.length - done.length;
  const name = list?.name ?? choices.find((p) => p.id === project)?.name ?? "To-dos";
  const switcher = (
    <Pressable accessibilityRole="button" accessibilityLabel={`To-dos of ${name}`} accessibilityHint={choices.length > 1 ? "Shows another project's to-dos" : undefined} disabled={choices.length < 2} onPress={pickProject} hitSlop={6} style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" }}>
      <Txt variant={title ? "small" : "title"} numberOfLines={1} style={[{ flexShrink: 1 }, title ? { color: colors.ink2, fontWeight: "600" } : null]}>
        {name}
      </Txt>
      {choices.length > 1 && (
        <Txt variant={title ? "small" : "body"} style={{ color: accent, fontWeight: "700" }}>
          ▾
        </Txt>
      )}
    </Pressable>
  );

  return (
    // Its place on the screen is found, not assumed: a page sheet starts below the top, by more than the keyboard would leave.
    <KeyboardAvoidingView behavior="padding" automaticOffset testID="todos-pane" style={{ flex: 1, backgroundColor: colors.card, paddingTop: inSheet || float?.floating ? 16 : insets.top + 6 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", paddingHorizontal: space.lg, paddingBottom: 4, gap: 8 }}>
        <View style={{ flex: 1, gap: 2 }}>
          {title}
          {switcher}
          {list && (
            <Txt variant="small" tone="ink3">
              {openCount === 0 ? "All done" : `${openCount} open`}
            </Txt>
          )}
        </View>
        {float && (
          <PressScale accessibilityRole="button" accessibilityLabel={float.floating ? "Put the to-dos beside the chat" : "Float the to-dos over the chat"} onPress={float.onToggle} haptic="select" hitSlop={8} scaleTo={0.88} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
            <FloatIcon floating={float.floating} color={colors.ink} />
          </PressScale>
        )}
        <Button label={hideLabel} kind="ghost" onPress={onHide} />
      </View>
      {problem && (
        <Txt variant="small" tone="stop" accessibilityRole="alert" style={{ paddingHorizontal: space.lg, paddingTop: 6 }}>
          {problem}
        </Txt>
      )}
      {projects !== null && choices.length === 0 ? (
        <Empty text="No projects yet. Open a folder in Lantern on your Mac first." />
      ) : !list ? (
        !problem && <Empty text={up ? "Asking your Mac…" : "Connecting to your Mac…"} />
      ) : (
        <ScrollView testID="todo-items" style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: space.xl }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
          {openCount === 0 && <Empty text={items.length === 0 ? "Nothing on this list yet." : "Nothing left to do here."} />}
          {sections.map((s) => (
            <View key={s.key} style={{ marginTop: 16 }}>
              <Txt variant="tiny" accessibilityRole="header" style={{ paddingHorizontal: space.lg, paddingBottom: 4, fontWeight: "800", letterSpacing: 0.8, textTransform: "uppercase", color: s.key === "overdue" ? colors.stop : s.key === "today" ? accent : colors.ink3 }}>
                {s.title}
              </Txt>
              {s.items.map((t) => (
                <TodoRow key={t.id} todo={t} now={now} today={s.key === "today"} busy={busy} edit={edit} open={tray === t.id} onOpenChange={(o) => setTray(o ? t.id : null)} />
              ))}
            </View>
          ))}
          {done.length > 0 && (
            <View style={{ marginTop: 16 }}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: showDone }} onPress={() => setShowDone(!showDone)} style={{ paddingHorizontal: space.lg, paddingVertical: 8 }}>
                <Txt variant="small" tone="ink3" style={{ fontWeight: "700" }}>
                  {showDone ? `Hide done (${done.length})` : `Show done (${done.length})`}
                </Txt>
              </Pressable>
              {showDone && done.map((t) => <TodoRow key={t.id} todo={t} now={now} busy={busy} edit={edit} open={tray === t.id} onOpenChange={(o) => setTray(o ? t.id : null)} />)}
            </View>
          )}
        </ScrollView>
      )}
      {list && <NewTodo busy={busy} now={now} bottom={inSheet ? insets.bottom : 0} onAdd={(t, date, time) => edit({ op: "add", title: t, due_date: date, due_time: date ? time : null })} />}
    </KeyboardAvoidingView>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <Txt variant="body" tone="ink3" style={{ paddingHorizontal: space.xl, paddingTop: 28, textAlign: "center" }}>
      {text}
    </Txt>
  );
}

/** One to-do: a round check, its title (and who added it), and its day at the right; swiped left, what can be done to it. */
function TodoRow({ todo: t, now, today = false, busy, edit, open, onOpenChange }: { todo: RemoteUserTodo; now: number; /** In the Today section, which says the day: only its time is shown. */ today?: boolean; busy: boolean; edit: (e: RemoteTodoEdit) => Promise<boolean>; open: boolean; onOpenChange: (open: boolean) => void }) {
  const colors = useColors();
  const accent = useAccent();
  // Ticked: the check fills at once and the row fades out, then the Mac is told (and the row is back if it refused).
  const [ticking, setTicking] = useState(false);
  const fade = useRef(new Animated.Value(1)).current;
  const checked = t.done || ticking;
  const tick = () => {
    if (t.done) return void edit({ op: "done", id: t.id, done: false });
    setTicking(true);
    run(fade, 0, TICK_MS, () => {
      void edit({ op: "done", id: t.id, done: true }).then((ok) => {
        if (ok) return;
        setTicking(false);
        fade.setValue(1);
      });
    });
  };
  const due = !t.due_date || t.done ? null : today ? t.due_time : dueText(t.due_date, t.due_time, now);
  const buttons: TrayButton[] = [
    ...(t.overdue && !t.done
      ? [
          { key: "hour", label: "In 1 hour", onPress: () => void edit({ op: "snooze", id: t.id, until: Date.now() + 3_600_000 }) },
          { key: "tomorrow", label: "Tomorrow", onPress: () => void edit({ op: "snooze", id: t.id, until: tomorrowMorning(Date.now()) }) },
        ]
      : []),
    { key: "delete", label: "Delete", tone: "danger" as const, onPress: () => void edit({ op: "delete", id: t.id }) },
  ];
  return (
    <Animated.View testID={`todo-${t.id}`} style={{ opacity: fade }}>
      <SwipeRow background={colors.card} tray={buttons} open={open} onOpenChange={onOpenChange}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: space.lg, paddingVertical: 11, backgroundColor: colors.card }}>
          <PressScale
            accessibilityRole="checkbox"
            accessibilityLabel={t.title}
            accessibilityState={{ checked, disabled: busy }}
            accessibilityHint={t.done ? "Opens it again" : "Ticks it off"}
            accessibilityActions={buttons.map((b) => ({ name: b.key, label: b.label }))}
            onAccessibilityAction={(e) => buttons.find((b) => b.key === e.nativeEvent.actionName)?.onPress()}
            disabled={busy || ticking}
            onPress={tick}
            haptic="select"
            scaleTo={0.85}
            hitSlop={8}
            style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: checked ? accent : t.overdue ? colors.stop : colors.ink3, backgroundColor: checked ? accent : "transparent", alignItems: "center", justifyContent: "center" }}
          >
            {checked && (
              <Txt variant="tiny" tone="white" style={{ fontWeight: "900" }}>
                ✓
              </Txt>
            )}
          </PressScale>
          <View style={{ flex: 1, gap: 2 }}>
            <Txt variant="body" tone={t.done ? "ink3" : "ink"} style={t.done ? { textDecorationLine: "line-through" } : undefined}>
              {t.title}
            </Txt>
            {t.by_claude && (
              <Txt variant="tiny" tone="ink3">
                {t.done ? "Done by Claude" : "Added by Claude"}
              </Txt>
            )}
          </View>
          {due && (
            <Txt variant="small" style={{ color: t.overdue ? colors.stop : colors.ink3, fontWeight: t.overdue ? "700" : "400" }}>
              {due}
            </Txt>
          )}
        </View>
      </SwipeRow>
    </Animated.View>
  );
}

/**
 * The New To-Do row: a tap opens a field, and under it Today, Tomorrow, Next week and a month to pick a day from; with a day, the
 * times. Return adds it and leaves the field open for the next.
 */
function NewTodo({ busy, now, bottom, onAdd }: { busy: boolean; now: number; /** Room kept under it for the home indicator. */ bottom: number; onAdd: (title: string, date: string | null, time: string | null) => Promise<boolean> }) {
  const colors = useColors();
  const accent = useAccent();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [month, setMonth] = useState<{ y: number; m: number } | null>(null);
  const quick = quickDays(now);
  const add = async () => {
    if (!title.trim() || busy) return;
    if (await onAdd(title.trim(), date, time)) {
      setTitle("");
      setDate(null);
      setTime(null);
      setMonth(null);
    }
  };
  const pickDay = (d: string | null) => {
    setDate(d);
    if (!d) setTime(null);
  };
  const frame = { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.rule, paddingHorizontal: space.lg, paddingBottom: 14 + bottom } as const;
  if (!adding)
    return (
      <View style={[frame, { paddingTop: 14 }]}>
        <PressScale accessibilityRole="button" accessibilityLabel="New To-Do" onPress={() => setAdding(true)} haptic="light" scaleTo={0.97} style={{ flexDirection: "row", alignItems: "center", gap: 10, alignSelf: "flex-start" }}>
          <Txt variant="heading" style={{ color: accent }}>
            ＋
          </Txt>
          <Txt variant="body" style={{ color: accent, fontWeight: "700" }}>
            New To-Do
          </Txt>
        </PressScale>
      </View>
    );
  const today = new Date(now);
  const shown = month ?? { y: today.getFullYear(), m: today.getMonth() };
  const step = (by: number) => {
    const d = new Date(shown.y, shown.m + by, 1);
    setMonth({ y: d.getFullYear(), m: d.getMonth() });
  };
  const todayKey = dayOf(today);
  const picked = date && !quick.some((q) => q.date === date) ? dueText(date, null, now) : null;
  return (
    <View style={[frame, { paddingTop: 12, gap: 10 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: colors.ink3 }} />
        <TextInput accessibilityLabel="New to-do" autoFocus value={title} onChangeText={setTitle} placeholder="New To-Do" placeholderTextColor={colors.ink3} maxLength={200} returnKeyType="done" submitBehavior="submit" onSubmitEditing={() => void add()} style={{ flex: 1, fontSize: 17, color: colors.ink, paddingVertical: 4 }} />
        <Pressable accessibilityRole="button" accessibilityLabel="Add" disabled={!title.trim() || busy} onPress={() => void add()} hitSlop={8}>
          <Txt variant="body" style={{ color: title.trim() && !busy ? accent : colors.ink3, fontWeight: "700" }}>
            Add
          </Txt>
        </Pressable>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {quick.map((q) => (
          <Pill key={q.label} label={q.label} on={date === q.date} onPress={() => pickDay(date === q.date ? null : q.date)} />
        ))}
        {/* The month takes the keyboard's place, as iOS's own pickers do. */}
        <Pill
          label={picked ?? "Pick a day"}
          on={!!picked || !!month}
          onPress={() => {
            if (!month) Keyboard.dismiss();
            setMonth(month ? null : shown);
          }}
        />
      </View>
      {month && (
        <View style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Pressable accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => step(-1)} hitSlop={10} style={{ padding: 6 }}>
              <Txt variant="body" style={{ color: accent, fontWeight: "700" }}>
                ‹
              </Txt>
            </Pressable>
            <Txt variant="small" accessibilityRole="header" style={{ fontWeight: "700" }}>
              {MONTHS[shown.m]} {shown.y}
            </Txt>
            <Pressable accessibilityRole="button" accessibilityLabel="Next month" onPress={() => step(1)} hitSlop={10} style={{ padding: 6 }}>
              <Txt variant="body" style={{ color: accent, fontWeight: "700" }}>
                ›
              </Txt>
            </Pressable>
          </View>
          {monthWeeks(shown.y, shown.m).map((week, w) => (
            <View key={w} style={{ flexDirection: "row" }}>
              {week.map((d, i) => {
                // (A blank before the 1st is not the day picked when none is.)
                const on = !!d && d === date;
                const past = !!d && d < todayKey;
                return (
                  <Pressable key={i} accessibilityRole="button" accessibilityLabel={d ? dueText(d, null, now) : undefined} accessibilityState={{ selected: on, disabled: !d || past }} disabled={!d || past} onPress={() => d && (pickDay(d), setMonth(null))} style={{ flex: 1, alignItems: "center", paddingVertical: 1 }}>
                    <View style={{ width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: on ? accent : "transparent" }}>
                      {d && (
                        <Txt variant="small" style={{ color: on ? colors.white : past ? colors.shape : d === todayKey ? accent : colors.ink, fontWeight: d === todayKey || on ? "800" : "400" }}>
                          {Number(d.slice(8))}
                        </Txt>
                      )}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      )}
      {date && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Pill label="Any time" on={!time} onPress={() => setTime(null)} />
          {TIMES.map((t) => (
            <Pill key={t} label={t} on={time === t} onPress={() => setTime(time === t ? null : t)} />
          ))}
        </View>
      )}
    </View>
  );
}

function Pill({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const colors = useColors();
  const accent = useAccent();
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: on }} onPress={onPress} haptic="select" scaleTo={0.94} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: on ? accent : colors.wash }}>
      <Txt variant="small" style={{ color: on ? colors.white : colors.ink, fontWeight: "600" }}>
        {label}
      </Txt>
    </PressScale>
  );
}
