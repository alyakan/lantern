import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { blockLanguage, filePaths, inferLanguage, isMarkdownPath, languageHint, languageName, monacoLanguage, parsePlanStep, withFrontMatterAsCode } from "./markdown";
import { Md } from "../components/Md";

describe("isMarkdownPath", () => {
  it("is true for markdown files, whatever the case, and false for the rest", () => {
    expect(isMarkdownPath("/p/README.md")).toBe(true);
    expect(isMarkdownPath("/p/Notes.MD")).toBe(true);
    expect(isMarkdownPath("/p/a.ts")).toBe(false);
    expect(isMarkdownPath("/p/md")).toBe(false);
  });
});

describe("withFrontMatterAsCode", () => {
  it("turns a leading front matter block into a yaml code block", () => {
    expect(withFrontMatterAsCode("---\nname: a\ndescription: b\n---\n# Hi\n")).toBe("```yaml\nname: a\ndescription: b\n```\n# Hi\n");
  });

  it("leaves text without front matter, and rules further down, alone", () => {
    expect(withFrontMatterAsCode("# Hi\n\n---\n\nmore\n")).toBe("# Hi\n\n---\n\nmore\n");
    expect(withFrontMatterAsCode("text\n---\nx\n---\n")).toBe("text\n---\nx\n---\n");
  });

  it("handles an empty block and Windows line endings", () => {
    expect(withFrontMatterAsCode("---\n---\nBody")).toBe("```yaml\n\n```\nBody");
    expect(withFrontMatterAsCode("---\r\na: 1\r\n---\r\nBody")).toBe("```yaml\na: 1\n```\nBody");
  });
});

describe("parsePlanStep", () => {
  it("reads incremental-dev's File / Change / Verify block, with values running onto indented lines", () => {
    const step = parsePlanStep("Plan step 2 — Retry with backoff\nFile:   src/client/retry.ts\nChange: Loop up to attempts,\n        waiting 250·2^i ms.\nVerify: 503, 503, 200 resolves.\n");
    expect(step).toEqual({
      title: "Plan step 2 — Retry with backoff",
      fields: [
        { label: "File", value: "src/client/retry.ts" },
        { label: "Change", value: "Loop up to attempts,\nwaiting 250·2^i ms." },
        { label: "Verify", value: "503, 503, 200 resolves." },
      ],
    });
  });

  it("leaves code alone", () => {
    expect(parsePlanStep("const a = 1;\nFile: nope")).toBeNull();
    expect(parsePlanStep("File: a.ts")).toBeNull();
    expect(parsePlanStep("Change: x\nexport const y = 2;")).toBeNull();
  });

  it("splits a File value into paths", () => {
    expect(filePaths("src/a.ts, `src/b.ts` (new)")).toEqual([{ path: "src/a.ts", note: "" }, { path: "src/b.ts", note: "(new)" }]);
    expect(filePaths("a.swift and b.swift").map((p) => p.path)).toEqual(["a.swift", "b.swift"]);
  });

  it("names a code block's language", () => {
    expect(languageName("language-ts")).toBe("TypeScript");
    expect(languageName("language-zig")).toBe("zig");
    expect(languageName(undefined)).toBeNull();
  });

  it("maps a code block's language to what Monaco colours", () => {
    expect(monacoLanguage("language-ts")).toBe("typescript");
    expect(monacoLanguage("language-bash")).toBe("shell");
    expect(monacoLanguage("language-Swift")).toBe("swift");
    expect(monacoLanguage("language-zig")).toBeNull();
    expect(monacoLanguage(undefined)).toBeNull();
  });
});

describe("untagged code blocks", () => {
  it("takes the language of the files a message names, the most mentioned winning", () => {
    expect(languageHint("Changed `src/client/retry.ts:3-10` and src/client/index.ts, and the config in package.json.")).toBe("typescript");
    expect(languageHint("In `app.py` and `util.py`, plus lib/a.ts.")).toBe("python");
    expect(languageHint("First `a.rs`, then `b.go`.")).toBe("rust");
    // Not files: abbreviations, versions, a sentence ending in a period.
    expect(languageHint("e.g. v1.2 of it, i.e. fine. See README.md.")).toBeNull();
    expect(languageHint("nothing here")).toBeNull();
  });

  it("recognises a diff, JSON and a shell command by their shape", () => {
    expect(inferLanguage("@@ -1,2 +1,3 @@\n a\n+b", null)).toBe("diff");
    expect(inferLanguage("--- a/x.ts\n+++ b/x.ts\n-old\n+new", null)).toBe("diff");
    expect(inferLanguage("-old\n+new\n same", null)).toBe("diff");
    // A list of dashes alone is a list, not a diff.
    expect(inferLanguage("- one\n- two", null)).toBeNull();
    expect(inferLanguage('{ "a": [1, 2] }', null)).toBe("json");
    expect(inferLanguage("{ not json }", null)).toBeNull();
    expect(inferLanguage("$ npm test", null)).toBe("shell");
    expect(inferLanguage("git status --short", null)).toBe("shell");
  });

  it("uses the message's language only for what looks like code, so plain output stays plain", () => {
    expect(inferLanguage("const RETRYABLE = new Set([429]);", "typescript")).toBe("typescript");
    expect(inferLanguage("def retry(n):\n    return n", "python")).toBe("python");
    expect(inferLanguage("✓ 3 passed\n✗ 1 failed", "typescript")).toBeNull();
    expect(inferLanguage("src/\n  client/\n    retry.ts", "typescript")).toBeNull();
    expect(inferLanguage("const a = 1;", null)).toBeNull();
    expect(inferLanguage("  \n", "typescript")).toBeNull();
  });

  it("keeps a language a block names, colours diff blocks itself, and leaves a plain-text tag alone", () => {
    expect(blockLanguage("language-ts", "x", "python")).toEqual({ id: "typescript", label: "TypeScript" });
    expect(blockLanguage("language-diff", "+a", null)).toEqual({ id: "diff", label: "Diff" });
    expect(blockLanguage("language-text", "const a = 1;", "typescript")).toEqual({ id: null, label: "text" });
    expect(blockLanguage(undefined, "const a = 1;", "typescript")).toEqual({ id: "typescript", label: "TypeScript" });
    expect(blockLanguage(undefined, "@@ -1 +1 @@\n-a\n+b", null)).toEqual({ id: "diff", label: "Diff" });
    expect(blockLanguage(undefined, "just words", "typescript")).toEqual({ id: null, label: null });
  });

  it("knows more languages by name", () => {
    for (const tag of ["php", "cs", "csharp", "dockerfile", "jsonc", "powershell", "c++", "scala", "dart"]) expect(monacoLanguage(`language-${tag}`), tag).not.toBeNull();
  });
});

