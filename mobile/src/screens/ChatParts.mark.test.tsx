import { StyleSheet } from "react-native";
import { render, screen } from "@testing-library/react-native";
import type { Item } from "../sync/reducer";
import { lightColors } from "../ui/theme";
import { timeline, type Row } from "../view/timeline";
import { PageRow, SummaryRow, withCaret } from "./ChatParts";
import { fileNamed } from "../ui/Markdown";

const said = (id: string, text: string): Item => ({ kind: "assistant", id, text, streaming: false });
const washed = (text: string) => screen.queryAllByText(text).filter((n) => StyleSheet.flatten(n.props.style)?.backgroundColor === lightColors.hiSoft);

describe("what a chat search looks for, in a page and a summary", () => {
  const filler = "Start with the form and the login page. ".repeat(12);
  const page = timeline([said("a1", `# Plan step 1 — Signup\n\n${filler}\n\nThe last line says zebra.`)]).find((r): r is Extract<Row, { kind: "page" }> => r.kind === "page")!;

  it("marks the title of a page and its words", async () => {
    await render(<PageRow row={page} answered={false} onAction={() => {}} mark="signup" />);
    expect(washed("Signup")).toHaveLength(1);
  });

  it("is cut short as it always was, and shown whole while a search marks it, so a match in the part cut can be seen", async () => {
    expect(page.page.body.length).toBeGreaterThan(260);
    await render(<PageRow row={page} answered={false} onAction={() => {}} />);
    expect(screen.queryByText(/zebra/)).toBeNull();
    expect(screen.getByText("Show the whole page")).toBeTruthy();
    await screen.unmount();
    await render(<PageRow row={page} answered={false} onAction={() => {}} mark="zebra" />);
    expect(washed("zebra")).toHaveLength(1);
    expect(screen.getByText("Show less")).toBeTruthy();
  });

  it("marks a summary's words", async () => {
    const item = { kind: "assistant", id: "a1", text: "Fixed the login bug in auth.ts.", streaming: false } as const;
    const summary: Extract<Row, { kind: "summary" }> = { key: "a-a1", kind: "summary", item, chips: [], durationMs: null, files: [] };
    await render(<SummaryRow row={summary} onFiles={() => {}} mark="login" />);
    expect(washed("login")).toHaveLength(1);
  });
});

describe("words still coming in", () => {
  it("end with a caret, except inside a code block that is still open", () => {
    expect(withCaret("Bumping the version")).toBe("Bumping the version ▍");
    expect(withCaret("Here:\n```ts\nconst a")).toBe("Here:\n```ts\nconst a");
    expect(withCaret("Here:\n```ts\nconst a\n```\nDone")).toMatch(/Done ▍$/);
  });
});

describe("a path in Claude's words", () => {
  const files = ["/Users/me/lantern/mobile/src/view/home.ts", "/Users/me/lantern/README.md"];
  it("names an edited file by its whole path, its end, or with a line number", () => {
    expect(fileNamed("home.ts", files)).toBe(files[0]);
    expect(fileNamed("src/view/home.ts", files)).toBe(files[0]);
    expect(fileNamed("mobile/src/view/home.ts:42", files)).toBe(files[0]);
    expect(fileNamed(files[1], files)).toBe(files[1]);
  });
  it("is not a file that wasn't edited, a part of a name, or a few words", () => {
    expect(fileNamed("other.ts", files)).toBeNull();
    expect(fileNamed("ome.ts", files)).toBeNull();
    expect(fileNamed("npm test", files)).toBeNull();
  });
});
