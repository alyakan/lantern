import "@shopify/flash-list/jestSetup";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import { chat, makeController, renderWith } from "../test/render";
import { ChangesPane } from "./ChangesPane";

const events = [
  { kind: "user_text" as const, text: "Fix it.", at: 1_000_000, sent_by: "desktop" },
  { kind: "tool_started" as const, tool_use_id: "t1", name: "Edit", summary: "a.ts" },
  { kind: "file_edited" as const, tool_use_id: "t1", path: "/p/src/a.ts", created: false, added: 3, removed: 1 },
  { kind: "tool_started" as const, tool_use_id: "t2", name: "Write", summary: "b.ts" },
  { kind: "file_edited" as const, tool_use_id: "t2", path: "/p/src/b.ts", created: true, added: 9, removed: 0 },
];

async function pane(answers: Parameters<typeof attachSession>[1] = {}, evs = events) {
  const { controller } = makeController();
  const session = attachSession(controller, answers);
  const onHide = jest.fn();
  await renderWith(<ChangesPane slot="a" onHide={onHide} />, { chats: [chat()], events: { a: evs } }, controller);
  return { ...session, onHide };
}

describe("the Changes pane", () => {
  it("lists the changed files, newest first, with their counts, and shows the newest one's diff", async () => {
    const { lastOf } = await pane({ diff: "@@ -1 +1 @@\n-old\n+new" });
    expect(screen.getByText("2 files · +12 −1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "b.ts, new, 9 added, 0 removed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "a.ts, 3 added, 1 removed" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("+new")).toBeTruthy());
    expect(lastOf("diff")).toEqual({ op: "diff", slot: "a", path: "/p/src/b.ts" });
  });

  it("shows another file's diff when it is chosen", async () => {
    const { lastOf } = await pane({ diff: "+x" });
    await fireEvent.press(screen.getByRole("button", { name: "a.ts, 3 added, 1 removed" }));
    await waitFor(() => expect(lastOf("diff")).toEqual({ op: "diff", slot: "a", path: "/p/src/a.ts" }));
  });

  it("says why when the Mac can't give a diff", async () => {
    await pane({ diff: new Error("That file is not in this chat's changes.") });
    expect(await screen.findByText("That file is not in this chat's changes.")).toBeTruthy();
  });

  it("says nothing changed yet, and hides when asked", async () => {
    const { onHide } = await pane({}, events.slice(0, 1));
    expect(screen.getByText("Nothing changed in this chat yet.")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Hide" }));
    expect(onHide).toHaveBeenCalled();
  });
});
