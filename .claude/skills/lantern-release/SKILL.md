---
name: lantern-release
description: Ship Lantern: decide what needs releasing, then the Mac release (version PR, tag, signed draft, publish, install and restore chats) and the phone's TestFlight build. Use when the user says "release", "publish", "install and restart", "testflight", "admin merge" on a version PR, or asks to ship, upload or install a build.
---

# Releasing Lantern

Two independent tracks. The scripts are in `scripts/release/` (they take the version or build number as an argument; nothing is hard-coded to a release). Run each as its own Bash call: a hook in this setup blocks `&&`, `;` and `||` chains (a `for` loop is allowed, but not `&&` inside it: use a script file).

## First: what needs releasing

Read it from git, never from memory. `git fetch origin --tags --prune`, then:

- `git log vPREV..origin/main --oneline` (newest Mac tag: `git tag --list 'v0.1.*' --sort=-creatordate`) and `git log mobile-build-0.1.0-N..origin/main --oneline` (newest build: `scripts/release/testflight-latest.sh`).
- Changes under `mobile/` only: **TestFlight only**. Changes under `src-tauri/` or `src/`: **Mac release**. A new request, push or setting between the two (anything in `protocol.rs`, `notifier.rs`, the gateway): **both**, and the phone half does nothing until that Mac is installed. Say which, and why, before starting.
- Other sessions ship too: a version PR you did not open may already be merged and tagged. Look at the newest tag and build before you name a number ("the newest is v0.1.70, so this is 0.1.71"; "the newest build is 32, so this is 33").
- Only what is on `origin/main` is released. Open PRs are merged first, and a PR that conflicts with main gets **no CI at all** ("no checks reported"; `gh pr view N --json mergeStateStatus` says `DIRTY`): rebase it before waiting on it.

## The rules that hold for both

- **Merges, tag pushes, publishes, force-pushes and uploads need the user's go-ahead.** They type it as a message of its own ("admin merge", "admin testflight", "publish", "force push"). One typed while you are mid-turn, a general "go release", and a `request_approval` card on its own, did not satisfy the auto-mode classifier. When it denies, do not work around it: do what does not need the merge, then stop and ask for the exact phrase. Ask with `mcp__lantern__request_approval` before each push of a branch or tag and each remote branch deletion, and say what is pushed.
- Never print a key. The App Store Connect key id and issuer live in `~/.appstoreconnect/lantern.env` and the `.p8` in `~/.appstoreconnect/private_keys`; the Developer ID and notarization secrets are in the repo's GitHub secrets.
- Run npm and fastlane under Node 24 (`source ~/.nvm/nvm.sh; nvm use 24`): the default Node skips the rolldown binding. **CI runs Node 22 (npm 10, `.nvmrc`)**, so a `package-lock.json` that passes `npm ci` here can fail there ("Missing: typescript@5.9.3 from lock file"). Before pushing a lock change, copy `package.json` and the lock to a scratch folder and run `npm ci --ignore-scripts --dry-run` under **both** Node 22 and 24 (print one line: the dry run lists every package). To fix it, let npm 10 resolve in the scratch copy (`npm uninstall X --package-lock-only`, then `npm install X@^N --package-lock-only`) and copy only the keys the committed lock is missing; the rest is npm 10 reordering.
- A rebase that conflicts in `mobile/src/protocol/generated/*`: take main's file (`git checkout --ours` during a rebase), finish, run `cargo test` (it regenerates them), and commit the result. A rebased PR branch needs `git push --force-with-lease`, which needs the user's typed "force push".
- `gh pr checks N --watch` sometimes exits 1 early while checks are still pending; look again with `gh pr checks N` before calling it a failure.

## Mac release

