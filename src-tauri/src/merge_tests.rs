//! Runs a project's tests inside a worker's worktree, for the merge card's "Run tests". Only the user starts a run (the
//! button, or the setting that does it when a merge is proposed); the main agent has no tool for it.
//!
//! The command is an argument vector, never a shell string: what the user types is split into words here (`split_command`),
//! shown to them before it runs, and handed to the program word by word. It runs in the worktree and nowhere else, with a
//! time limit, and can be cancelled. Its output is kept up to a cap (the end of it), and read by `test_runs`.

use crate::test_runs::{self, Outcome};
use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

/// How long a run may take before it is stopped.
pub const DEFAULT_LIMIT: Duration = Duration::from_secs(10 * 60);
/// How much of a run's output is kept for reading its results: the end of it.
const KEEP_BYTES: usize = 2 * 1024 * 1024;
/// The lines of output the card shows.
const TAIL_LINES: usize = 30;
/// Longest a typed command may be, and how many words it may have.
const MAX_COMMAND_CHARS: usize = 1000;
const MAX_WORDS: usize = 50;
/// The most a project file is read when looking for the test command.
const MAX_FILE: u64 = 1024 * 1024;

/// A test command found in the worktree, and the file that told us.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Detected {
    pub command: Vec<String>,
    pub source: String,
}

fn words(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// A plain file (not a link, which could point anywhere on the disk) read up to `MAX_FILE`.
fn read_plain(path: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() || meta.len() > MAX_FILE {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// What this project's tests are run with, from the files in its worktree: package.json's `test` script, Cargo.toml,
/// pytest's settings, or a Makefile's `test` target, in that order. None when nothing says.
pub fn detect(root: &Path) -> Option<Detected> {
    let found = |command: &[&str], source: &str| Some(Detected { command: words(command), source: source.to_string() });
    if let Some(text) = read_plain(&root.join("package.json")) {
        let script = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v["scripts"]["test"].as_str().map(str::to_string));
        // `npm init` writes a placeholder test script that only fails.
        if script.is_some_and(|s| !s.trim().is_empty() && !s.contains("no test specified")) {
            return found(&["npm", "test"], "package.json");
        }
    }
    if read_plain(&root.join("Cargo.toml")).is_some() {
        return found(&["cargo", "test"], "Cargo.toml");
    }
    let pytest = read_plain(&root.join("pytest.ini")).is_some()
        || read_plain(&root.join("pyproject.toml")).is_some_and(|t| t.contains("pytest"))
        || read_plain(&root.join("setup.cfg")).is_some_and(|t| t.contains("[tool:pytest]"))
        || read_plain(&root.join("tox.ini")).is_some_and(|t| t.contains("[pytest]"));
    if pytest {
        return found(&["pytest"], "pytest settings");
    }
    for name in ["Makefile", "makefile", "GNUmakefile"] {
        if read_plain(&root.join(name)).is_some_and(|t| t.lines().any(|l| l.trim_end().strip_prefix("test").is_some_and(|rest| rest.trim_start().starts_with(':') && !rest.trim_start().starts_with(":=")))) {
            return found(&["make", "test"], name);
        }
    }
    None
}

/// What the user typed, as the words of one command: split at spaces, with 'single' and "double" quotes keeping spaces
/// in a word and a backslash taking the next character as it is. Nothing is run through a shell, so what a shell would
/// do with `&&`, `|`, `;`, `>`, `$(…)` or `NAME=value` doesn't happen: those are refused with a reason rather than
/// handed to the program as words it wouldn't expect.
pub fn split_command(text: &str) -> Result<Vec<String>, String> {
    if text.chars().count() > MAX_COMMAND_CHARS {
        return Err(format!("That command is too long (over {MAX_COMMAND_CHARS} characters)."));
    }
    let shell = "Type one command with its arguments. To chain commands or use pipes, run them in a shell yourself, like: sh -c \"npm ci && npm test\"";
    let mut out: Vec<String> = vec![];
    let mut word = String::new();
    let mut started = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\0' => return Err("That command has a character that can't be part of one.".into()),
            '\'' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => word.push(c),
                        None => return Err("A quote isn't closed: add the matching ' at the end.".into()),
                    }
                }
            }
            '"' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') if matches!(chars.peek(), Some('"' | '\\')) => word.push(chars.next().unwrap_or('\\')),
                        Some(c) => word.push(c),
                        None => return Err("A quote isn't closed: add the matching \" at the end.".into()),
                    }
                }
            }
            '\\' => {
                started = true;
                word.push(chars.next().ok_or("A backslash at the end has nothing to apply to.")?);
            }
            c if c.is_whitespace() => {
                if started {
                    out.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            '|' | '&' | ';' | '<' | '>' | '`' | '(' | ')' => return Err(format!("“{c}” is a shell symbol, and nothing here goes through a shell. {shell}")),
            '$' if matches!(chars.peek(), Some('(' | '{')) => return Err(format!("“$” starts a shell substitution, and nothing here goes through a shell. {shell}")),
            c => {
                started = true;
                word.push(c);
            }
        }
    }
    if started {
        out.push(word);
    }
    check_words(&out)?;
    Ok(out)
}

