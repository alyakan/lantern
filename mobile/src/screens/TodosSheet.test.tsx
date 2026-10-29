import { act, fireEvent, screen } from "@testing-library/react-native";
import type { RemoteUserTodo } from "../protocol/generated/RemoteUserTodo";
import type { RemoteUserTodos } from "../protocol/generated/RemoteUserTodos";
import { attachSession } from "../test/fakeSession";
import { connected, connectedWith, makeController, renderWith } from "../test/render";
import { MacSheet } from "./OfflineScreen";
import { TodosSheet } from "./TodosSheet";

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));

const item = (id: string, over: Partial<RemoteUserTodo> = {}): RemoteUserTodo => ({ id, title: `Item ${id}`, note: null, done: false, due_date: null, due_time: null, overdue: false, by_claude: false, snoozed_until: null, ...over });
const list = (...items: RemoteUserTodo[]): RemoteUserTodos => ({ project: "/Users/me/app", name: "app", items });

async function open(todos: RemoteUserTodos, project: string | null = null, projects = [{ id: "/Users/me/app", name: "app" }]) {
  const { controller } = makeController();
  const session = attachSession(controller, { projects, todos, todo_edit: todos }, ["todos"]);
  const onClose = jest.fn();
  await renderWith(<TodosSheet project={project} onClose={onClose} />, { connection: connectedWith(["todos"]) }, controller);
  await settle();
  return session;
}

describe("the to-do sheet", () => {
  it("reads the first project's list, overdue first, with who added what", async () => {
    const { lastOf } = await open(list(item("a", { by_claude: true }), item("b", { overdue: true, due_date: "2020-01-02" })));
    expect(lastOf("todos")).toEqual({ op: "todos", project: "/Users/me/app" });
    expect(screen.getByText("To-dos: app")).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((b) => b.props.accessibilityLabel)).toEqual(["Item b", "Item a"]);
    expect(screen.getByText(/^Overdue · /)).toBeTruthy();
    expect(screen.getByText("Added by Claude")).toBeTruthy();
  });

  it("ticks one off, and puts an overdue one's reminder off", async () => {
    const { lastOf } = await open(list(item("a", { overdue: true, due_date: "2020-01-02" })));
    await fireEvent.press(screen.getByText("In 1 hour"));
    await settle();
    expect(lastOf("todo_edit")).toMatchObject({ op: "todo_edit", project: "/Users/me/app", edit: { op: "snooze", id: "a" } });
    await fireEvent.press(screen.getByRole("checkbox", { name: "Item a" }));
    await settle();
    expect(lastOf("todo_edit")).toEqual({ op: "todo_edit", project: "/Users/me/app", edit: { op: "done", id: "a", done: true } });
  });

  it("adds one with a due day and time, and refuses a day that isn't real", async () => {
    const { lastOf } = await open(list());
    await fireEvent.changeText(screen.getByLabelText("New to-do"), "Renew cert");
    await fireEvent.changeText(screen.getByLabelText("Due day"), "2026-02-30");
    expect(screen.getByRole("button", { name: "Add" }).props.accessibilityState?.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText("Due day"), "2026-11-03");
    await fireEvent.changeText(screen.getByLabelText("Due time"), "14:00");
    await fireEvent.press(screen.getByRole("button", { name: "Add" }));
    await settle();
    expect(lastOf("todo_edit")).toEqual({ op: "todo_edit", project: "/Users/me/app", edit: { op: "add", title: "Renew cert", due_date: "2026-11-03", due_time: "14:00" } });
  });

  it("opens on the project a reminder named, even one that isn't among the recent ones", async () => {
    const { asked } = await open({ project: "/Users/me/old", name: "old", items: [item("x")] }, "0123456789abcdef");
    // Asked by the push's token first, then by the folder the Mac named.
    expect(asked.filter((r) => r.op === "todos")).toEqual([{ op: "todos", project: "0123456789abcdef" }, { op: "todos", project: "/Users/me/old" }]);
    expect(screen.getByText("To-dos: old")).toBeTruthy();
    expect(screen.getByText("old")).toBeTruthy();
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
