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

/// An open pull request, as the start screen's picker lists it.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct OpenPr {
    pub number: u32,
    pub title: String,
    pub author: String,
    pub branch: String,
    pub draft: bool,
}

/// What `gh pr list --json number,title,author,headRefName,isDraft` printed, as the picker shows it. Newest first, as gh has them.
pub fn parse_open_prs(json: &[u8]) -> Result<Vec<OpenPr>, String> {
    let list: Vec<serde_json::Value> = serde_json::from_slice(json).map_err(|e| format!("gh pr list: {e}"))?;
    Ok(list
        .iter()
        .filter_map(|pr| {
            Some(OpenPr {
                number: u32::try_from(pr["number"].as_u64()?).ok()?,
                title: pr["title"].as_str().unwrap_or("").to_string(),
                author: pr["author"]["login"].as_str().unwrap_or("").to_string(),
                branch: pr["headRefName"].as_str().unwrap_or("").to_string(),
                draft: pr["isDraft"].as_bool().unwrap_or(false),
            })
        })
        .collect())
}

/// What to tell the user when `gh pr list` couldn't list: gh isn't installed, isn't logged in, or the folder isn't a
/// GitHub repository. Anything else gets gh's own first line.
pub fn list_error(spawn_error: Option<&std::io::Error>, stderr: &str) -> String {
    if spawn_error.is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return "The GitHub CLI (gh) isn't installed. Install it from cli.github.com, then run `gh auth login` in a terminal.".to_string();
    }
    let lower = stderr.to_lowercase();
    if lower.contains("gh auth login") || lower.contains("not logged in") || lower.contains("authentication") {
        return "gh isn't logged in to GitHub. Run `gh auth login` in a terminal, then try again.".to_string();
    }
    if lower.contains("not a git repository") || lower.contains("no git remotes") || lower.contains("known github host") || lower.contains("could not determine base repo") {
        return "This folder isn't a GitHub repository, so there are no pull requests to list.".to_string();
    }
    let line = stderr.lines().map(str::trim).find(|l| !l.is_empty());
    match (spawn_error, line) {
        (Some(e), _) => format!("Couldn't run gh: {e}"),
        (None, Some(line)) => format!("gh couldn't list the pull requests: {line}"),
        (None, None) => "gh couldn't list the pull requests.".to_string(),
    }
}

/// The folder's repository's open pull requests, from `gh pr list`.
pub fn open_prs(folder: &Path, path_env: Option<&str>) -> Result<Vec<OpenPr>, String> {
    let mut cmd = Command::new("gh");
    cmd.current_dir(folder).args(["pr", "list", "--state", "open", "--limit", "30", "--json", "number,title,author,headRefName,isDraft"]);
    if let Some(path) = path_env {
        cmd.env("PATH", path);
    }
    match cmd.output() {
        Err(e) => Err(list_error(Some(&e), "")),
        Ok(out) if !out.status.success() => Err(list_error(None, &String::from_utf8_lossy(&out.stderr))),
        Ok(out) => parse_open_prs(&out.stdout),
    }
}

/// Looks the PR up with `gh` and fetches it and its base from the remote of the repository `gh` resolved it in: a
/// fork's `refs/pull/N/head` is in the base repository, not in the fork's origin.
pub fn resolve(folder: &Path, number: u32, path_env: Option<&str>) -> Result<PrRange, String> {
    let view = run(folder, "gh", &["pr", "view", &number.to_string(), "--json", "baseRefName,headRefOid,url"], path_env)?;
    let view: serde_json::Value = serde_json::from_slice(&view).map_err(|e| format!("gh pr view: {e}"))?;
    let base_branch = view["baseRefName"].as_str().ok_or("gh didn't name the PR's base branch.")?;
    let remote = remote_for(folder, view["url"].as_str());
    git(folder, &["fetch", "--quiet", "--no-tags", &remote, &format!("refs/heads/{base_branch}")])?;
    let base_tip = git(folder, &["rev-parse", "FETCH_HEAD"])?;
    git(folder, &["fetch", "--quiet", "--no-tags", &remote, &format!("refs/pull/{number}/head")])?;
    let head = git(folder, &["rev-parse", "FETCH_HEAD"])?;
    between(folder, &base_tip, &head)
}

