import { ActionSheetIOS } from "react-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import type { RemoteUserTodo } from "../protocol/generated/RemoteUserTodo";
import type { RemoteUserTodos } from "../protocol/generated/RemoteUserTodos";
import { attachSession } from "../test/fakeSession";
import { connected, connectedWith, makeController, renderWith } from "../test/render";
import { dayOf, dueText } from "../view/todos";
import { MacSheet } from "./OfflineScreen";
import { TodosSheet } from "./TodosSheet";

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));

const item = (id: string, over: Partial<RemoteUserTodo> = {}): RemoteUserTodo => ({ id, title: `Item ${id}`, note: null, done: false, due_date: null, due_time: null, overdue: false, by_claude: false, snoozed_until: null, ...over });
const list = (...items: RemoteUserTodo[]): RemoteUserTodos => ({ project: "/Users/me/app", name: "app", items });
const day = (plus: number) => {
  const d = new Date();
  return dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + plus));
};

async function open(todos: RemoteUserTodos, project: string | null = null, projects = [{ id: "/Users/me/app", name: "app" }]) {
  const { controller } = makeController();
  const session = attachSession(controller, { projects, todos, todo_edit: todos }, ["todos"]);
  const onClose = jest.fn();
  await renderWith(<TodosSheet project={project} onClose={onClose} />, { connection: connectedWith(["todos"]) }, controller);
  await settle();
  return { ...session, onClose };
}

