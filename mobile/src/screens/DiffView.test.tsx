import { fireEvent, screen, within } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { renderWith } from "../test/render";
import { DiffView, MAX_ROWS } from "./DiffView";

const colourOf = (el: { props: { style?: unknown } }) => (StyleSheet.flatten(el.props.style as never) as { color?: string }).color;
const rowOf = (label: string) => screen.getByLabelText(label);

describe("the file's change", () => {
  it("numbers each line, and tells added from removed by the label and the wash, not a sign", async () => {
    await renderWith(<DiffView path="/p/src/a.ts" text={"--- a\n+++ a\n@@ -3,3 +3,3 @@\n one\n-two\n+TWO\n three\n"} />);
    expect(screen.queryByText("+TWO")).toBeNull();
    expect(screen.queryByText("-two")).toBeNull();
    const removed = rowOf("Removed, line 4: two");
    const added = rowOf("Added, line 4: TWO");
    // Old number then new number, the way a unified diff reads. The numbers are hidden from a screen reader (the row's label says them).
    const numbers = (row: ReturnType<typeof rowOf>) => within(row).getAllByText(/^\d*$/, { includeHiddenElements: true }).map((n) => String(n.props.children));
    expect(numbers(removed)).toEqual(["4", ""]);
    expect(numbers(added)).toEqual(["", "4"]);
    expect(numbers(rowOf("Unchanged, line 5: three"))).toEqual(["5", "5"]);
    expect(StyleSheet.flatten(removed.props.style).backgroundColor).toBe("#d93b3b26");
    expect(StyleSheet.flatten(added.props.style).backgroundColor).toBe("#1f9d5526");
    expect(StyleSheet.flatten(rowOf("Unchanged, line 3: one").props.style).backgroundColor).toBe("transparent");
  });

  it("colours the code as its language", async () => {
    await renderWith(<DiffView path="/p/src/a.ts" text={'--- a\n+++ a\n@@ -1 +1 @@\n+const n = 42; // hi\n'} />);
    const row = rowOf("Added, line 1: const n = 42; // hi");
    expect(colourOf(within(row).getByText("const"))).toBe("#2f5bff");
    expect(colourOf(within(row).getByText("42"))).toBe("#a15c00");
    expect(colourOf(within(row).getByText("// hi"))).toBe("#8a94a1");
  });

  it("leaves a file of an unknown kind in one colour", async () => {
    await renderWith(<DiffView path="/p/Makefile" text={"--- a\n+++ a\n@@ -1 +1 @@\n+all: build\n"} />);
    expect(within(rowOf("Added, line 1: all: build")).getByText("all: build")).toBeTruthy();
  });

  it("draws a markdown file's lines as markdown: heading, bold, list bullet, code, quote", async () => {
    const md = "--- a.md\n+++ a.md\n@@ -0,0 +1,6 @@\n+## Setup\n+Run **this** now\n+- first\n+```sh\n+# not a heading\n+```\n";
    await renderWith(<DiffView path="/p/docs/a.md" text={md} />);
    const heading = within(rowOf("Added, line 1: ## Setup")).getByText("Setup");
    expect(StyleSheet.flatten(heading.props.style).fontWeight).toBe("700");
    expect(screen.queryByText("## Setup")).toBeNull();
    expect(StyleSheet.flatten(within(rowOf("Added, line 2: Run **this** now")).getByText("this").props.style).fontWeight).toBe("700");
    expect(screen.queryByText(/\*\*/)).toBeNull();
    expect(within(rowOf("Added, line 3: - first")).getByText("•")).toBeTruthy();
    // A "#" inside a fence is code, not a heading.
    expect(within(rowOf("Added, line 5: # not a heading")).getByText("# not a heading")).toBeTruthy();
  });

  it("shows where lines are skipped, and a diff the Mac cut short", async () => {
    await renderWith(<DiffView path="/p/a.ts" text={"--- a\n+++ a\n@@ -1 +1 @@\n+a\n@@ -40 +40 @@\n+b\n… (cut short: the rest is on your Mac)"} />);
    expect(screen.getByLabelText("Lines skipped, next from line 40")).toBeTruthy();
    expect(screen.getByText("… (cut short: the rest is on your Mac)")).toBeTruthy();
  });

  it("reads a diff with no numbers in it, without a gutter", async () => {
    await renderWith(<DiffView path="/p/a.ts" text={"--- a\n+++ b\n-old\n+new"} />);
    expect(within(rowOf("Removed: old")).queryAllByText(/^\d+$/)).toEqual([]);
    expect(rowOf("Added: new")).toBeTruthy();
  });

  it("draws a long change in part, and the rest when asked", async () => {
    const n = MAX_ROWS + 5;
    const body = Array.from({ length: n }, (_, i) => `+line ${i + 1}`).join("\n");
    await renderWith(<DiffView path="/p/lock.json" text={`--- a\n+++ a\n@@ -0,0 +1,${n} @@\n${body}\n`} />);
    expect(screen.getByLabelText(`Added, line ${MAX_ROWS}: line ${MAX_ROWS}`)).toBeTruthy();
    expect(screen.queryByLabelText(`Added, line ${MAX_ROWS + 1}: line ${MAX_ROWS + 1}`)).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Show the other 5 lines" }));
    expect(screen.getByLabelText(`Added, line ${n}: line ${n}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show the other/ })).toBeNull();
  });

  it("shows words that are not a diff as they are", async () => {
    await renderWith(<DiffView path="/p/a.ts" text="That file isn't in this review." />);
    expect(screen.getByText("That file isn't in this review.")).toBeTruthy();
  });

  it("says so when there is nothing to show", async () => {
    await renderWith(<DiffView path="/p/a.ts" text="" />);
    expect(screen.getByText("Nothing to show.")).toBeTruthy();
  });
});
