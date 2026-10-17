import { describe, expect, it } from "vitest";
import { candidatePaths, collectLibs, importSpecifiers } from "./projectLibs";

function fakeRead(files: Record<string, string>) {
  const calls: string[] = [];
  const read = async (path: string): Promise<string> => {
    calls.push(path);
    if (!(path in files)) throw new Error(`ENOENT ${path}`);
    return files[path];
  };
  return { read, calls };
}

describe("importSpecifiers", () => {
  it("finds every import form, in order", () => {
    const src = [
      'import x from "./a";',
      "import {b} from './b';",
      'import "./c";',
      'import type {T} from "./t";',
      'export * from "./star";',
      'export {a} from "./named";',
      'const d = import("./dyn");',
      'const r = require("./req");',
    ].join("\n");
    expect(importSpecifiers(src)).toEqual(["./a", "./b", "./c", "./t", "./star", "./named", "./dyn", "./req"]);
  });

  it("accepts backticks without interpolation and parent-relative paths, and skips interpolated ones", () => {
    const src = ["import x from `./tpl`;", "const y = require(`../up`);", "import z from `./${name}`;"].join("\n");
    expect(importSpecifiers(src)).toEqual(["./tpl", "../up"]);
  });

  it("ignores specifiers in line and block comments", () => {
    const src = [
      '// import a from "./line"',
      '/* import b from "./block"',
      '   require("./block2") */',
      "// don't import c from \"./apostrophe\"",
      'import d from "./real";',
    ].join("\n");
    expect(importSpecifiers(src)).toEqual(["./real"]);
  });

  it("does not treat // inside a string as a comment", () => {
    expect(importSpecifiers('const url = "http://example.com/x"; import y from "./y";')).toEqual(["./y"]);
  });

  it("follows `.` and `..` (a folder's index) like any relative specifier", () => {
    const src = ['import a from ".";', "import b from '..';", 'export * from "../.";'].join("\n");
    expect(importSpecifiers(src)).toEqual([".", "..", "../."]);
  });

  it("ignores bare specifiers", () => {
    const src = [
      'import React from "react";',
      'import { x } from "@scope/pkg";',
      'import "lodash";',
      'const r = require("fs");',
      'const d = import("zod");',
    ].join("\n");
    expect(importSpecifiers(src)).toEqual([]);
  });

  it("de-duplicates, keeping first appearance", () => {
    const src = ['import a from "./x";', 'import "./x";', 'export * from "./y";', 'const z = require("./x");'].join("\n");
    expect(importSpecifiers(src)).toEqual(["./x", "./y"]);
  });
});

