//! How each project with a chat open stands, for the Desk's board: per folder its branch and how many files are changed,
//! per repository its worktrees, open pull requests and how their checks stand, what merged lately, and its latest
//! release. Read-only. The folders are the open chats' own (never ones the window names), and the repositories they are
//! in are looked at once each, however many worktrees of one have a chat. git runs hardened (`git::run`); `gh` is told
//! which repository with `--repo` and runs outside it, so nothing in a project's config is read or run by it. What comes
//! back from GitHub (titles, branch names) is shown, never handed to a model.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::checks::{run_program, Keep};
use crate::git;

/// The longest one `gh` call may take.
const GH_TIMEOUT: Duration = Duration::from_secs(30);
/// How long what GitHub said about a repository is used before it is asked again.
const GH_FRESH: Duration = Duration::from_secs(90);
/// The open pull requests and the merged ones listed, at most.
const OPEN_MAX: &str = "30";
const MERGED_MAX: &str = "10";

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct FolderStatus {
    pub folder: String,
    /// None: a detached HEAD, or not a checkout.
    pub branch: Option<String>,
    /// Files changed and not committed; None when git couldn't say.
    pub changed: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct PrStatus {
    pub number: u32,
    pub title: String,
    pub author: String,
    pub branch: String,
    pub draft: bool,
    /// "pass", "fail", "pending" or "none" (no checks).
    pub checks: &'static str,
    /// GitHub's review decision: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED; None when there is none.
    pub review: Option<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct MergedPr {
    pub number: u32,
    pub title: String,
    /// As GitHub has it (ISO 8601, UTC).
    pub merged_at: String,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Release {
    pub tag: String,
    /// None for a draft.
    pub published_at: Option<String>,
}

/// Whether GitHub could be asked about the repository.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Gh {
    Ready,
    /// gh isn't installed.
    Missing,
    LoggedOut,
    /// Its origin isn't on github.com (or there is no origin).
    NotGithub,
    /// gh failed for a reason that may pass (the network, a time limit): `error` says which.
    Failed,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct RepoStatus {
    /// The repository's main checkout.
    pub repo: String,
    /// "owner/name" on GitHub, when it is there.
    pub github: Option<String>,
    pub folders: Vec<FolderStatus>,
    /// Linked worktrees, besides the main checkout.
    pub worktrees: usize,
    pub gh: Gh,
    pub prs: Vec<PrStatus>,
    /// The latest merged pull requests, newest first.
    pub merged: Vec<MergedPr>,
    /// The latest published release.
    pub release: Option<Release>,
    /// Releases waiting as drafts.
    pub drafts: Vec<String>,
    pub error: Option<String>,
}

/// What GitHub said, kept for `GH_FRESH`.
#[derive(Clone, Debug, PartialEq)]
struct FromGh {
    gh: Gh,
    prs: Vec<PrStatus>,
    merged: Vec<MergedPr>,
    release: Option<Release>,
    drafts: Vec<String>,
    error: Option<String>,
}

static CACHE: Mutex<Option<HashMap<String, (Instant, FromGh)>>> = Mutex::new(None);

/// "owner/name" from a github.com remote URL (https, ssh or scp-style, with or without `.git` and credentials). Anything
/// else, or a name with characters GitHub doesn't allow, is None.
pub fn github_of(url: &str) -> Option<String> {
    let url = url.trim();
    let rest = if let Some(rest) = url.strip_prefix("git@github.com:") {
        rest
    } else {
        let after_scheme = url.strip_prefix("https://").or_else(|| url.strip_prefix("ssh://")).or_else(|| url.strip_prefix("git://"))?;
        // Credentials before the host are skipped, never kept.
        let host_on = after_scheme.rsplit_once('@').map_or(after_scheme, |(_, h)| h);
        let (host, path) = host_on.split_once('/')?;
        if !host.eq_ignore_ascii_case("github.com") {
            return None;
        }
        path
    };
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, name) = rest.split_once('/')?;
    // Starts with a letter or digit (so never reads as a flag), and holds only what GitHub allows.
    let ok = |s: &str| s.len() <= 100 && s.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b));
    (ok(owner) && ok(name)).then(|| format!("{owner}/{name}"))
}

