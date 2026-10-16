//! The one command a read-only agent has besides Read, Grep and Glob: Lantern's `git` tool. It has no shell. Lantern runs
//! git itself, from an argument list, and only the read-only part of it: the subcommands that look at a repository,
//! with every flag that writes a file or starts a program refused.
//!
//! Two things are checked, apart from each other so each can be tested alone: `validate` says whether the arguments are
//! ones a read-only agent may pass, and `resolve_repo` which repository they run in (the agent's own folder, or one that
//! shares its git directory, such as the user's linked worktrees). `run` then runs git with no stdin, a time limit, an
//! output cap, and none of the configuration that would make a read start a program.

use serde_json::Value;
use std::ffi::OsString;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The most output a call returns; what git printed after it is dropped, and the reply says so.
pub const MAX_OUTPUT: usize = 256 * 1024;
/// How long a call may run before git is killed.
pub const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ARGS: usize = 200;
const MAX_ARG_LEN: usize = 4096;

/// What a read-only agent's git tool may run in: the folder the agent works in, and the PATH its chat was started with.
#[derive(Debug, Clone, PartialEq)]
pub struct Scope {
    pub folder: PathBuf,
    pub path_env: Option<String>,
}

/// Subcommands that only look. `branch`, `tag` and `worktree` also read, but have forms that write, so they are checked
/// one by one (`check_branch`, `check_tag`, `check_worktree`).
const LOOKING: &[&str] = &["log", "diff", "show", "status", "blame", "grep", "rev-parse", "merge-base", "rev-list", "shortlog", "describe", "ls-files"];

/// Where diff output is made: these take `--no-ext-diff --no-textconv`, so a driver the repository's config names never runs.
const DIFFING: &[&str] = &["diff", "log", "show"];

/// Long options refused in every subcommand: they write a file or run a program, or (the last ones) point git somewhere
/// else or read a file outside the repository. Git takes any unambiguous abbreviation of a long option, so an option is
/// refused when what was typed is the start of one of these (`--outp`); no real option is that short, so nothing else is
/// lost but `--text`, which `-a` says.
const DENIED_LONG: &[&str] = &[
    "output", "ext-diff", "textconv", "exec", "upload-pack", "receive-pack", "open-files-in-pager", "exec-path", "git-dir", "work-tree", "config-env", "namespace", "super-prefix", "no-index",
    "contents", "file",
];

/// Short options refused in a subcommand, wherever they sit in a cluster (`-nO`): grep's `-O` opens its matches in a pager
/// program, and `-f` reads its patterns from a file anywhere on the disk.
fn denied_short(sub: &str) -> &'static str {
    if sub == "grep" {
        "Of"
    } else {
        ""
    }
}

const ALLOWED: &str = "Only read-only git is available: log, diff, show, status, blame, grep, rev-parse, merge-base, rev-list, shortlog, describe, ls-files, `branch --list`, `tag --list` and `worktree list`. Options that write a file or run a program (--output, --ext-diff, --textconv, --exec, -O …) are refused, and so is everything else, such as config, cat-file, checkout or stash.";

fn refuse(what: String) -> String {
    format!("{what} {ALLOWED}")
}

/// The arguments git is run with (after the options Lantern adds itself), or why they are refused. `args` is the whole
/// command after `git`: the subcommand first, and nothing before it.
pub fn validate(args: &[String]) -> Result<Vec<String>, String> {
    let Some(sub) = args.first() else {
        return Err(refuse("`args` is empty: name a git subcommand first, such as [\"log\", \"--oneline\", \"-5\"].".into()));
    };
    if args.len() > MAX_ARGS || args.iter().any(|a| a.len() > MAX_ARG_LEN) {
        return Err(format!("At most {MAX_ARGS} arguments of {MAX_ARG_LEN} characters."));
    }
    if args.iter().any(|a| a.contains(['\0', '\n', '\r'])) {
        return Err("An argument has a NUL or a line break in it, which git is never given.".into());
    }
    if sub.starts_with('-') {
        return Err(refuse(format!("{sub:?} comes first, but the subcommand does: git's own options (-c, -C, --git-dir …) are not available.")));
    }
    let rest = &args[1..];
    match sub.as_str() {
        "branch" => check_branch(rest)?,
        "tag" => check_tag(rest)?,
        "worktree" => check_worktree(rest)?,
        s if LOOKING.contains(&s) => check_flags(s, rest)?,
        other => return Err(refuse(format!("git {other} is not available."))),
    }
    let mut out = vec![sub.clone()];
    if DIFFING.contains(&sub.as_str()) {
        out.extend(["--no-ext-diff".to_string(), "--no-textconv".to_string()]);
    }
    out.extend(rest.iter().cloned());
    Ok(out)
}

