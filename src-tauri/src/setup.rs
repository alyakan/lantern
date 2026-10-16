//! Per-project setup for a new worktree: a few command lines the user wrote in Lantern (`npm ci`, `cp "$LANTERN_PROJECT_DIR/.env" .env`),
//! run once in each worktree right after it is made, before its agent starts. And the project's "Run" command, started from a button.
//!
//! The lines come only from what the user saved in Lantern's own settings (the window sends them here, see `SetupStore`): never from
//! a file in the repository or the worktree, which an agent could edit, and never from anything an agent said. Each line runs as one
//! command through `/bin/sh -c`, with the new worktree as its folder, under a time limit, with its output kept short.

use crate::shell::kill_group;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::watch;

/// The most lines a project's setup may have, and the longest one (a line is a command, not a script).
pub const MAX_COMMANDS: usize = 20;
pub const MAX_LINE: usize = 2000;
/// How long one command may run before it is stopped.
pub const COMMAND_LIMIT: Duration = Duration::from_secs(600);
/// How much of a command's output is kept: the end of it, which is where an error is.
const TAIL_BYTES: usize = 16 * 1024;
/// How often the card is told what the command printed last.
const LINE_EVERY: Duration = Duration::from_millis(400);

/// What the user saved for a project: the lines run in each new worktree, and the command its Run button starts.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct ProjectSetup {
    pub commands: Vec<String>,
    pub run: Option<String>,
}

fn check_line(line: &str) -> Result<String, String> {
    let line = line.trim();
    if line.chars().count() > MAX_LINE {
        return Err(format!("A line is longer than {MAX_LINE} characters."));
    }
    // One line is one command: a line break would be a second one the user never saw as its own line.
    if line.chars().any(|c| c.is_control() && c != '\t') {
        return Err("A line has a control character in it.".into());
    }
    Ok(line.to_string())
}

impl ProjectSetup {
    /// The same, trimmed and without blank lines, or why it can't be used.
    pub fn checked(self) -> Result<Self, String> {
        let mut commands = Vec::new();
        for line in &self.commands {
            let line = check_line(line)?;
            if !line.is_empty() {
                commands.push(line);
            }
        }
        if commands.len() > MAX_COMMANDS {
            return Err(format!("A project's setup has at most {MAX_COMMANDS} lines."));
        }
        let run = match self.run {
            Some(r) => Some(check_line(&r)?).filter(|r| !r.is_empty()),
            None => None,
        };
        Ok(Self { commands, run })
    }

    fn is_empty(&self) -> bool {
        self.commands.is_empty() && self.run.is_none()
    }
}

/// What every project's setup is, as the window last sent it (it keeps them: this is the copy the backend reads when an
/// agent starts, which the window isn't asked about).
#[derive(Default)]
pub struct SetupStore {
    by_folder: Mutex<HashMap<PathBuf, ProjectSetup>>,
}

/// A folder as the store knows it: the real path when there is one (so a link to it finds the same entry).
fn key(folder: &Path) -> PathBuf {
    folder.canonicalize().unwrap_or_else(|_| folder.to_path_buf())
}

impl SetupStore {
    pub fn set(&self, folder: &Path, setup: ProjectSetup) -> Result<(), String> {
        if !folder.is_absolute() {
            return Err("The project's folder isn't a full path.".into());
        }
        let setup = setup.checked()?;
        let mut all = self.by_folder.lock().unwrap();
        if setup.is_empty() {
            all.remove(&key(folder));
        } else {
            all.insert(key(folder), setup);
        }
        Ok(())
    }

    pub fn get(&self, folder: &Path) -> ProjectSetup {
        self.by_folder.lock().unwrap().get(&key(folder)).cloned().unwrap_or_default()
    }
}

/// What a project's files suggest: lines for the setup, and a command to run. Only suggested: the user saves them.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Suggestion {
    pub commands: Vec<String>,
    pub run: Option<String>,
}