/// A pull request's checks rolled up from `statusCheckRollup`: any failed is "fail", else any still running is "pending",
/// else "pass"; none at all is "none". A check run's conclusion and a status's state both count.
fn rollup(checks: &serde_json::Value) -> &'static str {
    let Some(list) = checks.as_array().filter(|l| !l.is_empty()) else { return "none" };
    let mut pending = false;
    for c in list {
        let word = c["conclusion"].as_str().filter(|s| !s.is_empty()).or_else(|| c["state"].as_str()).unwrap_or("").to_uppercase();
        let running = c["status"].as_str().is_some_and(|s| !s.eq_ignore_ascii_case("COMPLETED"));
        match word.as_str() {
            "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => return "fail",
            "SUCCESS" | "NEUTRAL" | "SKIPPED" if !running => {}
            _ => pending = true,
        }
    }
    if pending { "pending" } else { "pass" }
}

fn number(v: &serde_json::Value) -> Option<u32> {
    u32::try_from(v["number"].as_u64()?).ok()
}

/// What `gh pr list --json number,title,author,headRefName,isDraft,statusCheckRollup,reviewDecision` printed.
pub fn parse_open(json: &[u8]) -> Result<Vec<PrStatus>, String> {
    let list: Vec<serde_json::Value> = serde_json::from_slice(json).map_err(|e| format!("gh pr list: {e}"))?;
    Ok(list
        .iter()
        .filter_map(|pr| {
            Some(PrStatus {
                number: number(pr)?,
                title: pr["title"].as_str().unwrap_or("").to_string(),
                author: pr["author"]["login"].as_str().unwrap_or("").to_string(),
                branch: pr["headRefName"].as_str().unwrap_or("").to_string(),
                draft: pr["isDraft"].as_bool().unwrap_or(false),
                checks: rollup(&pr["statusCheckRollup"]),
                review: pr["reviewDecision"].as_str().filter(|s| !s.is_empty()).map(String::from),
            })
        })
        .collect())
}

/// What `gh pr list --state merged --json number,title,mergedAt` printed, newest first.
pub fn parse_merged(json: &[u8]) -> Result<Vec<MergedPr>, String> {
    let list: Vec<serde_json::Value> = serde_json::from_slice(json).map_err(|e| format!("gh pr list: {e}"))?;
    let mut out: Vec<MergedPr> = list
        .iter()
        .filter_map(|pr| Some(MergedPr { number: number(pr)?, title: pr["title"].as_str().unwrap_or("").to_string(), merged_at: pr["mergedAt"].as_str()?.to_string() }))
        .collect();
    // ISO 8601 in UTC sorts as text.
    out.sort_by(|a, b| b.merged_at.cmp(&a.merged_at));
    Ok(out)
}

/// What `gh release list --json tagName,publishedAt,isDraft` printed: the latest published release, and the drafts' tags.
pub fn parse_releases(json: &[u8]) -> Result<(Option<Release>, Vec<String>), String> {
    let list: Vec<serde_json::Value> = serde_json::from_slice(json).map_err(|e| format!("gh release list: {e}"))?;
    let mut latest: Option<Release> = None;
    let mut drafts = Vec::new();
    for r in &list {
        let Some(tag) = r["tagName"].as_str().filter(|t| !t.is_empty()) else { continue };
        if r["isDraft"].as_bool().unwrap_or(false) {
            drafts.push(tag.to_string());
            continue;
        }
        let at = r["publishedAt"].as_str().filter(|s| !s.is_empty()).map(String::from);
        if latest.as_ref().is_none_or(|l| at > l.published_at) {
            latest = Some(Release { tag: tag.to_string(), published_at: at });
        }
    }
    Ok((latest, drafts))
}

