// Keeps a self-hosted runner's kept target folder ($CARGO_TARGET_DIR) from growing without end. Cargo never deletes what
// it built: every run leaves another copy of Lantern's own binaries beside the last ones (a version bump, a Cargo.lock
// change or a build of another kind gives them new names), and a new Rust leaves every dependency's old build behind.
//
//   node .github/prune-target.mjs start   before the build: a new rustc empties the folder (nothing in it can be reused),
//                                         and the run's start is marked
//   node .github/prune-target.mjs end     after the job, even a failed one: removes the builds of the project's own crates
//                                         that this run replaced, then empties the folder if it is still over
//                                         $PRUNE_LIMIT_GB (default 12)
//
// Only the project's own crates are pruned one by one; a dependency only ever goes with the whole folder.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const target = process.env.CARGO_TARGET_DIR;
if (!target) throw new Error("CARGO_TARGET_DIR is not set");
const manifest = process.env.PRUNE_MANIFEST || "src-tauri/Cargo.toml";
const limitGb = Number(process.env.PRUNE_LIMIT_GB || 12);
const marker = join(target, ".run-start");
const empty = (why) => {
  // Only a folder cargo made (it tags it), so a wrong CARGO_TARGET_DIR never empties someone's other folder.
  if (!existsSync(join(target, "CACHEDIR.TAG"))) return console.log(`${why}, but ${target} has no CACHEDIR.TAG: left as it is`);
  console.log(`${why}: emptying ${target}`);
  for (const e of readdirSync(target)) rmSync(join(target, e), { recursive: true, force: true });
};

/** Each entry under `dir`, with the newest change time of anything inside it. */
function walk(dir, visit) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    visit(p, e);
    if (e.isDirectory() && !e.isSymbolicLink()) walk(p, visit);
  }
}

const mode = process.argv[2];
if (mode === "start") {
  mkdirSync(target, { recursive: true });
  const rustc = execFileSync("rustc", ["-V"], { encoding: "utf8" }).trim();
  const was = existsSync(join(target, ".rustc")) ? readFileSync(join(target, ".rustc"), "utf8").trim() : null;
  if (was !== null && was !== rustc) empty(`Rust changed (${was} → ${rustc})`);
  writeFileSync(join(target, ".rustc"), rustc + "\n");
  writeFileSync(marker, "");
  const now = new Date();
  utimesSync(marker, now, now);
} else if (mode === "end") {
  if (!existsSync(target)) process.exit(0);
  if (existsSync(marker)) {
    const since = lstatSync(marker).mtimeMs;
    // The crate's targets (lib, bin, tests, examples), named as their files are: dashes become underscores.
    const meta = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifest], { encoding: "utf8", maxBuffer: 64 << 20 }));
    const names = new Set(meta.packages.flatMap((p) => [p.name, ...p.targets.map((t) => t.name)]).map((n) => n.replace(/-/g, "_")));
    const unit = /^(?:lib)?(.+)-([0-9a-f]{16})(?:\.|$)/;
    // The builds this run wrote (by name and hash): anything inside them changed after the start.
    const fresh = new Set();
    walk(target, (p, e) => {
      if (!e.isFile() || lstatSync(p).mtimeMs < since) return;
      for (const part of p.slice(target.length).split("/")) {
        const m = unit.exec(part);
        if (m && names.has(m[1])) fresh.add(`${m[1]}-${m[2]}`);
      }
    });
    const rebuilt = new Set([...fresh].map((k) => k.slice(0, -17)));
    // In deps, build, examples and .fingerprint of every profile (debug, release, <triple>/release): an own crate's build
    // that this run replaced with another. A crate the run didn't build again (it failed first) keeps what it has.
    let removed = 0;
    walk(target, (p, e) => {
      if (!e.isDirectory() || !["deps", "build", "examples", ".fingerprint"].includes(e.name)) return;
      for (const entry of readdirSync(p)) {
        const m = unit.exec(entry);
        if (!m || !rebuilt.has(m[1]) || fresh.has(`${m[1]}-${m[2]}`)) continue;
        rmSync(join(p, entry), { recursive: true, force: true });
        removed++;
      }
    });
    console.log(`Removed ${removed} old builds of ${[...rebuilt].sort().join(", ") || "nothing"}`);
  }
  const kb = Number(execFileSync("du", ["-sk", target], { encoding: "utf8" }).split("\t")[0]);
  console.log(`${target}: ${(kb / 1048576).toFixed(1)} GB`);
  if (kb > limitGb * 1048576) empty(`Over ${limitGb} GB (the next run builds from scratch)`);
} else {
  console.error("usage: node .github/prune-target.mjs start|end");
  process.exit(2);
}
