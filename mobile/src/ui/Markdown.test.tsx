import { StyleSheet } from "react-native";
import * as Clipboard from "expo-clipboard";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Markdown } from "./Markdown";

const table = ["| Step | Status | Time |", "|:--|:-:|--:|", "| Bump the version | **done** | 3 s |", "| Run `npm test` | passed | 41 s |", "| Open the PR | pending | |"].join("\n");

describe("a table in Claude's reply", () => {
  it("shows each cell as text, not as bars and dashes", async () => {
    await render(<Markdown text={table} />);
    for (const cell of ["Step", "Status", "Time", "Bump the version", "done", "3 s", "Run npm test", "passed", "41 s", "Open the PR", "pending"]) {
      expect(screen.getByText(cell)).toBeTruthy();
    }
    expect(screen.queryByText(/\|/)).toBeNull();
    expect(screen.queryByText(/---/)).toBeNull();
  });

  it("marks the header row as one, and aligns each column as the table says", async () => {
    await render(<Markdown text={table} />);
    const head = screen.getByText("Step").parent!.parent!;
    expect(head.props.accessibilityRole).toBe("header");
    const align = (text: string) => StyleSheet.flatten(screen.getByText(text).props.style).textAlign;
    expect(align("Step")).toBe("left");
    expect(align("Status")).toBe("center");
    expect(align("Time")).toBe("right");
    expect(StyleSheet.flatten(screen.getByText("Step").props.style).fontWeight).toBe("700");
  });

  it("keeps the marks inside a cell: bold stays bold, code stays code", async () => {
    await render(<Markdown text={table} />);
    const bold = screen.getByText("done");
    expect(StyleSheet.flatten(bold.props.style).fontWeight).toBe("700");
    const code = screen.getByText("npm test");
    expect(StyleSheet.flatten(code.props.style).fontFamily).toMatch(/Menlo|monospace/);
  });

  it("is a table of its own that scrolls sideways, with text around it", async () => {
    await render(<Markdown text={`Here is the plan:\n\n${table}\n\nThat is all.`} />);
    expect(screen.getByText("Here is the plan:")).toBeTruthy();
    expect(screen.getByText("That is all.")).toBeTruthy();
    expect(screen.getByText("Step")).toBeTruthy();
  });

  it("draws a table that has only come in part: a header, a short row", async () => {
    await render(<Markdown text={"| a | b |\n|---|---|\n| 1"} />);
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });
});

describe("the rest of the formatting", () => {
  it("indents nested lists, with a different mark at each depth", async () => {
    await render(<Markdown text={"- top\n  - middle\n    - bottom"} />);
    const indent = (text: string) => StyleSheet.flatten(screen.getByText(text).parent!.props.style).paddingLeft;
    expect(indent("top")).toBe(0);
    expect(indent("middle")).toBe(18);
    expect(indent("bottom")).toBe(36);
    expect(screen.getByText("•")).toBeTruthy();
    expect(screen.getByText("◦")).toBeTruthy();
    expect(screen.getByText("▪")).toBeTruthy();
  });

  it("numbers a loose list as it was numbered", async () => {
    await render(<Markdown text={"1. one\n\n2. two\n\n3. three"} />);
    expect(screen.getByText("1.")).toBeTruthy();
    expect(screen.getByText("2.")).toBeTruthy();
    expect(screen.getByText("3.")).toBeTruthy();
  });

  it("shows task boxes ticked or not, and strikes through a done one", async () => {
    await render(<Markdown text={"- [ ] write it\n- [x] test it"} />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((b) => b.props.accessibilityState.checked)).toEqual([false, true]);
    expect(StyleSheet.flatten(screen.getByText("test it").props.style).textDecorationLine).toBe("line-through");
    expect(StyleSheet.flatten(screen.getByText("write it").props.style).textDecorationLine).toBe("none");
  });

  it("strikes through, and nests bold with code", async () => {
    await render(<Markdown text={"~~old~~ and **bold `code`**"} />);
    expect(StyleSheet.flatten(screen.getByText("old").props.style).textDecorationLine).toBe("line-through");
    expect(StyleSheet.flatten(screen.getByText("code").props.style).fontFamily).toMatch(/Menlo|monospace/);
  });

  it("makes a bare link a link", async () => {
    await render(<Markdown text={"Read https://example.com/docs."} />);
    const link = screen.getByRole("link");
    expect(link.props.accessibilityRole).toBe("link");
    expect(screen.getByText("https://example.com/docs")).toBeTruthy();
  });

  it("draws a rule between sections, and sizes headings by their level", async () => {
    await render(<Markdown text={"# Big\n\n---\n\n### Small"} />);
    const big = StyleSheet.flatten(screen.getByText("Big").props.style);
    const small = StyleSheet.flatten(screen.getByText("Small").props.style);
    expect(big.fontSize).toBeGreaterThan(small.fontSize as number);
    expect(screen.getAllByRole("header")).toHaveLength(2);
  });

  it("shows a code block with its language, and copies the code when asked", async () => {
    await render(<Markdown text={"```bash\nnpm test\nnpm run build\n```"} />);
    expect(screen.getByText("bash")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Copy code" }));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("npm test\nnpm run build");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });
});

describe("a list in a message that wraps its own width (your bubble)", () => {
  it("lets a list item's words size their row, not start from nothing: a zero basis collapses a shrink-wrapped bubble to the bullet", async () => {
    await render(<Markdown text={"- first thing to do\n- second thing to do"} />);
    const style = StyleSheet.flatten(screen.getByText("first thing to do").props.style);
    // `flex: 1` is a basis of 0: inside a box that is only as wide as what it holds, that is no width at all.
    expect(style.flex).toBeUndefined();
    expect(style.flexBasis).toBeUndefined();
    expect(style.flexGrow).toBe(1);
    expect(style.flexShrink).toBe(1);
  });
});