/// Refuses a denied option in a subcommand's arguments. Everything after a bare `--` is a path, and left alone.
fn check_flags(sub: &str, rest: &[String]) -> Result<(), String> {
    for a in rest.iter().take_while(|a| *a != "--") {
        let denied = if let Some(long) = a.strip_prefix("--") {
            let name = long.split('=').next().unwrap_or("");
            name.is_empty() || DENIED_LONG.iter().any(|d| d.starts_with(name))
        } else if let Some(cluster) = a.strip_prefix('-') {
            cluster.chars().any(|c| denied_short(sub).contains(c))
        } else {
            false
        };
        if denied {
            return Err(refuse(format!("git {sub} {a:?} is refused: it can write a file, run a program or read outside the repository.")));
        }
    }
    Ok(())
}

/// What `branch` and `tag` may be given: the options that only list. `values` take a commit or object as the next
/// argument; `cluster` are the short letters that may be grouped (`-av`); `prefixed` are options with a value after `=`.
struct ListForm {
    sub: &'static str,
    flags: &'static [&'static str],
    values: &'static [&'static str],
    prefixed: &'static [&'static str],
    cluster: &'static str,
}

/// Checks that `rest` only lists. A pattern (an argument that isn't an option) is allowed after `--list`, and a commit
/// after the options that take one; anything else, such as a name to create, is refused. Returns whether it listed.
fn check_list_form(form: &ListForm, rest: &[String]) -> Result<bool, String> {
    let (mut listing, mut wants_value) = (false, false);
    for a in rest {
        let ok = if a.starts_with('-') {
            wants_value = false;
            if matches!(a.as_str(), "-l" | "--list") {
                listing = true;
                true
            } else if form.values.contains(&a.as_str()) {
                wants_value = true;
                true
            } else if form.flags.contains(&a.as_str()) || form.prefixed.iter().any(|p| a.starts_with(p)) {
                true
            } else if a.len() > 1 && !a.starts_with("--") && a[1..].chars().all(|c| form.cluster.contains(c)) {
                listing |= a.contains('l');
                true
            } else {
                form.sub == "tag" && a.strip_prefix("-n").is_some_and(|n| n.chars().all(|c| c.is_ascii_digit()))
            }
        } else {
            let allowed = listing || wants_value;
            wants_value = false;
            allowed
        };
        if !ok {
            return Err(refuse(format!("git {} {a:?} is refused: only the listing form is available.", form.sub)));
        }
    }
    Ok(listing)
}

fn check_branch(rest: &[String]) -> Result<(), String> {
    const FORM: ListForm = ListForm {
        sub: "branch",
        flags: &["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current"],
        values: &["--contains", "--merged", "--no-merged"],
        prefixed: &["--sort="],
        cluster: "arvl",
    };
    check_list_form(&FORM, rest).map(|_| ())
}

fn check_tag(rest: &[String]) -> Result<(), String> {
    const FORM: ListForm = ListForm {
        sub: "tag",
        flags: &["-i", "--ignore-case", "--no-column"],
        values: &["--contains", "--no-contains", "--merged", "--no-merged", "--points-at"],
        prefixed: &["--sort=", "--format=", "--column="],
        cluster: "il",
    };
    if check_list_form(&FORM, rest)? {
        Ok(())
    } else {
        Err(refuse("git tag without --list would create or change a tag.".into()))
    }
}

fn check_worktree(rest: &[String]) -> Result<(), String> {
    match rest.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["list"] | ["list", "--porcelain"] => Ok(()),
        _ => Err(refuse("git worktree is only available as `worktree list` (with --porcelain, if you like).".into())),
    }
}

// MARK: - Which repository

/// The directory git runs in: `asked` (an absolute path) or the agent's own folder, resolved through any links, and only
/// when it is that folder or shares its git directory (`git rev-parse --git-common-dir`): the user's linked worktrees
/// and Lantern's review copies of the project. A folder of another repository is refused, since its config could run
/// programs, and so is a link that leads to one.
pub fn resolve_repo(own: &Path, asked: Option<&str>, path_env: Option<&str>) -> Result<PathBuf, String> {
    let own = std::fs::canonicalize(own).map_err(|e| format!("The agent's own folder can't be read: {e}"))?;
    let Some(asked) = asked else { return Ok(own) };
    if !Path::new(asked).is_absolute() {
        return Err(format!("`repo` is an absolute path, or left out for your own folder ({}).", own.display()));
    }
    let dir = std::fs::canonicalize(asked).map_err(|_| format!("{asked} is not a folder that exists."))?;
    if !dir.is_dir() {
        return Err(format!("{asked} is not a folder."));
    }
    if dir == own {
        return Ok(dir);
    }
    match (common_dir(&own, path_env), common_dir(&dir, path_env)) {
        (Some(mine), Some(theirs)) if mine == theirs => Ok(dir),
        _ => Err(format!("{} is not in this project's repository. The git tool works in your own folder ({}) and in the worktrees of the same project.", dir.display(), own.display())),
    }
}

