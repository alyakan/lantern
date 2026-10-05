//! A GitHub pull request's changes, for the Changes pane while a PR is reviewed: its files compared with where it
//! branched from its base. `gh` names the base branch and head commit; `git fetch` brings both in (into FETCH_HEAD
//! only: nothing is checked out and no branch moves); the files are then read from git.

use crate::changes::{ChangeSummary, FileDiff};
use std::path::{Path, PathBuf};
use std::process::Command;

/// A PR as two commits: where it branched from its base, and its head.
#[derive(Clone, Debug, PartialEq)]
pub struct PrRange {
    pub base: String,
    pub head: String,
    /// The repository's top folder; PR paths are relative to it.
    pub root: PathBuf,
}

fn run(folder: &Path, program: &str, args: &[&str], path_env: Option<&str>) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new(program);
    cmd.current_dir(folder).args(args);
    if let Some(path) = path_env {
        cmd.env("PATH", path);
    }
    let out = cmd.output().map_err(|e| format!("Couldn't run {program}: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("it failed");
        return Err(format!("{program} {}: {line}", args.first().copied().unwrap_or("")));
    }
    Ok(out.stdout)
}

fn git(folder: &Path, args: &[&str]) -> Result<String, String> {
    run(folder, "git", args, None).map(|o| String::from_utf8_lossy(&o).trim().to_string())
}

/**
 * The repository a review is in. Usually the open folder's; when the folder only holds repositories (a workspace of
 * several), the one with the reviewed files (`hints`, paths relative to a repository), else the one whose branch has
 * commits of its own.
 */
pub fn repo_for(folder: &Path, hints: &[String]) -> Result<PathBuf, String> {
    if let Ok(root) = git(folder, &["rev-parse", "--show-toplevel"]) {
        return Ok(PathBuf::from(root));
    }
    let mut repos: Vec<PathBuf> = std::fs::read_dir(folder).map_err(|e| e.to_string())?.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.join(".git").exists()).collect();
    repos.sort();
    let not_a_repo = || format!("{} isn't in a git repository.", folder.display());
    if repos.is_empty() {
        return Err(not_a_repo());
    }
    // A hint is a path in the repository (from a file page) or an absolute path Claude used (git -C <repo> log).
    let holds = |repo: &PathBuf| hints.iter().filter(|h| if Path::new(h).is_absolute() { Path::new(h).starts_with(repo) } else { repo.join(h).exists() }).count();
    if let Some(best) = repos.iter().filter(|r| holds(r) > 0).max_by_key(|r| holds(r)) {
        return Ok(best.clone());
    }
    let ahead = |repo: &PathBuf| default_base(repo).and_then(|base| git(repo, &["rev-list", "--count", &format!("{base}..HEAD")])).is_ok_and(|n| n != "0");
    Ok(repos.iter().find(|r| ahead(r)).unwrap_or(&repos[0]).clone())
}

/// Looks the PR up with `gh` and fetches it and its base from `origin`.
pub fn resolve(folder: &Path, number: u32, path_env: Option<&str>) -> Result<PrRange, String> {
    let view = run(folder, "gh", &["pr", "view", &number.to_string(), "--json", "baseRefName,headRefOid"], path_env)?;
    let view: serde_json::Value = serde_json::from_slice(&view).map_err(|e| format!("gh pr view: {e}"))?;
    let base_branch = view["baseRefName"].as_str().ok_or("gh didn't name the PR's base branch.")?;
    git(folder, &["fetch", "--quiet", "--no-tags", "origin", &format!("refs/heads/{base_branch}")])?;
    let base_tip = git(folder, &["rev-parse", "FETCH_HEAD"])?;
    git(folder, &["fetch", "--quiet", "--no-tags", "origin", &format!("refs/pull/{number}/head")])?;
    let head = git(folder, &["rev-parse", "FETCH_HEAD"])?;
    between(folder, &base_tip, &head)
}

/// The range from where `head` branched off `base_tip` to `head`.
pub fn between(folder: &Path, base_tip: &str, head: &str) -> Result<PrRange, String> {
    let root = PathBuf::from(git(folder, &["rev-parse", "--show-toplevel"])?);
    let base = git(folder, &["merge-base", base_tip, head])?;
    Ok(PrRange { base, head: head.to_string(), root })
}

