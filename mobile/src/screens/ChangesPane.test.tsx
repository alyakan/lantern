import "@shopify/flash-list/jestSetup";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import type { Request } from "../protocol/generated/Request";
import { chat, connectedWith, makeController, renderWith } from "../test/render";
import { ChangesPane } from "./ChangesPane";

const events = [
  { kind: "user_text" as const, text: "Fix it.", at: 1_000_000, sent_by: "desktop" },
  { kind: "tool_started" as const, tool_use_id: "t1", name: "Edit", summary: "a.ts" },
  { kind: "file_edited" as const, tool_use_id: "t1", path: "/p/src/a.ts", created: false, added: 3, removed: 1 },
  { kind: "tool_started" as const, tool_use_id: "t2", name: "Write", summary: "b.ts" },
  { kind: "file_edited" as const, tool_use_id: "t2", path: "/p/src/b.ts", created: true, added: 9, removed: 0 },
];

async function pane(answers: Parameters<typeof attachSession>[1] = {}, evs = events, features: string[] = [], focus?: { path: string; n: number }) {
  const { controller } = makeController();
  const session = attachSession(controller, answers, features);
  const onHide = jest.fn();
  await renderWith(<ChangesPane slot="a" onHide={onHide} focus={focus} />, { chats: [chat()], events: { a: evs }, connection: connectedWith(features) }, controller);
  return { ...session, onHide };
}

/** A Mac's lists by view: the chat's has a script's edit beside Claude's; the branch has a committed file. */
const lists = (r: Request) => {
  const scope = r.op === "changes" ? r.scope : "chat";
  const file = (path: string, added: number, removed: number) => ({ path, created: false, deleted: false, added, removed });
  if (scope === "branch") return { files: [file("/p/src/old.ts", 4, 2)], base: "main" };
  if (scope === "uncommitted") return { files: [], base: null };
  return { files: [file("/p/src/a.ts", 3, 1), file("/p/src/b.ts", 9, 0), file("/p/gen.sh", 1, 0)], base: null };
};

describe("the Changes pane", () => {
  it("lists the changed files, newest first, with their counts, and shows the newest one's diff", async () => {
    const { lastOf } = await pane({ diff: "@@ -1 +1 @@\n-old\n+new" });
    expect(screen.getByText("2 files · +12 −1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "b.ts, new, 9 added, 0 removed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "a.ts, 3 added, 1 removed" })).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText("Added, line 1: new")).toBeTruthy());
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

  it("has no views to switch between on a Mac that can't list them", async () => {
    await pane({ diff: "+x" });
    expect(screen.queryByRole("tab", { name: "Uncommitted" })).toBeNull();
  });

  describe("on a Mac that lists its views", () => {
    it("lists what the Mac says the chat changed, a script's edit too", async () => {
      await pane({ changes: lists, diff: "+x" }, events, ["changescopes"]);
      expect(await screen.findByRole("button", { name: "gen.sh, 1 added, 0 removed" })).toBeTruthy();
      expect(screen.getByRole("tab", { name: "This chat", selected: true })).toBeTruthy();
    });

    it("keeps the newest edit first and shown once the Mac's list (by path) comes", async () => {
      const { lastOf } = await pane({ changes: lists, diff: "+x" }, events, ["changescopes"]);
      await screen.findByRole("button", { name: "gen.sh, 1 added, 0 removed" });
      expect(screen.getAllByRole("button", { name: /added/ }).map((b) => b.props.accessibilityLabel.split(",")[0])).toEqual(["b.ts", "a.ts", "gen.sh"]);
      expect(screen.getByRole("button", { name: "b.ts, 9 added, 0 removed" }).props.accessibilityState).toMatchObject({ selected: true });
      expect(lastOf("diff")).toEqual({ op: "diff", slot: "a", path: "/p/src/b.ts" });
    });

    it("switches to the branch's changes, says what they're against, and reads a file's diff in that view", async () => {
      const { lastOf } = await pane({ changes: lists, diff: "+x" }, events, ["changescopes"]);
      await fireEvent.press(screen.getByRole("tab", { name: "This branch" }));
      expect(await screen.findByRole("button", { name: "old.ts, 4 added, 2 removed" })).toBeTruthy();
      expect(screen.getByText("1 file · +4 −2 · against main")).toBeTruthy();
      expect(lastOf("changes")).toEqual({ op: "changes", slot: "a", scope: "branch" });
      await waitFor(() => expect(lastOf("diff")).toEqual({ op: "diff", slot: "a", path: "/p/src/old.ts", scope: "branch" }));
    });

    it("says when nothing is uncommitted, and what the Mac said when it can't list a view", async () => {
      await pane({ changes: (r: Request) => (r.op === "changes" && r.scope === "branch" ? new Error("feat/x has no commits of its own since main.") : lists(r)) }, events, ["changescopes"]);
      await fireEvent.press(screen.getByRole("tab", { name: "Uncommitted" }));
      expect(await screen.findByText("Nothing uncommitted.")).toBeTruthy();
      await fireEvent.press(screen.getByRole("tab", { name: "This branch" }));
      expect(await screen.findByText("feat/x has no commits of its own since main.")).toBeTruthy();
    });
  });

  it("shows a file a link named that the chat didn't change, at the top of the list, and its diff", async () => {
    const { lastOf } = await pane({ diff: " same" }, events, [], { path: "src/other.ts", n: 1 });
    expect(screen.getByRole("button", { name: "other.ts, from a link", selected: true })).toBeTruthy();
    await waitFor(() => expect(lastOf("diff")).toEqual({ op: "diff", slot: "a", path: "src/other.ts" }));
    expect(screen.getByText("2 files · +12 −1")).toBeTruthy();
  });
});