describe("candidatePaths", () => {
  it("tries an extensionless specifier as a file, then as a folder index", () => {
    expect(candidatePaths("/p/src/a.ts", "./x")).toEqual([
      "/p/src/x.ts",
      "/p/src/x.tsx",
      "/p/src/x.d.ts",
      "/p/src/x.js",
      "/p/src/x.jsx",
      "/p/src/x.mjs",
      "/p/src/x.cjs",
      "/p/src/x.json",
      "/p/src/x/index.ts",
      "/p/src/x/index.tsx",
      "/p/src/x/index.d.ts",
      "/p/src/x/index.js",
      "/p/src/x/index.jsx",
      "/p/src/x/index.mjs",
      "/p/src/x/index.cjs",
      "/p/src/x/index.json",
    ]);
  });

  it("maps ESM .js-style specifiers to the TypeScript file they stand for", () => {
    expect(candidatePaths("/p/src/a.ts", "./x.js")).toEqual(["/p/src/x.js", "/p/src/x.ts", "/p/src/x.tsx"]);
    expect(candidatePaths("/p/src/a.ts", "./x.jsx")).toEqual(["/p/src/x.jsx", "/p/src/x.tsx"]);
    expect(candidatePaths("/p/src/a.ts", "./x.mjs")).toEqual(["/p/src/x.mjs", "/p/src/x.mts"]);
    expect(candidatePaths("/p/src/a.ts", "./x.cjs")).toEqual(["/p/src/x.cjs", "/p/src/x.cts"]);
  });

  it("tries a specifier with a known extension as written, without probing further", () => {
    expect(candidatePaths("/p/src/a.ts", "./x.d.ts")).toEqual(["/p/src/x.d.ts"]);
    expect(candidatePaths("/p/src/a.ts", "./data.json")).toEqual(["/p/src/data.json"]);
  });

  it("normalises . and .. segments", () => {
    expect(candidatePaths("/p/src/deep/a.ts", "../shared/./y").slice(0, 2)).toEqual(["/p/src/shared/y.ts", "/p/src/shared/y.tsx"]);
  });

  it("resolves `.` and `..` to the folder's index file, not a sibling named like the folder", () => {
    expect(candidatePaths("/p/src/a.ts", ".")).toEqual(["/p/src/index.ts", "/p/src/index.tsx", "/p/src/index.d.ts", "/p/src/index.js", "/p/src/index.jsx", "/p/src/index.mjs", "/p/src/index.cjs", "/p/src/index.json"]);
    expect(candidatePaths("/p/src/deep/a.ts", "..").slice(0, 2)).toEqual(["/p/src/index.ts", "/p/src/index.tsx"]);
  });

  it("clamps .. at the root", () => {
    expect(candidatePaths("/a.ts", "../../../../z.ts")).toEqual(["/z.ts"]);
    expect(candidatePaths("/p/a.ts", "../../../x")[0]).toBe("/x.ts");
  });
});