/// A local branch under review: its commits since it left the default branch, and the range they span.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct BranchReview {
    pub branch: String,
    /// What it's compared with: "origin/main", "main", …
    pub base: String,
    /// Newest first.
    pub commits: Vec<Commit>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Commit {
    pub sha: String,
    pub subject: String,
    pub author: String,
    /// ms since the epoch
    pub at: u64,
}

/// The default branch to compare with: origin's HEAD, else origin/main or origin/master, else a local main/master.
fn default_base(folder: &Path) -> Result<String, String> {
    if let Ok(r) = git(folder, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]) {
        return Ok(r);
    }
    for candidate in ["origin/main", "origin/master", "main", "master", "origin/develop", "develop"] {
        if git(folder, &["rev-parse", "--verify", "--quiet", &format!("{candidate}^{{commit}}")]).is_ok() {
            return Ok(candidate.into());
        }
    }
    Err("No main or master branch to compare this branch with.".into())
}

/// The checked-out branch against where it left the default branch: the range, and the branch's commits.
pub fn branch(folder: &Path, hints: &[String]) -> Result<(PrRange, BranchReview), String> {
    let repo = repo_for(folder, hints)?;
    let folder = repo.as_path();
    let name = git(folder, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let base = default_base(folder)?;
    let head = git(folder, &["rev-parse", "HEAD"])?;
    let range = between(folder, &base, &head)?;
    if range.base == head {
        return Err(format!("{name} has no commits of its own since {base}."));
    }
    let log = git(folder, &["log", "--no-merges", "--format=%h%x1f%s%x1f%an%x1f%ct", &format!("{}..{}", range.base, head)])?;
    let commits = log
        .lines()
        .filter_map(|l| {
            let mut f = l.split('\u{1f}');
            Some(Commit { sha: f.next()?.into(), subject: f.next()?.into(), author: f.next()?.into(), at: f.next()?.parse::<u64>().ok()? * 1000 })
        })
        .collect();
    Ok((range, BranchReview { branch: name, base, commits }))
}

/// The PR's files: (absolute path, created, deleted, lines added, lines removed), by path.
pub fn summary(range: &PrRange) -> Result<Vec<ChangeSummary>, String> {
    let root = &range.root;
    let status = git(root, &["diff", "--name-status", "-z", "--no-renames", &range.base, &range.head])?;
    let numstat = git(root, &["diff", "--numstat", "-z", "--no-renames", &range.base, &range.head])?;
    let mut counts = std::collections::HashMap::new();
    for record in numstat.split('\0').filter(|r| !r.is_empty()) {
        let mut f = record.splitn(3, '\t');
        if let (Some(a), Some(r), Some(p)) = (f.next(), f.next(), f.next()) {
            counts.insert(p.to_string(), (a.parse().unwrap_or(0), r.parse().unwrap_or(0)));
        }
    }
    let mut fields = status.split('\0').filter(|f| !f.is_empty());
    let mut out = vec![];
    while let (Some(code), Some(path)) = (fields.next(), fields.next()) {
        let (added, removed) = counts.get(path).copied().unwrap_or((0, 0));
        out.push(ChangeSummary { path: root.join(path).display().to_string(), created: code == "A", deleted: code == "D", added, removed });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// One file of the PR, as it was at the base and as the PR has it.
pub fn file(range: &PrRange, path: &str) -> Result<FileDiff, String> {
    let rel = Path::new(path).strip_prefix(&range.root).map_err(|_| "That file isn't in this repository.")?.to_string_lossy().into_owned();
    let show = |commit: &str| run(&range.root, "git", &["show", &format!("{commit}:{rel}")], None).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
    let (original, current) = (show(&range.base), show(&range.head));
    Ok(FileDiff { path: path.to_string(), created: original.is_none(), deleted: current.is_none(), original: original.unwrap_or_default(), current: current.unwrap_or_default() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn reads_a_branchs_files_against_where_it_left_its_base() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        sh(d, &["init", "-q", "-b", "main"]);
        sh(d, &["config", "user.email", "t@t"]);
        sh(d, &["config", "user.name", "t"]);
        std::fs::write(d.join("a.txt"), "one\n").unwrap();
        std::fs::write(d.join("gone.txt"), "bye\n").unwrap();
        sh(d, &["add", "."]);
        sh(d, &["commit", "-qm", "init"]);
        sh(d, &["checkout", "-qb", "pr"]);
        std::fs::write(d.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(d.join("new.txt"), "hi\n").unwrap();
        std::fs::remove_file(d.join("gone.txt")).unwrap();
        sh(d, &["add", "-A"]);
        sh(d, &["commit", "-qm", "pr"]);
        let head = sh(d, &["rev-parse", "HEAD"]);
        // The base moves on after the PR branched: its new file isn't the PR's.
        sh(d, &["checkout", "-q", "main"]);
        std::fs::write(d.join("later.txt"), "later\n").unwrap();
        sh(d, &["add", "."]);
        sh(d, &["commit", "-qm", "later"]);

        // The same branch checked out, reviewed as a local branch against main.
        sh(d, &["checkout", "-q", "pr"]);
        let (local, review) = branch(d, &[]).unwrap();
        assert_eq!((review.branch.as_str(), review.base.as_str()), ("pr", "main"));
        assert_eq!(review.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["pr"]);
        assert_eq!(summary(&local).unwrap().len(), 3);
        sh(d, &["checkout", "-q", "main"]);
        assert!(branch(d, &[]).unwrap_err().contains("no commits of its own"));
        sh(d, &["checkout", "-q", "pr"]);

        // A workspace folder holding this repo and another: the branch is found in the repo with the reviewed file.
        let ws = tempfile::tempdir().unwrap();
        let other = ws.path().join("other");
        std::fs::create_dir(&other).unwrap();
        sh(&other, &["init", "-q", "-b", "main"]);
        std::os::unix::fs::symlink(d, ws.path().join("app")).unwrap();
        assert_eq!(repo_for(ws.path(), &["new.txt".into()]).unwrap(), ws.path().join("app"));
        assert_eq!(repo_for(ws.path(), &[]).unwrap(), ws.path().join("app"), "the repo whose branch has commits");
        let used = ws.path().join("other").join("src").display().to_string();
        assert_eq!(repo_for(ws.path(), &[used]).unwrap(), other, "an absolute path Claude used");
        assert_eq!(branch(ws.path(), &["new.txt".into()]).unwrap().1.branch, "pr");
        sh(d, &["checkout", "-q", "main"]);

        let range = between(d, "main", &head).unwrap();
        let root = range.root.clone();
        let rows = summary(&range).unwrap();
        let brief: Vec<_> = rows.iter().map(|r| (r.path.strip_prefix(&*root.display().to_string()).unwrap().to_string(), r.created, r.deleted, r.added, r.removed)).collect();
        assert_eq!(brief, [("/a.txt".into(), false, false, 1, 0), ("/gone.txt".into(), false, true, 0, 1), ("/new.txt".into(), true, false, 1, 0)]);
        let a = file(&range, &root.join("a.txt").display().to_string()).unwrap();
        assert_eq!((a.original.as_str(), a.current.as_str()), ("one\n", "one\ntwo\n"));
        assert!(file(&range, &root.join("new.txt").display().to_string()).unwrap().created);
        assert!(file(&range, "/elsewhere/x.txt").is_err());
    }

    /// LANTERN_PR="folder:number" cargo test real_pr -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_pr() {
        let spec = std::env::var("LANTERN_PR").unwrap();
        let (folder, n) = spec.rsplit_once(':').unwrap();
        let t = std::time::Instant::now();
        let range = resolve(Path::new(folder), n.parse().unwrap(), None).unwrap();
        let rows = summary(&range).unwrap();
        println!("{:?} in {:?}", range, t.elapsed());
        for r in &rows {
            println!("{} +{} -{} created={} deleted={}", r.path, r.added, r.removed, r.created, r.deleted);
        }
        assert!(!rows.is_empty());
    }

    /// LANTERN_BRANCH=folder cargo test real_branch -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_branch() {
        let folder = std::env::var("LANTERN_BRANCH").unwrap();
        let (range, review) = branch(Path::new(&folder), &[]).unwrap();
        println!("{} vs {}: {:?}", review.branch, review.base, review.commits);
        for r in summary(&range).unwrap() {
            println!("{} +{} -{}", r.path, r.added, r.removed);
        }
    }
}