/// Linked worktrees in `git worktree list --porcelain`: every `worktree` line but the main checkout's.
pub fn count_worktrees(porcelain: &str) -> usize {
    porcelain.lines().filter(|l| l.starts_with("worktree ")).count().saturating_sub(1)
}

/// What a failed `gh` said, as a state: not logged in, or a failure that may pass.
fn gh_failed(stderr: &str) -> (Gh, String) {
    let lower = stderr.to_lowercase();
    if lower.contains("gh auth login") || lower.contains("not logged in") || lower.contains("authentication") {
        return (Gh::LoggedOut, "gh isn't logged in to GitHub.".into());
    }
    (Gh::Failed, stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("gh failed").chars().take(200).collect())
}

/// Asks GitHub about `github` ("owner/name"): three read-only `gh` calls, run outside any checkout.
fn ask_github(github: &str, path_env: Option<&str>) -> FromGh {
    let outside = std::env::temp_dir();
    let call = |args: &[&str]| run_program("gh", &outside, args, path_env, GH_TIMEOUT, Keep::Head);
    let mut got = FromGh { gh: Gh::Ready, prs: Vec::new(), merged: Vec::new(), release: None, drafts: Vec::new(), error: None };
    let failed = |got: &mut FromGh, (gh, why): (Gh, String)| {
        got.gh = gh;
        got.error = Some(why);
    };
    match call(&["pr", "list", "--repo", github, "--state", "open", "--limit", OPEN_MAX, "--json", "number,title,author,headRefName,isDraft,statusCheckRollup,reviewDecision"]) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            got.gh = Gh::Missing;
            return got;
        }
        Err(e) => {
            failed(&mut got, (Gh::Failed, e.to_string()));
            return got;
        }
        Ok(out) if !out.success => {
            failed(&mut got, gh_failed(&out.stderr));
            return got;
        }
        Ok(out) => match parse_open(&out.stdout) {
            Ok(prs) => got.prs = prs,
            Err(e) => failed(&mut got, (Gh::Failed, e)),
        },
    }
    // The other two only add to what is known: one failing leaves the rest.
    if let Ok(out) = call(&["pr", "list", "--repo", github, "--state", "merged", "--limit", MERGED_MAX, "--json", "number,title,mergedAt"]) {
        if out.success {
            got.merged = parse_merged(&out.stdout).unwrap_or_default();
        }
    }
    if let Ok(out) = call(&["release", "list", "--repo", github, "--limit", "5", "--json", "tagName,publishedAt,isDraft"]) {
        if out.success {
            (got.release, got.drafts) = parse_releases(&out.stdout).unwrap_or_default();
        }
    }
    got
}

fn from_github(key: &str, github: Option<&str>, path_env: Option<&str>) -> FromGh {
    let Some(github) = github else {
        return FromGh { gh: Gh::NotGithub, prs: Vec::new(), merged: Vec::new(), release: None, drafts: Vec::new(), error: None };
    };
    if let Some((at, kept)) = CACHE.lock().ok().and_then(|c| c.as_ref()?.get(key).cloned()) {
        if at.elapsed() < GH_FRESH {
            return kept;
        }
    }
    let got = ask_github(github, path_env);
    if let Ok(mut cache) = CACHE.lock() {
        cache.get_or_insert_with(HashMap::new).insert(key.to_string(), (Instant::now(), got.clone()));
    }
    got
}

/// The folders grouped by the repository they are in (its own git directory, which its worktrees share), each repository
/// once. A folder that isn't in one is left out.
fn by_repo(folders: &[String], path_env: Option<&str>) -> Vec<(PathBuf, Vec<String>)> {
    let mut groups: Vec<(PathBuf, Vec<String>)> = Vec::new();
    for folder in folders {
        let path = Path::new(folder);
        if !path.is_absolute() || !path.is_dir() {
            continue;
        }
        let Some(common) = git::common_dir(path, path_env) else { continue };
        match groups.iter_mut().find(|(c, _)| *c == common) {
            Some((_, list)) if !list.contains(folder) => list.push(folder.clone()),
            Some(_) => {}
            None => groups.push((common, vec![folder.clone()])),
        }
    }
    groups
}

