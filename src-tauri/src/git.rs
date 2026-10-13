use std::path::{Path, PathBuf};
use std::process::Command;

/// The git directory of the checkout at `folder`: `.git` itself, or (in a linked worktree, where `.git` is a file saying
/// `gitdir: <path>`) the directory that file points to.
fn git_dir(folder: &Path) -> Option<PathBuf> {
    let dot_git = folder.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let pointer = std::fs::read_to_string(&dot_git).ok()?;
    let target = Path::new(pointer.trim().strip_prefix("gitdir:")?.trim());
    let dir = if target.is_absolute() { target.to_path_buf() } else { folder.join(target) };
    dir.is_dir().then_some(dir)
}

/// Current branch of the repository at `folder`, read from `HEAD` without spawning git (in a linked worktree too).
/// Returns a short commit hash for a detached HEAD, and None when the folder isn't a git checkout.
pub fn current_branch(folder: &Path) -> Option<String> {
    let head = std::fs::read_to_string(git_dir(folder)?.join("HEAD")).ok()?;
    parse_head(&head)
}

fn parse_head(head: &str) -> Option<String> {
    let head = head.trim();
    if let Some(reference) = head.strip_prefix("ref: ") {
        return reference.strip_prefix("refs/heads/").or(Some(reference)).map(String::from);
    }
    (head.len() >= 7 && head.chars().all(|c| c.is_ascii_hexdigit())).then(|| head[..7].to_string())
}

/// Runs `git` in `dir` and returns its trimmed stdout; a failure is git's own message. Blocking: call it off the async
/// threads. Never asks for a password or opens an editor.
fn run(dir: &Path, args: &[&str], path_env: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(dir).env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", "true").stdin(std::process::Stdio::null());
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    let out = cmd.output().map_err(|e| format!("Could not run git: {e}"))?;
    let text = |b: &[u8]| String::from_utf8_lossy(b).trim().to_string();
    if out.status.success() {
        Ok(text(&out.stdout))
    } else {
        let err = text(&out.stderr);
        Err(if err.is_empty() { text(&out.stdout) } else { err })
    }
}

/// The top of the repository `folder` is in, or None when it isn't in one.
pub fn repo_root(folder: &Path, path_env: Option<&str>) -> Option<PathBuf> {
    run(folder, &["rev-parse", "--show-toplevel"], path_env).ok().filter(|p| !p.is_empty()).map(PathBuf::from)
}

/// Where `folder` is inside its repository's top ("" at the top, "packages/app/" below it).
fn prefix_in_repo(folder: &Path, path_env: Option<&str>) -> String {
    run(folder, &["rev-parse", "--show-prefix"], path_env).unwrap_or_default()
}

/// A branch or directory name from a worker's name: lowercase letters and digits joined by single dashes.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let trimmed: String = out.trim_end_matches('-').chars().take(40).collect();
    let trimmed = trimmed.trim_end_matches('-');
    if trimmed.is_empty() { "agent".into() } else { trimmed.to_string() }
}