describe("the to-do sheet", () => {
  it("lays the open items out in the Mac's sections, with who added what and when each is due", async () => {
    const { lastOf } = await open(list(item("free", { by_claude: true }), item("later", { due_date: day(3) }), item("late", { overdue: true, due_date: "2020-01-02" }), item("now", { due_date: day(0) }), item("ticked", { done: true })));
    expect(lastOf("todos")).toEqual({ op: "todos", project: "/Users/me/app" });
    expect(screen.getByRole("button", { name: "To-dos of app" })).toBeTruthy();
    expect(screen.getByText("4 open")).toBeTruthy();
    expect(screen.getAllByRole("header").map((h) => h.props.children)).toEqual(["Overdue", "Today", "Upcoming", "No date"]);
    expect(screen.getAllByRole("checkbox").map((b) => b.props.accessibilityLabel)).toEqual(["Item late", "Item now", "Item later", "Item free"]);
    expect(screen.getByText("Added by Claude")).toBeTruthy();
    // Under Today an item doesn't say "Today" again; one later says when.
    expect(screen.getAllByText("Today")).toHaveLength(1);
    expect(screen.getByText(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/)).toBeTruthy();
    // The done ones are folded away until asked for.
    expect(screen.queryByRole("checkbox", { name: "Item ticked" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Show done (1)" }));
    expect(screen.getByRole("checkbox", { name: "Item ticked" }).props.accessibilityState).toMatchObject({ checked: true });
  });

  it("ticks one off, and puts an overdue one off or deletes it from its swipe's buttons", async () => {
    const { lastOf } = await open(list(item("a", { overdue: true, due_date: "2020-01-02" })));
    const box = screen.getByRole("checkbox", { name: "Item a" });
    expect(box.props.accessibilityActions.map((a: { label: string }) => a.label)).toEqual(["In 1 hour", "Tomorrow", "Delete"]);
    await fireEvent(box, "accessibilityAction", { nativeEvent: { actionName: "hour" } });
    await settle();
    expect(lastOf("todo_edit")).toMatchObject({ op: "todo_edit", project: "/Users/me/app", edit: { op: "snooze", id: "a" } });
    await fireEvent(box, "accessibilityAction", { nativeEvent: { actionName: "delete" } });
    await settle();
    expect(lastOf("todo_edit")).toEqual({ op: "todo_edit", project: "/Users/me/app", edit: { op: "delete", id: "a" } });
    await fireEvent.press(box);
    await settle();
    expect(lastOf("todo_edit")).toEqual({ op: "todo_edit", project: "/Users/me/app", edit: { op: "done", id: "a", done: true } });
  });

  it("offers only Delete on one that isn't overdue", async () => {
    await open(list(item("a")));
    expect(screen.getByRole("checkbox", { name: "Item a" }).props.accessibilityActions.map((a: { label: string }) => a.label)).toEqual(["Delete"]);
  });

  it("adds one for tomorrow at a time, and leaves the field open for the next", async () => {
    const { lastOf } = await open(list());
    await fireEvent.press(screen.getByRole("button", { name: "New To-Do" }));
    await fireEvent.changeText(screen.getByLabelText("New to-do"), "Renew cert");
    expect(screen.queryByRole("button", { name: "13:00" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Tomorrow" }));
    await fireEvent.press(screen.getByRole("button", { name: "13:00" }));
    await fireEvent.press(screen.getByRole("button", { name: "Add" }));
    await settle();
    expect(lastOf("todo_edit")).toEqual({ op: "todo_edit", project: "/Users/me/app", edit: { op: "add", title: "Renew cert", due_date: day(1), due_time: "13:00" } });
    expect(screen.getByLabelText("New to-do").props.value).toBe("");
    // With no day, it has no time either.
    await fireEvent.changeText(screen.getByLabelText("New to-do"), "Whenever");
    await fireEvent(screen.getByLabelText("New to-do"), "submitEditing");
    await settle();
    expect(lastOf("todo_edit")).toEqual({ op: "todo_edit", project: "/Users/me/app", edit: { op: "add", title: "Whenever", due_date: null, due_time: null } });
  });

  it("picks a day from a month, but not one that has gone", async () => {
    const { lastOf } = await open(list());
    await fireEvent.press(screen.getByRole("button", { name: "New To-Do" }));
    await fireEvent.changeText(screen.getByLabelText("New to-do"), "Book the venue");
    await fireEvent.press(screen.getByRole("button", { name: "Pick a day" }));
    await fireEvent.press(screen.getByRole("button", { name: "Next month" }));
    // The 15th of next month: far enough off to be named by its date, not a weekday or Tomorrow.
    const d = new Date();
    const mid = dayOf(new Date(d.getFullYear(), d.getMonth() + 1, 15));
    await fireEvent.press(screen.getByRole("button", { name: dueText(mid, null, Date.now()) }));
    // Picked, the month folds away and its chip says the day.
    expect(screen.queryByRole("button", { name: "Next month" })).toBeNull();
    expect(screen.getByRole("button", { name: dueText(mid, null, Date.now()) }).props.accessibilityState).toMatchObject({ selected: true });
    await fireEvent.press(screen.getByRole("button", { name: "Add" }));
    await settle();
    expect(lastOf("todo_edit")).toEqual({ op: "todo_edit", project: "/Users/me/app", edit: { op: "add", title: "Book the venue", due_date: mid, due_time: null } });
    // Back on this month, yesterday can't be picked.
    if (d.getDate() > 1) {
      await fireEvent.press(screen.getByRole("button", { name: "Pick a day" }));
      const yesterday = screen.getByRole("button", { name: "Yesterday" });
      expect(yesterday.props.accessibilityState).toMatchObject({ disabled: true });
    }
  });

  it("switches to another project from its name", async () => {
    const pick = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation((_o, cb) => cb(1));
    const { asked } = await open(list(item("a")), null, [
      { id: "/Users/me/app", name: "app" },
      { id: "/Users/me/site", name: "site" },
    ]);
    await fireEvent.press(screen.getByRole("button", { name: "To-dos of app" }));
    await settle();
    expect(pick.mock.calls[0][0]).toMatchObject({ options: ["app", "site", "Cancel"], cancelButtonIndex: 2 });
    expect(asked.filter((r) => r.op === "todos").pop()).toEqual({ op: "todos", project: "/Users/me/site" });
    pick.mockRestore();
  });

  it("closes from its Done button", async () => {
    const { onClose } = await open(list());
    await fireEvent.press(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("opens on the project a reminder named, even one that isn't among the recent ones", async () => {
    const { asked } = await open({ project: "/Users/me/old", name: "old", items: [item("x")] }, "0123456789abcdef");
    // Asked by the push's token first, then by the folder the Mac named.
    expect(asked.filter((r) => r.op === "todos")).toEqual([{ op: "todos", project: "0123456789abcdef" }, { op: "todos", project: "/Users/me/old" }]);
    expect(screen.getByRole("button", { name: "To-dos of old" })).toBeTruthy();
  });

  it("waits for the connection before asking, as after a reminder's tap that started the app", async () => {
    const { controller } = makeController();
    const { asked } = attachSession(controller, { projects: [{ id: "/p", name: "p" }], todos: list(item("a")) }, ["todos"]);
    await renderWith(<TodosSheet project="0123456789abcdef" onClose={jest.fn()} />, { connection: { kind: "connecting" } as never }, controller);
    await settle();
    expect(asked.filter((r) => r.op === "todos")).toEqual([]);
    expect(screen.getByText("Connecting to your Mac…")).toBeTruthy();
    await act(async () => controller.setConnection(connectedWith(["todos"])));
    await settle();
    expect(asked.filter((r) => r.op === "todos")[0]).toEqual({ op: "todos", project: "0123456789abcdef" });
  });

  it("says what the Mac refused", async () => {
    const { controller } = makeController();
    attachSession(controller, { projects: [{ id: "/p", name: "p" }], todos: new Error("That isn't one of your projects on this Mac.") }, ["todos"]);
    await renderWith(<TodosSheet onClose={jest.fn()} />, { connection: connectedWith(["todos"]) }, controller);
    await settle();
    expect(screen.getByText("That isn't one of your projects on this Mac.")).toBeTruthy();
  });

  it("is offered in the Mac sheet only by a Mac that has to-dos", async () => {
    const onTodos = jest.fn();
    await renderWith(<MacSheet state={connectedWith(["todos"])} onClose={jest.fn()} onUnpair={jest.fn()} onTodos={onTodos} />, {});
    await fireEvent.press(screen.getByRole("button", { name: "Your to-dos" }));
    expect(onTodos).toHaveBeenCalledTimes(1);
  });

  it("isn't offered by an older Mac", async () => {
    await renderWith(<MacSheet state={connected} onClose={jest.fn()} onUnpair={jest.fn()} onTodos={jest.fn()} />, {});
    expect(screen.queryByRole("button", { name: "Your to-dos" })).toBeNull();
  });
});