/// The words of a command, whoever made them (the typed text, or the app's detection): something to run, of sensible size.
pub fn check_words(command: &[String]) -> Result<(), String> {
    let first = command.first().ok_or("Type a command to run.")?;
    if command.len() > MAX_WORDS || command.iter().map(String::len).sum::<usize>() > MAX_COMMAND_CHARS * 2 || command.iter().any(|w| w.contains('\0')) {
        return Err("That command is too long.".into());
    }
    // `FOO=1 npm test` would look for a program called FOO=1.
    let name = first.split_once('=').map(|(n, _)| n).filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    if name.is_some() {
        return Err("Settings like NAME=value before a command aren't supported: type the command alone.".into());
    }
    Ok(())
}

/// The output of a run, as far as it is kept: the end of it, once it passes the cap.
#[derive(Default)]
pub struct Capped {
    buf: Vec<u8>,
}

impl Capped {
    fn push(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
        // Trimmed in big steps, so a run that prints a lot isn't copying its buffer after every read.
        if self.buf.len() > KEEP_BYTES * 2 {
            let cut = self.buf.len() - KEEP_BYTES;
            self.buf.drain(..cut);
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.buf).into_owned()
    }

    /// The last thing it printed, for the card's progress line.
    pub fn last_line(&self) -> String {
        let from = self.buf.len().saturating_sub(4096);
        let text = test_runs::strip_ansi(&String::from_utf8_lossy(&self.buf[from..]));
        let line = text.split(['\n', '\r']).rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
        let mut line: String = line.chars().take(200).collect();
        if line.chars().count() == 200 {
            line.push('…');
        }
        line
    }
}

/// How a process ended.
#[derive(Debug, PartialEq)]
pub enum Ended {
    /// Its exit code (None: ended by a signal).
    Exit(Option<i32>),
    TimedOut,
    Cancelled,
}

pub struct Finished {
    pub ended: Ended,
    pub output: String,
    pub took: Duration,
}

