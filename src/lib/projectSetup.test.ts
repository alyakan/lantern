import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { linesOf, MAX_SETUP_LINE, MAX_SETUP_LINES, problemWith, pushProjectSetups, runCommandOf } from "./projectSetup";
import { localUrl, localUrlIn } from "./localUrl";

vi.mock("../api", () => ({ api: { setProjectSetup: vi.fn() } }));

describe("what is typed in the setup box", () => {
  it("is one command per line, trimmed, with the blank lines left out", () => {
    expect(linesOf("  npm ci \n\n   \ncp a b\n")).toEqual(["npm ci", "cp a b"]);
    expect(linesOf("")).toEqual([]);
  });

  it("is refused when it is too long, has too many lines or a stray control character", () => {
    expect(problemWith(["npm ci"], "npm run dev")).toBeNull();
    expect(problemWith(Array(MAX_SETUP_LINES + 1).fill("x"), "")).toMatch(/at most/);
    expect(problemWith(["x".repeat(MAX_SETUP_LINE + 1)], "")).toMatch(/longer/);
    expect(problemWith([], "x".repeat(MAX_SETUP_LINE + 1))).toMatch(/longer/);
    expect(problemWith(["echo \u0007"], "")).toMatch(/control/);
    expect(problemWith([], "a\rb")).toMatch(/control/);
    expect(problemWith(["a\tb"], "")).toBeNull();
  });
});

describe("a project's Run command", () => {
  it("is the one saved for its folder, and none when blank or unknown", () => {
    const all = { "/p": { commands: [], run: " npm run dev " }, "/q": { commands: ["npm ci"], run: "  " } };
    expect(runCommandOf(all, "/p")).toBe("npm run dev");
    expect(runCommandOf(all, "/q")).toBeNull();
    expect(runCommandOf(all, "/other")).toBeNull();
    expect(runCommandOf(all, null)).toBeNull();
  });
});

describe("telling the backend", () => {
  beforeEach(() => vi.mocked(api.setProjectSetup).mockReset().mockResolvedValue(undefined));

  it("sends every project's lines and its Run command (null when there is none)", async () => {
    await pushProjectSetups({ "/p": { commands: ["npm ci"], run: "npm run dev" }, "/q": { commands: [], run: " " } });
    expect(api.setProjectSetup).toHaveBeenCalledWith("/p", ["npm ci"], "npm run dev");
    expect(api.setProjectSetup).toHaveBeenCalledWith("/q", [], null);
  });

  it("doesn't fail when the backend refuses one", async () => {
    vi.mocked(api.setProjectSetup).mockRejectedValueOnce("no");
    await expect(pushProjectSetups({ "/p": { commands: [], run: "" } })).resolves.toBeDefined();
  });
});

describe("an address in a program's output", () => {
  it("is only taken when it is this computer's own, over http or https", () => {
    expect(localUrl("http://localhost:5173/")).toBe("http://localhost:5173/");
    expect(localUrl("https://127.0.0.1:8443/app")).toBe("https://127.0.0.1:8443/app");
    expect(localUrl("http://[::1]:3000/")).toBe("http://[::1]:3000/");
    for (const bad of ["http://example.com/", "http://localhost.evil.com/", "http://127.0.0.1.evil.com/", "ftp://localhost/", "javascript:alert(1)", "http://user:pw@localhost/", "http://localhost@evil.com/", "not a url", "file:///etc/passwd", "http://0.0.0.0:3000/", "http://192.168.1.4:3000/"]) {
      expect(localUrl(bad), bad).toBeNull();
    }
  });

  it("is found in what vite and friends print, without colours or a sentence's full stop", () => {
    expect(localUrlIn("  \x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n")).toBe("http://localhost:5173/");
    expect(localUrlIn("Server listening at http://127.0.0.1:3000.\n")).toBe("http://127.0.0.1:3000/");
    expect(localUrlIn("ready on http://localhost:3000, press h")).toBe("http://localhost:3000/");
    expect(localUrlIn("see https://example.com/docs and then http://localhost:8080/x?y=1 ok")).toBe("http://localhost:8080/x?y=1");
  });

  it("waits for the end of an address that output stopped in the middle of", () => {
    expect(localUrlIn("ready on http://localhost:30")).toBeNull();
    expect(localUrlIn("ready on http://localhost:3000\n")).toBe("http://localhost:3000/");
  });

  it("is not found in addresses that only start like a local one", () => {
    expect(localUrlIn("fetching http://localhost.example.com/a")).toBeNull();
    expect(localUrlIn("http://127.0.0.1.nip.io:3000")).toBeNull();
    expect(localUrlIn("nothing here")).toBeNull();
  });
});