describe("Md", () => {
  it("puts a table in a box of its own, with each cell's content in a box with a widest width", () => {
    const { container } = render(<Md>{"| Share | What |\n| --: | --- |\n| ~34% | The Rayak team, run at the same time |"}</Md>);
    const box = container.querySelector(".md-table");
    expect(box?.firstElementChild?.tagName).toBe("TABLE");
    const cells = [...container.querySelectorAll("th, td")];
    expect(cells.map((c) => c.firstElementChild?.className)).toEqual(["md-cell", "md-cell", "md-cell", "md-cell"]);
    expect(cells.map((c) => c.textContent)).toEqual(["Share", "What", "~34%", "The Rayak team, run at the same time"]);
    // GFM's column alignment still reaches the cell.
    expect((cells[2] as HTMLElement).style.textAlign || cells[2].getAttribute("align")).toBe("right");
  });

  it("renders a plan step as a card, and other code with a header", () => {
    const { container } = render(<Md>{"```\nFile:   a.ts\nChange: add it\nVerify: a test\n```\n\n```ts\nconst a = 1;\n```"}</Md>);
    expect([...container.querySelectorAll(".plan-card dt")].map((d) => d.textContent)).toEqual(["File", "Change", "Verify"]);
    expect(container.querySelector(".code-block-lang")).toHaveTextContent("TypeScript");
    expect(container.querySelector(".code-block pre")).toHaveTextContent("const a = 1;");
  });

  it("renders GitHub callouts without their marker, and plain quotes as quotes", () => {
    const { container } = render(<Md>{"> [!WARNING]\n> This drops the table.\n\n> Just a quote."}</Md>);
    const callout = container.querySelector(".callout-warning")!;
    expect(callout.querySelector(".callout-title")).toHaveTextContent("Warning");
    expect(callout).toHaveTextContent("This drops the table.");
    expect(callout).not.toHaveTextContent("[!WARNING]");
    expect(container.querySelector("blockquote")).toHaveTextContent("Just a quote.");
  });

  it("tints a diff's lines, whether it's tagged or not, and labels a block whose language it worked out", () => {
    const { container, rerender } = render(<Md>{"```diff\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n same\n```"}</Md>);
    const kinds = () => [...container.querySelectorAll(".diff-line")].map((l) => l.className.replace("diff-line ", ""));
    expect(kinds()).toEqual(["meta", "meta", "meta", "del", "add", "ctx"]);
    expect(container.querySelector(".code-block-lang")).toHaveTextContent("Diff");
    rerender(<Md>{"```\n-old\n+new\n```"}</Md>);
    expect(kinds()).toEqual(["del", "add"]);
    // No tag, in a message about a .ts file: it's labelled TypeScript.
    rerender(<Md>{"Changed `src/a.ts`:\n\n```\nconst a = 1;\n```"}</Md>);
    expect(container.querySelector(".code-block-lang")).toHaveTextContent("TypeScript");
    // Plain output keeps the generic header and no colouring.
    rerender(<Md>{"```\n✓ 3 passed\n```"}</Md>);
    expect(container.querySelector(".code-block-lang")).toHaveTextContent("Code");
  });
});

describe("pictures", () => {
  const text = "Done.\n\n![status](https://tracker.example/p.png)";

  it("aren't loaded in Claude's text, which can be steered into naming a server", () => {
    const { container } = render(<Md>{text}</Md>);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("[Image: status]");
  });

  it("aren't loaded inside a plan step's fields either", () => {
    const { container } = render(<Md>{"```\nFile:   a.ts\nChange: ![x](https://tracker.example/p.png) edit\nVerify: a test\n```"}</Md>);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("[Image: x]");
  });

  it("load when the caller allows them", () => {
    const { container } = render(<Md images>{text}</Md>);
    expect(container.querySelector("img")).toHaveAttribute("src", "https://tracker.example/p.png");
  });
});