/// Runs `command` in `root` and waits for it to end, `limit` to pass or `cancel` to be notified; then everything it started
/// is stopped. Its output is collected into `live` as it comes, so a card can show the line it is on.
pub async fn run(root: &Path, command: &[String], path_env: Option<&str>, limit: Duration, cancel: Arc<Notify>, live: Arc<Mutex<Capped>>) -> Result<Finished, String> {
    check_words(command)?;
    let mut cmd = tokio::process::Command::new(&command[0]);
    cmd.args(&command[1..]).current_dir(root).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // Its own group, so stopping it stops what it started (npm runs node, cargo runs the tests).
    cmd.process_group(0);
    for var in crate::git::REDIRECTS {
        cmd.env_remove(var);
    }
    // CI: a test runner that would otherwise sit watching for changes runs once and ends.
    cmd.env("CI", "1").env("TERM", "dumb").env("NO_COLOR", "1");
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    let started = Instant::now();
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("Couldn't start “{}”: it isn't installed, or isn't on the PATH Lantern uses.", clip_word(&command[0])),
        _ => format!("Couldn't start “{}”: {e}", clip_word(&command[0])),
    })?;
    let pid = child.id();
    let pump = |pipe: Option<Box<dyn tokio::io::AsyncRead + Send + Unpin>>, live: Arc<Mutex<Capped>>| {
        tokio::spawn(async move {
            let Some(mut pipe) = pipe else { return };
            let mut chunk = vec![0u8; 16 * 1024];
            // A read that fails ends the pipe: what was printed so far is what there is.
            while let Ok(n) = pipe.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                live.lock().unwrap().push(&chunk[..n]);
            }
        })
    };
    let readers = [
        pump(child.stdout.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Send + Unpin>), live.clone()),
        pump(child.stderr.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Send + Unpin>), live.clone()),
    ];
    let ended = tokio::select! {
        status = child.wait() => Ended::Exit(status.map_err(|e| format!("Lost track of the tests: {e}"))?.code()),
        _ = tokio::time::sleep(limit) => Ended::TimedOut,
        _ = cancel.notified() => Ended::Cancelled,
    };
    // Stopped for time or by the user: whatever it started goes with it. (One that ended on its own is reaped already, and
    // its process group's number may belong to something else by now.)
    if matches!(ended, Ended::TimedOut | Ended::Cancelled) {
        if let Some(pid) = pid {
            unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
        }
        let _ = child.wait().await;
    }
    for r in readers {
        // The pipes close with the group; one a stray process kept open is let go after a moment.
        let _ = tokio::time::timeout(Duration::from_secs(2), r).await;
    }
    let output = live.lock().unwrap().text();
    Ok(Finished { ended, output, took: started.elapsed() })
}

fn clip_word(s: &str) -> String {
    s.chars().take(60).collect()
}

/// How a finished run went, as the card shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Report {
    pub command: Vec<String>,
    /// "passed", "failed" or "timed_out".
    pub result: String,
    pub passed: Option<u32>,
    pub failed: Option<u32>,
    pub skipped: Option<u32>,
    pub exit_code: Option<i32>,
    pub took_ms: u64,
    /// The last lines of the output.
    pub tail: String,
    /// What the user may need to know that the numbers don't say.
    pub note: Option<String>,
    /// Files the run left in the worktree that weren't there before.
    pub new_files: Vec<String>,
    /// When it finished (unix milliseconds).
    pub at: u64,
}