1. **Version PR.** New worktree from `origin/main` on `release/X.Y.Z`; `node scripts/release/bump-version.mjs X.Y.Z` (five files: package.json, package-lock.json, Cargo.toml, Cargo.lock, tauri.conf.json); commit `chore: release X.Y.Z`; ask, push, open the PR. Its body names the version bump and says what ships (read `git log vPREV..origin/main --oneline`). Say that the Mac side of anything phone-related is what needs the release.
2. **Wait for checks** (`gh pr checks N --watch`, about 12 minutes), then merge with `gh pr merge N --admin --squash --delete-branch` once the user has said "admin merge" (they may say "after checks").
3. **Tag.** `git fetch origin`, `git tag -a vX.Y.Z <the release commit on main> -m "Lantern X.Y.Z"`, ask, `git push origin vX.Y.Z`. That starts `release.yml`, which builds a signed, notarized dmg into a **draft** release.
4. **Wait for the build** with `scripts/release/wait-release.sh X.Y.Z` (run it in the background).
5. **Publish** the draft (`gh release edit vX.Y.Z --draft=false`) only on the user's "publish"; the classifier denies it otherwise, in which case ask them to publish it themselves.
6. **Install.** `scripts/release/stage-mac.sh X.Y.Z` downloads the dmg and checks codesign, Gatekeeper and the notarization ticket without touching `/Applications`. Then, on "install" / "restart": run `swap-mac.sh X.Y.Z` **detached** (`nohup bash scripts/release/swap-mac.sh X.Y.Z >/dev/null 2>&1 &`), because it quits the app the session may be running in (this very session, if Lantern is running it: say so first), and read `/tmp/lantern-swap-X.Y.Z.log` after. It touches the `restore-on-launch` marker so the open chats come back by themselves (without it a script swap loses them).

## Phone (TestFlight)

1. `scripts/release/testflight-latest.sh`: newest builds and tags. Say the next number.
2. **Before the first build with a new native target, capability or entitlement** (an extension, a keychain group), run the signing dry run: in the `lantern-wt/testflight` worktree on `origin/main`, `npm ci --ignore-scripts`, then `fastlane ios archive` from `mobile/` (source `scripts/release/asc.sh` AFTER checking out `origin/main`, since the worktree may be on an older commit without it). It builds and signs and uploads nothing; it does register a missing App ID and make its profile. Then unzip `mobile/build/Lantern.ipa` into a new empty folder and compare, for the app and each `PlugIns/*.appex`, `CFBundleShortVersionString` and `CFBundleVersion` (`/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" X/Info.plist`) and the entitlements (`codesign -d --entitlements :- X`). They must agree (an extension that disagrees with its app is refused at upload) and an extension must hold only the keychain groups it needs.
3. On the user's typed "testflight" / "admin testflight": `scripts/release/testflight.sh` in the background (about 7 minutes). It builds from a fresh `origin/main` in `<parent of the repo>/lantern-wt/testflight`, so merge first what should be in the build. Run from a worktree it builds in a nested `lantern-wt/lantern-wt/testflight`: that works, and the nested folder is a worktree to remove afterwards. If the session ended while it ran, its log (`/tmp/lantern-testflight.log`) just stops mid-compile and no build exists: check `testflight-latest.sh`, then run it again.
4. `scripts/release/testflight-compliance.sh N` waits until Apple has processed the build and answers the export question (standard Noise encryption, no extra declaration).
5. The lane tagged the build locally (`mobile-build-0.1.0-N`). Ask, then `git push origin mobile-build-0.1.0-N` (from the worktree that has the tag), so the next build counts from it. Aly is the only internal tester and builds reach their phone by themselves.
6. The phone side of a feature that needs the Mac (a new request or push) also needs the Mac release above; say so. After installing a build with a keychain or entitlement change, the first thing to check on the phone is that it still knows its Mac.

Apple sometimes answers the upload's checksum with a 500: rerun. Signing uses the App Store Connect API key (the lane makes its own profiles, and `ensure_app_id` registers an App ID the account lacks); the App Group is a manual step in the developer portal if it ever needs to change.

## After

Remove finished worktrees and local branches (`git worktree remove --force`, `git branch -D`; a squash-merged branch needs `-D`), and the remote branches once the user approves. Note in the brain what shipped if it was not obvious from the git log.
