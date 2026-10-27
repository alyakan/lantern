import { StyleSheet } from "react-native";
import { render, screen } from "@testing-library/react-native";
import type { Item } from "../sync/reducer";
import { lightColors } from "../ui/theme";
import { timeline, type Row } from "../view/timeline";
import { PageRow, SummaryRow } from "./ChatParts";

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
    const summary: Extract<Row, { kind: "summary" }> = { key: "a-a1", kind: "summary", item, chips: [], durationMs: null };
    await render(<SummaryRow row={summary} onFiles={() => {}} mark="login" />);
    expect(washed("login")).toHaveLength(1);
  });
});
