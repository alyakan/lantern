//! A pull request's checks, read-only. For a chat's folder: the open pull request on its branch and how its checks stand
//! (`gh pr view`, `gh pr checks`), and for a failed check the end of its log (`gh run view --log-failed`). Every call is an
//! argument vector (never a shell string) run in the folder with a time limit; none of them writes to GitHub. What comes
//! back from CI is data: the log is cleaned of terminal escapes and cut to its last lines before it goes anywhere.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The longest `gh pr view` or `gh pr checks` may take.
const LOOK_TIMEOUT: Duration = Duration::from_secs(30);
/// A log can be big and slow to fetch.
const LOG_TIMEOUT: Duration = Duration::from_secs(60);
/// What of a call's output is kept in memory: the rest is read and dropped.
const KEEP_BYTES: usize = 4 * 1024 * 1024;

/// A log is cut to this many lines and bytes (the last ones: that is where a failure is).
pub const LOG_LINES: usize = 200;
pub const LOG_BYTES: usize = 20 * 1024;

/// One check of a pull request, as the status card lists it.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Check {
    pub name: String,
    /// gh's own state: SUCCESS, FAILURE, PENDING, SKIPPED, …
    pub state: String,
    /// gh's grouping of the states: pass, fail, pending, skipping or cancel.
    pub bucket: String,
    pub link: Option<String>,
    pub workflow: Option<String>,
    /// The GitHub Actions run the link points at (digits), when it is one: its log can be read.
    pub run_id: Option<String>,
}

/// The pull request of a folder's branch.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct PullRequest {
    pub number: u32,
    pub url: String,
    /// OPEN, MERGED or CLOSED.
    pub state: String,
    pub branch: String,
    pub base: String,
    /// The commit the branch is at on GitHub: a new one means a push happened.
    pub head_sha: Option<String>,
}

/// What looking at a folder found.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrWatch {
    /// The GitHub CLI isn't installed.
    NoGh,
    /// The GitHub CLI isn't logged in.
    LoggedOut,
    /// The branch has no pull request (or the folder isn't a GitHub repository): nothing to show.
    NoPr,
    Found { pr: PullRequest, checks: Vec<Check> },
}

/// Whether the GitHub CLI can be used.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GhAccess {
    Ready,
    Missing,
    LoggedOut,
}

/// What a finished program printed.
struct Output {
    success: bool,
    stdout: Vec<u8>,
    stderr: String,
}

/// Which end of the output is kept when it is more than `KEEP_BYTES`.
#[derive(Clone, Copy)]
enum Keep {
    Head,
    Tail,
}

fn drain(pipe: Option<impl Read + Send + 'static>, keep: Keep) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut bytes: Vec<u8> = Vec::new();
        let Some(mut pipe) = pipe else { return bytes };
        let mut chunk = [0u8; 16 * 1024];
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 {
                break;
            }
            match keep {
                Keep::Head => {
                    let room = KEEP_BYTES.saturating_sub(bytes.len());
                    bytes.extend_from_slice(&chunk[..n.min(room)]);
                }
                Keep::Tail => {
                    bytes.extend_from_slice(&chunk[..n]);
                    if bytes.len() > 2 * KEEP_BYTES {
                        bytes.drain(..bytes.len() - KEEP_BYTES);
                    }
                }
            }
        }
        if bytes.len() > KEEP_BYTES && matches!(keep, Keep::Tail) {
            bytes.drain(..bytes.len() - KEEP_BYTES);
        }
        bytes
    })
}

/// Variables that would point git (which `gh` runs to find the repository) at another repository than the folder's.
const GIT_REDIRECTS: [&str; 6] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"];

