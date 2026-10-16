use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

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

/// The longest a git command may take. A checkout of a huge repository, or a hook that waits for something, must not hold a
/// tool call (and the prompts queued behind it) for ever.
const GIT_TIMEOUT: Duration = Duration::from_secs(180);

/// What every git command Lantern runs starts with. A repository's config is shared by its worktrees, so a worker can
/// write to it from its own: nothing in it may run a program of its own while Lantern looks or commits. No filesystem
/// monitor, no hooks, no pager, no going into submodules (a submodule's own git directory is the worker's to point
/// anywhere), and neither signing nor checking signatures: each runs a program the config names, so those programs are
/// pinned to `false` as well. git hands these on to the git commands it runs itself. Filter and merge drivers still
/// run: git-lfs is one, and without it a commit or a merge would take its pointer files for the content.
const HARDENED: [&str; 24] = [
    "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", "-c", "submodule.recurse=false",
    "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", "merge.verifySignatures=false", "-c", "log.showSignature=false",
    "-c", "gpg.program=/usr/bin/false", "-c", "gpg.ssh.program=/usr/bin/false", "-c", "gpg.x509.program=/usr/bin/false",
    "-c", "gpg.ssh.defaultKeyCommand=/usr/bin/false",
];

/// Variables that would point git at another repository, index or config than the one it is run in.
pub(crate) const REDIRECTS: [&str; 6] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"];

/// Where a git command runs.
#[derive(Clone, Copy)]
pub(crate) enum At<'a> {
    /// A folder of the user's own checkout: git finds the repository from there.
    Dir(&'a Path),
    /// A worker's worktree, checked (see `verify_worktree`): git is told where its repository is, so the `.git` file in it,
    /// which the worker can rewrite, is never read.
    Worktree(&'a Checked),
}

/// Runs `git` in `dir` and returns its trimmed stdout; a failure is git's own message. Blocking: call it off the async
/// threads. Never asks for a password or opens an editor, and is stopped after `GIT_TIMEOUT`.
fn run(dir: &Path, args: &[&str], path_env: Option<&str>) -> Result<String, String> {
    run_at(At::Dir(dir), args, path_env)
}

fn run_at(at: At, args: &[&str], path_env: Option<&str>) -> Result<String, String> {
    run_raw_within(at, args, path_env, GIT_TIMEOUT).map(|out| out.trim().to_string())
}

#[cfg(test)]
fn run_within(dir: &Path, args: &[&str], path_env: Option<&str>, limit: Duration) -> Result<String, String> {
    run_raw_within(At::Dir(dir), args, path_env, limit).map(|out| out.trim().to_string())
}

/// What `run` returns, exactly as git wrote it: for lists of file names (`-z`), where a name's own spaces count.
fn run_raw(dir: &Path, args: &[&str], path_env: Option<&str>) -> Result<String, String> {
    run_raw_within(At::Dir(dir), args, path_env, GIT_TIMEOUT)
}

fn run_raw_within(at: At, args: &[&str], path_env: Option<&str>, limit: Duration) -> Result<String, String> {
    run_with(at, args, path_env, limit, &[])
}

/// `run_raw_within` with variables of its own set after the redirects are removed: a private index for a checkpoint
/// (`GIT_INDEX_FILE`), the name a commit is made under. Only the checkpoints use it, and with values Lantern chose.
pub(crate) fn run_with(at: At, args: &[&str], path_env: Option<&str>, limit: Duration, env: &[(&str, &std::ffi::OsStr)]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(HARDENED);
    match at {
        At::Dir(dir) => {
            cmd.current_dir(dir);
        }
        At::Worktree(wt) => {
            let flag = |name: &str, path: &Path| {
                let mut f = std::ffi::OsString::from(name);
                f.push(path);
                f
            };
            cmd.arg(flag("--git-dir=", &wt.admin)).arg(flag("--work-tree=", &wt.root)).current_dir(&wt.root);
        }
    }
    for var in REDIRECTS {
        cmd.env_remove(var);
    }
    cmd.args(args).env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", "true").env("GIT_CONFIG_NOSYSTEM", "1").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (name, value) in env {
        cmd.env(name, value);
    }
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not run git: {e}"))?;
    // Both pipes are read as git writes, or a command with a lot of output would fill one and wait on us.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let (out, err) = (drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>)), drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>)));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > limit => {
                // Not waited for further: a hook it started may hold the pipes open, and we are done with it.
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("git {} took longer than {} seconds and was stopped.", args.first().unwrap_or(&""), limit.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(e) => return Err(format!("Could not run git: {e}")),
        }
    };
    let text = |b: Vec<u8>| String::from_utf8_lossy(&b).to_string();
    let (stdout, stderr) = (text(out.join().unwrap_or_default()), text(err.join().unwrap_or_default()));
    if status.success() {
        Ok(stdout)
    } else {
        let (stdout, stderr) = (stdout.trim(), stderr.trim());
        Err(if stderr.is_empty() { stdout } else { stderr }.to_string())
    }
}

/// The branch `folder`'s checkout is on, from git itself (so from any folder inside it); None for a detached HEAD or no
/// repository. `current_branch` above also names a detached HEAD by its commit, which is no place to merge into.
pub fn branch_of(folder: &Path, path_env: Option<&str>) -> Option<String> {
    run(folder, &["symbolic-ref", "--short", "-q", "HEAD"], path_env).ok().filter(|b| !b.is_empty())
}

/// The top of the repository `folder` is in, or None when it isn't in one.
pub fn repo_root(folder: &Path, path_env: Option<&str>) -> Option<PathBuf> {
    run(folder, &["rev-parse", "--show-toplevel"], path_env).ok().filter(|p| !p.is_empty()).map(PathBuf::from)
}

/// What the Ship it dialog needs to know about a folder's repository, all read-only.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct ShipInfo {
    /// The checked-out branch (None: not a git repository, or a detached HEAD).
    pub branch: Option<String>,
    /// The remote a push goes to: `origin`, else the first remote there is.
    pub remote: Option<String>,
    /// That remote's address, without any password or token in it.
    pub remote_url: Option<String>,
    /// The remote is on github.com.
    pub github: bool,
    /// The GitHub CLI (`gh`) can be run.
    pub gh: bool,
    /// The branch a pull request would go into: the remote's default, else main or master.
    pub base: Option<String>,
}

/// A remote's address as it can be shown and sent to Claude: a password or token written before the `@` of an
/// `https://user:token@host/…` address is dropped (`git@github.com:o/r.git` has none to drop).
pub fn redact_url(url: &str) -> String {
    let url = url.trim();
    let Some((scheme, rest)) = url.split_once("://") else { return url.to_string() };
    let (authority, path) = rest.split_once('/').map_or((rest, None), |(a, p)| (a, Some(p)));
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    match path {
        Some(path) => format!("{scheme}://{host}/{path}"),
        None => format!("{scheme}://{host}"),
    }
}

/// Whether `gh` starts (`gh --version`): it is what opens the pull request.
fn gh_installed(path_env: Option<&str>) -> bool {
    let mut cmd = Command::new("gh");
    cmd.arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Some(path) = path_env {
        cmd.env("PATH", path);
    }
    cmd.status().is_ok_and(|s| s.success())
}

/// The branch pull requests go into: the remote's own default (`refs/remotes/<remote>/HEAD`), else main or master.
fn default_branch(folder: &Path, remote: Option<&str>, path_env: Option<&str>) -> Option<String> {
    if let Some(remote) = remote {
        let head = format!("refs/remotes/{remote}/HEAD");
        if let Ok(r) = run(folder, &["symbolic-ref", "--quiet", "--short", &head], path_env) {
            if let Some(name) = r.strip_prefix(&format!("{remote}/")).filter(|n| !n.is_empty()) {
                return Some(name.to_string());
            }
        }
    }
    let exists = |full: String| run(folder, &["rev-parse", "--verify", "--quiet", &full], path_env).is_ok();
    ["main", "master"].into_iter().find(|name| exists(format!("refs/heads/{name}")) || remote.is_some_and(|r| exists(format!("refs/remotes/{r}/{name}")))).map(String::from)
}

