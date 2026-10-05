import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { filePaths, languageName, monacoLanguage, parsePlanStep } from "./markdown";
import { Md } from "../components/Md";

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

describe("Md", () => {
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
});