/// Runs `program` with `args` in `folder`: no shell, no input, no prompts, no colours, stopped after `limit`. The git that
/// `gh` starts is told (by environment, which beats the repository's own config) to run no filesystem monitor, no hooks and
/// no pager: a repository's config is the project's, and looking at a pull request must not run a program it names.
fn run_program(program: &str, folder: &Path, args: &[&str], path_env: Option<&str>, limit: Duration, keep: Keep) -> Result<Output, std::io::Error> {
    let mut cmd = Command::new(program);
    cmd.current_dir(folder).args(args);
    for var in GIT_REDIRECTS {
        cmd.env_remove(var);
    }
    cmd.env("GIT_CONFIG_COUNT", "3")
        .env("GIT_CONFIG_KEY_0", "core.fsmonitor")
        .env("GIT_CONFIG_VALUE_0", "false")
        .env("GIT_CONFIG_KEY_1", "core.hooksPath")
        .env("GIT_CONFIG_VALUE_1", "/dev/null")
        .env("GIT_CONFIG_KEY_2", "core.pager")
        .env("GIT_CONFIG_VALUE_2", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_PAGER", "cat")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = path_env {
        cmd.env("PATH", path);
    }
    let mut child = cmd.spawn()?;
    let out = drain(child.stdout.take(), keep);
    let err = drain(child.stderr.take(), Keep::Head);
    let started = Instant::now();
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if started.elapsed() > limit => {
                // Not waited for further: something it started may hold the pipes open.
                let _ = child.kill();
                let _ = child.wait();
                return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, format!("{program} took longer than {} seconds and was stopped.", limit.as_secs())));
            }
            None => std::thread::sleep(Duration::from_millis(15)),
        }
    };
    Ok(Output { success: status.success(), stdout: out.join().unwrap_or_default(), stderr: String::from_utf8_lossy(&err.join().unwrap_or_default()).to_string() })
}

/// A pull request number from the app: digits only, and a number gh can take.
pub fn parse_number(text: &str) -> Option<u32> {
    let digits = !text.is_empty() && text.len() <= 9 && text.bytes().all(|b| b.is_ascii_digit());
    digits.then(|| text.parse().ok()).flatten().filter(|n| *n > 0)
}

/// A GitHub Actions run id from the app: digits only.
pub fn valid_run_id(text: &str) -> bool {
    !text.is_empty() && text.len() <= 20 && text.bytes().all(|b| b.is_ascii_digit())
}

/// `gh pr view` for the branch the folder is on. Read-only.
fn view_args() -> Vec<String> {
    ["pr", "view", "--json", "number,url,state,headRefName,baseRefName,headRefOid"].map(String::from).to_vec()
}

/// `gh pr checks` for pull request `number`. Read-only.
fn checks_args(number: u32) -> Vec<String> {
    vec!["pr".into(), "checks".into(), number.to_string(), "--json".into(), "name,state,bucket,link,workflow".into()]
}

/// `gh run view` with only the failed steps' log. Read-only.
fn log_args(run_id: &str) -> Vec<String> {
    vec!["run".into(), "view".into(), run_id.into(), "--log-failed".into()]
}

fn strs(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).collect()
}

/// What `gh pr view` said when it failed: not logged in, no pull request here, or something that may pass (a network blip).
#[derive(Debug, PartialEq)]
enum ViewFailure {
    LoggedOut,
    NoPr,
    Other(String),
}

fn classify_view_failure(stderr: &str) -> ViewFailure {
    let lower = stderr.to_lowercase();
    if lower.contains("gh auth login") || lower.contains("not logged in") || lower.contains("authentication") {
        return ViewFailure::LoggedOut;
    }
    let none = ["no pull requests found", "not a git repository", "no git remotes", "known github host", "could not determine base repo", "no default remote", "not a github", "detached head", "could not resolve to a pullrequest"];
    if none.iter().any(|m| lower.contains(m)) {
        return ViewFailure::NoPr;
    }
    ViewFailure::Other(stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("gh couldn't look at the pull request").to_string())
}

