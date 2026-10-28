/** scripts/build-notes.sh: what a phone build's notes say, from a throwaway repository and a stand-in for `gh`. */
import { execFileSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SCRIPT = resolve(__dirname, "..", "scripts", "build-notes.sh");

let repo: string;
let bin: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
/** A commit that changes `file`, with `subject`. */
const commit = (subject: string, file: string) => {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), `${subject}\n${Math.random()}`);
  git("add", "-A");
  git("commit", "-q", "-m", subject);
};
const notes = (from = "base") => execFileSync(SCRIPT, [from, "HEAD"], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "notes-repo-"));
  bin = mkdtempSync(join(tmpdir(), "notes-bin-"));
  // `gh pr view 7 ...` answers with a description that has a Changelog; any other PR can't be read.
  writeFileSync(join(bin, "gh"), `#!/bin/bash\nif [ "$3" = "7" ]; then printf '## Why\\n\\nThe reason.\\n\\n## Changelog\\n- A paired phone can show a pairing code.\\n- It asks Face ID first.\\n\\n## Risks\\n- Not this.\\n'; else exit 1; fi\n`);
  chmodSync(join(bin, "gh"), 0o755);
  git("init", "-q", "-b", "main");
  commit("chore: start", "README.md");
  git("tag", "-a", "base", "-m", "base");
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe("a phone build's notes", () => {
  it("are the Changelog bullets of a PR that touched the phone app, and nothing from its other sections", () => {
    commit("feat: pairing for another device (#7)", "mobile/src/a.ts");
    expect(notes()).toBe("- A paired phone can show a pairing code.\n- It asks Face ID first.\n");
  });

  it("fall back to the title, capitalised, for a PR with no Changelog or one that can't be read", () => {
    commit("fix(mobile): chats hold still (#8)", "mobile/src/b.ts");
    commit("feat: a title with no PR number", "mobile/src/c.ts");
    expect(notes()).toBe("- Chats hold still\n- A title with no PR number\n");
  });

  it("go oldest first, and only from the previous build", () => {
    commit("fix: before the build (#1)", "mobile/src/old.ts");
    git("tag", "-a", "built", "-m", "built");
    commit("fix: after the build one (#2)", "mobile/src/one.ts");
    commit("feat: after the build two (#3)", "mobile/src/two.ts");
    expect(notes("built")).toBe("- After the build one\n- After the build two\n");
  });

  it("leave out changes that didn't touch the phone app, and chores, docs and releases", () => {
    commit("feat: a Mac-only feature (#4)", "src/mac.ts");
    commit("chore: release 0.1.63 (#5)", "mobile/package.json");
    commit("docs: explain it (#6)", "mobile/README.md");
    commit("fix: a phone fix (#9)", "mobile/src/d.ts");
    expect(notes()).toBe("- A phone fix\n");
  });

  it("leave out a change that only regenerated the protocol bindings, which the Mac's notes tell", () => {
    commit("feat: a new request on the Mac (#10)", "mobile/src/protocol/generated/Request.ts");
    commit("fix: a phone fix (#11)", "mobile/src/e.ts");
    expect(notes()).toBe("- A phone fix\n");
  });

  it("leave out what only builds the app: how it is signed, uploaded or noted", () => {
    commit("fix(mobile): the TestFlight export signs with named profiles (#13)", "mobile/fastlane/Fastfile");
    commit("fix(mobile): notes leave out build changes (#14)", "mobile/scripts/build-notes.sh");
    commit("fix: a phone fix (#15)", "mobile/src/g.ts");
    expect(notes()).toBe("- A phone fix\n");
  });

  it("keep a change that touched both the app and how it is built", () => {
    commit("feat: a new screen (#16)", "mobile/src/h.ts");
    writeFileSync(join(repo, "mobile", "fastlane.txt"), "x");
    mkdirSync(join(repo, "mobile", "fastlane"), { recursive: true });
    writeFileSync(join(repo, "mobile", "fastlane", "Fastfile"), `${Math.random()}`);
    writeFileSync(join(repo, "mobile", "src", "i.ts"), `${Math.random()}`);
    git("add", "-A");
    git("commit", "-q", "-m", "feat: a screen and its lane (#17)");
    expect(notes()).toBe("- A new screen\n- A screen and its lane\n");
  });

  it("leave out a PR whose Changelog says none, however it is written, and keep its neighbours", () => {
    writeFileSync(join(bin, "gh"), `#!/bin/bash\nif [ "$3" = "20" ]; then printf '## Changelog\\n- None\\n'; elif [ "$3" = "21" ]; then printf '## Changelog\\n- none.\\n'; else exit 1; fi\n`);
    commit("fix: an internal change (#20)", "mobile/src/j.ts");
    commit("fix: another internal change (#21)", "mobile/src/k.ts");
    commit("fix: a phone fix (#22)", "mobile/src/l.ts");
    expect(notes()).toBe("- A phone fix\n");
  });

  it("are empty when nothing changed", () => {
    expect(notes()).toBe("");
  });

  it("work from any folder of the repository", () => {
    commit("fix: a phone fix (#12)", "mobile/src/f.ts");
    const out = execFileSync(SCRIPT, ["base", "HEAD"], { cwd: join(repo, "mobile", "src"), encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });
    expect(out).toBe("- A phone fix\n");
  });
});
