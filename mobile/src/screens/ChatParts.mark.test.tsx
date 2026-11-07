import { StyleSheet } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { Item } from "../sync/reducer";
import { lightColors } from "../ui/theme";
import { timeline, type Row } from "../view/timeline";
import { PageRow, StepsRow, SummaryRow, withCaret } from "./ChatParts";
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

  it("a page opened whole is cut short again when the list draws its cell for another page", async () => {
    const other = timeline([said("a2", `# Plan step 2 — Billing\n\n${filler}\n\nThe last line says yak.`)]).find((r): r is Extract<Row, { kind: "page" }> => r.kind === "page")!;
    await render(<PageRow row={page} answered={false} onAction={() => {}} />);
    await fireEvent.press(screen.getByText("Show the whole page"));
    expect(screen.getByText(/zebra/)).toBeTruthy();
    await screen.rerender(<PageRow row={other} answered={false} onAction={() => {}} />);
    expect(screen.queryByText(/yak/)).toBeNull();
    expect(screen.getByText("Show the whole page")).toBeTruthy();
  });

  it("marks a summary's words", async () => {
    const item = { kind: "assistant", id: "a1", text: "Fixed the login bug in auth.ts.", streaming: false } as const;
    const summary: Extract<Row, { kind: "summary" }> = { key: "a-a1", kind: "summary", item, chips: [], durationMs: null, files: [] };
    await render(<SummaryRow row={summary} onFiles={() => {}} mark="login" />);
    expect(washed("login")).toHaveLength(1);
  });
});

describe("a summary card's height, as the list draws it", () => {
  const summaryOf = (id: string, text: string): Extract<Row, { kind: "summary" }> => ({ key: `a-${id}`, kind: "summary", item: { kind: "assistant", id, text, streaming: false }, chips: [], durationMs: null, files: [] });
  // The box its words are clipped by (the one that holds what onLayout measures).
  const clip = () => StyleSheet.flatten(screen.getByTestId("summary-words").parent!.props.style)?.maxHeight;
  const measure = async (h: number) => fireEvent(screen.getByTestId("summary-words"), "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: h } } });

  it("is held at the clipped height until its words are measured, not laid out whole and then cut (scrolling up jumped)", async () => {
    await render(<SummaryRow row={summaryOf("h1", "Fresh words, never measured.")} onFiles={() => {}} />);
    expect(clip()).toBe(230);
    expect(screen.queryByText("Show all")).toBeNull();
    await measure(120);
    expect(clip()).toBeUndefined();
  });

  it("a cell drawn again for a summary already measured starts at that summary's size", async () => {
    const long = summaryOf("h2", "A long one. ".repeat(40));
    const other = summaryOf("h3", "Another, short.");
    await render(<SummaryRow row={long} onFiles={() => {}} />);
    await measure(900);
    expect(screen.getByText("Show all")).toBeTruthy();
    await screen.rerender(<SummaryRow row={other} onFiles={() => {}} />);
    await measure(60);
    await screen.rerender(<SummaryRow row={long} onFiles={() => {}} />);
    // Before any layout of this drawing: already clipped, with its Show all.
    expect(clip()).toBe(230);
    expect(screen.getByText("Show all")).toBeTruthy();
  });
});

describe("what the agent said between its steps, on their row", () => {
  const notes = ["Now the tests.", "The cache is stale."];

  it("is one chip that opens to each message", async () => {
    await render(<StepsRow chips={[]} notes={notes} onFiles={() => {}} />);
    expect(screen.queryByText("Now the tests.")).toBeNull();
    await fireEvent.press(screen.getByText("2 messages"));
    expect(screen.getByText("Now the tests.")).toBeTruthy();
    expect(screen.getByText("The cache is stale.")).toBeTruthy();
  });

  it("is shown open, with what a chat search looks for marked", async () => {
    await render(<StepsRow chips={[]} notes={notes} onFiles={() => {}} mark="stale" />);
    expect(washed("stale")).toHaveLength(1);
  });

  it("starts closed again when the list draws its cell for another row (it was open for the one before)", async () => {
    await render(<StepsRow rowKey="s-1" chips={[]} notes={notes} onFiles={() => {}} />);
    await fireEvent.press(screen.getByText("2 messages"));
    expect(screen.getByText("Now the tests.")).toBeTruthy();
    await screen.rerender(<StepsRow rowKey="s-2" chips={[]} notes={notes} onFiles={() => {}} />);
    expect(screen.queryByText("Now the tests.")).toBeNull();
  });

  it("has no chip when nothing was said", async () => {
    await render(<StepsRow chips={[]} notes={[]} onFiles={() => {}} />);
    expect(screen.queryByText(/message/)).toBeNull();
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