/// The git directory `dir`'s repository shares with its linked worktrees, from git itself; None when it isn't in one.
fn common_dir(dir: &Path, path_env: Option<&str>) -> Option<PathBuf> {
    let out = execute(dir, &["rev-parse".into(), "--git-common-dir".into()], path_env, Duration::from_secs(10)).ok()?;
    if out.status != Some(0) {
        return None;
    }
    let printed = String::from_utf8_lossy(&out.stdout).trim().to_string();
    std::fs::canonicalize(dir.join(printed)).ok()
}

// MARK: - Running it

/// A tool call's input: `{"args": ["diff", "main...x", "--stat"], "repo": "/optional/absolute/path"}`. Returns what the
/// model reads, or why the call was refused.
pub fn call(scope: &Scope, input: &Value) -> Result<String, String> {
    let args: Vec<String> = input["args"]
        .as_array()
        .and_then(|list| list.iter().map(|a| a.as_str().map(String::from)).collect())
        .ok_or_else(|| refuse("`args` is an array of strings, one per argument, such as [\"log\", \"--oneline\", \"-5\"]; it is never one string.".into()))?;
    let asked = match &input["repo"] {
        Value::Null => None,
        Value::String(s) => Some(s.as_str()),
        _ => return Err("`repo` is an absolute path, or left out for your own folder.".into()),
    };
    // Validated first: a refused command never gets as far as running git to look at a folder.
    validate(&args)?;
    let repo = resolve_repo(&scope.folder, asked, scope.path_env.as_deref())?;
    run(&repo, &args, scope.path_env.as_deref())
}

/// `args` as `validate` takes them, run in `repo` (see `resolve_repo`): git's output as the model reads it.
pub fn run(repo: &Path, args: &[String], path_env: Option<&str>) -> Result<String, String> {
    run_within(repo, args, path_env, TIMEOUT)
}

fn run_within(repo: &Path, args: &[String], path_env: Option<&str>, limit: Duration) -> Result<String, String> {
    let argv = validate(args)?;
    // `blame` has no `--no-textconv`, and runs the program a repository's config names as a file's textconv driver.
    if argv[0] == "blame" && has_textconv_driver(repo, path_env) {
        return Err(refuse("git blame is refused in a repository whose config sets a textconv driver (diff.<name>.textconv), which blame would run.".into()));
    }
    let out = execute(repo, &argv, path_env, limit)?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.stderr.is_empty() {
        let room = MAX_OUTPUT.saturating_sub(out.stdout.len());
        let stderr = String::from_utf8_lossy(&out.stderr[..out.stderr.len().min(room)]);
        if !stderr.trim().is_empty() {
            text.push_str(&format!("\n[stderr]\n{}", stderr.trim_end()));
        }
    }
    if out.status != Some(0) {
        text.push_str(&format!("\n[git exited with {}]", out.status.map_or("a signal".to_string(), |c| format!("status {c}"))));
    }
    if out.cut {
        text.push_str(&format!("\n[output cut at {} KB]", MAX_OUTPUT / 1024));
    }
    Ok(if text.is_empty() { "(no output)".into() } else { text })
}

/// Whether the repository's config names a textconv driver. When git can't say, it is taken that one is there.
fn has_textconv_driver(repo: &Path, path_env: Option<&str>) -> bool {
    let list = ["config".to_string(), "--name-only".into(), "--get-regexp".into(), r"^diff\..*\.textconv$".into()];
    match execute(repo, &list, path_env, Duration::from_secs(10)) {
        Ok(out) => match out.status {
            Some(0) => !out.stdout.is_empty(),
            Some(1) => false,
            _ => true,
        },
        Err(_) => true,
    }
}

struct Output {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    status: Option<i32>,
    cut: bool,
}