fn branch_exists(repo: &Path, branch: &str, path_env: Option<&str>) -> bool {
    run(repo, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")], path_env).is_ok()
}

/// The linked worktree `folder` is in (or is), as a restored worker's: None when it is a main checkout (its `.git` is a
/// directory, not the file a linked worktree has) or no repository at all. The branch it started from is not known.
pub fn existing_worktree(folder: &Path, path_env: Option<&str>) -> Option<Worktree> {
    let root = repo_root(folder, path_env)?;
    if !root.join(".git").is_file() {
        return None;
    }
    let branch = current_branch(&root)?;
    Some(Worktree { folder: folder.to_path_buf(), root, branch, base: None })
}

/// A linked worktree for a worker, on a branch of its own.
#[derive(Debug, Clone, PartialEq)]
pub struct Worktree {
    /// Where the worker works: the worktree, plus the subfolder the main checkout was opened in, if it was in one.
    pub folder: PathBuf,
    /// The worktree's top, which is what `git worktree remove` takes.
    pub root: PathBuf,
    pub branch: String,
    /// The branch the main checkout was on when the worker started (None: a detached HEAD).
    pub base: Option<String>,
}

/// Creates a worktree for `name` under `parent` on a new branch `lantern/<name>` (numbered if that exists), starting
/// from the commit the main checkout is on. Work not committed yet is not in it.
pub fn add_worktree(folder: &Path, parent: &Path, name: &str, id: &str, path_env: Option<&str>) -> Result<Worktree, String> {
    let repo = repo_root(folder, path_env).ok_or("This folder isn't in a git repository, so a worker can't get a worktree of its own.")?;
    let base = current_branch(&repo).filter(|b| branch_exists(&repo, b, path_env));
    let slug = self::slug(name);
    let mut branch = format!("lantern/{slug}");
    let mut n = 1;
    while branch_exists(&repo, &branch, path_env) {
        n += 1;
        branch = format!("lantern/{slug}-{n}");
    }
    // Grouped by repository, and never onto a directory a worktree from an earlier run left behind.
    let parent = parent.join(self::slug(&repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
    let mut root = parent.join(format!("{slug}-{id}"));
    let mut n = 1;
    while root.exists() {
        n += 1;
        root = parent.join(format!("{slug}-{id}-{n}"));
    }
    std::fs::create_dir_all(&parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    let root_arg = root.to_string_lossy().to_string();
    run(&repo, &["worktree", "add", "-b", &branch, &root_arg, "HEAD"], path_env)?;
    let prefix = prefix_in_repo(folder, path_env);
    let inside = if prefix.is_empty() { root.clone() } else { root.join(prefix.trim_end_matches('/')) };
    Ok(Worktree { folder: inside, root, branch, base })
}

/// The files `dir` has changed but not committed, as `git status --porcelain` lists them.
pub fn dirty(dir: &Path, path_env: Option<&str>) -> Result<Vec<String>, String> {
    Ok(run(dir, &["status", "--porcelain"], path_env)?.lines().map(String::from).collect())
}

/// Commits everything in `dir` (so a worker's loose work isn't lost to a merge or a cleanup). Hooks are skipped: this is
/// Lantern keeping the work safe, not the worker finishing it. False when there was nothing to commit.
pub fn commit_all(dir: &Path, message: &str, path_env: Option<&str>) -> Result<bool, String> {
    run(dir, &["add", "-A"], path_env)?;
    if run(dir, &["diff", "--cached", "--quiet"], path_env).is_ok() {
        return Ok(false);
    }
    run(dir, &["commit", "--no-verify", "-m", message], path_env)?;
    Ok(true)
}

/// What a branch adds on top of `base`: the commits, and each changed file with its added and removed lines.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct BranchSummary {
    pub commits: u32,
    pub files: Vec<FileStat>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct FileStat {
    pub path: String,
    pub added: u32,
    pub removed: u32,
}

pub fn branch_summary(repo: &Path, base: &str, branch: &str, path_env: Option<&str>) -> Result<BranchSummary, String> {
    let commits = run(repo, &["rev-list", "--count", &format!("{base}..{branch}")], path_env)?.parse().unwrap_or(0);
    let numstat = run(repo, &["diff", "--numstat", &format!("{base}...{branch}")], path_env)?;
    let files = numstat
        .lines()
        .filter_map(|l| {
            let mut p = l.splitn(3, '\t');
            let (a, r, path) = (p.next()?, p.next()?, p.next()?);
            // Binary files list "-" for both.
            Some(FileStat { path: path.to_string(), added: a.parse().unwrap_or(0), removed: r.parse().unwrap_or(0) })
        })
        .collect();
    Ok(BranchSummary { commits, files })
}

#[derive(Debug, Clone, PartialEq)]
pub enum Merged {
    /// Merged into this branch.
    Into(String),
    /// Nothing was merged: these files conflict. The checkout is as it was.
    Conflicts(Vec<String>),
}

/// Merges `branch` into whatever the main checkout has checked out, with a merge commit so the branch's own commits
/// stay readable. The checkout must be clean. A conflict is undone, not left half-merged.
pub fn merge(repo: &Path, branch: &str, message: &str, path_env: Option<&str>) -> Result<Merged, String> {
    let into = current_branch(repo).ok_or("The main checkout isn't on a branch.")?;
    let dirty = dirty(repo, path_env)?;
    if !dirty.is_empty() {
        return Err(format!("The main checkout has {} uncommitted change{}; commit or stash them first, then approve the merge again.", dirty.len(), if dirty.len() == 1 { "" } else { "s" }));
    }
    match run(repo, &["merge", "--no-ff", "-m", message, branch], path_env) {
        Ok(_) => Ok(Merged::Into(into)),
        Err(e) => {
            let conflicts: Vec<String> = run(repo, &["diff", "--name-only", "--diff-filter=U"], path_env).unwrap_or_default().lines().map(String::from).collect();
            let _ = run(repo, &["merge", "--abort"], path_env);
            if conflicts.is_empty() { Err(e) } else { Ok(Merged::Conflicts(conflicts)) }
        }
    }
}

/// Removes a worktree and, when asked, its branch. `force` throws away uncommitted work and an unmerged branch.
pub fn remove_worktree(repo: &Path, root: &Path, branch: &str, delete_branch: bool, force: bool, path_env: Option<&str>) -> Result<(), String> {
    let root_arg = root.to_string_lossy().to_string();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&root_arg);
    run(repo, &args, path_env)?;
    if delete_branch {
        run(repo, &["branch", if force { "-D" } else { "-d" }, branch], path_env)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_and_detached_head() {
        assert_eq!(parse_head("ref: refs/heads/feat/new-thing\n").as_deref(), Some("feat/new-thing"));
        assert_eq!(parse_head("5909c1c8a1b2c3d4e5f60718293a4b5c6d7e8f90\n").as_deref(), Some("5909c1c"));
        assert_eq!(parse_head("garbage"), None);
    }

    #[test]
    fn reads_head_from_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(current_branch(dir.path()), None);
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        assert_eq!(current_branch(dir.path()).as_deref(), Some("main"));
    }

    #[test]
    fn a_linked_worktrees_branch_is_found_through_its_git_file() {
        let dir = tempfile::tempdir().unwrap();
        let admin = dir.path().join("main/.git/worktrees/w1");
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::write(admin.join("HEAD"), "ref: refs/heads/lantern/w1\n").unwrap();
        let wt = dir.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
        assert_eq!(current_branch(&wt).as_deref(), Some("lantern/w1"));
        // A relative pointer is read from the worktree's own folder.
        std::fs::write(wt.join(".git"), "gitdir: ../main/.git/worktrees/w1\n").unwrap();
        assert_eq!(current_branch(&wt).as_deref(), Some("lantern/w1"));
        std::fs::write(wt.join(".git"), "not a pointer\n").unwrap();
        assert_eq!(current_branch(&wt), None);
    }

    #[test]
    fn names_become_short_plain_slugs() {
        assert_eq!(slug("Login form"), "login-form");
        assert_eq!(slug("  Fix: the /api (v2)!  "), "fix-the-api-v2");
        assert_eq!(slug("日本語"), "agent");
        assert_eq!(slug(&"a".repeat(80)).len(), 40);
        assert!(!slug("--x--").starts_with('-'));
    }

    /// A repository with one commit on `main`, which needs git (every developer machine has it).
    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let g = |args: &[&str]| run(dir.path(), args, None).unwrap();
        g(&["init", "-q", "-b", "main"]);
        g(&["config", "user.email", "t@example.com"]);
        g(&["config", "user.name", "Test"]);
        g(&["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        g(&["add", "-A"]);
        g(&["commit", "-q", "-m", "first"]);
        dir
    }

    /// A directory for worktrees that outlives the statement it's made in (the OS clears /tmp).
    fn worktrees() -> PathBuf {
        tempfile::tempdir().unwrap().keep()
    }

    #[test]
    fn a_worker_gets_a_worktree_on_its_own_branch_and_a_second_of_the_same_name_gets_a_number() {
        let main = repo();
        let parent = worktrees();
        let a = add_worktree(main.path(), &parent, "Login form", "w1", None).unwrap();
        assert_eq!(a.branch, "lantern/login-form");
        assert_eq!(a.base.as_deref(), Some("main"));
        assert!(a.folder.join("a.txt").is_file());
        assert_eq!(current_branch(&a.folder).as_deref(), Some("lantern/login-form"));
        let b = add_worktree(main.path(), &parent, "Login form", "w2", None).unwrap();
        assert_eq!(b.branch, "lantern/login-form-2");
        assert_ne!(a.root, b.root);
    }

    #[test]
    fn a_worktree_that_is_already_there_is_recognised_and_a_main_checkout_is_not() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        // git names the real path (on macOS /var is /private/var), so compare real paths.
        let real = |p: &Path| std::fs::canonicalize(p).unwrap();
        let found = existing_worktree(&wt.folder, None).unwrap();
        assert_eq!((found.branch.as_str(), real(&found.root), found.base.as_deref()), ("lantern/w", real(&wt.root), None));
        // From a subfolder of it too, and the main checkout and a plain folder are not worktrees.
        std::fs::create_dir_all(wt.folder.join("sub")).unwrap();
        assert_eq!(real(&existing_worktree(&wt.folder.join("sub"), None).unwrap().root), real(&wt.root));
        assert_eq!(existing_worktree(main.path(), None), None);
        assert_eq!(existing_worktree(tempfile::tempdir().unwrap().path(), None), None);
    }

    #[test]
    fn a_directory_left_by_an_earlier_run_is_never_reused() {
        let main = repo();
        let parent = worktrees();
        let a = add_worktree(main.path(), &parent, "w", "w1", None).unwrap();
        // The next run numbers its workers from w1 again.
        let b = add_worktree(main.path(), &parent, "w", "w1", None).unwrap();
        assert_ne!(a.root, b.root);
        assert!(b.root.to_string_lossy().ends_with("-2"), "{}", b.root.display());
    }

    #[test]
    fn a_folder_outside_a_repository_gets_no_worktree() {
        let plain = tempfile::tempdir().unwrap();
        let err = add_worktree(plain.path(), &worktrees(), "x", "w1", None).unwrap_err();
        assert!(err.contains("isn't in a git repository"), "{err}");
    }

    #[test]
    fn a_folder_inside_the_repository_starts_the_worker_in_the_same_subfolder() {
        let main = repo();
        std::fs::create_dir_all(main.path().join("packages/app")).unwrap();
        std::fs::write(main.path().join("packages/app/x.txt"), "x\n").unwrap();
        run(main.path(), &["add", "-A"], None).unwrap();
        run(main.path(), &["commit", "-q", "-m", "app"], None).unwrap();
        let wt = add_worktree(&main.path().join("packages/app"), &worktrees(), "app work", "w1", None).unwrap();
        assert!(wt.folder.ends_with("packages/app"), "{}", wt.folder.display());
        assert!(wt.folder.join("x.txt").is_file());
    }

    #[test]
    fn a_worker_starts_from_the_last_commit_not_from_uncommitted_edits() {
        let main = repo();
        std::fs::write(main.path().join("a.txt"), "edited, not committed\n").unwrap();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        assert_eq!(std::fs::read_to_string(wt.folder.join("a.txt")).unwrap(), "one\n");
    }

    #[test]
    fn loose_work_is_committed_and_summarised_against_the_base() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        assert_eq!(commit_all(&wt.folder, "nothing", None), Ok(false));
        std::fs::write(wt.folder.join("b.txt"), "b1\nb2\n").unwrap();
        std::fs::write(wt.folder.join("a.txt"), "one\ntwo\n").unwrap();
        assert_eq!(dirty(&wt.folder, None).unwrap().len(), 2);
        assert_eq!(commit_all(&wt.folder, "Lantern: w", None), Ok(true));
        assert!(dirty(&wt.folder, None).unwrap().is_empty());
        let s = branch_summary(main.path(), "main", &wt.branch, None).unwrap();
        assert_eq!(s.commits, 1);
        assert_eq!(s.files, vec![FileStat { path: "a.txt".into(), added: 1, removed: 0 }, FileStat { path: "b.txt".into(), added: 2, removed: 0 }]);
    }

    #[test]
    fn an_approved_branch_is_merged_with_a_merge_commit() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        std::fs::write(wt.folder.join("b.txt"), "b\n").unwrap();
        commit_all(&wt.folder, "add b", None).unwrap();
        assert_eq!(merge(main.path(), &wt.branch, "Merge w", None), Ok(Merged::Into("main".into())));
        assert!(main.path().join("b.txt").is_file());
        assert_eq!(run(main.path(), &["log", "-1", "--format=%s"], None).unwrap(), "Merge w");
    }

    #[test]
    fn a_conflict_is_undone_and_named_rather_than_left_half_merged() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        std::fs::write(wt.folder.join("a.txt"), "worker\n").unwrap();
        commit_all(&wt.folder, "worker edit", None).unwrap();
        std::fs::write(main.path().join("a.txt"), "main\n").unwrap();
        run(main.path(), &["commit", "-q", "-am", "main edit"], None).unwrap();
        assert_eq!(merge(main.path(), &wt.branch, "Merge w", None), Ok(Merged::Conflicts(vec!["a.txt".into()])));
        assert!(dirty(main.path(), None).unwrap().is_empty(), "the checkout was left mid-merge");
        assert_eq!(std::fs::read_to_string(main.path().join("a.txt")).unwrap(), "main\n");
    }

    #[test]
    fn a_dirty_main_checkout_blocks_the_merge_with_a_reason() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        std::fs::write(wt.folder.join("b.txt"), "b\n").unwrap();
        commit_all(&wt.folder, "add b", None).unwrap();
        std::fs::write(main.path().join("a.txt"), "loose\n").unwrap();
        let err = merge(main.path(), &wt.branch, "Merge w", None).unwrap_err();
        assert!(err.contains("1 uncommitted change"), "{err}");
        assert!(!main.path().join("b.txt").exists());
    }

    #[test]
    fn removing_a_worktree_keeps_an_unmerged_branch_unless_forced() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        std::fs::write(wt.folder.join("b.txt"), "b\n").unwrap();
        commit_all(&wt.folder, "add b", None).unwrap();
        // Not merged: `branch -d` refuses, and the worktree is gone by then, so a caller sees the error and the branch.
        assert!(remove_worktree(main.path(), &wt.root, &wt.branch, true, false, None).is_err());
        assert!(!wt.root.exists());
        assert!(branch_exists(main.path(), &wt.branch, None));
        run(main.path(), &["branch", "-D", &wt.branch], None).unwrap();
    }

    #[test]
    fn removing_a_worktree_with_loose_work_needs_force() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        std::fs::write(wt.folder.join("loose.txt"), "x\n").unwrap();
        assert!(remove_worktree(main.path(), &wt.root, &wt.branch, false, false, None).is_err());
        assert!(wt.root.exists(), "unforced removal deleted uncommitted work");
        assert!(remove_worktree(main.path(), &wt.root, &wt.branch, true, true, None).is_ok());
        assert!(!wt.root.exists() && !branch_exists(main.path(), &wt.branch, None));
    }
}