/// What `gh pr view --json …` printed, as a pull request.
pub fn parse_pr(json: &[u8]) -> Result<PullRequest, String> {
    let v: serde_json::Value = serde_json::from_slice(json).map_err(|e| format!("gh pr view: {e}"))?;
    let text = |key: &str| v[key].as_str().unwrap_or("").to_string();
    Ok(PullRequest {
        number: u32::try_from(v["number"].as_u64().ok_or("gh pr view: no number")?).map_err(|_| "gh pr view: odd number")?,
        url: text("url"),
        state: text("state").to_uppercase(),
        branch: text("headRefName"),
        base: text("baseRefName"),
        head_sha: v["headRefOid"].as_str().filter(|s| !s.is_empty()).map(String::from),
    })
}

/// The Actions run a check's link points at: `https://github.com/o/r/actions/runs/<id>/job/<id>` gives `<id>`.
pub fn run_id_of(link: &str) -> Option<String> {
    let id: String = link.split_once("/actions/runs/")?.1.chars().take_while(char::is_ascii_digit).collect();
    valid_run_id(&id).then_some(id)
}

/// gh's buckets are pass, fail, pending, skipping and cancel; anything else is treated as still pending, which never
/// counts as a failure.
fn bucket_of(raw: &str) -> &'static str {
    match raw.to_lowercase().as_str() {
        "pass" => "pass",
        "fail" => "fail",
        "skipping" => "skipping",
        "cancel" => "cancel",
        _ => "pending",
    }
}

/// What `gh pr checks --json name,state,bucket,link,workflow` printed. A check without a name is dropped.
pub fn parse_checks(json: &[u8]) -> Result<Vec<Check>, String> {
    let list: Vec<serde_json::Value> = serde_json::from_slice(json).map_err(|e| format!("gh pr checks: {e}"))?;
    Ok(list
        .iter()
        .filter_map(|c| {
            let name = c["name"].as_str().filter(|n| !n.trim().is_empty())?.to_string();
            let link = c["link"].as_str().filter(|l| !l.is_empty()).map(String::from);
            Some(Check {
                name,
                state: c["state"].as_str().unwrap_or("").to_uppercase(),
                bucket: bucket_of(c["bucket"].as_str().unwrap_or("")).to_string(),
                run_id: link.as_deref().and_then(run_id_of),
                link,
                workflow: c["workflow"].as_str().filter(|w| !w.is_empty()).map(String::from),
            })
        })
        .collect())
}

fn spawn_failure(e: &std::io::Error) -> Option<PrWatch> {
    (e.kind() == std::io::ErrorKind::NotFound).then_some(PrWatch::NoGh)
}

/// Whether `gh` is there and logged in (`gh auth status`, which only reads).
pub fn gh_access(path_env: Option<&str>) -> GhAccess {
    match run_program("gh", Path::new("/"), &["auth", "status"], path_env, LOOK_TIMEOUT, Keep::Head) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => GhAccess::Missing,
        Ok(out) if out.success => GhAccess::Ready,
        // Installed but not usable: not logged in, or cannot reach GitHub; both are told as not logged in.
        _ => GhAccess::LoggedOut,
    }
}