describe("collectLibs", () => {
  it("follows imports transitively", async () => {
    const { read } = fakeRead({ "/p/b.ts": 'import "./c";', "/p/c.ts": "export const c = 1;" });
    const libs = await collectLibs({ path: "/p/a.ts", text: 'import "./b";' }, read);
    expect(libs).toEqual([
      { path: "/p/b.ts", text: 'import "./c";' },
      { path: "/p/c.ts", text: "export const c = 1;" },
    ]);
  });

  it("handles a cycle and never returns the entry", async () => {
    const { read, calls } = fakeRead({ "/p/b.ts": 'import "./a";' });
    const libs = await collectLibs({ path: "/p/a.ts", text: 'import "./b";' }, read);
    expect(libs.map((f) => f.path)).toEqual(["/p/b.ts"]);
    expect(calls).toEqual(["/p/b.ts"]);
  });

  it("falls through a missing candidate to the next one", async () => {
    const { read, calls } = fakeRead({ "/p/x/index.ts": "export {};" });
    const libs = await collectLibs({ path: "/p/main.ts", text: 'import { x } from "./x";' }, read);
    expect(libs).toEqual([{ path: "/p/x/index.ts", text: "export {};" }]);
    expect(calls).toEqual([
      "/p/x.ts",
      "/p/x.tsx",
      "/p/x.d.ts",
      "/p/x.js",
      "/p/x.jsx",
      "/p/x.mjs",
      "/p/x.cjs",
      "/p/x.json",
      "/p/x/index.ts",
    ]);
  });

  it("stops at maxFiles", async () => {
    const { read } = fakeRead({ "/p/1.ts": "", "/p/2.ts": "", "/p/3.ts": "" });
    const libs = await collectLibs({ path: "/p/a.ts", text: 'import "./1";\nimport "./2";\nimport "./3";' }, read, { maxFiles: 2 });
    expect(libs.map((f) => f.path)).toEqual(["/p/1.ts", "/p/2.ts"]);
  });

  it("stops at maxDepth, where the entry's imports are depth 1", async () => {
    const { read } = fakeRead({
      "/p/b.ts": 'import "./c";',
      "/p/c.ts": 'import "./d";',
      "/p/d.ts": 'import "./e";',
      "/p/e.ts": "export {};",
    });
    const entry = { path: "/p/a.ts", text: 'import "./b";' };
    expect((await collectLibs(entry, read)).map((f) => f.path)).toEqual(["/p/b.ts", "/p/c.ts", "/p/d.ts"]);
    expect((await collectLibs(entry, read, { maxDepth: 1 })).map((f) => f.path)).toEqual(["/p/b.ts"]);
  });

  it("stops once maxBytes would be exceeded", async () => {
    const { read } = fakeRead({ "/p/1.ts": "x".repeat(10), "/p/2.ts": "x".repeat(20), "/p/3.ts": "x".repeat(5) });
    const libs = await collectLibs({ path: "/p/a.ts", text: 'import "./1";\nimport "./2";\nimport "./3";' }, read, { maxBytes: 25 });
    expect(libs.map((f) => f.path)).toEqual(["/p/1.ts"]);
  });

  it("skips a file over 100,000 characters and keeps the rest", async () => {
    const { read } = fakeRead({ "/p/big.ts": "x".repeat(100_001), "/p/edge.ts": "x".repeat(100_000), "/p/small.ts": "" });
    const libs = await collectLibs({ path: "/p/a.ts", text: 'import "./big";\nimport "./edge";\nimport "./small";' }, read);
    expect(libs.map((f) => f.path)).toEqual(["/p/edge.ts", "/p/small.ts"]);
  });

  it("reads a file reached by two routes once", async () => {
    const { read, calls } = fakeRead({
      "/p/b.ts": 'import "./shared";',
      "/p/c.ts": 'import "./shared";',
      "/p/shared.ts": "export {};",
    });
    const libs = await collectLibs({ path: "/p/a.ts", text: 'import "./b";\nimport "./c";' }, read);
    expect(libs.map((f) => f.path)).toEqual(["/p/b.ts", "/p/c.ts", "/p/shared.ts"]);
    expect(calls.filter((p) => p === "/p/shared.ts")).toHaveLength(1);
  });

  it("reads one file once when two specifiers name it differently", async () => {
    const { read, calls } = fakeRead({ "/p/s.ts": "export {};" });
    const libs = await collectLibs({ path: "/p/a.ts", text: 'import "./s";\nimport "./s.ts";' }, read);
    expect(libs.map((f) => f.path)).toEqual(["/p/s.ts"]);
    expect(calls.filter((p) => p === "/p/s.ts")).toHaveLength(1);
  });

  it("keeps breadth-first order even when reads finish out of order", async () => {
    const { read: base } = fakeRead({
      "/p/a.ts": 'import "./c";',
      "/p/b.ts": 'import "./d";',
      "/p/c.ts": "",
      "/p/d.ts": "",
    });
    const read = async (path: string) => {
      if (path === "/p/a.ts") await new Promise((r) => setTimeout(r, 5));
      return base(path);
    };
    const libs = await collectLibs({ path: "/p/main.ts", text: 'import "./a";\nimport "./b";' }, read);
    expect(libs.map((f) => f.path)).toEqual(["/p/a.ts", "/p/b.ts", "/p/c.ts", "/p/d.ts"]);
  });

  it("returns JSON files but does not parse them for imports", async () => {
    const { read, calls } = fakeRead({ "/p/data.json": '{"s": "import x from `./hidden`"}' });
    const libs = await collectLibs({ path: "/p/a.ts", text: 'import d from "./data.json";' }, read);
    expect(libs.map((f) => f.path)).toEqual(["/p/data.json"]);
    expect(calls).not.toContain("/p/hidden.ts");
  });

  it("returns [] when read rejects for everything", async () => {
    const read = async (): Promise<string> => {
      throw "nope";
    };
    const libs = await collectLibs({ path: "/p/a.ts", text: 'import "./a";\nimport "./b/c";' }, read);
    expect(libs).toEqual([]);
  });
});