/// The report of a run that ended on its own or at the time limit; None for a cancelled one.
pub fn report(command: &[String], finished: &Finished, limit: Duration, missing_packages: bool) -> Option<Report> {
    let (result, exit_code) = match finished.ended {
        Ended::Cancelled => return None,
        Ended::TimedOut => ("timed_out", None),
        Ended::Exit(code) => (if code == Some(0) { "passed" } else { "failed" }, code),
    };
    let clean = test_runs::strip_ansi(&finished.output);
    let parsed = test_runs::detect(&command.join(" "), &clean);
    // The program's own exit code decides; the counts only describe it (a runner that crashed before any test ran has none).
    let failed_by_output = parsed.as_ref().is_some_and(|r| r.outcome == Outcome::Failed);
    let result = if result == "passed" && failed_by_output { "failed" } else { result };
    let lines: Vec<&str> = clean.lines().map(|l| l.trim_end_matches('\r')).collect();
    let tail = lines[lines.len().saturating_sub(TAIL_LINES)..].join("\n");
    let note = match result {
        "timed_out" => Some(format!("Stopped after {} minutes, the longest a run may take.", limit.as_secs() / 60)),
        "failed" if missing_packages => Some("This worktree has no installed packages (node_modules), which is usually why a run fails here. Install them in the worktree, then run again.".to_string()),
        _ => None,
    };
    Some(Report {
        command: command.to_vec(),
        result: result.to_string(),
        passed: parsed.as_ref().map(|r| r.passed),
        failed: parsed.as_ref().map(|r| r.failed),
        skipped: parsed.as_ref().map(|r| r.skipped),
        exit_code,
        took_ms: finished.took.as_millis() as u64,
        tail,
        note,
        new_files: vec![],
        at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        words(list)
    }

    #[test]
    fn a_typed_command_is_split_into_words_with_quotes_keeping_spaces() {
        assert_eq!(split_command("npm run test:unit").unwrap(), argv(&["npm", "run", "test:unit"]));
        assert_eq!(split_command("  pytest   -k \"a and b\"  ").unwrap(), argv(&["pytest", "-k", "a and b"]));
        assert_eq!(split_command("cargo test 'my test' x\\ y").unwrap(), argv(&["cargo", "test", "my test", "x y"]));
        assert_eq!(split_command("echo \"\"").unwrap(), argv(&["echo", ""]));
        assert_eq!(split_command("sh -c \"npm ci && npm test\"").unwrap(), argv(&["sh", "-c", "npm ci && npm test"]));
        assert_eq!(split_command("echo \"a \\\"b\\\" c\"").unwrap(), argv(&["echo", "a \"b\" c"]));
        // Single quotes hold everything, a dollar sign included.
        assert_eq!(split_command("echo '$(x) | y'").unwrap(), argv(&["echo", "$(x) | y"]));
    }

    #[test]
    fn what_a_shell_would_act_on_is_refused_and_never_passed_on() {
        for bad in ["npm test && rm -rf ~", "npm test | tee x", "a; b", "a > out", "a < in", "echo `id`", "echo $(id)", "echo ${HOME}", "a & b", "(a)"] {
            let e = split_command(bad).unwrap_err();
            assert!(e.contains("shell"), "{bad}: {e}");
        }
        assert!(split_command("FOO=1 npm test").unwrap_err().contains("NAME=value"));
        assert!(split_command("").is_err());
        assert!(split_command("   ").is_err());
        assert!(split_command("echo 'open").unwrap_err().contains("quote"));
        assert!(split_command("echo \"open").unwrap_err().contains("quote"));
        assert!(split_command("echo a\\").is_err());
        assert!(split_command("a\0b").is_err());
        assert!(split_command(&"x ".repeat(2000)).unwrap_err().contains("too long"));
        assert!(check_words(&vec!["x".to_string(); MAX_WORDS + 1]).is_err());
        // A dollar sign that starts nothing is just a character.
        assert_eq!(split_command("echo $HOME $5").unwrap(), argv(&["echo", "$HOME", "$5"]));
    }

    fn project(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, text) in files {
            std::fs::write(dir.path().join(name), text).unwrap();
        }
        dir
    }

    #[test]
    fn the_test_command_comes_from_the_files_in_the_worktree() {
        let found = |files: &[(&str, &str)]| detect(project(files).path()).map(|d| (d.command.join(" "), d.source));
        assert_eq!(found(&[("package.json", r#"{"scripts":{"test":"vitest run"}}"#)]), Some(("npm test".into(), "package.json".into())));
        // npm init's placeholder only fails, and a package.json with no scripts has no tests.
        assert_eq!(found(&[("package.json", r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#)]), None);
        assert_eq!(found(&[("package.json", r#"{"name":"x"}"#)]), None);
        assert_eq!(found(&[("package.json", "not json")]), None);
        assert_eq!(found(&[("Cargo.toml", "[package]")]), Some(("cargo test".into(), "Cargo.toml".into())));
        // package.json is looked at first; a placeholder one falls through to the next.
        assert_eq!(found(&[("package.json", r#"{"scripts":{"test":"jest"}}"#), ("Cargo.toml", "")]).unwrap().0, "npm test");
        assert_eq!(found(&[("package.json", r#"{"scripts":{}}"#), ("Cargo.toml", "")]).unwrap().0, "cargo test");
        assert_eq!(found(&[("pyproject.toml", "[tool.pytest.ini_options]\n")]), Some(("pytest".into(), "pytest settings".into())));
        assert_eq!(found(&[("pytest.ini", "")]).unwrap().0, "pytest");
        assert_eq!(found(&[("setup.cfg", "[tool:pytest]\n")]).unwrap().0, "pytest");
        assert_eq!(found(&[("pyproject.toml", "[project]\nname='x'\n")]), None);
        assert_eq!(found(&[("Makefile", "build:\n\tcc x\n\ntest: build\n\t./t\n")]), Some(("make test".into(), "Makefile".into())));
        assert_eq!(found(&[("Makefile", "test-all:\n\techo\n")]), None);
        assert_eq!(found(&[("Makefile", "build:\n\techo test:\n")]), None);
        assert_eq!(found(&[]), None);
    }

    #[test]
    fn a_project_file_that_is_a_link_is_not_read() {
        let outside = project(&[("package.json", r#"{"scripts":{"test":"x"}}"#)]);
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path().join("package.json"), dir.path().join("package.json")).unwrap();
        assert_eq!(detect(dir.path()), None);
    }

    async fn go(dir: &Path, command: &[&str], limit: Duration) -> Result<Finished, String> {
        run(dir, &argv(command), None, limit, Arc::new(Notify::new()), Arc::default()).await
    }

    #[tokio::test]
    async fn a_run_collects_both_outputs_and_the_exit_code_in_the_worktree_only() {
        let dir = tempfile::tempdir().unwrap();
        let done = go(dir.path(), &["sh", "-c", "echo out; echo err >&2; pwd; echo \"ci=$CI\"; exit 3"], DEFAULT_LIMIT).await.unwrap();
        assert_eq!(done.ended, Ended::Exit(Some(3)));
        assert!(done.output.contains("out") && done.output.contains("err") && done.output.contains("ci=1"));
        let here = std::fs::canonicalize(dir.path()).unwrap();
        assert!(done.output.lines().any(|l| std::fs::canonicalize(l).is_ok_and(|p| p == here)), "ran somewhere else: {}", done.output);
    }

    #[tokio::test]
    async fn words_reach_the_program_as_they_are_never_through_a_shell() {
        let dir = tempfile::tempdir().unwrap();
        let done = go(dir.path(), &["echo", "$(touch pwned)", "a;b", "&&", "`id`"], DEFAULT_LIMIT).await.unwrap();
        assert!(done.output.contains("$(touch pwned) a;b && `id`"), "{}", done.output);
        assert!(!dir.path().join("pwned").exists());
    }

    #[tokio::test]
    async fn a_program_that_does_not_exist_is_said_so_in_words() {
        let dir = tempfile::tempdir().unwrap();
        let e = go(dir.path(), &["definitely-not-a-program-xyz"], DEFAULT_LIMIT).await.err().unwrap();
        assert!(e.contains("isn't installed"), "{e}");
    }

    #[tokio::test]
    async fn a_run_over_its_time_limit_is_stopped_with_what_it_started() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("late");
        let script = format!("(sleep 2; touch {}) & echo started; sleep 30", marker.display());
        let done = go(dir.path(), &["sh", "-c", &script], Duration::from_millis(400)).await.unwrap();
        assert_eq!(done.ended, Ended::TimedOut);
        assert!(done.output.contains("started"));
        assert!(done.took < Duration::from_secs(5));
        tokio::time::sleep(Duration::from_millis(2300)).await;
        assert!(!marker.exists(), "a process the run started outlived it");
    }

    #[tokio::test]
    async fn a_run_can_be_cancelled_even_before_it_gets_going() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = Arc::new(Notify::new());
        // A permit left by a cancel that came first still stops it.
        cancel.notify_one();
        let done = run(dir.path(), &argv(&["sleep", "30"]), None, DEFAULT_LIMIT, cancel, Arc::default()).await.unwrap();
        assert_eq!(done.ended, Ended::Cancelled);
        assert!(done.took < Duration::from_secs(5));
        assert!(report(&argv(&["sleep"]), &done, DEFAULT_LIMIT, false).is_none());
    }

    #[tokio::test]
    async fn only_the_end_of_a_very_long_output_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let live: Arc<Mutex<Capped>> = Arc::default();
        let script = "i=0; while [ $i -lt 200000 ]; do echo \"line number $i of a long run\"; i=$((i+1)); done";
        let done = run(dir.path(), &argv(&["sh", "-c", script]), None, DEFAULT_LIMIT, Arc::new(Notify::new()), live.clone()).await.unwrap();
        assert!(done.output.len() <= KEEP_BYTES * 2 + 16 * 1024, "{} bytes kept", done.output.len());
        assert!(done.output.trim_end().ends_with("line number 199999 of a long run"));
        assert_eq!(live.lock().unwrap().last_line(), "line number 199999 of a long run");
    }

    fn ended(code: i32, output: &str) -> Finished {
        Finished { ended: Ended::Exit(Some(code)), output: output.to_string(), took: Duration::from_millis(1500) }
    }

    #[test]
    fn a_report_says_how_it_went_from_the_exit_code_and_the_counts() {
        let ok = report(&argv(&["cargo", "test"]), &ended(0, "test a ... ok\ntest result: ok. 214 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.50s\n"), DEFAULT_LIMIT, false).unwrap();
        assert_eq!((ok.result.as_str(), ok.passed, ok.failed, ok.took_ms), ("passed", Some(214), Some(0), 1500));
        let bad = report(&argv(&["cargo", "test"]), &ended(101, "test result: FAILED. 11 passed; 3 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s\n"), DEFAULT_LIMIT, false).unwrap();
        assert_eq!((bad.result.as_str(), bad.failed, bad.exit_code), ("failed", Some(3), Some(101)));
        // A command whose output isn't a known runner's: the exit code alone.
        let plain = report(&argv(&["./check.sh"]), &ended(1, "boom\n"), DEFAULT_LIMIT, false).unwrap();
        assert_eq!((plain.result.as_str(), plain.passed), ("failed", None));
        assert_eq!(report(&argv(&["./check.sh"]), &ended(0, "fine\n"), DEFAULT_LIMIT, false).unwrap().result, "passed");
        // A runner that printed failures but exited 0 is still a failure.
        let odd = report(&argv(&["cargo", "test"]), &ended(0, "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s\n"), DEFAULT_LIMIT, false).unwrap();
        assert_eq!(odd.result, "failed");
        let slow = report(&argv(&["npm", "test"]), &Finished { ended: Ended::TimedOut, output: String::new(), took: Duration::from_secs(600) }, DEFAULT_LIMIT, false).unwrap();
        assert_eq!(slow.result, "timed_out");
        assert!(slow.note.unwrap().contains("10 minutes"));
        let no_packages = report(&argv(&["npm", "test"]), &ended(127, "sh: vitest: command not found\n"), DEFAULT_LIMIT, true).unwrap();
        assert!(no_packages.note.unwrap().contains("node_modules"));
    }

    #[test]
    fn a_report_keeps_the_last_thirty_lines_without_colour_codes() {
        let output: String = (1..=100).map(|i| format!("\x1b[31mline {i}\x1b[0m\n")).collect();
        let r = report(&argv(&["./x"]), &ended(1, &output), DEFAULT_LIMIT, false).unwrap();
        let lines: Vec<&str> = r.tail.lines().collect();
        assert_eq!((lines.len(), lines[0], lines[29]), (30, "line 71", "line 100"));
    }
}
