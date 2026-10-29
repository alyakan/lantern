import { StyleSheet } from "react-native";
import * as Clipboard from "expo-clipboard";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Markdown, pathNamed } from "./Markdown";
import { lightColors } from "./theme";

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

describe("a code block", () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

  it("colours what it knows how to on the page, and never changes the text", async () => {
    await render(<Markdown text={"```ts\nconst a = 1; // one\n```"} />);
    const keyword = screen.getByText("const");
    expect(StyleSheet.flatten(keyword.props.style).color).toBeTruthy();
    expect(screen.getByText("// one")).toBeTruthy();
  });

  it("keeps your own message's code one colour", async () => {
    await render(<Markdown tone="on-ink" text={"```ts\nconst a = 1;\n```"} />);
    expect(screen.queryByText("const")).toBeNull();
    expect(screen.getByText("const a = 1;")).toBeTruthy();
  });

  it("folds a long one until it is opened, and Copy still copies all of it", async () => {
    await render(<Markdown text={"```\n" + long(30) + "\n```"} />);
    expect(screen.queryByText(/line 30/)).toBeNull();
    expect(screen.getByRole("button", { name: "Show 18 more lines of code" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Copy code" }));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(long(30));
    await fireEvent.press(screen.getByRole("button", { name: "Show 18 more lines of code" }));
    expect(screen.getByText(/line 30/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show less code" })).toBeTruthy();
  });

  it("does not fold a short one", async () => {
    await render(<Markdown text={"```\n" + long(10) + "\n```"} />);
    expect(screen.queryByRole("button", { name: /more lines/ })).toBeNull();
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

describe("the room between a list's mark and its words", () => {
  const markWidth = (mark: string) => StyleSheet.flatten(screen.getAllByText(mark)[0].props.style).minWidth;

  it("is small for a bullet, which is only a dot, so the words aren't left a gap after it", async () => {
    await render(<Markdown text={"- first\n- second"} />);
    expect(markWidth("•")).toBeLessThanOrEqual(12);
    const row = screen.getByText("first").parent!;
    expect(StyleSheet.flatten(row.props.style).gap).toBeLessThanOrEqual(6);
  });

  it("keeps room for a number's two digits", async () => {
    await render(<Markdown text={"1. first\n2. second"} />);
    expect(markWidth("1.")).toBeGreaterThanOrEqual(22);
  });
});

describe("what a chat search looks for, marked in the words", () => {
  const flat = (text: string) => StyleSheet.flatten(screen.getByText(text).props.style);
  const marked = (text: string) => {
    const st = flat(text);
    return st.backgroundColor === lightColors.hiSoft && st.color === lightColors.ink;
  };
  const long = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

  it("marks the word in a paragraph in any case, in the highlighter wash with ink words, and leaves the rest", async () => {
    await render(<Markdown text="Fix the Login bug, then login again" mark="LOGIN" />);
    expect(screen.getAllByText(/login/i).filter((n) => n.props.style && StyleSheet.flatten(n.props.style).backgroundColor === lightColors.hiSoft)).toHaveLength(2);
    expect(marked("Login")).toBe(true);
    expect(screen.getByText("Fix the Login bug, then login again")).toBeTruthy();
  });

  it("marks it in a heading, a list item, a quote, bold, italic, a link and inline code, each keeping its own look", async () => {
    await render(<Markdown text={"# The login page\n\n- fix **login** now\n- *login* is slow\n\n> login quote\n\nsee [login docs](https://example.com) and `npm login`"} mark="login" />);
    // Heading, bold, italic, quote, link and code: six places (a bold or italic span is itself a Text of that word, so only the washed ones count).
    const washed = screen.getAllByText("login").filter((n) => StyleSheet.flatten(n.props.style)?.backgroundColor === lightColors.hiSoft);
    expect(washed).toHaveLength(6);
    // Around a mark the span is what it was: the code is still code, the link still a link.
    expect(StyleSheet.flatten(screen.getByText("npm login").props.style).fontFamily).toMatch(/Menlo|monospace/);
    expect(screen.getByRole("link").props.accessibilityRole).toBe("link");
  });

  it("marks inside inline code without losing the code look around it", async () => {
    await render(<Markdown text="run `npm test` now" mark="npm" />);
    expect(marked("npm")).toBe(true);
    expect(StyleSheet.flatten(screen.getByText("npm test").props.style).fontFamily).toMatch(/Menlo|monospace/);
  });

  it("marks a match that runs across the colours of a code block, and the code's words stay what they were", async () => {
    await render(<Markdown text={"```ts\nconst user = 1;\n```"} mark="t user" />);
    expect(marked("t")).toBe(true);
    expect(marked("user")).toBe(true);
    expect(screen.getByText("cons")).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByText("cons").props.style).backgroundColor).not.toBe(lightColors.hiSoft);
  });

  it("opens a folded code block when the match is in the part folded", async () => {
    await render(<Markdown text={"```\n" + long(30) + "\n```"} mark="line 30" />);
    expect(screen.getByText(/line 30/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show less code" })).toBeTruthy();
  });

  it("marks it in a table cell", async () => {
    await render(<Markdown text={table} mark="version" />);
    expect(marked("version")).toBe(true);
    expect(screen.getByText("Bump the version")).toBeTruthy();
  });

  it("marks nothing for no query or one under two characters, and a text not searched is drawn as it was", async () => {
    for (const mark of [undefined, "", " ", "l"]) {
      await render(<Markdown text="Fix the Login bug" mark={mark} />);
      expect(screen.queryByText("Login")).toBeNull();
      expect(screen.getByText("Fix the Login bug")).toBeTruthy();
      await screen.unmount();
    }
  });

  it("opens the change of a file a link points at", async () => {
    const onFile = jest.fn();
    const text = "See [`Flow.swift:35`](/Users/me/App/Flow.swift#L35).";
    // The turn changed it, so the code naming it would be a link of its own: inside the link, it is just its words.
    await render(<Markdown text={text} files={["/Users/me/App/Flow.swift"]} onFile={onFile} />);
    await fireEvent.press(screen.getByRole("link"));
    expect(onFile).toHaveBeenCalledWith("/Users/me/App/Flow.swift");
  });

  it("opens a path in code even when the turn did not edit that file", async () => {
    const onFile = jest.fn();
    // A script's edit, or a step shown again later, is not in the turn's list: the Mac is asked, and says if it has no such file.
    await render(<Markdown text="`App/Sensors/Pairing.swift:82`: `removeDevice` is gone." files={[]} onFile={onFile} />);
    await fireEvent.press(screen.getByRole("link"));
    expect(onFile).toHaveBeenCalledWith("App/Sensors/Pairing.swift");
    expect(screen.queryAllByRole("link")).toHaveLength(1);
  });

  it("knows a path to a file from other code", () => {
    expect(pathNamed("a/b/Home.swift:42")).toBe("a/b/Home.swift");
    expect(pathNamed("./src/app.ts")).toBe("src/app.ts");
    expect(pathNamed("/Users/me/App/Flow.swift:3:9")).toBe("/Users/me/App/Flow.swift");
    for (const code of ["self.value", "Home.swift", "a/b", "a/b/Home", "../a/b.ts", "see a/b.ts", "isOn.toggle()", "https://x.com/a.md", "a/b/c.weird"]) expect(pathNamed(code)).toBeNull();
  });

  it("shows just a file link's words where nothing can open it", async () => {
    await render(<Markdown text="See [`Flow.swift:35`](/Users/me/App/Flow.swift#L35)." />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Flow.swift:35")).toBeTruthy();
    expect(screen.queryByText(/\]\(/)).toBeNull();
  });
});
