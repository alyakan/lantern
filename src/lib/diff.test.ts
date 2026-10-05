import { describe, expect, it } from "vitest";
import { basename, countChanges, dirOf, languageFor, relativeTo } from "./diff";

describe("diff helpers", () => {
  it("counts added and removed lines", () => {
    expect(countChanges([{ old_start: 1, old_lines: 2, new_start: 1, new_lines: 2, lines: [" a", "-b", "+c", "+d", "\\ No newline at end of file"] }])).toEqual({ added: 2, removed: 1 });
  });

  it("maps extensions to Monaco languages", () => {
    expect(languageFor("/a/b.tsx")).toBe("typescript");
    expect(languageFor("/a/Main.swift")).toBe("swift");
    expect(languageFor("/a/Makefile")).toBe("plaintext");
  });

  it("formats paths relative to the open folder", () => {
    expect(relativeTo("/p/src/a.ts", "/p")).toBe("src/a.ts");
    expect(relativeTo("/p/src/a.ts", "/p/")).toBe("src/a.ts");
    expect(relativeTo("/other/a.ts", "/p")).toBe("/other/a.ts");
    expect(relativeTo("npm test", "/p")).toBe("npm test");
    // Outside the folder: under the same home as "~/…", otherwise just the last parts.
    expect(relativeTo("/Users/me/notes/todo.md", "/Users/me/src/app")).toBe("~/notes/todo.md");
    expect(relativeTo("/private/tmp/claude-501/-Users-me-app/scratchpad/probe/a.ts", "/Users/me/src/app")).toBe("…/scratchpad/probe/a.ts");
    expect(basename("/p/src/a.ts")).toBe("a.ts");
    expect(dirOf("src/a.ts")).toBe("src");
    expect(dirOf("a.ts")).toBe("");
  });
});