/// The command that runs git in `repo` with `argv` after Lantern's own options. Nothing of the environment that git reads
/// is kept (every GIT_* variable of `inherited`, the names the process has, goes), the user's and the system's git config
/// are not read, and nothing here may start a program the repository's config names to watch the files
/// (`core.fsmonitor`), page the output or draw a diff. It has no stdin, and its own process group.
fn command(repo: &Path, argv: &[String], path_env: Option<&str>, inherited: &[OsString]) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo).args(["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "diff.external="]).args(argv);
    for name in inherited.iter().filter(|n| n.to_string_lossy().starts_with("GIT_")) {
        cmd.env_remove(name);
    }
    cmd.env("GIT_PAGER", "cat").env("PAGER", "cat").env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0").env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "/dev/null");
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    // Its own group, so stopping it stops what it started.
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    cmd
}

/// Runs `command` for `limit` at most, keeping up to MAX_OUTPUT of each of its outputs.
fn execute(repo: &Path, argv: &[String], path_env: Option<&str>, limit: Duration) -> Result<Output, String> {
    let inherited: Vec<OsString> = std::env::vars_os().map(|(name, _)| name).collect();
    let mut child = command(repo, argv, path_env, &inherited).spawn().map_err(|e| format!("Could not run git: {e}"))?;
    let pid = child.id();
    let over = Arc::new(AtomicBool::new(false));
    let take = |pipe: Option<Box<dyn Read + Send>>| {
        let kept = Arc::new(Mutex::new(Vec::<u8>::new()));
        let (buf, over) = (kept.clone(), over.clone());
        let reader = std::thread::spawn(move || {
            let Some(mut pipe) = pipe else { return };
            let mut chunk = [0u8; 16 * 1024];
            while let Ok(n) = pipe.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let mut buf = buf.lock().unwrap();
                let room = MAX_OUTPUT.saturating_sub(buf.len());
                buf.extend_from_slice(&chunk[..n.min(room)]);
                if n > room {
                    over.store(true, Ordering::SeqCst);
                    break;
                }
            }
        });
        (kept, reader)
    };
    let (stdout, out_reader) = take(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let (stderr, err_reader) = take(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let started = Instant::now();
    let stop = |child: &mut std::process::Child| {
        unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
        let _ = child.wait();
    };
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if over.load(Ordering::SeqCst) => {
                stop(&mut child);
                break None;
            }
            Ok(None) if started.elapsed() > limit => {
                stop(&mut child);
                return Err(format!("git {} took longer than {} seconds and was stopped.", argv.first().map_or("", String::as_str), limit.as_secs_f64()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(format!("Could not run git: {e}")),
        }
    };
    // The pipes close with git. One that a stray process kept open is let go after a moment, with what it printed so far.
    for reader in [out_reader, err_reader] {
        let waited = Instant::now();
        while !reader.is_finished() && waited.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    let (stdout, stderr) = (stdout.lock().unwrap().clone(), stderr.lock().unwrap().clone());
    Ok(Output { stdout, stderr, status, cut: over.load(Ordering::SeqCst) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn refused(list: &[&str]) -> String {
        validate(&args(list)).expect_err(&format!("{list:?} was allowed"))
    }

    fn allowed(list: &[&str]) -> Vec<String> {
        validate(&args(list)).unwrap_or_else(|e| panic!("{list:?} was refused: {e}"))
    }

    #[test]
    fn a_read_only_command_is_passed_on_with_the_drivers_that_run_programs_switched_off() {
        assert_eq!(allowed(&["diff", "main...x", "--stat"]), ["diff", "--no-ext-diff", "--no-textconv", "main...x", "--stat"]);
        assert_eq!(allowed(&["log", "--oneline", "-5"]), ["log", "--no-ext-diff", "--no-textconv", "--oneline", "-5"]);
        assert_eq!(allowed(&["show", "HEAD:path"]), ["show", "--no-ext-diff", "--no-textconv", "HEAD:path"]);
        assert_eq!(allowed(&["status", "--short"]), ["status", "--short"]);
        assert_eq!(allowed(&["branch", "--list"]), ["branch", "--list"]);
        assert_eq!(allowed(&["tag", "-l"]), ["tag", "-l"]);
        assert_eq!(allowed(&["worktree", "list", "--porcelain"]), ["worktree", "list", "--porcelain"]);
        assert_eq!(allowed(&["grep", "-n", "foo", "--", "src"]), ["grep", "-n", "foo", "--", "src"]);
        for sub in LOOKING {
            allowed(&[sub]);
        }
        allowed(&["branch"]);
        allowed(&["branch", "-a", "-vv"]);
        allowed(&["branch", "--contains", "abc123", "--list", "feat/*"]);
        allowed(&["branch", "--merged", "main", "--sort=-committerdate"]);
        allowed(&["branch", "--show-current"]);
        allowed(&["tag", "--list", "v1.*", "-n5", "--sort=-v:refname"]);
        allowed(&["tag", "-l", "--contains", "HEAD~3"]);
        allowed(&["tag", "--points-at", "HEAD", "--list"]);
        // A pattern, a path or a revision that starts like an option sits after `--`, where nothing is looked at.
        allowed(&["log", "--", "--output=x"]);
        allowed(&["diff", "HEAD", "--", "-O"]);
    }

    #[test]
    fn an_option_that_writes_a_file_or_runs_a_program_is_refused_even_abbreviated_or_in_a_cluster() {
        for hostile in [
            vec!["diff", "--output=/tmp/x"],
            vec!["diff", "--output", "/tmp/x"],
            vec!["log", "--outp=/tmp/x"],
            vec!["log", "--out=/tmp/x"],
            vec!["log", "--ou"],
            vec!["log", "--ext-diff"],
            vec!["log", "--ext=x"],
            vec!["show", "--textconv", "HEAD:a"],
            vec!["show", "--text"],
            vec!["diff", "--exec=sh"],
            vec!["grep", "-O", "x"],
            vec!["grep", "-nO", "x"],
            vec!["grep", "-Oless", "x"],
            vec!["grep", "--open-files-in-pager", "x"],
            vec!["grep", "--open=less", "x"],
            vec!["grep", "-f", "/etc/passwd"],
            vec!["grep", "--file=/etc/passwd", "x"],
            vec!["grep", "--no-index", "x", "/etc"],
            vec!["diff", "--no-index", "/etc/passwd", "/dev/null"],
            vec!["blame", "--contents", "/etc/passwd", "a"],
            vec!["ls-files", "--upload-pack=x"],
            vec!["rev-list", "--receive-pack=x", "HEAD"],
            vec!["log", "--git-dir=/other/.git"],
            vec!["log", "--work-tree=/other"],
            vec!["log", "--exec-path=/other"],
            vec!["log", "--config-env=core.pager=X"],
            vec!["log", "--namespace=x"],
            vec!["log", "--out"],
        ] {
            let why = refused(&hostile);
            assert!(why.contains("refused") && why.contains("Only read-only git is available"), "{hostile:?}: {why}");
        }
    }

    #[test]
    fn nothing_may_come_before_the_subcommand_and_only_the_read_only_ones_are_there() {
        for hostile in [
            vec!["-c", "core.pager=sh", "log"],
            vec!["-C", "/other", "log"],
            vec!["--git-dir=/x/.git", "log"],
            vec!["--exec-path=/x", "log"],
            vec!["--work-tree=/x", "status"],
            vec!["--config-env=a=B", "log"],
            vec!["--namespace=x", "log"],
            vec!["-p", "log"],
        ] {
            assert!(refused(&hostile).contains("subcommand"), "{hostile:?}");
        }
        for sub in ["config", "cat-file", "format-patch", "archive", "bundle", "remote", "stash", "checkout", "commit", "push", "fetch", "reset", "add", "rm", "clean", "gc", "fsck", "notes", "reflog", "var", "init", "clone", "apply", "am", "submodule", "sh", "frobnicate", ""] {
            assert!(refused(&[sub]).contains("is not available"), "{sub}");
        }
    }

    #[test]
    fn empty_arguments_and_ones_git_is_never_given_are_refused() {
        assert!(refused(&[]).contains("`args` is empty"));
        assert!(refused(&["log", "a\nb"]).contains("line break"));
        assert!(refused(&["log", "a\0b"]).contains("NUL"));
        assert!(refused(&["log", "--format=%H\rx"]).contains("line break"));
        // Also after `--`, where options are not looked at.
        assert!(refused(&["log", "--", "x\ny"]).contains("line break"));
        let many = vec!["x"; MAX_ARGS];
        assert!(validate(&args(&[&["log"][..], &many].concat())).is_err());
        assert!(validate(&args(&["log", &"x".repeat(MAX_ARG_LEN + 1)])).is_err());
    }

    #[test]
    fn branch_tag_and_worktree_are_only_their_listing_forms() {
        for hostile in [
            vec!["branch", "newname"],
            vec!["branch", "-d", "x"],
            vec!["branch", "-D", "x"],
            vec!["branch", "-m", "a", "b"],
            vec!["branch", "--delete", "x"],
            vec!["branch", "--list", "-d", "x"],
            vec!["branch", "-u", "origin/x"],
            vec!["branch", "--set-upstream-to=origin/x"],
            vec!["branch", "--force", "x", "HEAD"],
            vec!["branch", "--edit-description"],
            vec!["branch", "--contains", "abc", "newname"],
            vec!["branch", "-ad"],
            vec!["tag", "v1"],
            vec!["tag", "-d", "x"],
            vec!["tag", "v1", "HEAD"],
            vec!["tag", "-a", "v1", "-m", "x"],
            vec!["tag", "-s", "v1"],
            vec!["tag", "--list", "-d", "v1"],
            vec!["tag", "-f", "-l", "x"],
            vec!["tag"],
            vec!["tag", "--contains", "HEAD"],
            vec!["worktree", "add", "x"],
            vec!["worktree", "remove", "x"],
            vec!["worktree", "prune"],
            vec!["worktree", "list", "--porcelain", "x"],
            vec!["worktree", "list", "-z"],
            vec!["worktree"],
        ] {
            assert!(refused(&hostile).contains("Only read-only git is available"), "{hostile:?}");
        }
    }

    // MARK: - Which repository

    fn git_in(dir: &Path, list: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"])
            .args(list)
            .env_remove("GIT_DIR")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {list:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A repository with one commit, `a.txt` and a line saying what it is.
    fn repo(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        git_in(dir, &["init", "-q"]);
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        git_in(dir, &["add", "."]);
        git_in(dir, &["commit", "-q", "-m", "first commit"]);
    }

    fn scratch() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        (dir, root)
    }

    #[test]
    fn the_git_tool_runs_in_its_own_folder_and_the_worktrees_of_its_project_and_nowhere_else() {
        let (_keep, root) = scratch();
        let (project, other) = (root.join("project"), root.join("other"));
        repo(&project);
        repo(&other);
        git_in(&project, &["worktree", "add", "-q", "-b", "feat", root.join("linked").to_str().unwrap()]);
        let linked = root.join("linked");
        std::os::unix::fs::symlink(&other, root.join("link-to-other")).unwrap();
        std::os::unix::fs::symlink(&project, root.join("link-to-project")).unwrap();
        fs::create_dir_all(project.join("sub")).unwrap();
        let ask = |own: &Path, repo: Option<&str>| resolve_repo(own, repo, None);
        let text = |p: &Path| p.to_str().unwrap().to_string();

        // Its own folder, whether it says so or not; a folder inside it; a linked worktree of the project, from either side.
        assert_eq!(ask(&project, None).unwrap(), project);
        assert_eq!(ask(&project, Some(&text(&project))).unwrap(), project);
        assert_eq!(ask(&project, Some(&text(&project.join("sub")))).unwrap(), project.join("sub"));
        assert_eq!(ask(&project, Some(&text(&linked))).unwrap(), linked);
        assert_eq!(ask(&linked, Some(&text(&project))).unwrap(), project);
        // A link that stays in the project is the folder it leads to.
        assert_eq!(ask(&project, Some(&text(&root.join("link-to-project")))).unwrap(), project);

        // Another repository, a link that leads to one, a folder that is no repository, a file, a path that isn't there, a
        // relative path.
        for (own, asked) in [(&project, &other), (&project, &root.join("link-to-other")), (&project, &root), (&project, &project.join("a.txt")), (&project, &root.join("nope")), (&linked, &other)] {
            assert!(ask(own, Some(&text(asked))).is_err(), "{}", asked.display());
        }
        assert!(ask(&project, Some("other")).unwrap_err().contains("absolute"));
        assert!(ask(&project, Some("/")).unwrap_err().contains("not in this project's repository"));
        // The agent's own folder, if it is not a repository, is the one place it may ask.
        let plain = root.join("plain");
        fs::create_dir_all(&plain).unwrap();
        assert_eq!(ask(&plain, None).unwrap(), plain);
        assert!(ask(&plain, Some(&text(&other))).is_err());
    }

    #[test]
    fn a_call_names_its_arguments_as_a_list_and_its_repository_as_a_path() {
        let (_keep, root) = scratch();
        let (project, other) = (root.join("project"), root.join("other"));
        repo(&project);
        repo(&other);
        let scope = Scope { folder: project.clone(), path_env: None };
        let log = call(&scope, &serde_json::json!({"args": ["log", "--oneline"]})).unwrap();
        assert!(log.contains("first commit"), "{log}");
        // A string, not a list; something other than strings in it; a repository that isn't the project's.
        for bad in [serde_json::json!({"args": "log --oneline"}), serde_json::json!({"args": ["log", 5]}), serde_json::json!({}), serde_json::json!({"args": ["log"], "repo": 5})] {
            assert!(call(&scope, &bad).is_err(), "{bad}");
        }
        let elsewhere = call(&scope, &serde_json::json!({"args": ["log"], "repo": other.to_str().unwrap()}));
        assert!(elsewhere.unwrap_err().contains("not in this project's repository"));
    }

    // MARK: - Running it

    fn run_args(repo: &Path, list: &[&str]) -> Result<String, String> {
        run(repo, &args(list), None)
    }

    #[test]
    fn it_returns_what_git_printed_with_its_errors_after_and_says_when_git_failed() {
        let (_keep, root) = scratch();
        repo(&root);
        assert!(run_args(&root, &["log", "--oneline"]).unwrap().contains("first commit"));
        assert!(run_args(&root, &["show", "HEAD:a.txt"]).unwrap().starts_with("one"));
        assert_eq!(run_args(&root, &["status", "--short"]).unwrap(), "(no output)");
        assert!(run_args(&root, &["branch", "--list"]).unwrap().contains("main"));
        assert!(run_args(&root, &["branch", "--show-current"]).unwrap().contains("main"));
        assert!(run_args(&root, &["worktree", "list", "--porcelain"]).unwrap().contains("worktree "));
        assert!(run_args(&root, &["blame", "a.txt"]).unwrap().contains("(t "));
        fs::write(root.join("a.txt"), "two\n").unwrap();
        let diff = run_args(&root, &["diff"]).unwrap();
        assert!(diff.contains("-one") && diff.contains("+two"), "{diff}");
        assert!(run_args(&root, &["diff", "--stat"]).unwrap().contains("a.txt"));
        assert!(run_args(&root, &["grep", "-n", "two", "--", "a.txt"]).unwrap().contains("a.txt:1:two"));
        let bad = run_args(&root, &["show", "nosuchrevision"]).unwrap();
        assert!(bad.contains("[stderr]") && bad.contains("unknown revision") && bad.contains("[git exited with status 128]"), "{bad}");
        // What is refused never runs.
        assert!(run_args(&root, &["branch", "created"]).is_err());
        assert!(run_args(&root, &["branch", "--list"]).unwrap().lines().count() == 1);
    }

    #[test]
    fn an_option_that_would_write_a_file_does_not_write_it() {
        let (_keep, root) = scratch();
        repo(&root);
        let target = root.join("written.txt");
        for hostile in [vec!["diff", "HEAD", &format!("--output={}", target.display())], vec!["log", &format!("--outp={}", target.display())]] {
            assert!(run(&root, &args(&hostile), None).is_err());
        }
        assert!(!target.exists());
    }

    /// An executable that makes `marker` when run, and its path.
    fn marker_script(root: &Path, name: &str, marker: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = root.join(name);
        fs::write(&script, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    /// Whether the plain git (no Lantern options) runs `marker`'s program doing `list`: so a test that says it does not run
    /// under Lantern is shown to be one that would have caught it.
    fn plain_git_runs_it(repo: &Path, marker: &Path, list: &[&str]) -> bool {
        let _ = fs::remove_file(marker);
        let _ = Command::new("git").arg("-C").arg(repo).args(list).env("GIT_PAGER", "cat").output().unwrap();
        let ran = marker.exists();
        let _ = fs::remove_file(marker);
        ran
    }

    #[test]
    fn a_configured_fsmonitor_is_not_run_by_status_or_diff() {
        let (_keep, scratch) = scratch();
        let (project, tools) = (scratch.join("project"), scratch.join("tools"));
        fs::create_dir_all(&tools).unwrap();
        repo(&project);
        let marker = tools.join("fsmonitor-ran");
        let script = marker_script(&tools, "fsmonitor.sh", &marker);
        let config = project.join(".git/config");
        fs::write(&config, format!("{}[core]\n\tfsmonitor = {}\n", fs::read_to_string(&config).unwrap(), script.display())).unwrap();
        fs::write(project.join("a.txt"), "changed\n").unwrap();
        assert!(plain_git_runs_it(&project, &marker, &["status"]), "git doesn't run the fsmonitor on this machine, so this test can't tell");
        for list in [&["status"][..], &["diff"], &["status", "--short"], &["log", "-p"], &["diff", "--stat"], &["ls-files", "-m"]] {
            run_args(&project, list).unwrap();
            assert!(!marker.exists(), "git {list:?} ran the fsmonitor");
        }
    }

    #[test]
    fn a_diff_driver_that_runs_a_program_is_not_run_by_diff_log_show_grep_or_blame() {
        for (driver, config) in [("external", "[diff]\n\texternal = {}\n"), ("textconv", "[diff \"conv\"]\n\ttextconv = {}\n")] {
            let (_keep, scratch) = scratch();
            let (project, tools) = (scratch.join("project"), scratch.join("tools"));
            fs::create_dir_all(&tools).unwrap();
            repo(&project);
            let marker = tools.join("ran");
            let script = marker_script(&tools, "driver.sh", &marker);
            let path = project.join(".git/config");
            fs::write(&path, format!("{}{}", fs::read_to_string(&path).unwrap(), config.replace("{}", &script.display().to_string()))).unwrap();
            fs::write(project.join(".gitattributes"), "*.txt diff=conv\n").unwrap();
            git_in(&project, &["add", ".gitattributes"]);
            git_in(&project, &["commit", "-q", "-m", "attributes"]);
            fs::write(project.join("a.txt"), "changed\n").unwrap();
            assert!(plain_git_runs_it(&project, &marker, &["diff"]), "git doesn't run a {driver} driver here, so this test can't tell");
            for list in [&["diff"][..], &["diff", "HEAD"], &["log", "-p"], &["show", "HEAD~1"], &["show", "HEAD"], &["diff", "--stat"], &["log", "--stat", "-p", "-3"], &["grep", "chang", "--", "a.txt"]] {
                run_args(&project, list).unwrap();
                assert!(!marker.exists(), "git {list:?} ran the {driver} driver");
            }
            // `blame` can't be told not to run a textconv driver, so it is refused where the config has one.
            let blame = run_args(&project, &["blame", "a.txt"]);
            assert_eq!(blame.is_err(), driver == "textconv", "{blame:?}");
            assert!(!marker.exists(), "git blame ran the {driver} driver");
        }
    }

    #[test]
    fn output_past_the_cap_is_cut_and_says_so() {
        let (_keep, root) = scratch();
        repo(&root);
        fs::write(root.join("big.txt"), format!("{}\n", "line of text\n".repeat(30_000))).unwrap();
        git_in(&root, &["add", "."]);
        git_in(&root, &["commit", "-q", "-m", "big"]);
        let out = run_args(&root, &["show", "HEAD:big.txt"]).unwrap();
        assert!(out.ends_with("\n[output cut at 256 KB]"), "{}", &out[out.len().saturating_sub(80)..]);
        assert!(out.len() <= MAX_OUTPUT + 100, "{}", out.len());
        assert!(out.starts_with("line of text"));
        // A small answer isn't marked.
        assert!(!run_args(&root, &["log", "--oneline"]).unwrap().contains("cut"));
    }

    #[test]
    fn a_command_that_takes_too_long_is_killed_with_what_it_started() {
        let (_keep, root) = scratch();
        repo(&root);
        // The slow work is a clean filter, which `diff` runs on a changed file to read it as the index would have it.
        let config = root.join(".git/config");
        fs::write(&config, format!("{}[filter \"slow\"]\n\tclean = sleep 20; cat\n", fs::read_to_string(&config).unwrap())).unwrap();
        fs::write(root.join(".gitattributes"), "*.txt filter=slow\n").unwrap();
        fs::write(root.join("a.txt"), "a longer line than before\n").unwrap();
        let started = Instant::now();
        let err = run_within(&root, &args(&["diff"]), None, Duration::from_millis(500)).unwrap_err();
        assert!(err.contains("took longer than 0.5 seconds"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(10), "waited for the filter: {:?}", started.elapsed());
    }

    #[test]
    fn git_is_run_with_none_of_the_environment_that_would_redirect_it_and_the_config_it_pins() {
        let inherited: Vec<OsString> = ["GIT_DIR", "GIT_EXTERNAL_DIFF", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_SSH_COMMAND", "HOME", "PATH"].iter().map(OsString::from).collect();
        let cmd = command(Path::new("/some/repo"), &args(&["log", "--no-ext-diff", "-1"]), Some("/usr/bin:/bin"), &inherited);
        let envs: std::collections::HashMap<String, Option<String>> = cmd.get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect();
        for gone in ["GIT_DIR", "GIT_EXTERNAL_DIFF", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_SSH_COMMAND"] {
            assert_eq!(envs.get(gone), Some(&None), "{gone} reaches git");
        }
        assert!(!envs.contains_key("HOME"), "HOME is left as it is");
        for (name, value) in [("GIT_PAGER", "cat"), ("PAGER", "cat"), ("GIT_TERMINAL_PROMPT", "0"), ("GIT_OPTIONAL_LOCKS", "0"), ("GIT_CONFIG_NOSYSTEM", "1"), ("GIT_CONFIG_GLOBAL", "/dev/null"), ("PATH", "/usr/bin:/bin")] {
            assert_eq!(envs.get(name), Some(&Some(value.to_string())), "{name}");
        }
        let argv: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(argv, ["-C", "/some/repo", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "diff.external=", "log", "--no-ext-diff", "-1"]);
    }
}
