#!/usr/bin/env node
// Bumps Lantern's version in the five files a release PR changes: node scripts/release/bump-version.mjs 0.1.66
// Run from the repo root (or a worktree of it). It refuses anything but the next patch or a higher version.
import fs from "node:fs";

const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(next ?? "")) {
  console.error("usage: bump-version.mjs <x.y.z>");
  process.exit(1);
}
const read = (f) => fs.readFileSync(f, "utf8");
const current = JSON.parse(read("package.json")).version;
const n = (v) => v.split(".").map(Number);
const [a, b] = [n(current), n(next)];
if (!(b[0] > a[0] || (b[0] === a[0] && (b[1] > a[1] || (b[1] === a[1] && b[2] > a[2]))))) {
  console.error(`${next} is not higher than ${current}`);
  process.exit(1);
}
const replace = (file, from, to) => {
  const s = read(file);
  const found = s.split(from).length - 1;
  if (found !== 1) throw new Error(`${file}: expected one ${JSON.stringify(from)}, found ${found}`);
  fs.writeFileSync(file, s.replace(from, () => to));
};
replace("package.json", `"version": "${current}"`, `"version": "${next}"`);
replace("src-tauri/tauri.conf.json", `"version": "${current}"`, `"version": "${next}"`);
replace("src-tauri/Cargo.toml", `name = "lantern"\nversion = "${current}"`, `name = "lantern"\nversion = "${next}"`);
replace("src-tauri/Cargo.lock", `name = "lantern"\nversion = "${current}"`, `name = "lantern"\nversion = "${next}"`);
// package-lock.json names the version twice: at the top and under packages[""] (indented deeper).
replace("package-lock.json", `"name": "lantern",\n  "version": "${current}"`, `"name": "lantern",\n  "version": "${next}"`);
replace("package-lock.json", `"name": "lantern",\n      "version": "${current}"`, `"name": "lantern",\n      "version": "${next}"`);
console.log(`${current} -> ${next} in package.json, package-lock.json, Cargo.toml, Cargo.lock, tauri.conf.json`);