/// "owner/repo" (lowercase) from a GitHub URL, https or ssh: `https://github.com/o/r/pull/3`, `git@github.com:o/r.git`.
fn github_repo(url: &str) -> Option<String> {
    let rest = url.trim().split_once("github.com")?.1.trim_start_matches(['/', ':']);
    let mut parts = rest.split('/');
    let (owner, repo) = (parts.next()?, parts.next()?.trim_end_matches(".git"));
    (!owner.is_empty() && !repo.is_empty()).then(|| format!("{owner}/{repo}").to_lowercase())
}

/// The remote that points at the repository `pr_url` is in, else origin.
fn remote_for(folder: &Path, pr_url: Option<&str>) -> String {
    let Some(repo) = pr_url.and_then(github_repo) else { return "origin".into() };
    let names = git(folder, &["remote"]).unwrap_or_default();
    names.lines().find(|name| git(folder, &["remote", "get-url", name]).ok().and_then(|u| github_repo(&u)).as_deref() == Some(repo.as_str())).unwrap_or("origin").to_string()
}

/// The range from where `head` branched off `base_tip` to `head`.
pub fn between(folder: &Path, base_tip: &str, head: &str) -> Result<PrRange, String> {
    let root = PathBuf::from(git(folder, &["rev-parse", "--show-toplevel"])?);
    let base = git(folder, &["merge-base", base_tip, head])?;
    Ok(PrRange { base, head: head.to_string(), root })
}

/// A local branch under review: its commits since it left its base, and the range they span.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct BranchReview {
    pub branch: String,
    /// What it's compared with: the branch it is stacked on ("feat/core"), or the default branch ("origin/main", "main").
    pub base: String,
    /// Why it isn't the base the reviewer named, when it couldn't be used.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
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

/// A branch name the reviewer gave that can be handed to git: no option, no range, nothing but a ref's characters.
fn ref_name(name: &str) -> Option<&str> {
    let name = name.trim().trim_matches('`');
    let ok = !name.is_empty() && name.len() <= 200 && !name.starts_with('-') && !name.contains("..") && name.chars().all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c));
    ok.then_some(name)
}

/// Whether `name` is a commit-ish here.
fn exists(folder: &Path, name: &str) -> bool {
    git(folder, &["rev-parse", "--verify", "--quiet", &format!("{name}^{{commit}}")]).is_ok()
}

/**
 * The branch HEAD is stacked on: the nearest branch tip in HEAD's own (first-parent) history, before it reaches where
 * it left the default branch. None when it was cut straight from the default branch. The branch itself (and its own
 * copy on the remote) doesn't count, nor does a branch at HEAD's own commit.
 */
fn stacked_on(folder: &Path, name: &str, head: &str, default: &str) -> Option<String> {
    let stop = git(folder, &["merge-base", default, head]).ok()?;
    // Every branch whose tip is in HEAD's history, by its commit.
    let refs = git(folder, &["for-each-ref", "--merged", head, "--format=%(objectname) %(refname:short)", "refs/heads", "refs/remotes"]).ok()?;
    let own = |r: &str| r == name || r.split_once('/').is_some_and(|(_, rest)| rest == name) || r.ends_with("/HEAD") || r == default;
    let mut at: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
    for line in refs.lines() {
        if let Some((sha, r)) = line.split_once(' ') {
            if sha != head && !own(r) {
                at.entry(sha).or_default().push(r);
            }
        }
    }
    if at.is_empty() {
        return None;
    }
    let walk = git(folder, &["rev-list", "--first-parent", "--max-count=2000", head]).ok()?;
    for sha in walk.lines().skip(1) {
        if sha == stop {
            return None;
        }
        if let Some(names) = at.get(sha) {
            // A local branch before its copy on a remote.
            let mut names = names.clone();
            names.sort_by_key(|r| (r.contains('/') && !exists(folder, &format!("refs/heads/{r}")), r.len()));
            return names.first().map(|r| r.to_string());
        }
    }
    None
}