pub fn detect(folder: &Path) -> Suggestion {
    let has = |name: &str| folder.join(name).is_file();
    let mut found = Suggestion::default();
    // The package manager the lock file says; one is enough.
    let node = if has("pnpm-lock.yaml") {
        Some(("pnpm install --frozen-lockfile", "pnpm run"))
    } else if has("yarn.lock") {
        Some(("yarn install --frozen-lockfile", "yarn"))
    } else if has("package-lock.json") {
        Some(("npm ci", "npm run"))
    } else {
        None
    };
    if let Some((install, runner)) = node {
        found.commands.push(install.into());
        found.run = dev_script(folder).map(|s| format!("{runner} {s}"));
    }
    if has("requirements.txt") {
        found.commands.push("pip install -r requirements.txt".into());
    }
    found
}

/// The script a project starts its app with: "dev", else "start". The name is only used when it is a plain word.
fn dev_script(folder: &Path) -> Option<&'static str> {
    let text = std::fs::read_to_string(folder.join("package.json")).ok().filter(|t| t.len() < 1 << 20)?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    ["dev", "start"].into_iter().find(|name| json["scripts"][*name].is_string())
}

/// Setup commands being run, by process group, so quitting Lantern ends them.
static ACTIVE: Mutex<Option<HashSet<i32>>> = Mutex::new(None);

fn track(pgid: i32, on: bool) {
    let mut active = ACTIVE.lock().unwrap();
    let set = active.get_or_insert_with(HashSet::new);
    if on {
        set.insert(pgid);
    } else {
        set.remove(&pgid);
    }
}

/// Lantern is quitting: whatever setup is running stops with it.
pub fn stop_all() {
    let groups: Vec<i32> = ACTIVE.lock().unwrap().take().map(|s| s.into_iter().collect()).unwrap_or_default();
    for g in groups {
        unsafe { libc::kill(-g, libc::SIGKILL) };
    }
}

/// What a running setup tells the card.
#[derive(Debug, Clone, PartialEq)]
pub enum Progress {
    /// Command number `index` (from 0) of `total` is starting.
    Started { index: usize, total: usize, command: String },
    /// What it printed last.
    Line { index: usize, line: String },
}

/// Why setup stopped before its end, for the card.
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub index: usize,
    pub command: String,
    /// "it exited with code 1", "it took longer than 10 minutes and was stopped"…
    pub reason: String,
    /// The last lines of what it printed.
    pub tail: String,
    /// The user stopped it (not the command's doing).
    pub cancelled: bool,
}

/// Where and how setup runs.
pub struct Env<'a> {
    /// The new worktree: every command's folder, and nowhere else.
    pub folder: &'a Path,
    /// The user's own checkout, for lines that copy something from it (`$LANTERN_PROJECT_DIR`).
    pub project: &'a Path,
    pub path_env: Option<&'a str>,
    pub limit: Duration,
}

/// The end of what a command printed, kept as it comes.
#[derive(Default)]
struct Tail {
    bytes: Vec<u8>,
    /// Counts what was added, so a reader can tell whether there is anything new.
    added: u64,
}

impl Tail {
    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        self.added += chunk.len() as u64;
        if self.bytes.len() > TAIL_BYTES * 2 {
            let cut = self.bytes.len() - TAIL_BYTES;
            self.bytes.drain(..cut);
        }
    }

    fn text(&self) -> String {
        let from = self.bytes.len().saturating_sub(TAIL_BYTES);
        plain(&String::from_utf8_lossy(&self.bytes[from..]))
    }
}