/// Looks at the folder's repository for the Ship it dialog: its branch, where a push would go, and whether a pull request
/// can be opened. Only reads: `rev-parse`, `remote`, `remote get-url`, `symbolic-ref`, and `gh --version`.
pub fn ship_info(folder: &Path, path_env: Option<&str>) -> ShipInfo {
    let branch = run(folder, &["rev-parse", "--abbrev-ref", "HEAD"], path_env).ok().filter(|b| !b.is_empty() && b != "HEAD");
    let remotes = run(folder, &["remote"], path_env).unwrap_or_default();
    let names = || remotes.lines().map(str::trim).filter(|r| !r.is_empty());
    let remote = names().find(|r| *r == "origin").or_else(|| names().next()).map(String::from);
    let remote_url = remote.as_deref().and_then(|r| run(folder, &["remote", "get-url", r], path_env).ok()).filter(|u| !u.is_empty()).map(|u| redact_url(&u));
    let github = remote_url.as_deref().is_some_and(|u| u.contains("github.com"));
    let base = default_branch(folder, remote.as_deref(), path_env);
    ShipInfo { branch, remote, remote_url, github, gh: gh_installed(path_env), base }
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

impl Worktree {
    /// It has no branch of its own (see `add_detached_worktree`): there is nothing to merge, and nothing to delete with it.
    pub fn detached(&self) -> bool {
        self.branch.is_empty()
    }
}

/// Where a worktree for `name` goes under `parent`: grouped by repository, and never onto a directory a worktree from an
/// earlier run left behind. The directory's parent is created.
fn new_root(repo: &Path, parent: &Path, slug: &str, id: &str) -> Result<PathBuf, String> {
    let parent = parent.join(self::slug(&repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
    let mut root = parent.join(format!("{slug}-{id}"));
    let mut n = 1;
    while root.exists() {
        n += 1;
        root = parent.join(format!("{slug}-{id}-{n}"));
    }
    std::fs::create_dir_all(&parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    Ok(root)
}

/// Creates a worktree for `name` under `parent` on a new branch `lantern/<name>` (numbered if that exists), starting
/// from the commit the main checkout is on. Work not committed yet is not in it.
pub fn add_worktree(folder: &Path, parent: &Path, name: &str, id: &str, path_env: Option<&str>) -> Result<Worktree, String> {
    let repo = repo_root(folder, path_env).ok_or("This folder isn't in a git repository, so an agent can't get a worktree of its own.")?;
    let base = current_branch(&repo).filter(|b| branch_exists(&repo, b, path_env));
    let slug = self::slug(name);
    let mut branch = format!("lantern/{slug}");
    let mut n = 1;
    while branch_exists(&repo, &branch, path_env) {
        n += 1;
        branch = format!("lantern/{slug}-{n}");
    }
    let root = new_root(&repo, parent, &slug, id)?;
    let root_arg = root.to_string_lossy().to_string();
    run(&repo, &["worktree", "add", "-b", &branch, &root_arg, "HEAD"], path_env)?;
    let prefix = prefix_in_repo(folder, path_env);
    let inside = if prefix.is_empty() { root.clone() } else { root.join(prefix.trim_end_matches('/')) };
    Ok(Worktree { folder: inside, root, branch, base })
}

/// A worktree with no branch, checked out at exactly `commit` (a full commit id, as `tip_of` gives): what a reviewer or a
/// tester is given of a builder's work. It holds that commit's files and nothing else (not what the builder has loose in
/// its own worktree, which is left alone), and nothing is committed to a branch from it, so removing it leaves no trace.
/// Its `branch` is empty (see `Worktree::detached`).
pub fn add_detached_worktree(folder: &Path, parent: &Path, name: &str, id: &str, commit: &str, path_env: Option<&str>) -> Result<Worktree, String> {
    let repo = repo_root(folder, path_env).ok_or("This folder isn't in a git repository, so an agent can't get a worktree of its own.")?;
    if commit.len() != 40 || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("That isn't a commit.".into());
    }
    let root = new_root(&repo, parent, &self::slug(name), id)?;
    let root_arg = root.to_string_lossy().to_string();
    run(&repo, &["worktree", "add", "--detach", &root_arg, commit], path_env)?;
    let prefix = prefix_in_repo(folder, path_env);
    let inside = if prefix.is_empty() { root.clone() } else { root.join(prefix.trim_end_matches('/')) };
    Ok(Worktree { folder: inside, root, branch: String::new(), base: None })
}

/// The files `dir` has changed but not committed, as `git status --porcelain` lists them.
pub fn dirty(dir: &Path, path_env: Option<&str>) -> Result<Vec<String>, String> {
    Ok(run(dir, &["status", "--porcelain"], path_env)?.lines().map(String::from).collect())
}

/// Commits everything there is, as a worker would. False when there was nothing to commit.
#[cfg(test)]
fn commit_all(at: At, message: &str, path_env: Option<&str>) -> Result<bool, String> {
    run_at(at, &["add", "-A"], path_env)?;
    if run_at(at, &["diff", "--no-ext-diff", "--cached", "--quiet"], path_env).is_ok() {
        return Ok(false);
    }
    run_at(at, &["commit", "--no-verify", "-m", message], path_env)?;
    Ok(true)
}

/// The repository's own git directory (the one its linked worktrees share), as a real path.
fn common_dir(repo: &Path, path_env: Option<&str>) -> Option<PathBuf> {
    let out = run(repo, &["rev-parse", "--git-common-dir"], path_env).ok().filter(|p| !p.is_empty())?;
    // Relative to the folder it was asked in, unless git says it whole.
    std::fs::canonicalize(repo.join(out)).ok()
}

/// A worker's worktree that was checked to be one of the main repository's own (see `verify_worktree`). The only way to
/// run git in a worktree.
#[derive(Debug, Clone, PartialEq)]
pub struct Checked {
    /// The worktree's directory in the repository's git directory (`.git/worktrees/<name>`).
    admin: PathBuf,
    root: PathBuf,
}

impl Checked {
    /// The worktree's own directory in the repository's git directory: where its index lives.
    pub(crate) fn admin(&self) -> &Path {
        &self.admin
    }

    /// The worktree's top.
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
}

/// Checks that `root` is a linked worktree of the repository `repo` is in, before Lantern runs git there. A worktree's
/// `.git` is a plain file in the worker's own folder, saying where its git directory is: rewritten to point at one the
/// worker made, the config there would have git run the worker's commands for Lantern (a filesystem monitor, a hook).
/// So the file has to point into the repository's own `worktrees`, and that directory has to say it belongs to this
/// repository and to this worktree. All of it is read from disk: no git runs in the worktree before it is checked.
pub fn verify_worktree(repo: &Path, root: &Path, path_env: Option<&str>) -> Result<Checked, String> {
    let refuse = |why: &str| format!("Lantern won't run git in {}: {why}, so it isn't the worktree Lantern made for this repository.", root.display());
    let common = common_dir(repo, path_env).ok_or("The main folder isn't in a git repository.")?;
    let worktrees = std::fs::canonicalize(common.join("worktrees")).map_err(|_| refuse("the repository has no linked worktrees"))?;
    let dot_git = root.join(".git");
    if !std::fs::symlink_metadata(&dot_git).is_ok_and(|m| m.file_type().is_file()) {
        return Err(refuse("its .git isn't a plain file"));
    }
    let pointer = std::fs::read_to_string(&dot_git).map_err(|_| refuse("its .git can't be read"))?;
    let target = pointer.trim().strip_prefix("gitdir:").map(str::trim).ok_or_else(|| refuse("its .git doesn't say where its git directory is"))?;
    let admin = std::fs::canonicalize(root.join(target)).map_err(|_| refuse("its .git points at nothing"))?;
    if admin.parent() != Some(worktrees.as_path()) {
        return Err(refuse("its .git points outside the repository's worktrees"));
    }
    let read = |name: &str| std::fs::read_to_string(admin.join(name)).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let back_to_repo = read("commondir").and_then(|c| std::fs::canonicalize(admin.join(c)).ok());
    if back_to_repo.as_ref() != Some(&common) {
        return Err(refuse("its git directory belongs to another repository"));
    }
    // And the repository's own record of where this worktree is names this very folder.
    let back_to_root = read("gitdir").and_then(|g| std::fs::canonicalize(admin.join(g)).ok());
    if back_to_root.is_none() || back_to_root != std::fs::canonicalize(&dot_git).ok() {
        return Err(refuse("the repository's record of it names another folder"));
    }
    Ok(Checked { admin, root: std::fs::canonicalize(root).map_err(|e| e.to_string())? })
}

/// The linked worktree `folder` is in (or is), as a restored worker's, once it is checked to be one of `repo`'s (see
/// `verify_worktree`): None when it is a main checkout, no repository at all, or a worktree that doesn't check out.
/// `branch` is the one Lantern saved for the worker; without it (an older save) the branch is read from the worktree,
/// which the worker can switch, so it is never deleted (see `remove_worktree`) unless it is one of Lantern's own. The
/// branch it started from is not known.
pub fn existing_worktree(repo: &Path, folder: &Path, branch: Option<&str>, path_env: Option<&str>) -> Option<Worktree> {
    // Found on disk, not by asking git there: that is what the check is for.
    let root = folder.ancestors().find(|d| d.join(".git").symlink_metadata().is_ok())?;
    if root.join(".git").is_dir() {
        return None;
    }
    verify_worktree(repo, root, path_env).ok()?;
    let branch = match branch {
        Some(b) => b.to_string(),
        None => current_branch(root)?,
    };
    Some(Worktree { folder: folder.to_path_buf(), root: root.to_path_buf(), branch, base: None })
}

/// The files a checked worktree has changed but not committed, by name: each untracked one on its own (not its folder),
/// and a rename as the two names it touches.
pub fn loose_files(wt: &Checked, path_env: Option<&str>) -> Result<Vec<String>, String> {
    let out = run_raw_within(At::Worktree(wt), &["status", "--porcelain", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=all"], path_env, GIT_TIMEOUT)?;
    // Each entry is "XY name".
    let mut names: Vec<String> = out.split('\0').filter_map(|e| e.get(3..)).filter(|n| !n.is_empty()).map(String::from).collect();
    names.sort();
    names.dedup();
    Ok(names)
}

/// What a merge is proposed on: the commit the branch is at, and the loose files that will be committed on top of it.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub tip: String,
    pub loose: Vec<String>,
}

/// The commit `branch` is at, from the main repository.
pub fn tip_of(repo: &Path, branch: &str, path_env: Option<&str>) -> Result<String, String> {
    run(repo, &["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}^{{commit}}")], path_env).map_err(|_| format!("The branch {branch} is gone."))
}

/// What merging the worker's branch would take now. Its worktree has to be on that branch, or the loose files committed
/// for the merge would go onto another one.
pub fn snapshot(repo: &Path, wt: &Checked, branch: &str, path_env: Option<&str>) -> Result<Snapshot, String> {
    let head = run_at(At::Worktree(wt), &["symbolic-ref", "-q", "HEAD"], path_env).unwrap_or_default();
    if head != format!("refs/heads/{branch}") {
        return Err(format!("Its worktree isn't on {branch} now, so there is no telling what a merge would take."));
    }
    Ok(Snapshot { tip: tip_of(repo, branch, path_env)?, loose: loose_files(wt, path_env)? })
}

/// What the worker's branch is at and what is loose in its worktree, down to each loose file's size and time: it changes
/// when the branch moves or any of its loose work does. A test run compares it to say whether it still describes the branch.
pub fn fingerprint(repo: &Path, wt: &Checked, branch: &str, path_env: Option<&str>) -> Result<(Snapshot, String), String> {
    let seen = snapshot(repo, wt, branch, path_env)?;
    let mut text = format!("{}\n", seen.tip);
    for name in &seen.loose {
        // A link is the link itself, never what it points at.
        let stat = std::fs::symlink_metadata(wt.root.join(name)).ok().map(|m| (m.len(), m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos())));
        text.push_str(&format!("{name}\0{stat:?}\n"));
    }
    Ok((seen, text))
}

/// What `commit_snapshot` found.
#[derive(Debug, Clone, PartialEq)]
pub enum Pinned {
    /// The commit to merge: the branch as it was proposed, with the loose files the user was shown committed on top.
    Ready(String),
    /// Something changed since it was proposed (why, in words): nothing was committed, or what was committed is not what
    /// the user saw, and either way nothing may be merged.
    Changed(String),
}

/// Commits the worker's loose work, as long as the branch and its loose files are what the user was shown (`seen`), and
/// returns the commit to merge. The commit is made on `seen.tip` and onto `branch` by name, whatever the worktree has
/// checked out meanwhile, and only when it holds exactly the loose files that were shown and the branch hasn't moved;
/// otherwise nothing is published. It is Lantern keeping the work safe, not the worker finishing it, so no hook runs
/// and it isn't signed (a signing program is the repository config's to name).
pub fn commit_snapshot(repo: &Path, wt: &Checked, branch: &str, seen: &Snapshot, message: &str, path_env: Option<&str>) -> Result<Pinned, String> {
    let now = match snapshot(repo, wt, branch, path_env) {
        Ok(now) => now,
        Err(e) => return Ok(Pinned::Changed(e)),
    };
    if now.tip != seen.tip {
        return Ok(Pinned::Changed(format!("{branch} has commits it didn't have when the merge was proposed.")));
    }
    if now.loose != seen.loose {
        return Ok(Pinned::Changed("Its loose files aren't the ones the merge was proposed with.".into()));
    }
    if seen.loose.is_empty() {
        return Ok(Pinned::Ready(seen.tip.clone()));
    }
    let at = At::Worktree(wt);
    run_at(at, &["add", "-A"], path_env)?;
    let tree = run_at(at, &["write-tree"], path_env)?;
    let made = run_at(at, &["commit-tree", "--no-gpg-sign", "-p", &seen.tip, "-m", message, &tree], path_env)?;
    let mut committed: Vec<String> = run_raw(repo, &["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--no-renames", &seen.tip, &made], path_env)?.split('\0').filter(|n| !n.is_empty()).map(String::from).collect();
    committed.sort();
    if committed != seen.loose {
        return Ok(Pinned::Changed("Its loose files changed while they were being committed.".into()));
    }
    // Moved from the commit the user was shown to this one, or not at all.
    if run(repo, &["update-ref", "-m", message, &format!("refs/heads/{branch}"), &made, &seen.tip], path_env).is_err() {
        return Ok(Pinned::Changed(format!("{branch} moved while its loose files were being committed.")));
    }
    Ok(Pinned::Ready(made))
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
    let numstat = run(repo, &["diff", "--no-ext-diff", "--no-textconv", "--numstat", &format!("{base}...{branch}")], path_env)?;
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

/// A builder's work as a reviewer that has no shell reads it: the files changed (a stat) and the diff, from where the builder
/// started to its commit. `cut`: the diff is not all of it (it was too long to hand over whole).
#[derive(Debug, Clone, PartialEq)]
pub struct ReviewDiff {
    pub stat: String,
    pub diff: String,
    pub cut: bool,
}

/// More changed lines than this and the diff text is left out altogether: git would have to write it all down before it could
/// be cut, and nobody reviews that many lines from a brief. The stat is still there.
const DIFF_LINES_MAX: u32 = 20_000;
/// The most of the stat that is kept.
const STAT_MAX: usize = 6_000;

/// What `base...commit` changed, read by git with argument vectors only (never a shell), without running a diff or text
/// conversion program the repository's config names, and cut to `max_bytes` of diff at a line. The merge base is what the
/// builder started from, so it is the builder's work and not what the base branch gained since.
pub fn review_diff(repo: &Path, base: &str, commit: &str, max_bytes: usize, path_env: Option<&str>) -> Result<ReviewDiff, String> {
    if base.is_empty() || base.starts_with('-') || base.chars().any(char::is_control) {
        return Err("The branch the work started from isn't usable.".into());
    }
    if commit.len() != 40 || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("That isn't a commit.".into());
    }
    let range = format!("{base}...{commit}");
    let plain = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
    let with = |extra: &[&str]| -> Vec<String> { plain.iter().map(|a| a.to_string()).chain(extra.iter().map(|a| a.to_string())).chain([range.clone()]).collect() };
    let run_with = |extra: &[&str], raw: bool| {
        let args = with(extra);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        if raw { run_raw(repo, &refs, path_env) } else { run(repo, &refs, path_env) }
    };
    let mut stat = run_with(&["--stat=100,60"], false)?;
    if stat.len() > STAT_MAX {
        let at = (0..=STAT_MAX).rev().find(|i| stat.is_char_boundary(*i)).unwrap_or(0);
        let keep = stat[..at].rfind('\n').unwrap_or(at);
        stat.truncate(keep);
        stat.push_str("\n…");
    }
    let changed: u32 = run_with(&["--numstat"], false)?.lines().filter_map(|l| l.split('\t').take(2).map(|n| n.parse::<u32>().unwrap_or(0)).reduce(|a, b| a + b)).sum();
    if changed > DIFF_LINES_MAX {
        return Ok(ReviewDiff { stat, diff: String::new(), cut: true });
    }
    let mut diff = run_with(&[], true)?;
    let cut = diff.len() > max_bytes;
    if cut {
        let at = (0..=max_bytes).rev().find(|i| diff.is_char_boundary(*i)).unwrap_or(0);
        let keep = diff[..at].rfind('\n').unwrap_or(at);
        diff.truncate(keep);
    }
    Ok(ReviewDiff { stat, diff: diff.trim_end().to_string(), cut })
}

#[derive(Debug, Clone, PartialEq)]
pub enum Merged {
    /// Merged into this branch.
    Into(String),
    /// Nothing was merged: these files conflict. The checkout is as it was.
    Conflicts(Vec<String>),
}

/// The files `commit` adds that the main checkout already has on disk but keeps out of git (ignored): a merge writes over
/// them, silently, and `status` never lists them, so the clean-checkout check can't see them.
fn would_overwrite_ignored(repo: &Path, commit: &str, path_env: Option<&str>) -> Result<Vec<String>, String> {
    // Paths below are relative to the top of the repository, whichever folder inside it the main agent was opened in.
    let root = repo_root(repo, path_env).unwrap_or_else(|| repo.to_path_buf());
    // Names are read exactly as git writes them (NUL-separated, untrimmed) and handed back as literal paths: a name that
    // starts with ":" or holds `*` or `[` would otherwise be read by git as a pathspec pattern, and not match itself.
    let added = run_raw(&root, &["--literal-pathspecs", "diff", "--name-only", "-z", "--diff-filter=AR", &format!("HEAD...{commit}")], path_env)?;
    let paths: Vec<&str> = added.split('\0').filter(|p| !p.is_empty()).collect();
    let mut tracked = std::collections::HashSet::new();
    for chunk in paths.chunks(200) {
        let mut args = vec!["--literal-pathspecs", "ls-files", "-z", "--"];
        args.extend(chunk);
        for p in run_raw(&root, &args, path_env)?.split('\0').filter(|p| !p.is_empty()) {
            tracked.insert(p.to_string());
        }
    }
    // What the branch adds that the checkout already has on disk without tracking it: since the clean-checkout check already
    // covers untracked files that aren't ignored, these are ignored ones. Asked of the disk rather than of git's ignore
    // rules, so a different spelling of the same file (the filesystem here ignores case) is found too.
    Ok(paths.iter().filter(|p| !tracked.contains(**p) && root.join(p).symlink_metadata().is_ok()).map(|p| p.to_string()).collect())
}

/// Merges `commit` (a worker's branch, as the user was shown it: see `commit_snapshot`) into `into`, with a merge commit so
/// the branch's own commits stay readable. `into` is the branch the
/// user was shown when they were asked: the main checkout must still be on it, or nothing is merged. The checkout must be
/// clean, and a file the user keeps out of git (ignored) is never overwritten by the merge. A conflict is undone, not left
/// half-merged.
pub fn merge(repo: &Path, into: &str, commit: &str, message: &str, path_env: Option<&str>) -> Result<Merged, String> {
    match branch_of(repo, path_env) {
        Some(now) if now == into => {}
        Some(now) => return Err(format!("The main checkout is on {now} now, not {into}, which is where the merge was proposed. Switch it back to {into}, or ask for the merge again.")),
        None => return Err("The main checkout isn't on a branch, so there is nothing to merge into.".into()),
    }
    let dirty = dirty(repo, path_env)?;
    if !dirty.is_empty() {
        return Err(format!("The main checkout has {} uncommitted change{}; commit or stash them first, then approve the merge again.", dirty.len(), if dirty.len() == 1 { "" } else { "s" }));
    }
    let clobbered = would_overwrite_ignored(repo, commit, path_env)?;
    if !clobbered.is_empty() {
        let shown: Vec<&str> = clobbered.iter().take(5).map(String::as_str).collect();
        let more = if clobbered.len() > 5 { format!(" and {} more", clobbered.len() - 5) } else { String::new() };
        return Err(format!("The merge would overwrite files you keep out of git ({}{more}). Move them aside, then approve the merge again.", shown.join(", ")));
    }
    match run(repo, &["merge", "--no-ff", "--no-gpg-sign", "--no-verify-signatures", "-m", message, commit], path_env) {
        Ok(_) => Ok(Merged::Into(into.to_string())),
        Err(e) => {
            let conflicts: Vec<String> = run(repo, &["diff", "--name-only", "--diff-filter=U"], path_env).unwrap_or_default().lines().map(String::from).collect();
            let _ = run(repo, &["merge", "--abort"], path_env);
            if conflicts.is_empty() { Err(e) } else { Ok(Merged::Conflicts(conflicts)) }
        }
    }
}

/// Whether `branch` is one Lantern made for a worker (see `add_worktree`), which is the only kind it ever deletes.
pub fn is_workers_branch(branch: &str) -> bool {
    branch.strip_prefix("lantern/").is_some_and(|rest| !rest.is_empty())
}

/// Removes a worktree and, when asked, its branch. `force` throws away uncommitted work and an unmerged branch. A branch
/// that isn't one of Lantern's own (see `is_workers_branch`) is never deleted: asked to, nothing is removed.
pub fn remove_worktree(repo: &Path, root: &Path, branch: &str, delete_branch: bool, force: bool, path_env: Option<&str>) -> Result<(), String> {
    if delete_branch && !is_workers_branch(branch) {
        return Err(format!("{branch} isn't a branch Lantern made for an agent, so Lantern won't delete it."));
    }
    let root_arg = root.to_string_lossy().to_string();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&root_arg);
    run(repo, &args, path_env)?;
    if delete_branch {
        // Unforced, a branch with commits that were never merged is kept (git refuses): the worktree is gone either way.
        let deleted = run(repo, &["branch", if force { "-D" } else { "-d" }, branch], path_env);
        if force {
            deleted?;
        }
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

    #[test]
    fn a_remote_address_loses_the_password_or_token_in_it() {
        assert_eq!(redact_url("https://ada:ghp_secret@github.com/o/r.git"), "https://github.com/o/r.git");
        assert_eq!(redact_url("https://token@github.com/o/r"), "https://github.com/o/r");
        assert_eq!(redact_url("https://github.com/o/r.git\n"), "https://github.com/o/r.git");
        assert_eq!(redact_url("git@github.com:o/r.git"), "git@github.com:o/r.git");
        assert_eq!(redact_url("ssh://git@github.com/o/r.git"), "ssh://github.com/o/r.git");
        assert_eq!(redact_url("https://u:p@host"), "https://host");
    }

    #[test]
    fn ship_info_reads_the_branch_the_remote_and_the_default_branch() {
        let dir = repo();
        let none = ship_info(dir.path(), None);
        assert_eq!((none.branch.as_deref(), none.remote.as_deref(), none.remote_url.as_deref(), none.github, none.base.as_deref()), (Some("main"), None, None, false, Some("main")));
        let g = |args: &[&str]| run(dir.path(), args, None).unwrap();
        g(&["remote", "add", "upstream", "git@example.com:o/r.git"]);
        g(&["remote", "add", "origin", "https://ada:secret@github.com/o/r.git"]);
        g(&["checkout", "-q", "-b", "feat/x"]);
        let info = ship_info(dir.path(), None);
        assert_eq!((info.branch.as_deref(), info.remote.as_deref(), info.remote_url.as_deref(), info.github), (Some("feat/x"), Some("origin"), Some("https://github.com/o/r.git"), true));
        assert_eq!(info.base.as_deref(), Some("main"));
    }

    #[test]
    fn ship_info_has_no_branch_on_a_detached_head_or_outside_a_repository() {
        let dir = repo();
        let sha = run(dir.path(), &["rev-parse", "HEAD"], None).unwrap();
        run(dir.path(), &["checkout", "-q", "--detach", &sha], None).unwrap();
        assert_eq!(ship_info(dir.path(), None).branch, None);
        let empty = tempfile::tempdir().unwrap();
        let outside = ship_info(empty.path(), None);
        assert_eq!((outside.branch, outside.remote, outside.base), (None, None, None));
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
        let found = existing_worktree(main.path(), &wt.folder, None, None).unwrap();
        assert_eq!((found.branch.as_str(), real(&found.root), found.base.as_deref()), ("lantern/w", real(&wt.root), None));
        // From a subfolder of it too, and the main checkout and a plain folder are not worktrees.
        std::fs::create_dir_all(wt.folder.join("sub")).unwrap();
        assert_eq!(real(&existing_worktree(main.path(), &wt.folder.join("sub"), None, None).unwrap().root), real(&wt.root));
        assert_eq!(existing_worktree(main.path(), main.path(), None, None), None);
        assert_eq!(existing_worktree(main.path(), tempfile::tempdir().unwrap().path(), None, None), None);
        // Another repository's worktree is not this one's.
        let other = repo();
        let theirs = add_worktree(other.path(), &worktrees(), "w", "w1", None).unwrap();
        assert_eq!(existing_worktree(main.path(), &theirs.folder, None, None), None);
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
        assert_eq!(commit_all(At::Dir(&wt.folder), "nothing", None), Ok(false));
        std::fs::write(wt.folder.join("b.txt"), "b1\nb2\n").unwrap();
        std::fs::write(wt.folder.join("a.txt"), "one\ntwo\n").unwrap();
        assert_eq!(dirty(&wt.folder, None).unwrap().len(), 2);
        assert_eq!(commit_all(At::Dir(&wt.folder), "Lantern: w", None), Ok(true));
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
        commit_all(At::Dir(&wt.folder), "add b", None).unwrap();
        assert_eq!(merge(main.path(), "main", &wt.branch, "Merge w", None), Ok(Merged::Into("main".into())));
        assert!(main.path().join("b.txt").is_file());
        assert_eq!(run(main.path(), &["log", "-1", "--format=%s"], None).unwrap(), "Merge w");
    }

    #[test]
    fn a_conflict_is_undone_and_named_rather_than_left_half_merged() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        std::fs::write(wt.folder.join("a.txt"), "worker\n").unwrap();
        commit_all(At::Dir(&wt.folder), "worker edit", None).unwrap();
        std::fs::write(main.path().join("a.txt"), "main\n").unwrap();
        run(main.path(), &["commit", "-q", "-am", "main edit"], None).unwrap();
        assert_eq!(merge(main.path(), "main", &wt.branch, "Merge w", None), Ok(Merged::Conflicts(vec!["a.txt".into()])));
        assert!(dirty(main.path(), None).unwrap().is_empty(), "the checkout was left mid-merge");
        assert_eq!(std::fs::read_to_string(main.path().join("a.txt")).unwrap(), "main\n");
    }

    #[test]
    fn a_dirty_main_checkout_blocks_the_merge_with_a_reason() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        std::fs::write(wt.folder.join("b.txt"), "b\n").unwrap();
        commit_all(At::Dir(&wt.folder), "add b", None).unwrap();
        std::fs::write(main.path().join("a.txt"), "loose\n").unwrap();
        let err = merge(main.path(), "main", &wt.branch, "Merge w", None).unwrap_err();
        assert!(err.contains("1 uncommitted change"), "{err}");
        assert!(!main.path().join("b.txt").exists());
    }

    #[test]
    fn removing_a_worktree_keeps_an_unmerged_branch_unless_forced() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        std::fs::write(wt.folder.join("b.txt"), "b\n").unwrap();
        commit_all(At::Dir(&wt.folder), "add b", None).unwrap();
        // Not merged: `branch -d` refuses, so the branch (with its commit) is kept, and the worktree is gone either way.
        assert!(remove_worktree(main.path(), &wt.root, &wt.branch, true, false, None).is_ok());
        assert!(!wt.root.exists());
        assert!(branch_exists(main.path(), &wt.branch, None));
        run(main.path(), &["branch", "-D", &wt.branch], None).unwrap();
    }

    #[test]
    fn a_merge_only_goes_into_the_branch_that_was_proposed_and_never_onto_a_detached_head() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        std::fs::write(wt.folder.join("b.txt"), "b\n").unwrap();
        commit_all(At::Dir(&wt.folder), "add b", None).unwrap();
        // The checkout was moved to another branch after the card was shown.
        run(main.path(), &["checkout", "-q", "-b", "other"], None).unwrap();
        let err = merge(main.path(), "main", &wt.branch, "Merge w", None).unwrap_err();
        assert!(err.contains("is on other now, not main"), "{err}");
        assert!(!main.path().join("b.txt").exists());
        // A detached HEAD is no branch at all.
        run(main.path(), &["checkout", "-q", "--detach"], None).unwrap();
        assert_eq!(branch_of(main.path(), None), None);
        let err = merge(main.path(), "main", &wt.branch, "Merge w", None).unwrap_err();
        assert!(err.contains("isn't on a branch"), "{err}");
        assert!(!main.path().join("b.txt").exists());
        run(main.path(), &["checkout", "-q", "main"], None).unwrap();
        assert_eq!(merge(main.path(), "main", &wt.branch, "Merge w", None), Ok(Merged::Into("main".into())));
    }

    #[test]
    fn a_merge_from_a_folder_inside_the_repository_finds_its_branch() {
        let main = repo();
        std::fs::create_dir_all(main.path().join("packages/app")).unwrap();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        std::fs::write(wt.folder.join("b.txt"), "b\n").unwrap();
        commit_all(At::Dir(&wt.folder), "add b", None).unwrap();
        let sub = main.path().join("packages/app");
        assert_eq!(branch_of(&sub, None).as_deref(), Some("main"));
        assert_eq!(merge(&sub, "main", &wt.branch, "Merge w", None), Ok(Merged::Into("main".into())));
        assert!(main.path().join("b.txt").is_file());
    }

    #[test]
    fn a_merge_never_overwrites_a_file_the_user_keeps_out_of_git() {
        let main = repo();
        std::fs::write(main.path().join(".gitignore"), "config.local\n").unwrap();
        run(main.path(), &["add", "-A"], None).unwrap();
        run(main.path(), &["commit", "-q", "-m", "ignore config"], None).unwrap();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        // The worker force-adds a path the user ignores locally.
        std::fs::write(wt.folder.join("config.local"), "shared-from-worker\n").unwrap();
        run(&wt.folder, &["add", "-f", "config.local"], None).unwrap();
        run(&wt.folder, &["commit", "-q", "-m", "add config"], None).unwrap();
        std::fs::write(main.path().join("config.local"), "my-secret-token\n").unwrap();
        // The dirty check doesn't see ignored files, so it is the merge itself that must refuse.
        assert!(dirty(main.path(), None).unwrap().is_empty());
        let result = merge(main.path(), "main", &wt.branch, "Merge w", None);
        assert_eq!(std::fs::read_to_string(main.path().join("config.local")).unwrap(), "my-secret-token\n", "{result:?}");
        assert!(result.is_err() || matches!(result, Ok(Merged::Conflicts(_))), "{result:?}");
        assert!(dirty(main.path(), None).unwrap().is_empty());
    }

    #[test]
    fn names_with_pattern_characters_or_odd_spacing_are_checked_as_the_literal_files_they_are() {
        let main = repo();
        std::fs::write(main.path().join(".gitignore"), "*.local\n:*\n[ab]*\n *\n").unwrap();
        run(main.path(), &["add", "-A"], None).unwrap();
        run(main.path(), &["commit", "-q", "-m", "ignore"], None).unwrap();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        // Names git would read as pathspec magic or patterns, or that begin with a space.
        let names = [":(exclude)x.local", ":plain.local", "[ab].local", "a*.local", " lead.local"];
        for n in names {
            std::fs::write(wt.folder.join(n), "from worker\n").unwrap();
            run(&wt.folder, &["--literal-pathspecs", "add", "-f", "--", n], None).unwrap();
        }
        run(&wt.folder, &["commit", "-q", "-m", "odd names"], None).unwrap();
        for n in names {
            std::fs::write(main.path().join(n), "mine\n").unwrap();
        }
        let hit = would_overwrite_ignored(main.path(), &wt.branch, None).unwrap();
        for n in names {
            assert!(hit.iter().any(|h| h == n), "{n:?} was missed: {hit:?}");
        }
        assert!(merge(main.path(), "main", &wt.branch, "Merge w", None).is_err());
        for n in names {
            assert_eq!(std::fs::read_to_string(main.path().join(n)).unwrap(), "mine\n", "{n:?}");
        }
    }

    #[test]
    fn a_different_spelling_of_a_file_on_a_case_insensitive_disk_is_still_found() {
        let main = repo();
        std::fs::write(main.path().join("Notes.LOCAL"), "mine\n").unwrap();
        let on_disk_is_case_blind = main.path().join("notes.local").symlink_metadata().is_ok();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        std::fs::write(wt.folder.join("notes.local"), "theirs\n").unwrap();
        run(&wt.folder, &["add", "-f", "notes.local"], None).unwrap();
        run(&wt.folder, &["commit", "-q", "-m", "add"], None).unwrap();
        let hit = would_overwrite_ignored(main.path(), &wt.branch, None).unwrap();
        // Where the disk treats the two spellings as one file (the default on a Mac), the merge would write over it.
        assert_eq!(!hit.is_empty(), on_disk_is_case_blind, "{hit:?}");
    }

    #[test]
    fn a_git_command_that_takes_too_long_is_stopped() {
        let dir = tempfile::tempdir().unwrap();
        run(dir.path(), &["init", "-q"], None).unwrap();
        // A filter that never finishes (hooks don't run for Lantern, filters do).
        std::fs::write(dir.path().join(".gitattributes"), "a filter=slow\n").unwrap();
        std::fs::write(dir.path().join("a"), "a").unwrap();
        let started = Instant::now();
        let err = run_within(dir.path(), &["-c", "filter.slow.clean=sleep 30", "add", "a"], None, Duration::from_millis(400)).unwrap_err();
        assert!(err.contains("took longer than"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5), "waited {:?}", started.elapsed());
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

    /// An executable script at `path` that leaves `marker` behind when it runs.
    fn tripwire(path: &Path, marker: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn a_worktree_lantern_made_checks_out_and_its_loose_files_are_listed_one_by_one() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        let checked = verify_worktree(main.path(), &wt.root, None).unwrap();
        std::fs::create_dir_all(wt.folder.join("new/deep")).unwrap();
        std::fs::write(wt.folder.join("new/deep/x.txt"), "x\n").unwrap();
        std::fs::write(wt.folder.join("new/y.txt"), "y\n").unwrap();
        std::fs::write(wt.folder.join("a.txt"), "changed\n").unwrap();
        assert_eq!(loose_files(&checked, None).unwrap(), ["a.txt", "new/deep/x.txt", "new/y.txt"]);
        // A subfolder of the main checkout checks it just the same.
        std::fs::create_dir_all(main.path().join("sub")).unwrap();
        assert!(verify_worktree(&main.path().join("sub"), &wt.root, None).is_ok());
    }

    #[test]
    fn a_worktree_whose_git_file_was_pointed_elsewhere_is_refused_and_nothing_in_it_runs() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        let marker = wt.root.join("ran");
        // The worker makes a git directory of its own, whose config runs its program, and points .git at it.
        let fake = wt.root.join("x");
        std::fs::create_dir_all(fake.join("objects")).unwrap();
        std::fs::create_dir_all(fake.join("refs")).unwrap();
        std::fs::write(fake.join("HEAD"), "ref: refs/heads/lantern/w\n").unwrap();
        tripwire(&wt.root.join("monitor.sh"), &marker);
        std::fs::write(fake.join("config"), format!("[core]\n\trepositoryformatversion = 0\n\tfsmonitor = {}\n", wt.root.join("monitor.sh").display())).unwrap();
        std::fs::write(fake.join("commondir"), format!("{}\n", main.path().join(".git").display())).unwrap();
        std::fs::write(wt.root.join(".git"), "gitdir: ./x\n").unwrap();
        let err = verify_worktree(main.path(), &wt.root, None).unwrap_err();
        assert!(err.contains("points outside the repository's worktrees"), "{err}");
        assert_eq!(existing_worktree(main.path(), &wt.folder, None, None), None);
        // Inside the repository's worktrees, but a directory that belongs to another worktree.
        let other = add_worktree(main.path(), &worktrees(), "o", "w2", None).unwrap();
        let others = std::fs::read_to_string(other.root.join(".git")).unwrap();
        std::fs::write(wt.root.join(".git"), &others).unwrap();
        assert!(verify_worktree(main.path(), &wt.root, None).unwrap_err().contains("names another folder"));
        // A symlink in place of the file.
        std::fs::remove_file(wt.root.join(".git")).unwrap();
        std::os::unix::fs::symlink(other.root.join(".git"), wt.root.join(".git")).unwrap();
        assert!(verify_worktree(main.path(), &wt.root, None).unwrap_err().contains("isn't a plain file"));
        assert!(!marker.exists(), "the worker's program ran");
    }

    #[test]
    fn a_filesystem_monitor_or_hook_in_the_shared_config_never_runs_for_lantern() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let marker = scratch.path().join("ran");
        // The worker writes the repository's config from its worktree: it is shared.
        tripwire(&scratch.path().join("monitor.sh"), &marker);
        run(&wt.folder, &["config", "core.fsmonitor", &scratch.path().join("monitor.sh").display().to_string()], None).unwrap();
        let hooks = scratch.path().join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        for hook in ["pre-commit", "post-commit", "pre-merge-commit", "post-merge", "commit-msg"] {
            tripwire(&hooks.join(hook), &marker);
        }
        run(&wt.folder, &["config", "core.hooksPath", &hooks.display().to_string()], None).unwrap();
        // A signing program: the merge commit would otherwise run it in the main checkout.
        tripwire(&scratch.path().join("sign.sh"), &marker);
        run(&wt.folder, &["config", "commit.gpgSign", "true"], None).unwrap();
        run(&wt.folder, &["config", "gpg.program", &scratch.path().join("sign.sh").display().to_string()], None).unwrap();
        std::fs::write(wt.folder.join("b.txt"), "b\n").unwrap();
        let checked = verify_worktree(main.path(), &wt.root, None).unwrap();
        let seen = snapshot(main.path(), &checked, &wt.branch, None).unwrap();
        let Pinned::Ready(commit) = commit_snapshot(main.path(), &checked, &wt.branch, &seen, "Lantern: w", None).unwrap() else { panic!() };
        assert!(dirty(main.path(), None).unwrap().is_empty());
        assert_eq!(merge(main.path(), "main", &commit, "Merge w", None), Ok(Merged::Into("main".into())));
        assert!(!marker.exists(), "a program from the repository's config ran");
    }

    #[test]
    fn a_signed_worker_commit_never_gets_its_signature_checked_by_a_program_from_the_config() {
        use std::os::unix::fs::PermissionsExt;
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let marker = scratch.path().join("ran");
        // The worker signs its tip with a made-up signature, then asks for signatures to be checked with its program.
        let signer = scratch.path().join("fake-sign.sh");
        std::fs::write(&signer, "#!/bin/sh\ncat >/dev/null\nprintf '\\n[GNUPG:] SIG_CREATED D 1 8 00 0 X\\n' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\nfake\\n-----END PGP SIGNATURE-----\\n'\n").unwrap();
        std::fs::set_permissions(&signer, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(wt.folder.join("b.txt"), "b\n").unwrap();
        run(&wt.folder, &["add", "b.txt"], None).unwrap();
        let program = format!("gpg.program={}", signer.display());
        run(&wt.folder, &["-c", "commit.gpgSign=true", "-c", "gpg.format=openpgp", "-c", &program, "commit", "-q", "-m", "signed"], None).unwrap();
        assert!(run(&wt.folder, &["cat-file", "commit", "HEAD"], None).unwrap().contains("gpgsig"));
        tripwire(&scratch.path().join("verify.sh"), &marker);
        run(&wt.folder, &["config", "merge.verifySignatures", "true"], None).unwrap();
        run(&wt.folder, &["config", "gpg.format", "openpgp"], None).unwrap();
        run(&wt.folder, &["config", "gpg.program", &scratch.path().join("verify.sh").display().to_string()], None).unwrap();
        let checked = verify_worktree(main.path(), &wt.root, None).unwrap();
        let seen = snapshot(main.path(), &checked, &wt.branch, None).unwrap();
        let Pinned::Ready(commit) = commit_snapshot(main.path(), &checked, &wt.branch, &seen, "Lantern: w", None).unwrap() else { panic!() };
        assert_eq!(merge(main.path(), "main", &commit, "Merge w", None), Ok(Merged::Into("main".into())));
        assert!(!marker.exists(), "a program from the repository's config checked the signature");
    }

    #[test]
    fn a_merge_takes_the_branch_and_loose_files_the_user_was_shown_and_nothing_since() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        let checked = verify_worktree(main.path(), &wt.root, None).unwrap();
        std::fs::write(wt.folder.join("b.txt"), "b\n").unwrap();
        commit_all(At::Dir(&wt.folder), "add b", None).unwrap();
        std::fs::write(wt.folder.join("loose.txt"), "l\n").unwrap();
        let seen = snapshot(main.path(), &checked, &wt.branch, None).unwrap();
        assert_eq!(seen.loose, ["loose.txt"]);
        // A loose file the user wasn't shown, even inside a folder that was already loose.
        std::fs::write(wt.folder.join("late.txt"), "x\n").unwrap();
        assert!(matches!(commit_snapshot(main.path(), &checked, &wt.branch, &seen, "m", None).unwrap(), Pinned::Changed(_)));
        std::fs::remove_file(wt.folder.join("late.txt")).unwrap();
        // A commit the user wasn't shown.
        std::fs::write(wt.folder.join("c.txt"), "c\n").unwrap();
        run(&wt.folder, &["add", "c.txt"], None).unwrap();
        run(&wt.folder, &["commit", "-q", "-m", "c"], None).unwrap();
        assert!(matches!(commit_snapshot(main.path(), &checked, &wt.branch, &seen, "m", None).unwrap(), Pinned::Changed(_)));
        assert_eq!(dirty(&wt.folder, None).unwrap().len(), 1, "something was committed for a merge that can't happen");
        // Shown as it is now, the loose file is committed on top and that commit is what gets merged.
        let seen = snapshot(main.path(), &checked, &wt.branch, None).unwrap();
        let Pinned::Ready(commit) = commit_snapshot(main.path(), &checked, &wt.branch, &seen, "m", None).unwrap() else { panic!() };
        assert_eq!(run(main.path(), &["rev-parse", &format!("{commit}^1")], None).unwrap(), seen.tip);
        assert_eq!(merge(main.path(), "main", &commit, "Merge w", None), Ok(Merged::Into("main".into())));
        assert!(main.path().join("loose.txt").is_file() && main.path().join("c.txt").is_file());
    }

    #[test]
    fn a_worktree_switched_to_another_branch_has_nothing_to_merge() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        let checked = verify_worktree(main.path(), &wt.root, None).unwrap();
        let seen = snapshot(main.path(), &checked, &wt.branch, None).unwrap();
        run(&wt.folder, &["checkout", "-q", "-b", "elsewhere"], None).unwrap();
        assert!(snapshot(main.path(), &checked, &wt.branch, None).unwrap_err().contains("isn't on lantern/w"));
        std::fs::write(wt.folder.join("x.txt"), "x\n").unwrap();
        assert!(matches!(commit_snapshot(main.path(), &checked, &wt.branch, &seen, "m", None).unwrap(), Pinned::Changed(_)));
    }

    #[test]
    fn a_restored_worker_keeps_the_branch_lantern_saved_and_only_lantern_branches_are_deleted() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "w", "w1", None).unwrap();
        // The worker checked out the user's branch in its worktree.
        run(&wt.folder, &["checkout", "-q", "-b", "users-own"], None).unwrap();
        assert_eq!(existing_worktree(main.path(), &wt.folder, Some("lantern/w"), None).unwrap().branch, "lantern/w");
        let read_from_head = existing_worktree(main.path(), &wt.folder, None, None).unwrap();
        assert_eq!(read_from_head.branch, "users-own");
        let err = remove_worktree(main.path(), &wt.root, &read_from_head.branch, true, true, None).unwrap_err();
        assert!(err.contains("won't delete it"), "{err}");
        assert!(wt.root.exists() && branch_exists(main.path(), "users-own", None), "something was removed");
        assert!(remove_worktree(main.path(), &wt.root, "main", true, true, None).is_err());
        assert!(!is_workers_branch("lantern/") && !is_workers_branch("main") && is_workers_branch("lantern/w-2"));
        assert!(remove_worktree(main.path(), &wt.root, "lantern/w", true, true, None).is_ok());
        assert!(branch_exists(main.path(), "users-own", None) && !branch_exists(main.path(), "lantern/w", None));
    }

    #[test]
    fn a_detached_worktree_holds_exactly_the_commit_and_leaves_the_builders_own_worktree_alone() {
        let main = repo();
        let builder = add_worktree(main.path(), &worktrees(), "Builder", "w1", None).unwrap();
        std::fs::write(builder.folder.join("built.txt"), "built\n").unwrap();
        let checked = verify_worktree(main.path(), &builder.root, None).unwrap();
        assert!(commit_all(At::Worktree(&checked), "build it", None).unwrap());
        let tip = tip_of(main.path(), &builder.branch, None).unwrap();
        // Work the builder has not committed is not part of what is checked.
        std::fs::write(builder.folder.join("loose.txt"), "loose\n").unwrap();

        let check = add_detached_worktree(main.path(), &worktrees(), "Reviewer: Builder", "w2", &tip, None).unwrap();
        assert!(check.detached() && check.base.is_none());
        assert_eq!(std::fs::read_to_string(check.folder.join("built.txt")).unwrap(), "built\n");
        assert!(!check.folder.join("loose.txt").exists());
        // No branch: HEAD is the commit itself.
        assert_eq!(branch_of(&check.folder, None), None);
        assert_eq!(run(&check.folder, &["rev-parse", "HEAD"], None).unwrap(), tip);
        assert!(branch_exists(main.path(), &builder.branch, None));
        let branches = run(main.path(), &["branch", "--format=%(refname:short)"], None).unwrap();
        assert_eq!(branches.lines().count(), 2, "{branches}");
        // The builder's worktree is as it was, loose file included.
        assert!(builder.folder.join("loose.txt").is_file());
        assert!(verify_worktree(main.path(), &check.root, None).is_ok());
        assert_ne!(check.root, builder.root);
    }

    #[test]
    fn removing_a_detached_worktree_takes_everything_in_it_and_no_branch_with_it() {
        let main = repo();
        let tip = tip_of(main.path(), "main", None).unwrap();
        let check = add_detached_worktree(main.path(), &worktrees(), "Reviewer", "w2", &tip, None).unwrap();
        // A tester's scratch work, committed or not, is not kept.
        std::fs::write(check.folder.join("scratch.txt"), "x\n").unwrap();
        let checked = verify_worktree(main.path(), &check.root, None).unwrap();
        commit_all(At::Worktree(&checked), "scratch", None).unwrap();
        std::fs::write(check.folder.join("loose.txt"), "y\n").unwrap();
        remove_worktree(main.path(), &check.root, &check.branch, false, true, None).unwrap();
        assert!(!check.root.exists());
        assert_eq!(run(main.path(), &["worktree", "list", "--porcelain"], None).unwrap().matches("worktree ").count(), 1);
        assert_eq!(run(main.path(), &["branch", "--format=%(refname:short)"], None).unwrap(), "main");
    }

    #[test]
    fn a_detached_worktree_needs_a_real_commit_id_and_a_repository() {
        let main = repo();
        let parent = worktrees();
        for bad in ["main", "--help", "abc", &"g".repeat(40)] {
            assert_eq!(add_detached_worktree(main.path(), &parent, "x", "w1", bad, None).unwrap_err(), "That isn't a commit.");
        }
        assert!(add_detached_worktree(main.path(), &parent, "x", "w1", &"0".repeat(40), None).is_err());
        let plain = tempfile::tempdir().unwrap();
        assert!(add_detached_worktree(plain.path(), &parent, "x", "w1", &"0".repeat(40), None).unwrap_err().contains("isn't in a git repository"));
        // Two checks of the same work get two folders.
        let tip = tip_of(main.path(), "main", None).unwrap();
        let a = add_detached_worktree(main.path(), &parent, "x", "w1", &tip, None).unwrap();
        let b = add_detached_worktree(main.path(), &parent, "x", "w1", &tip, None).unwrap();
        assert_ne!(a.root, b.root);
    }

    #[test]
    fn the_diff_of_a_builders_work_is_its_stat_and_text_from_where_it_started_and_never_the_bases_own_news() {
        let main = repo();
        let builder = add_worktree(main.path(), &worktrees(), "Builder", "w1", None).unwrap();
        std::fs::write(builder.folder.join("built.txt"), "built\nmore\n").unwrap();
        let checked = verify_worktree(main.path(), &builder.root, None).unwrap();
        commit_all(At::Worktree(&checked), "build it", None).unwrap();
        // The base branch moves on meanwhile: that is not the builder's work.
        std::fs::write(main.path().join("elsewhere.txt"), "x\n").unwrap();
        run(main.path(), &["add", "-A"], None).unwrap();
        run(main.path(), &["commit", "-q", "-m", "elsewhere"], None).unwrap();
        let tip = tip_of(main.path(), &builder.branch, None).unwrap();
        let d = review_diff(main.path(), "main", &tip, 60_000, None).unwrap();
        assert!(!d.cut && d.stat.contains("built.txt") && d.stat.contains("1 file changed"), "{d:?}");
        assert!(d.diff.contains("diff --git a/built.txt b/built.txt") && d.diff.contains("+built") && d.diff.contains("+more"), "{}", d.diff);
        assert!(!d.diff.contains("elsewhere"), "{}", d.diff);
    }

    #[test]
    fn a_long_diff_is_cut_at_a_line_and_says_so_and_a_huge_one_is_left_to_its_stat() {
        let main = repo();
        let wt = add_worktree(main.path(), &worktrees(), "Builder", "w1", None).unwrap();
        let body: String = (0..400).map(|i| format!("line number {i} of the new file\n")).collect();
        std::fs::write(wt.folder.join("big.txt"), &body).unwrap();
        let checked = verify_worktree(main.path(), &wt.root, None).unwrap();
        commit_all(At::Worktree(&checked), "big", None).unwrap();
        let tip = tip_of(main.path(), &wt.branch, None).unwrap();
        let d = review_diff(main.path(), "main", &tip, 2_000, None).unwrap();
        assert!(d.cut && d.diff.len() <= 2_000, "{}", d.diff.len());
        assert!(d.diff.lines().last().unwrap().starts_with('+') && d.diff.lines().last().unwrap().ends_with("of the new file"), "cut mid-line: {:?}", d.diff.lines().last());
        // Whole when it fits.
        assert!(!review_diff(main.path(), "main", &tip, 60_000, None).unwrap().cut);
    }

    #[test]
    fn the_diff_is_read_for_a_commit_and_a_base_that_cant_be_an_option() {
        let main = repo();
        let tip = tip_of(main.path(), "main", None).unwrap();
        for base in ["", "--output=/tmp/pwned", "-x", "a\nb"] {
            assert!(review_diff(main.path(), base, &tip, 100, None).is_err(), "{base:?}");
        }
        assert_eq!(review_diff(main.path(), "main", "--help", 100, None).unwrap_err(), "That isn't a commit.");
        assert!(review_diff(main.path(), "no-such-branch", &tip, 100, None).is_err());
        // Nothing changed: an empty diff, not an error.
        let same = review_diff(main.path(), "main", &tip, 100, None).unwrap();
        assert_eq!((same.diff.as_str(), same.cut), ("", false));
    }
}