/// The main checkout of the repository whose git directory is `common`: the folder holding `.git`, or (a bare repository)
/// the directory itself.
fn main_checkout(common: &Path) -> PathBuf {
    if common.file_name().is_some_and(|n| n == ".git") {
        common.parent().map(Path::to_path_buf).unwrap_or_else(|| common.to_path_buf())
    } else {
        common.to_path_buf()
    }
}

fn repo_status(common: &Path, folders: &[String], path_env: Option<&str>) -> RepoStatus {
    let main = main_checkout(common);
    let at = Path::new(&folders[0]);
    let github = git::run(at, &["remote", "get-url", "origin"], path_env).ok().and_then(|u| github_of(&u));
    let worktrees = git::run(at, &["worktree", "list", "--porcelain"], path_env).map(|p| count_worktrees(&p)).unwrap_or(0);
    let folders = folders
        .iter()
        .map(|f| {
            let path = Path::new(f);
            FolderStatus { folder: f.clone(), branch: git::current_branch(path), changed: git::dirty(path, path_env).ok().map(|d| d.len()) }
        })
        .collect();
    let got = from_github(&common.to_string_lossy(), github.as_deref(), path_env);
    RepoStatus {
        repo: main.to_string_lossy().into_owned(),
        github,
        folders,
        worktrees,
        gh: got.gh,
        prs: got.prs,
        merged: got.merged,
        release: got.release,
        drafts: got.drafts,
        error: got.error,
    }
}