/**
 * The checked-out branch against where it left its base, with the branch's commits. The base is `asked` when the
 * reviewer named one that is a branch here (or on origin); otherwise the branch it is stacked on; otherwise the default
 * branch.
 */
pub fn branch(folder: &Path, hints: &[String], asked: Option<&str>) -> Result<(PrRange, BranchReview), String> {
    let repo = repo_for(folder, hints)?;
    let folder = repo.as_path();
    let name = git(folder, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let head = git(folder, &["rev-parse", "HEAD"])?;
    let default = default_base(folder)?;
    let mut note = None;
    let named = asked.map(str::trim).filter(|a| !a.is_empty());
    let base = match named {
        Some(a) => match ref_name(a).and_then(|r| [r.to_string(), format!("origin/{r}")].into_iter().find(|c| exists(folder, c))) {
            Some(found) => found,
            None => {
                let fallback = stacked_on(folder, &name, &head, &default).unwrap_or_else(|| default.clone());
                note = Some(format!("Couldn't find the base {a:?}; comparing with {fallback}."));
                fallback
            }
        },
        None => stacked_on(folder, &name, &head, &default).unwrap_or_else(|| default.clone()),
    };
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
    Ok((range, BranchReview { branch: name, base, note, commits }))
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
    fn lists_open_prs_from_gh_json() {
        let json = br#"[{"number": 12, "title": "Add search", "author": {"login": "ada"}, "headRefName": "feat/search", "isDraft": false},
                         {"number": 9, "title": "WIP", "author": {"login": "bob"}, "headRefName": "wip", "isDraft": true}]"#;
        let prs = parse_open_prs(json).unwrap();
        assert_eq!(prs.len(), 2);
        assert_eq!((prs[0].number, prs[0].title.as_str(), prs[0].author.as_str(), prs[0].branch.as_str(), prs[0].draft), (12, "Add search", "ada", "feat/search", false));
        assert!(prs[1].draft);
        assert!(parse_open_prs(b"[]").unwrap().is_empty());
        assert!(parse_open_prs(b"not json").is_err());
    }

    #[test]
    fn says_why_gh_could_not_list() {
        let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(list_error(Some(&missing), "").contains("isn't installed"));
        assert!(list_error(None, "To get started with GitHub CLI, please run:  gh auth login").contains("isn't logged in"));
        assert!(list_error(None, "none of the git remotes configured for this repository point to a known GitHub host").contains("isn't a GitHub repository"));
        assert!(list_error(None, "\nrate limited\n").contains("rate limited"));
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
        let (local, review) = branch(d, &[], None).unwrap();
        assert_eq!((review.branch.as_str(), review.base.as_str()), ("pr", "main"));
        assert_eq!(review.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["pr"]);
        assert_eq!(summary(&local).unwrap().len(), 3);
        sh(d, &["checkout", "-q", "main"]);
        assert!(branch(d, &[], None).unwrap_err().contains("no commits of its own"));
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
        assert_eq!(branch(ws.path(), &["new.txt".into()], None).unwrap().1.branch, "pr");
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

    /// main ← core (2 commits) ← ui (1 commit), with main moving on after core left it.
    fn stack() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let commit = |file: &str, msg: &str| {
            std::fs::write(d.join(file), msg).unwrap();
            sh(d, &["add", "."]);
            sh(d, &["commit", "-qm", msg]);
        };
        sh(d, &["init", "-q", "-b", "main"]);
        sh(d, &["config", "user.email", "t@t"]);
        sh(d, &["config", "user.name", "t"]);
        commit("a.txt", "init");
        sh(d, &["checkout", "-qb", "feat/core"]);
        commit("core1.txt", "core one");
        commit("core2.txt", "core two");
        sh(d, &["checkout", "-qb", "feat/ui"]);
        commit("ui.txt", "ui");
        sh(d, &["checkout", "-q", "main"]);
        commit("later.txt", "later on main");
        sh(d, &["checkout", "-q", "feat/ui"]);
        dir
    }
    fn subjects(r: &BranchReview) -> Vec<String> {
        r.commits.iter().map(|c| c.subject.clone()).collect()
    }

    #[test]
    fn a_stacked_branch_is_compared_with_the_branch_it_was_built_on() {
        let dir = stack();
        let (range, review) = branch(dir.path(), &[], None).unwrap();
        assert_eq!((review.base.as_str(), review.note.as_deref()), ("feat/core", None));
        assert_eq!(subjects(&review), ["ui"]);
        let files: Vec<_> = summary(&range).unwrap().into_iter().map(|f| f.path.rsplit('/').next().unwrap().to_string()).collect();
        assert_eq!(files, ["ui.txt"]);
        // The branch below it, cut straight from main, is compared with main.
        sh(dir.path(), &["checkout", "-q", "feat/core"]);
        let (_, core) = branch(dir.path(), &[], None).unwrap();
        assert_eq!((core.base.as_str(), subjects(&core)), ("main", vec!["core two".to_string(), "core one".to_string()]));
    }

    #[test]
    fn the_base_the_reviewer_names_wins_and_one_that_isnt_there_says_so() {
        let dir = stack();
        // Named: main, so the whole stack is the review.
        let (_, review) = branch(dir.path(), &[], Some("main")).unwrap();
        assert_eq!((review.base.as_str(), review.commits.len(), review.note.as_deref()), ("main", 3, None));
        // In backticks, as Claude may write it.
        assert_eq!(branch(dir.path(), &[], Some("`feat/core`")).unwrap().1.base, "feat/core");
        // A branch that isn't there, or isn't a branch name at all: the stack's own base, and a note.
        for bad in ["feat/gone", "--output=/tmp/x", "main..feat/ui"] {
            let (_, r) = branch(dir.path(), &[], Some(bad)).unwrap();
            assert_eq!(r.base, "feat/core", "{bad}");
            assert!(r.note.as_deref().unwrap().contains("Couldn't find the base"), "{bad}");
        }
    }

    #[test]
    fn a_branch_on_the_remote_counts_and_the_branch_itself_does_not() {
        let dir = stack();
        let d = dir.path();
        // Only the remote copy of the parent is there: it is the base.
        sh(d, &["update-ref", "refs/remotes/origin/feat/core", "feat/core"]);
        sh(d, &["update-ref", "refs/remotes/origin/feat/ui", "feat/ui~0"]);
        sh(d, &["branch", "-qD", "feat/core"]);
        assert_eq!(branch(d, &[], None).unwrap().1.base, "origin/feat/core");
        // Its own copy on the remote, a step behind, isn't its base.
        sh(d, &["update-ref", "refs/remotes/origin/feat/ui", "feat/ui~1"]);
        sh(d, &["update-ref", "-d", "refs/remotes/origin/feat/core"]);
        assert_eq!(branch(d, &[], None).unwrap().1.base, "main");
    }

    #[test]
    fn fetches_from_the_remote_of_the_repository_gh_resolved_the_pr_in() {
        assert_eq!(github_repo("https://github.com/Acme/App/pull/3").as_deref(), Some("acme/app"));
        assert_eq!(github_repo("git@github.com:me/app.git\n").as_deref(), Some("me/app"));
        assert_eq!(github_repo("https://gitlab.com/me/app"), None);
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        sh(d, &["init", "-q", "-b", "main"]);
        sh(d, &["remote", "add", "origin", "https://github.com/me/app.git"]);
        sh(d, &["remote", "add", "upstream", "git@github.com:acme/app.git"]);
        assert_eq!(remote_for(d, Some("https://github.com/acme/app/pull/3")), "upstream");
        assert_eq!(remote_for(d, Some("https://github.com/me/app/pull/3")), "origin");
        assert_eq!(remote_for(d, Some("https://github.com/other/app/pull/3")), "origin", "no remote for it: origin");
        assert_eq!(remote_for(d, None), "origin");
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
        let (range, review) = branch(Path::new(&folder), &[], std::env::var("LANTERN_BASE").ok().as_deref()).unwrap();
        println!("{} vs {}: {:?}", review.branch, review.base, review.commits);
        for r in summary(&range).unwrap() {
            println!("{} +{} -{}", r.path, r.added, r.removed);
        }
    }
}