/// The open pull request of the folder's branch and its checks. Err: gh failed for a reason that may pass (the network, a
/// time limit): the caller keeps what it knew.
pub fn watch(folder: &Path, path_env: Option<&str>) -> Result<PrWatch, String> {
    if !folder.is_dir() {
        return Err("That folder isn't there.".into());
    }
    let view = view_args();
    let out = match run_program("gh", folder, &strs(&view), path_env, LOOK_TIMEOUT, Keep::Head) {
        Ok(out) => out,
        Err(e) => return spawn_failure(&e).ok_or_else(|| e.to_string()),
    };
    if !out.success {
        return match classify_view_failure(&out.stderr) {
            ViewFailure::LoggedOut => Ok(PrWatch::LoggedOut),
            ViewFailure::NoPr => Ok(PrWatch::NoPr),
            ViewFailure::Other(why) => Err(why),
        };
    }
    let pr = parse_pr(&out.stdout)?;
    // A merged or closed pull request has nothing left to watch.
    if pr.state != "OPEN" {
        return Ok(PrWatch::Found { pr, checks: Vec::new() });
    }
    let checks = checks_args(pr.number);
    let out = match run_program("gh", folder, &strs(&checks), path_env, LOOK_TIMEOUT, Keep::Head) {
        Ok(out) => out,
        Err(e) => return Err(e.to_string()),
    };
    // gh exits with 8 while checks are pending and 1 when some failed, and still prints them: what it printed counts.
    // A branch with no checks at all exits 1 with a sentence and nothing else.
    let text = String::from_utf8_lossy(&out.stdout);
    let checks = if text.trim_start().starts_with('[') {
        parse_checks(&out.stdout)?
    } else if out.stderr.to_lowercase().contains("no checks reported") || (out.success && text.trim().is_empty()) {
        Vec::new()
    } else {
        return Err(out.stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("gh couldn't read the checks").to_string());
    };
    Ok(PrWatch::Found { pr, checks })
}