/// How the repositories of `folders` (the open chats' folders) stand, each looked at in parallel. Blocking: call it off
/// the async threads.
pub fn status(folders: &[String], path_env: Option<&str>) -> Vec<RepoStatus> {
    let groups = by_repo(folders, path_env);
    std::thread::scope(|scope| {
        let handles: Vec<_> = groups.iter().map(|(common, list)| scope.spawn(move || repo_status(common, list, path_env))).collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_github_remotes_and_nothing_else() {
        assert_eq!(github_of("git@github.com:alyakan/lantern.git").as_deref(), Some("alyakan/lantern"));
        assert_eq!(github_of("https://github.com/alyakan/lantern").as_deref(), Some("alyakan/lantern"));
        assert_eq!(github_of("https://x-access-token:secret@github.com/alyakan/lantern.git/").as_deref(), Some("alyakan/lantern"));
        assert_eq!(github_of("ssh://git@github.com/alyakan/lantern.git").as_deref(), Some("alyakan/lantern"));
        assert_eq!(github_of("https://gitlab.com/a/b.git"), None);
        assert_eq!(github_of("https://github.com.evil.com/a/b"), None);
        assert_eq!(github_of("git@github.com:a/b c"), None);
        assert_eq!(github_of("git@github.com:--repo/x"), None);
        assert_eq!(github_of("git@github.com:../x"), None);
        assert_eq!(github_of("/local/path"), None);
    }

    #[test]
    fn rolls_checks_up() {
        let v = |s: &str| serde_json::from_str::<serde_json::Value>(s).unwrap();
        assert_eq!(rollup(&v("[]")), "none");
        assert_eq!(rollup(&v("null")), "none");
        assert_eq!(rollup(&v(r#"[{"status":"COMPLETED","conclusion":"SUCCESS"},{"state":"SUCCESS"}]"#)), "pass");
        assert_eq!(rollup(&v(r#"[{"status":"COMPLETED","conclusion":"SUCCESS"},{"status":"IN_PROGRESS","conclusion":""}]"#)), "pending");
        assert_eq!(rollup(&v(r#"[{"status":"IN_PROGRESS","conclusion":""},{"status":"COMPLETED","conclusion":"FAILURE"}]"#)), "fail");
        assert_eq!(rollup(&v(r#"[{"state":"PENDING"}]"#)), "pending");
        assert_eq!(rollup(&v(r#"[{"state":"ERROR"}]"#)), "fail");
    }

    #[test]
    fn parses_open_and_merged_pull_requests() {
        let open = br#"[{"number":7,"title":"feat: x","author":{"login":"aly"},"headRefName":"feat/x","isDraft":false,"statusCheckRollup":[{"status":"COMPLETED","conclusion":"FAILURE"}],"reviewDecision":""},{"title":"no number"}]"#;
        let prs = parse_open(open).unwrap();
        assert_eq!(prs.len(), 1);
        assert_eq!((prs[0].number, prs[0].checks, prs[0].review.clone()), (7, "fail", None));
        let merged = br#"[{"number":1,"title":"a","mergedAt":"2026-10-30T10:00:00Z"},{"number":2,"title":"b","mergedAt":"2026-10-31T09:00:00Z"},{"number":3,"title":"c"}]"#;
        assert_eq!(parse_merged(merged).unwrap().iter().map(|m| m.number).collect::<Vec<_>>(), vec![2, 1]);
        assert!(parse_open(b"not json").is_err());
    }

    #[test]
    fn finds_the_latest_published_release_and_the_drafts() {
        let list = br#"[{"tagName":"v0.1.94","publishedAt":"","isDraft":true},{"tagName":"v0.1.92","publishedAt":"2026-10-30T08:00:00Z","isDraft":false},{"tagName":"v0.1.93","publishedAt":"2026-10-31T08:00:00Z","isDraft":false}]"#;
        let (latest, drafts) = parse_releases(list).unwrap();
        assert_eq!(latest.unwrap().tag, "v0.1.93");
        assert_eq!(drafts, vec!["v0.1.94"]);
        assert_eq!(parse_releases(b"[]").unwrap(), (None, vec![]));
    }

    /// Asks GitHub for real: `cargo test --lib real_status -- --ignored --nocapture` (needs gh logged in).
    #[test]
    #[ignore]
    fn real_status() {
        let here = std::env::current_dir().unwrap().parent().unwrap().to_string_lossy().into_owned();
        let path = std::env::var("PATH").ok();
        for s in status(&[here], path.as_deref()) {
            println!("{s:#?}");
            assert_eq!(s.gh, Gh::Ready, "{:?}", s.error);
        }
    }

    #[test]
    fn counts_linked_worktrees() {
        let porcelain = "worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r-wt/a\nHEAD def\nbranch refs/heads/a\n\nworktree /r-wt/b\nHEAD 123\ndetached\n";
        assert_eq!(count_worktrees(porcelain), 2);
        assert_eq!(count_worktrees(""), 0);
    }

    #[test]
    fn groups_a_repository_and_its_worktrees_once_and_skips_what_isnt_one() {
        let base = std::env::temp_dir().join(format!("lantern-status-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |dir: &Path, args: &[&str]| git::run(dir, args, None).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one"]);
        let wt = base.join("wt");
        git(&repo, &["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap()]);
        std::fs::write(repo.join("new.txt"), "x").unwrap();
        let plain = base.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let folders = [repo.to_string_lossy().into_owned(), wt.to_string_lossy().into_owned(), plain.to_string_lossy().into_owned(), "relative/path".into()];
        let groups = by_repo(&folders, None);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].1.len(), 2);
        let s = repo_status(&groups[0].0, &groups[0].1, None);
        assert_eq!(std::fs::canonicalize(&s.repo).unwrap(), std::fs::canonicalize(&repo).unwrap());
        assert_eq!(s.worktrees, 1);
        assert_eq!(s.gh, Gh::NotGithub);
        assert_eq!(s.folders.iter().map(|f| (f.branch.clone(), f.changed)).collect::<Vec<_>>(), vec![(Some("main".into()), Some(1)), (Some("side".into()), Some(0))]);
        let _ = std::fs::remove_dir_all(&base);
    }
}
