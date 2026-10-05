import { describe, expect, it } from "vitest";
import { mattersToTask } from "./commands";

describe("mattersToTask", () => {
  it("keeps commands that change or check the project", () => {
    for (const c of [
      "npm install zod",
      "npm test -- retry",
      "cargo test --manifest-path src-tauri/Cargo.toml",
      "python manage.py migrate",
      "cd app && pnpm build",
      "npx prisma generate",
      "git apply fix.patch",
      "git -C /p pull --rebase",
      "gh api repos/o/r/pulls/1/comments -f body=hi",
      "gh pr create --fill",
      "cat > src/a.ts <<'EOF'\nexport const a = 1;\nEOF",
      "python3 - <<'EOF'\nopen('a.ts', 'w').write('x')\nEOF",
      "for f in a b; do npm test -- $f; done",
      "curl -X POST http://localhost:3000/seed",
      "sed -i '' 's/a/b/' src/a.ts",
      "echo 'X=1' > .env",
      "FOO=1 sudo make install",
      "xcodebuild test -scheme App 2>&1 | tail -20",
      "rm -rf dist",
    ])
      expect(mattersToTask(c), c).toBe(true);
  });

  it("leaves out looking around, git bookkeeping and GitHub lookups", () => {
    for (const c of [
      "cd src",
      "ls -la",
      "cat src/a.ts | head -20",
      "grep -rn fetchJson src",
      "git status",
      "git -C /p diff --stat",
      "git log --oneline -5",
      "sed -n 1,40p src/a.ts",
      "find . -name '*.ts' | wc -l",
      "which node",
      "echo done",
      "ls 2>/dev/null",
      "cat a.txt 2>&1",
      // git bookkeeping
      "git commit -m 'add retries'",
      "git -C /Users/me/app add src/a.ts",
      "git checkout -b feat/retry",
      "git -C /p switch -c feature/x main",
      "git stash push -m 'noise' Podfile.lock",
      "git push -u origin HEAD",
      "git fetch origin",
      "git -C /p commit -F - <<'EOF'\nchore: add changeset\n\nRefs #153\nEOF",
      'git -C /p commit -q -m "feat: a \\"quoted\\" title\n\nA body line.\n\nCo-Authored-By: Claude <c@a.com>" src/a.ts',
      // GitHub lookups
      'PATH="/opt/homebrew/bin:$PATH" gh pr view 492 --json number,title --jq \'"#\\(.number) \\(.title)"\'',
      "gh pr diff 492 --patch 2>/dev/null | awk '/^diff --git/{f=1} f' | head -80",
      "gh issue view 153 -R PostHog/posthog-ios --json comments --jq '.comments[-2:][] | .author.login'",
      "gh api repos/o/r/pulls/492/comments --paginate --jq '.[] | .path'",
      "gh api repos/o/r/commits -X GET -f path=a.swift",
      "gh search issues --repo PostHog/posthog 'mobile OR iOS'",
      'for n in 1 2; do echo "=== PR $n"; gh pr view $n --json reviews; done',
      // Quoted text isn't a pipe or a redirect.
      'grep -n "=> {" src/a.ts',
      "printf '%s > %s\\n' a b",
      "export PATH=/opt/homebrew/bin:$PATH; which gh",
      "curl -s http://localhost:3000/health",
      "docker ps",
      "/usr/bin/time -p git -C /p status --porcelain=v1 | tail -4",
      "gh pr diff 492 --patch | git apply --numstat -",
    ])
      expect(mattersToTask(c), c).toBe(false);
  });
});
