/** .github/release-notes.sh: what a Mac release's notes say, from a throwaway repository and a stand-in for `gh`. */
import { execFileSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SCRIPT = resolve(__dirname, "..", "..", ".github", "release-notes.sh");

let repo: string;
let bin: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const commit = (subject: string, ...files: string[]) => {
  for (const file of files) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), `${subject}\n${Math.random()}`);
  }
  git("add", "-A");
  git("commit", "-q", "-m", subject);
};
/** The notes of the release tagged v0.2.0, made after the commits since v0.1.0. */
const notes = () => {
  git("tag", "-a", "v0.2.0", "-m", "v0.2.0");
  return execFileSync(SCRIPT, ["v0.2.0"], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "mac-notes-repo-"));
  bin = mkdtempSync(join(tmpdir(), "mac-notes-bin-"));
  // `gh pr view N ...` answers with a Changelog for the PRs below; any other can't be read.
  const bodies: Record<string, string> = { "7": "## Changelog\\n- A real thing you will notice.\\n- And another.\\n", "8": "## Changelog\\n- none\\n", "9": "## Changelog\\n- None.\\n", "10": "## Why\\nx\\n## Changelog\\n- Something kept.\\n" };
  const cases = Object.entries(bodies).map(([n, body]) => `if [ "$3" = "${n}" ]; then printf '%b' '${body}'; exit 0; fi\n`).join("");
  writeFileSync(join(bin, "gh"), `#!/bin/bash\n${cases}exit 1\n`);
  chmodSync(join(bin, "gh"), 0o755);
  git("init", "-q", "-b", "main");
  commit("chore: start", "README.md");
  git("tag", "-a", "v0.1.0", "-m", "v0.1.0");
  git("tag", "-a", "mobile-build-0.1.0-5", "-m", "a phone build, not a Mac release");
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe("a Mac release's notes", () => {
  it("are the Changelog bullets of a PR, and the title of one without", () => {
    commit("feat: a thing (#7)", "src/a.ts");
    commit("fix: a bug (#99)", "src/b.ts");
    expect(notes()).toBe("## What's new\n\n- A real thing you will notice.\n- And another.\n- A bug\n\n");
  });

  it("leave out what only builds, signs or documents the app", () => {
    commit("fix(mobile): the TestFlight export signs with profiles (#20)", "mobile/fastlane/Fastfile");
    commit("fix(mobile): the notes tool (#21)", "mobile/scripts/build-notes.sh");
    commit("fix: the release workflow (#22)", ".github/workflows/release.yml");
    commit("fix: a doc (#23)", "docs/MOBILE.md");
    commit("fix: a real fix (#24)", "src/c.ts");
    expect(notes()).toBe("## What's new\n\n- A real fix\n\n");
  });

  it("keep a change that touched the app and its lane together", () => {
    commit("feat: a screen and its lane (#25)", "mobile/src/screen.ts", "mobile/fastlane/Fastfile");
    expect(notes()).toBe("## What's new\n\n- A screen and its lane\n\n");
  });

  it("leave out a PR whose Changelog says none, however it is written, and not the word as a bullet", () => {
    commit("fix: internal (#8)", "src/d.ts");
    commit("fix: also internal (#9)", "src/e.ts");
    commit("fix: kept (#10)", "src/f.ts");
    const out = notes();
    expect(out).toBe("## What's new\n\n- Something kept.\n\n");
    expect(out.toLowerCase()).not.toContain("none");
  });

  it("count only the Mac's own tags as the last release, and say nothing when nothing is left", () => {
    commit("fix: before the phone build (#26)", "src/g.ts");
    git("tag", "-a", "mobile-build-0.1.0-6", "-m", "a later phone build");
    commit("fix: after it (#27)", "src/h.ts");
    expect(notes()).toBe("## What's new\n\n- Before the phone build\n- After it\n\n");
  });

  it("are empty when only chores and internal changes came", () => {
    commit("chore: release 0.2.0", "package.json");
    commit("fix: only the lane (#28)", "mobile/fastlane/Fastfile");
    expect(notes()).toBe("");
  });
});