/// Control characters and terminal escapes out of text that came from CI: colours, cursor moves, a bell. Newlines and
/// tabs stay; a lone carriage return (a progress bar redrawing itself) becomes a newline.
pub fn clean_log(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.peek() {
                // CSI: up to a letter or one of @ to ~.
                Some('[') => {
                    chars.next();
                    for n in chars.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                // OSC (a window title, a link): up to the bell or the string terminator.
                Some(']') => {
                    chars.next();
                    while let Some(n) = chars.next() {
                        if n == '\u{7}' {
                            break;
                        }
                        if n == '\u{1b}' {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {
                    chars.next();
                }
            },
            '\r' => {
                if chars.peek() != Some(&'\n') {
                    out.push('\n');
                }
            }
            '\n' | '\t' => out.push(c),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// The last `LOG_LINES` lines of `text`, and at most `LOG_BYTES` of them (cut at a line, or at a character).
pub fn cap_log(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let from = lines.len().saturating_sub(LOG_LINES);
    let mut kept = lines[from..].join("\n");
    let mut cut = from > 0;
    if kept.len() > LOG_BYTES {
        let mut start = kept.len() - LOG_BYTES;
        while !kept.is_char_boundary(start) {
            start += 1;
        }
        // Start on a whole line when there is one.
        if let Some(nl) = kept[start..].find('\n') {
            start += nl + 1;
        }
        kept = kept[start..].to_string();
        cut = true;
    }
    if cut {
        format!("[earlier lines left out]\n{kept}")
    } else {
        kept
    }
}

/// The end of the log of the failed steps of Actions run `run_id`. Read-only.
pub fn failure_log(folder: &Path, run_id: &str, path_env: Option<&str>) -> Result<String, String> {
    if !valid_run_id(run_id) {
        return Err("That isn't a run number.".into());
    }
    if !folder.is_dir() {
        return Err("That folder isn't there.".into());
    }
    let args = log_args(run_id);
    let out = run_program("gh", folder, &strs(&args), path_env, LOG_TIMEOUT, Keep::Tail).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "The GitHub CLI (gh) isn't installed.".to_string() } else { e.to_string() })?;
    if !out.success {
        let why = out.stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("gh couldn't read the log");
        return Err(format!("gh run view: {why}"));
    }
    Ok(cap_log(&clean_log(&String::from_utf8_lossy(&out.stdout))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_arguments_only_read() {
        assert_eq!(view_args(), ["pr", "view", "--json", "number,url,state,headRefName,baseRefName,headRefOid"]);
        assert_eq!(checks_args(42), ["pr", "checks", "42", "--json", "name,state,bucket,link,workflow"]);
        assert_eq!(log_args("123456"), ["run", "view", "123456", "--log-failed"]);
        for args in [view_args(), checks_args(7), log_args("9")] {
            for write in ["merge", "comment", "edit", "close", "reopen", "create", "ready", "review", "rerun", "cancel", "delete", "api", "-X", "--method"] {
                assert!(!args.iter().any(|a| a == write), "{write} in {args:?}");
            }
            assert!(matches!(args[1].as_str(), "view" | "checks"), "{args:?}");
        }
    }

    #[test]
    fn a_number_is_digits() {
        assert_eq!(parse_number("42"), Some(42));
        assert_eq!(parse_number("007"), Some(7));
        for bad in ["", "0", "-1", "4 2", "42;ls", "$(id)", "12a", "--web", "99999999999", "٤٢", "4_2", " 42"] {
            assert_eq!(parse_number(bad), None, "{bad:?}");
        }
        assert!(valid_run_id("123456789012"));
        for bad in ["", "12x", "../1", "1 2", "--log", "123456789012345678901"] {
            assert!(!valid_run_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_run_is_read_from_a_check_link() {
        assert_eq!(run_id_of("https://github.com/o/r/actions/runs/12345/job/678"), Some("12345".into()));
        assert_eq!(run_id_of("https://github.com/o/r/actions/runs/9"), Some("9".into()));
        assert_eq!(run_id_of("https://circleci.com/gh/o/r/123"), None);
        assert_eq!(run_id_of("https://github.com/o/r/actions/runs/abc"), None);
    }

    #[test]
    fn a_pull_request_is_read_from_gh() {
        let json = br#"{"number":57,"url":"https://github.com/o/r/pull/57","state":"OPEN","headRefName":"feat/x","baseRefName":"main","headRefOid":"abc123"}"#;
        assert_eq!(parse_pr(json).unwrap(), PullRequest { number: 57, url: "https://github.com/o/r/pull/57".into(), state: "OPEN".into(), branch: "feat/x".into(), base: "main".into(), head_sha: Some("abc123".into()) });
        let merged = parse_pr(br#"{"number":1,"state":"merged","headRefName":"a","baseRefName":"b"}"#).unwrap();
        assert_eq!((merged.state.as_str(), merged.head_sha), ("MERGED", None));
        assert!(parse_pr(b"{}").is_err());
        assert!(parse_pr(b"not json").is_err());
    }

    #[test]
    fn checks_fall_into_the_five_buckets() {
        let json = br#"[
          {"name":"build","state":"SUCCESS","bucket":"pass","link":"https://github.com/o/r/actions/runs/1/job/2","workflow":"CI"},
          {"name":"test","state":"FAILURE","bucket":"fail","link":"https://github.com/o/r/actions/runs/1/job/3","workflow":"CI"},
          {"name":"deploy","state":"IN_PROGRESS","bucket":"pending","link":"","workflow":""},
          {"name":"docs","state":"SKIPPED","bucket":"skipping","link":null},
          {"name":"old","state":"CANCELLED","bucket":"cancel"},
          {"name":"odd","state":"WEIRD","bucket":"something-new"},
          {"name":"  ","state":"SUCCESS","bucket":"pass"}
        ]"#;
        let checks = parse_checks(json).unwrap();
        let buckets: Vec<(&str, &str)> = checks.iter().map(|c| (c.name.as_str(), c.bucket.as_str())).collect();
        assert_eq!(buckets, [("build", "pass"), ("test", "fail"), ("deploy", "pending"), ("docs", "skipping"), ("old", "cancel"), ("odd", "pending")]);
        assert_eq!(checks[1].run_id.as_deref(), Some("1"));
        assert_eq!(checks[1].workflow.as_deref(), Some("CI"));
        assert_eq!(checks[2].link, None);
        assert_eq!(checks[2].workflow, None);
        assert_eq!(parse_checks(b"[]").unwrap(), vec![]);
        assert!(parse_checks(b"nope").is_err());
    }

    #[test]
    fn a_view_failure_is_told_apart() {
        assert_eq!(classify_view_failure("no pull requests found for branch \"x\""), ViewFailure::NoPr);
        assert_eq!(classify_view_failure("fatal: not a git repository"), ViewFailure::NoPr);
        assert_eq!(classify_view_failure("none of the git remotes configured for this repository point to a known GitHub host"), ViewFailure::NoPr);
        assert_eq!(classify_view_failure("To get started with GitHub CLI, please run:  gh auth login"), ViewFailure::LoggedOut);
        assert_eq!(classify_view_failure("error connecting to api.github.com\ncheck your internet connection"), ViewFailure::Other("error connecting to api.github.com".into()));
    }

    #[test]
    fn a_log_is_cleaned_of_terminal_escapes() {
        assert_eq!(clean_log("\u{1b}[31mred\u{1b}[0m text\u{7}\r\nnext\rprogress\u{1b}]0;title\u{7}!"), "red text\nnext\nprogress!");
        assert_eq!(clean_log("a\tb\u{0}c\u{8}d"), "a\tbcd");
        assert_eq!(clean_log("tail\u{1b}"), "tail");
    }

    #[test]
    fn a_log_is_cut_to_its_last_lines_and_bytes() {
        let short = "one\ntwo";
        assert_eq!(cap_log(short), short);
        let many: String = (1..=500).map(|n| format!("line {n}\n")).collect();
        let capped = cap_log(&many);
        assert!(capped.starts_with("[earlier lines left out]\nline 301\n"), "{}", &capped[..60]);
        assert!(capped.ends_with("line 500"));
        assert_eq!(capped.lines().count(), LOG_LINES + 1);
        let wide = format!("{}\n", "é".repeat(500)).repeat(100);
        let capped = cap_log(&wide);
        assert!(capped.len() <= LOG_BYTES + 40, "{}", capped.len());
        assert!(capped.lines().skip(1).all(|l| l.chars().count() == 500), "a line was cut in the middle");
        let one_line = "x".repeat(LOG_BYTES * 3);
        let capped = cap_log(&one_line);
        assert!(capped.len() <= LOG_BYTES + 40);
    }

    #[test]
    fn a_program_runs_without_a_shell_and_is_stopped_at_its_limit() {
        let here = std::env::temp_dir();
        let out = run_program("printf", &here, &["%s", "a;b && $(c)"], None, Duration::from_secs(5), Keep::Head).unwrap();
        assert!(out.success);
        assert_eq!(String::from_utf8_lossy(&out.stdout), "a;b && $(c)");
        let slow = run_program("sleep", &here, &["5"], None, Duration::from_millis(100), Keep::Head);
        assert_eq!(slow.err().map(|e| e.kind()), Some(std::io::ErrorKind::TimedOut));
        let gone = run_program("lantern-no-such-program", &here, &[], None, Duration::from_secs(1), Keep::Head);
        assert_eq!(gone.err().map(|e| e.kind()), Some(std::io::ErrorKind::NotFound));
        let failed = run_program("sh", &here, &["-c", "echo oops >&2; exit 3"], None, Duration::from_secs(5), Keep::Head).unwrap();
        assert!(!failed.success);
        assert_eq!(failed.stderr.trim(), "oops");
    }

    #[test]
    fn the_tail_of_a_long_output_is_kept() {
        let here = std::env::temp_dir();
        let out = run_program("sh", &here, &["-c", "i=0; while [ $i -lt 3000 ]; do echo \"line $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"; i=$((i+1)); done"], None, Duration::from_secs(10), Keep::Tail).unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).trim_end().ends_with("line 2999 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
    }

    #[test]
    fn a_folder_that_isnt_there_is_refused() {
        assert!(watch(Path::new("/definitely/not/here"), None).is_err());
        assert!(failure_log(Path::new("/definitely/not/here"), "1", None).is_err());
        assert!(failure_log(Path::new("/"), "1; rm -rf /", None).is_err());
    }
}
