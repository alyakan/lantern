---
name: lantern-release
description: Ship Lantern: the Mac release (version PR, tag, signed draft, publish, install and restore chats) and the phone's TestFlight build. Use when the user says "release", "publish", "install and restart", "testflight", "admin merge" on a version PR, or asks to ship, upload or install a build.
---

# Releasing Lantern

Two independent tracks. The scripts are in `scripts/release/` (they take the version or build number as an argument; nothing is hard-coded to a release). Run each as its own Bash call: a hook in this setup blocks `&&`, `;` and `||` chains.

## The rules that hold for both

- **Merges, tag pushes, publishes and uploads need the user's go-ahead.** They type it as a message of its own ("admin merge", "admin testflight", "publish"). One typed while you are mid-turn, and a `request_approval` card on its own, did not satisfy the auto-mode classifier for an upload. Ask with `mcp__lantern__request_approval` before each push of a branch or tag, and say what is pushed.
- Never print a key. The App Store Connect key id and issuer live in `~/.appstoreconnect/lantern.env` and the `.p8` in `~/.appstoreconnect/private_keys`; the Developer ID and notarization secrets are in the repo's GitHub secrets.
- Other sessions ship too. Look at the newest build and tag before you name a number ("the newest is 23, so this is 24"), and `git fetch origin --tags` first.
- Run npm and fastlane under Node 24 (`source ~/.nvm/nvm.sh; nvm use 24`): the default Node skips the rolldown binding.

## Mac release

1. **Version PR.** New worktree from `origin/main` on `release/X.Y.Z`; `node scripts/release/bump-version.mjs X.Y.Z` (five files: package.json, package-lock.json, Cargo.toml, Cargo.lock, tauri.conf.json); commit `chore: release X.Y.Z`; ask, push, open the PR. Its body names the version bump and says what ships (read `git log vPREV..origin/main --oneline`). Say that the Mac side of anything phone-related is what needs the release.
2. **Wait for checks** (`gh pr checks N --watch`, about 12 minutes), then merge with `gh pr merge N --admin --squash --delete-branch` once the user has said "admin merge" (they may say "after checks").
3. **Tag.** `git fetch origin`, `git tag -a vX.Y.Z <the release commit on main> -m "Lantern X.Y.Z"`, ask, `git push origin vX.Y.Z`. That starts `release.yml`, which builds a signed, notarized dmg into a **draft** release.
4. **Wait for the build** with `scripts/release/wait-release.sh X.Y.Z` (run it in the background).
5. **Publish** the draft (`gh release edit vX.Y.Z --draft=false`) only on the user's "publish"; the classifier denies it otherwise, in which case ask them to publish it themselves.
6. **Install.** `scripts/release/stage-mac.sh X.Y.Z` downloads the dmg and checks codesign, Gatekeeper and the notarization ticket without touching `/Applications`. Then, on "install" / "restart": run `swap-mac.sh X.Y.Z` **detached** (`nohup bash scripts/release/swap-mac.sh X.Y.Z >/dev/null 2>&1 &`), because it quits the app the session may be running in, and read `/tmp/lantern-swap-X.Y.Z.log` after. It touches the `restore-on-launch` marker so the open chats come back by themselves (without it a script swap loses them).

## Phone (TestFlight)

1. `scripts/release/testflight-latest.sh`: newest builds and tags. Say the next number.
2. On the user's typed "testflight" / "admin testflight": `scripts/release/testflight.sh` in the background (about 7 minutes). It builds from a fresh `origin/main` in `lantern-wt/testflight`, so merge first what should be in the build.
3. `scripts/release/testflight-compliance.sh N` waits until Apple has processed the build and answers the export question (standard Noise encryption, no extra declaration).
4. The lane tagged the build locally (`mobile-build-0.1.0-N`). Ask, then `git push origin mobile-build-0.1.0-N`, so the next build counts from it. Aly is the only internal tester and builds reach their phone by themselves.
5. The phone side of a feature that needs the Mac (a new request or push) also needs the Mac release above; say so.

Apple sometimes answers the upload's checksum with a 500: rerun. Signing uses the App Store Connect API key (the lane makes its own profiles); the App Group is a manual step in the developer portal if it ever needs to change.

## After

Remove finished worktrees and local branches (`git worktree remove --force`, `git branch -D`), and note in the brain what shipped if it was not obvious from the git log.