/// Text without the colour and cursor codes a tool prints.
fn plain(text: &str) -> String {
    static ANSI: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let ansi = ANSI.get_or_init(|| regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07").expect("a valid pattern"));
    ansi.replace_all(text, "").replace("\r\n", "\n")
}

/// The last thing printed, one line: a progress bar redraws its line with carriage returns, so those end lines too.
fn last_line(text: &str) -> String {
    let line = text.split(['\n', '\r']).map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("");
    if line.chars().count() > 120 {
        format!("{}…", line.chars().take(120).collect::<String>())
    } else {
        line.to_string()
    }
}

/// The last lines of `text`, for a failure card.
fn last_lines(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').map(str::trim_end).collect();
    let lines: Vec<&str> = lines.iter().rev().skip_while(|l| l.is_empty()).take(15).copied().collect();
    let joined = lines.into_iter().rev().map(|l| if l.chars().count() > 300 { format!("{}…", l.chars().take(300).collect::<String>()) } else { l.to_string() }).collect::<Vec<_>>().join("\n");
    let chars = joined.chars().count();
    if chars > 3000 {
        joined.chars().skip(chars - 3000).collect()
    } else {
        joined
    }
}

fn minutes(limit: Duration) -> String {
    let secs = limit.as_secs();
    if secs >= 120 && secs.is_multiple_of(60) {
        format!("{} minutes", secs / 60)
    } else if secs == 60 {
        "a minute".into()
    } else if secs == 1 {
        "a second".into()
    } else {
        format!("{secs} seconds")
    }
}

/// Resolves once the user cancels (never, if nobody can any more).
async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow() {
            return;
        }
        if cancel.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// Runs the lines in order, in the worktree, and stops at the first that fails. `Err` says which, and why.
pub async fn run_all(commands: &[String], env: &Env<'_>, cancel: &mut watch::Receiver<bool>, progress: &(dyn Fn(Progress) + Send + Sync)) -> Result<(), Failure> {
    for (index, command) in commands.iter().enumerate() {
        progress(Progress::Started { index, total: commands.len(), command: command.clone() });
        run_one(index, command, env, cancel, progress).await?;
    }
    Ok(())
}

async fn run_one(index: usize, command: &str, env: &Env<'_>, cancel: &mut watch::Receiver<bool>, progress: &(dyn Fn(Progress) + Send + Sync)) -> Result<(), Failure> {
    let fail = |reason: String, tail: String, cancelled: bool| Failure { index, command: command.to_string(), reason, tail, cancelled };
    if *cancel.borrow() {
        return Err(fail("setup was stopped".into(), String::new(), true));
    }
    let mut cmd = Command::new("/bin/sh");
    // Its own process group, so stopping it also stops what it started. No terminal and nobody to type: what asks a question gets none.
    cmd.arg("-c")
        .arg(command)
        .current_dir(env.folder)
        .env("LANTERN_PROJECT_DIR", env.project)
        .env("TERM", "dumb")
        .env("NO_COLOR", "1")
        .env("CI", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    if let Some(p) = env.path_env {
        cmd.env("PATH", p);
    }
    let mut child = cmd.spawn().map_err(|e| fail(format!("it could not start: {e}"), String::new(), false))?;
    let pgid = child.id().ok_or_else(|| fail("it ended before it started".into(), String::new(), false))? as i32;
    track(pgid, true);

    let tail = Arc::new(Mutex::new(Tail::default()));
    let mut readers = Vec::new();
    for pipe in [child.stdout.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Send + Unpin>), child.stderr.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Send + Unpin>)].into_iter().flatten() {
        let tail = tail.clone();
        readers.push(tokio::spawn(async move {
            let mut pipe = pipe;
            let mut buf = [0u8; 8192];
            // Read to the end even when nothing is kept: a command that fills its pipe would otherwise wait for us.
            while let Ok(n) = pipe.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                tail.lock().unwrap().push(&buf[..n]);
            }
        }));
    }

    enum End {
        Exit(std::io::Result<std::process::ExitStatus>),
        Timeout,
        Cancel,
    }
    let deadline = tokio::time::sleep(env.limit);
    tokio::pin!(deadline);
    let mut tick = tokio::time::interval(LINE_EVERY);
    let mut told = 0;
    let end = loop {
        tokio::select! {
            status = child.wait() => break End::Exit(status),
            _ = &mut deadline => break End::Timeout,
            _ = cancelled(cancel) => break End::Cancel,
            _ = tick.tick() => {
                let (text, added) = {
                    let t = tail.lock().unwrap();
                    (if t.added == told { None } else { Some(t.text()) }, t.added)
                };
                if let Some(text) = text {
                    told = added;
                    let line = last_line(&text);
                    if !line.is_empty() {
                        progress(Progress::Line { index, line });
                    }
                }
            }
        }
    };
    let stopped = !matches!(end, End::Exit(_));
    if stopped {
        kill_group(pgid);
        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    }
    track(pgid, false);
    // What the command left running may hold its pipes open: a moment for the last of its output, then they are let go.
    for r in &mut readers {
        let _ = tokio::time::timeout(Duration::from_millis(500), &mut *r).await;
        r.abort();
    }
    let out = last_lines(&tail.lock().unwrap().text());
    match end {
        End::Exit(Ok(status)) if status.success() => Ok(()),
        End::Exit(Ok(status)) => Err(fail(
            match status.code() {
                Some(code) => format!("it exited with code {code}"),
                None => "it was ended by a signal".to_string(),
            },
            out,
            false,
        )),
        End::Exit(Err(e)) => Err(fail(format!("it could not be waited for: {e}"), out, false)),
        End::Timeout => Err(fail(format!("it took longer than {} and was stopped", minutes(env.limit)), out, false)),
        End::Cancel => Err(fail("setup was stopped".into(), out, true)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| s.to_string()).collect()
    }

    fn env<'a>(folder: &'a Path, project: &'a Path, limit: Duration) -> Env<'a> {
        Env { folder, project, path_env: None, limit }
    }

    async fn go(commands: &[&str], folder: &Path, limit: Duration) -> (Result<(), Failure>, Vec<Progress>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let (_tx, mut rx) = watch::channel(false);
        let project = folder.to_path_buf();
        let result = run_all(&lines(commands), &env(folder, &project, limit), &mut rx, &move |p| log.lock().unwrap().push(p)).await;
        let progress = seen.lock().unwrap().clone();
        (result, progress)
    }

    #[test]
    fn lines_are_trimmed_and_blank_ones_dropped() {
        let ok = ProjectSetup { commands: lines(&["  npm ci ", "", "   "]), run: Some("  npm run dev ".into()) }.checked().unwrap();
        assert_eq!(ok, ProjectSetup { commands: lines(&["npm ci"]), run: Some("npm run dev".into()) });
        assert_eq!(ProjectSetup { commands: vec![], run: Some("  ".into()) }.checked().unwrap().run, None);
    }

    #[test]
    fn a_line_that_is_really_two_or_too_long_is_refused() {
        assert!(ProjectSetup { commands: lines(&["echo a\nrm -rf x"]), run: None }.checked().is_err());
        assert!(ProjectSetup { commands: lines(&["echo \0"]), run: None }.checked().is_err());
        assert!(ProjectSetup { commands: vec![], run: Some("a\rb".into()) }.checked().is_err());
        assert!(ProjectSetup { commands: vec!["x".repeat(MAX_LINE + 1)], run: None }.checked().is_err());
        assert!(ProjectSetup { commands: vec!["x".into(); MAX_COMMANDS + 1], run: None }.checked().is_err());
        assert!(ProjectSetup { commands: vec!["x".into(); MAX_COMMANDS], run: None }.checked().is_ok());
    }

    #[test]
    fn the_store_keeps_a_setup_per_folder_and_forgets_an_empty_one() {
        let dir = tempfile::tempdir().unwrap();
        let store = SetupStore::default();
        store.set(dir.path(), ProjectSetup { commands: lines(&["npm ci"]), run: None }).unwrap();
        assert_eq!(store.get(dir.path()).commands, lines(&["npm ci"]));
        assert_eq!(store.get(Path::new("/nowhere/else")), ProjectSetup::default());
        store.set(dir.path(), ProjectSetup::default()).unwrap();
        assert_eq!(store.get(dir.path()), ProjectSetup::default());
        assert!(store.set(Path::new("relative"), ProjectSetup::default()).is_err());
    }

    #[test]
    fn a_project_is_suggested_what_its_lock_file_installs_with() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(detect(dir.path()), Suggestion::default());
        std::fs::write(dir.path().join("Cargo.toml"), "").unwrap();
        assert_eq!(detect(dir.path()), Suggestion::default(), "Cargo builds what it needs");
        std::fs::write(dir.path().join("package-lock.json"), "{}").unwrap();
        std::fs::write(dir.path().join("package.json"), r#"{"scripts":{"dev":"vite","start":"x"}}"#).unwrap();
        assert_eq!(detect(dir.path()), Suggestion { commands: lines(&["npm ci"]), run: Some("npm run dev".into()) });
        std::fs::write(dir.path().join("requirements.txt"), "").unwrap();
        assert_eq!(detect(dir.path()).commands, lines(&["npm ci", "pip install -r requirements.txt"]));
        std::fs::write(dir.path().join("yarn.lock"), "").unwrap();
        assert_eq!(detect(dir.path()).commands[0], "yarn install --frozen-lockfile");
        std::fs::write(dir.path().join("pnpm-lock.yaml"), "").unwrap();
        let found = detect(dir.path());
        assert_eq!(found.commands[0], "pnpm install --frozen-lockfile");
        assert_eq!(found.run.as_deref(), Some("pnpm run dev"));
    }

    #[test]
    fn a_script_name_is_only_read_from_a_package_file_that_has_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("package-lock.json"), "{}").unwrap();
        std::fs::write(dir.path().join("package.json"), "not json").unwrap();
        assert_eq!(detect(dir.path()).run, None);
        std::fs::write(dir.path().join("package.json"), r#"{"scripts":{"start":"node ."}}"#).unwrap();
        assert_eq!(detect(dir.path()).run.as_deref(), Some("npm run start"));
    }

    #[tokio::test]
    async fn lines_run_in_order_in_the_worktree_and_with_the_project_named() {
        let dir = tempfile::tempdir().unwrap();
        let (result, progress) = go(&["pwd > where.txt", "echo second >> order.txt", "echo \"$LANTERN_PROJECT_DIR\" > project.txt", "echo third >> order.txt"], dir.path(), COMMAND_LIMIT).await;
        assert_eq!(result, Ok(()));
        let here = dir.path().canonicalize().unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("where.txt")).unwrap().trim(), here.display().to_string());
        assert_eq!(std::fs::read_to_string(dir.path().join("order.txt")).unwrap(), "second\nthird\n");
        assert_eq!(std::fs::read_to_string(dir.path().join("project.txt")).unwrap().trim(), dir.path().display().to_string());
        let started: Vec<usize> = progress.iter().filter_map(|p| if let Progress::Started { index, .. } = p { Some(*index) } else { None }).collect();
        assert_eq!(started, vec![0, 1, 2, 3]);
    }

    #[tokio::test]
    async fn the_first_failure_stops_the_rest_and_says_what_it_printed() {
        let dir = tempfile::tempdir().unwrap();
        let (result, progress) = go(&["echo one > one.txt", "echo 'not good' >&2 && exit 3", "echo never > never.txt"], dir.path(), COMMAND_LIMIT).await;
        let failure = result.unwrap_err();
        assert_eq!((failure.index, failure.command.as_str(), failure.reason.as_str(), failure.cancelled), (1, "echo 'not good' >&2 && exit 3", "it exited with code 3", false));
        assert_eq!(failure.tail, "not good");
        assert!(dir.path().join("one.txt").exists());
        assert!(!dir.path().join("never.txt").exists(), "a line after a failed one ran");
        assert_eq!(progress.iter().filter(|p| matches!(p, Progress::Started { .. })).count(), 2);
    }

    #[tokio::test]
    async fn a_command_that_runs_too_long_is_stopped_with_what_it_started() {
        let dir = tempfile::tempdir().unwrap();
        let (result, _) = go(&["echo begun && sleep 30 & wait"], dir.path(), Duration::from_millis(600)).await;
        let failure = result.unwrap_err();
        assert!(failure.reason.starts_with("it took longer than"), "{failure:?}");
        assert!(failure.tail.contains("begun"));
        assert!(!failure.cancelled);
    }

    #[tokio::test]
    async fn a_stopped_command_takes_what_it_started_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let (result, _) = go(&["sleep 60 & echo $! > child.pid && wait"], dir.path(), Duration::from_millis(800)).await;
        assert!(result.is_err());
        let pid: i32 = std::fs::read_to_string(dir.path().join("child.pid")).unwrap().trim().parse().unwrap();
        for _ in 0..60 {
            let out = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
            let stat = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if stat.is_empty() || stat.starts_with('Z') {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("the command's child is still running after it was stopped");
    }

    #[tokio::test]
    async fn cancelling_stops_the_running_command_and_the_ones_after_it() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, mut rx) = watch::channel(false);
        let folder = dir.path().to_path_buf();
        let task = tokio::spawn(async move {
            let project = folder.clone();
            run_all(&lines(&["sleep 30", "echo after > after.txt"]), &env(&folder, &project, COMMAND_LIMIT), &mut rx, &|_| {}).await
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        tx.send(true).unwrap();
        let failure = tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap_err();
        assert!(failure.cancelled);
        assert_eq!(failure.index, 0);
        assert!(!dir.path().join("after.txt").exists());
    }

    #[tokio::test]
    async fn output_is_capped_to_its_end_and_a_flood_doesnt_stall_the_command() {
        let dir = tempfile::tempdir().unwrap();
        // About 6 MB, more than a pipe holds: it finishes only if the output is read as it comes.
        let (result, _) = go(&["i=0 && while [ $i -lt 60000 ]; do echo \"line number $i of the flood, padded out a bit more to be long......................................\"; i=$((i+1)); done && echo THE-END && exit 1"], dir.path(), COMMAND_LIMIT).await;
        let failure = result.unwrap_err();
        assert!(failure.tail.ends_with("THE-END"), "{}", failure.tail);
        assert!(failure.tail.len() <= 3000 * 4, "the tail grew to {} bytes", failure.tail.len());
        assert!(failure.tail.lines().count() <= 15);
    }

    #[tokio::test]
    async fn a_command_gets_no_input_to_wait_for() {
        let dir = tempfile::tempdir().unwrap();
        let (result, _) = go(&["read answer && echo \"got $answer\" > got.txt || echo none > got.txt"], dir.path(), Duration::from_secs(10)).await;
        assert_eq!(result, Ok(()));
        assert_eq!(std::fs::read_to_string(dir.path().join("got.txt")).unwrap().trim(), "none");
    }

    #[tokio::test]
    async fn a_background_job_that_keeps_the_pipes_open_doesnt_hold_setup_up() {
        let dir = tempfile::tempdir().unwrap();
        let started = std::time::Instant::now();
        let (result, _) = go(&["(sleep 3 &) && echo ok"], dir.path(), COMMAND_LIMIT).await;
        assert_eq!(result, Ok(()));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn what_a_tool_printed_is_read_without_its_colours_and_redrawn_lines() {
        assert_eq!(plain("\x1b[31mred\x1b[0m done\r\n"), "red done\n");
        assert_eq!(last_line("downloading 10%\rdownloading 90%\r\n\n"), "downloading 90%");
        let many: String = (0..40).map(|i| format!("line {i}\n")).collect();
        let tail = last_lines(&many);
        assert_eq!(tail.lines().count(), 15);
        assert!(tail.ends_with("line 39"));
    }
}
