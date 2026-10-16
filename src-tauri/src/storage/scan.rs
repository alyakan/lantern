//! The scanners: where things are found, what git says about them, and how big they are. Read-only: nothing here changes
//! a file. What each one finds is an `Item` with a risk: Safe, Review (the user decides) or Blocked (unsaved work in it).

#[cfg(test)]
use super::now_secs;
use super::{is_protected, run_program, Item, Kind, Removal, Risk, STALE_DAYS};
use crate::git::{self, At};
use std::collections::HashSet;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// A build folder or a cache that changed within this many days is probably being worked in: shown, not ticked.
const RECENT_DAYS: u64 = 7;
/// A worktree touched within this many days may be in use by a chat.
const WORKTREE_RECENT_DAYS: u64 = 1;
/// A simulator not booted for this many days is offered for review.
const SIMULATOR_IDLE_DAYS: u64 = 60;
/// Downloads smaller than this aren't worth listing.
const DOWNLOAD_MIN_BYTES: u64 = 50_000_000;
/// How deep a project is looked for under the home folder.
const DEPTH: usize = 6;

pub struct Env {
    pub home: PathBuf,
    pub path_env: Option<String>,
    pub now: i64,
    /// The folders (real paths) a chat or an agent is running in: a worktree or project holding one is never offered.
    pub in_use: Vec<PathBuf>,
}

/// Whether a chat or an agent is working in `path` or somewhere inside it.
fn busy(env: &Env, path: &Path) -> bool {
    let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    env.in_use.iter().any(|f| f.starts_with(&real))
}

/// `args` after `--no-optional-locks`: a scan looks at repositories agents are working in, and git's own habit of
/// refreshing the index as it reads would take `index.lock` from under their `git add`.
fn lockless<'a>(args: &[&'a str]) -> Vec<&'a str> {
    std::iter::once("--no-optional-locks").chain(args.iter().copied()).collect()
}

#[derive(Default)]
pub struct Scanned {
    pub items: Vec<Item>,
    pub notes: Vec<String>,
}

fn days_since(env: &Env, secs: i64) -> u64 {
    (env.now - secs).max(0) as u64 / 86_400
}

// ---------- sizes ----------

/// What a folder takes on disk and when anything in it last changed.
#[derive(Default, Clone, Copy)]
pub struct Usage {
    pub bytes: u64,
    /// The newest modification time (seconds since the epoch), not counting build folders: 0 when empty.
    pub newest: i64,
}

/// Names of folders that are build output or caches of a project: they take space and change on every build, so they
/// say nothing about whether the project is in use.
pub const BUILD_DIRS: [&str; 8] = ["node_modules", "target", ".next", ".turbo", "Pods", ".build", ".gradle", "DerivedData"];

/// Allocated bytes (not file lengths: clones and sparse files would be overstated) of `path`, and its newest change.
/// Symlinks aren't followed; a hard link is counted once.
pub fn usage(path: &Path, cancel: &AtomicBool) -> Usage {
    let mut out = Usage::default();
    let mut seen: HashSet<(u64, u64)> = HashSet::new();
    let mut stack: Vec<(PathBuf, bool)> = vec![(path.to_path_buf(), true)];
    while let Some((dir, counts_for_newest)) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Ok(meta) = std::fs::symlink_metadata(&dir) else { continue };
        let mut take = |m: &std::fs::Metadata, newest: bool| {
            if m.nlink() > 1 && !m.is_dir() && !seen.insert((m.dev(), m.ino())) {
                return;
            }
            out.bytes += m.blocks() * 512;
            if newest {
                out.newest = out.newest.max(m.mtime());
            }
        };
        take(&meta, counts_for_newest);
        if !meta.is_dir() {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                let build = entry.file_name().to_str().is_some_and(|n| BUILD_DIRS.contains(&n));
                stack.push((entry.path(), counts_for_newest && !build));
            } else if let Ok(m) = entry.metadata() {
                take(&m, counts_for_newest);
            }
        }
    }
    out
}

// ---------- finding projects and build output ----------

pub struct Found {
    pub repos: Vec<PathBuf>,
    /// A build folder or dependency folder, and what it is.
    pub artifacts: Vec<(PathBuf, &'static str)>,
}

/// What a folder named `name` is when it is build output, given the names beside it.
fn artifact(name: &str, beside: &dyn Fn(&str) -> bool) -> Option<&'static str> {
    match name {
        "node_modules" => Some("Installed packages: `npm install` (or yarn, pnpm) brings them back"),
        "target" if beside("Cargo.toml") => Some("Rust build output: the next `cargo build` rebuilds it (a full build takes minutes)"),
        ".next" => Some("Next.js build cache: rebuilt by the next build or dev server"),
        ".turbo" => Some("Turborepo cache: rebuilt by the next build"),
        "Pods" if beside("Podfile") => Some("CocoaPods dependencies: `pod install` brings them back"),
        ".build" if beside("Package.swift") => Some("SwiftPM build output: rebuilt by the next build"),
        ".gradle" if beside("build.gradle") || beside("build.gradle.kts") || beside("settings.gradle") || beside("settings.gradle.kts") => Some("Gradle project cache: rebuilt by the next build"),
        _ => None,
    }
}

const SKIP_TOP: [&str; 9] = ["Library", "Applications", "Desktop", "Documents", "Pictures", "Movies", "Music", "Public", "Sites"];

/// Looks for git repositories and build folders under the home folder, a few levels deep. A linked worktree (its `.git`
/// is a file) is left to its repository, which lists it.
pub fn discover(home: &Path, cancel: &AtomicBool) -> Found {
    let mut found = Found { repos: vec![], artifacts: vec![] };
    let mut stack: Vec<(PathBuf, usize)> = vec![(home.to_path_buf(), DEPTH)];
    while let Some((dir, left)) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let kids: Vec<(String, PathBuf, bool)> = rd.flatten().filter_map(|e| Some((e.file_name().to_str()?.to_string(), e.path(), e.file_type().ok()?.is_dir()))).collect();
        let beside = |n: &str| kids.iter().any(|(k, _, _)| k == n);
        if kids.iter().any(|(k, _, is_dir)| k == ".git" && !*is_dir) {
            continue;
        }
        let mut left = left;
        if kids.iter().any(|(k, _, is_dir)| k == ".git" && *is_dir) {
            found.repos.push(dir.clone());
            left = left.max(4);
        }
        for (name, path, is_dir) in &kids {
            if !is_dir {
                continue;
            }
            if let Some(what) = artifact(name, &beside) {
                found.artifacts.push((path.clone(), what));
                continue;
            }
            if name.starts_with('.') || (dir == home && SKIP_TOP.contains(&name.as_str())) || is_protected(home, path) {
                continue;
            }
            if left > 1 {
                stack.push((path.clone(), left - 1));
            }
        }
    }
    found
}

// ---------- git ----------

fn git_ok(dir: &Path, args: &[&str], env: &Env) -> Option<String> {
    git::run(dir, &lockless(args), env.path_env.as_deref()).ok()
}

/// One entry of `git worktree list`.
#[derive(Debug, Default, PartialEq)]
pub struct Wt {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub detached: bool,
    pub locked: bool,
}

/// The repository's worktrees, the main one first. Parsed from the NUL-separated form: a path may hold anything.
pub fn worktrees(repo: &Path, env: &Env) -> Vec<Wt> {
    let Ok(out) = git::run_raw(repo, &lockless(&["worktree", "list", "--porcelain", "-z"]), env.path_env.as_deref()) else { return vec![] };
    parse_worktrees(&out)
}

fn parse_worktrees(out: &str) -> Vec<Wt> {
    let mut list = vec![];
    let mut cur: Option<Wt> = None;
    for field in out.split('\0') {
        if field.is_empty() {
            list.extend(cur.take());
        } else if let Some(p) = field.strip_prefix("worktree ") {
            list.extend(cur.take());
            cur = Some(Wt { path: PathBuf::from(p), ..Wt::default() });
        } else if let Some(w) = cur.as_mut() {
            if let Some(b) = field.strip_prefix("branch ") {
                w.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            } else if field == "detached" {
                w.detached = true;
            } else if field == "locked" || field.starts_with("locked ") {
                w.locked = true;
            }
        }
    }
    list.extend(cur.take());
    list
}

const LIMIT: Duration = Duration::from_secs(60);

/// What git says about a checked worktree: loose files (not ignored), and the ignored files that aren't build output.
pub fn worktree_state(checked: &git::Checked, env: &Env) -> Result<(usize, Vec<String>), String> {
    let run = |args: &[&str]| git::run_with(At::Worktree(checked), &lockless(args), env.path_env.as_deref(), LIMIT, &[]);
    let status = run(&["status", "--porcelain", "-z", "--untracked-files=normal"])?;
    let dirty = status.split('\0').filter(|s| !s.is_empty()).count();
    let ignored = run(&["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])?;
    let extras: Vec<String> = ignored
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|p| !p.rsplit('/').next().is_some_and(|n| BUILD_DIRS.contains(&n) || n == ".DS_Store"))
        .collect();
    Ok((dirty, extras))
}

/// A worktree's item, assessed. None when it isn't a worktree git can vouch for.
pub fn worktree_item(repo: &Path, wt: &Wt, env: &Env, cancel: &AtomicBool) -> Option<Item> {
    let root = std::fs::canonicalize(&wt.path).ok()?;
    let checked = git::verify_worktree(repo, &root, env.path_env.as_deref()).ok()?;
    let use_ = usage(&root, cancel);
    let repo_name = repo.file_name()?.to_string_lossy().into_owned();
    let dir_name = root.file_name()?.to_string_lossy().into_owned();
    let branch = wt.branch.clone().unwrap_or_else(|| "a detached HEAD".into());
    let mut item = Item::new(Kind::Worktree, &root, format!("{repo_name}/{dir_name}"), use_.bytes, Removal::Worktree, format!("A worktree of {repo_name} on {branch}. Removing it leaves {}", if wt.branch.is_some() { "the branch and its commits in the repository." } else { "the repository as it is." }));
    item.repo = Some(repo.to_path_buf());
    let idle = if use_.newest > 0 { Some(days_since(env, use_.newest)) } else { None };
    item.idle_days = idle;
    let mut block = |why: String| {
        item.risk = Risk::Blocked;
        item.warning = Some(why);
    };
    match worktree_state(&checked, env) {
        _ if busy(env, &root) => block("A chat or an agent is working in it right now.".into()),
        Err(e) => block(format!("git couldn't read it: {}", e.lines().next().unwrap_or(""))),
        Ok((dirty, extras)) => {
            if wt.locked {
                block("It is locked: `git worktree unlock` it first.".into());
            } else if dirty > 0 {
                block(format!("{dirty} uncommitted change{} that exist nowhere else.", if dirty == 1 { "" } else { "s" }));
            } else if wt.detached && git_ok(&root, &["for-each-ref", "--contains", "HEAD", "--count=1", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"], env).is_none_or(|o| o.is_empty()) {
                block("Its detached HEAD has commits that no branch or tag has.".into());
            } else if !extras.is_empty() {
                item.risk = Risk::Review;
                item.warning = Some(format!("Holds ignored files git doesn't keep: {}.", extras.iter().take(4).cloned().collect::<Vec<_>>().join(", ")));
            } else if idle.is_some_and(|d| d < WORKTREE_RECENT_DAYS) {
                item.risk = Risk::Review;
                item.warning = Some("Changed in the last day: a chat may be using it.".into());
            }
        }
    }
    item.ticked = item.risk == Risk::Safe;
    Some(item)
}

/// A stale project's item: nothing changed in `STALE_DAYS`, and its state decides whether it is safe. None when it is in
/// use (or isn't one git can read).
pub fn repo_item(repo: &Path, env: &Env, cancel: &AtomicBool) -> Option<Item> {
    // Cheap first: git's own files change whenever it is used, so a project used lately is skipped without a walk.
    let git_dir = repo.join(".git");
    let touched = ["HEAD", "index", "FETCH_HEAD", "ORIG_HEAD", "logs/HEAD"].iter().filter_map(|f| std::fs::metadata(git_dir.join(f)).ok()).map(|m| m.mtime()).max().unwrap_or(0);
    if days_since(env, touched) < STALE_DAYS {
        return None;
    }
    let use_ = usage(repo, cancel);
    if use_.newest > 0 && days_since(env, use_.newest) < STALE_DAYS {
        return None;
    }
    let idle = days_since(env, use_.newest.max(touched));
    let name = repo.file_name()?.to_string_lossy().into_owned();
    let mut item = Item::new(Kind::Repo, repo, name, use_.bytes, Removal::Trash, "A project nothing has changed in for a long time. It goes to the Trash; ignored files such as .env go with it.");
    item.idle_days = Some(idle);
    let why = repo_blockers(repo, env);
    if let Some(why) = why {
        item.risk = Risk::Blocked;
        item.warning = Some(why);
    }
    item.ticked = item.risk == Risk::Safe;
    Some(item)
}

/// Why a project can't be deleted without losing something, or None when everything in it is saved elsewhere.
pub fn repo_blockers(repo: &Path, env: &Env) -> Option<String> {
    if busy(env, repo) {
        return Some("A chat or an agent is working in it right now.".into());
    }
    if repo.join(".git").is_dir() && worktrees(repo, env).len() > 1 {
        return Some("It has linked worktrees: remove those first.".into());
    }
    let Some(remotes) = git_ok(repo, &["remote"], env) else { return Some("git couldn't read it.".into()) };
    if remotes.is_empty() {
        return Some("It has no remote: this copy is the only one.".into());
    }
    match git_ok(repo, &["status", "--porcelain", "--untracked-files=normal"], env) {
        None => return Some("git couldn't read its state.".into()),
        Some(s) if !s.is_empty() => return Some(format!("{} uncommitted change(s).", s.lines().count())),
        _ => {}
    }
    match git_ok(repo, &["rev-list", "-n", "1", "--branches", "--not", "--remotes"], env) {
        None => return Some("git couldn't compare its branches with the remote.".into()),
        Some(s) if !s.is_empty() => return Some("It has commits that no remote has.".into()),
        _ => {}
    }
    if git_ok(repo, &["stash", "list"], env).is_none_or(|s| !s.is_empty()) {
        return Some("It has stashed changes.".into());
    }
    None
}

// ---------- jobs ----------

type Job = Box<dyn FnOnce(&Env, &AtomicBool) -> Scanned + Send>;

fn one(item: Option<Item>) -> Scanned {
    Scanned { items: item.into_iter().collect(), notes: vec![] }
}

fn job_for_repo(repo: PathBuf) -> Job {
    Box::new(move |env, cancel| {
        let mut out = Scanned::default();
        let list = worktrees(&repo, env);
        for wt in list.iter().skip(1) {
            if wt.path.is_dir() {
                out.items.extend(worktree_item(&repo, wt, env, cancel));
            }
        }
        out.items.extend(repo_item(&repo, env, cancel));
        out
    })
}

fn job_for_artifact(path: PathBuf, what: &'static str) -> Job {
    Box::new(move |env, cancel| {
        let u = usage(&path, cancel);
        if u.bytes == 0 {
            return Scanned::default();
        }
        // The last three parts of its path: `target` alone says nothing, `lantern/src-tauri/target` does.
        let parts: Vec<String> = path.strip_prefix(&env.home).unwrap_or(&path).components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
        let name = parts[parts.len().saturating_sub(3)..].join("/");
        let mtime = std::fs::metadata(&path).map(|m| m.mtime()).unwrap_or(0);
        let idle = days_since(env, mtime);
        let mut item = Item::new(Kind::BuildOutput, &path, name, u.bytes, Removal::Permanent, what);
        item.idle_days = Some(idle);
        item.ticked = idle >= RECENT_DAYS;
        if !item.ticked {
            item.warning = Some(format!("Changed {} day(s) ago: you may be working in this project.", idle));
        }
        one(Some(item))
    })
}

/// A cache folder or file: ticked unless it changed lately (or `keep_unticked`).
fn job_for_cache(path: PathBuf, name: String, note: String, ticked: bool, kind: Kind, removal: Removal, min_bytes: u64) -> Job {
    Box::new(move |env, cancel| {
        let u = usage(&path, cancel);
        if u.bytes == 0 || u.bytes < min_bytes {
            return Scanned::default();
        }
        let mtime = std::fs::symlink_metadata(&path).map(|m| m.mtime()).unwrap_or(0);
        let mut item = Item::new(kind, &path, name, u.bytes, removal, note);
        let idle = days_since(env, mtime);
        item.idle_days = Some(idle);
        item.ticked = ticked;
        // A cache written in the last week is in use (an Xcode project's DerivedData, say): clearing it makes the next build slow.
        if kind == Kind::Cache && ticked && idle < RECENT_DAYS {
            item.ticked = false;
            item.warning = Some(format!("Changed {idle} day(s) ago: it is probably in use, and clearing it makes the next build slower."));
        }
        if kind == Kind::Download {
            item.risk = Risk::Review;
            item.warning = Some("It's yours: check it before deleting.".into());
        }
        one(Some(item))
    })
}

/// (path under home, note, ticked): Sweep's developer caches, each with how it comes back.
fn known_caches() -> Vec<(&'static str, &'static str, bool)> {
    vec![
        ("Library/Developer/Xcode/iOS DeviceSupport", "Device symbols: rebuilt only when you reconnect a device on that iOS version", false),
        ("Library/Developer/Xcode/watchOS DeviceSupport", "Device symbols: rebuilt only when you reconnect a watch on that version", false),
        ("Library/Developer/Xcode/tvOS DeviceSupport", "Device symbols: rebuilt only when you reconnect a device on that version", false),
        ("Library/Developer/CoreSimulator/Caches", "Simulator cache: rebuilt automatically", true),
        ("Library/Caches/org.swift.swiftpm", "SwiftPM cache: downloaded again when building", true),
        ("Library/Caches/CocoaPods", "CocoaPods cache: downloaded again by pod install", true),
        ("Library/Caches/com.apple.dt.Xcode", "Xcode cache: rebuilt automatically", true),
        ("Library/Caches/Homebrew", "Homebrew download cache: downloaded again as needed", true),
        ("Library/Caches/pip", "pip download cache: downloaded again as needed", true),
        ("Library/Caches/Yarn", "Yarn cache: downloaded again as needed", true),
        (".npm", "npm cache: downloaded again as needed", true),
        (".gradle/caches", "Gradle cache: downloaded again as needed", true),
        (".m2/repository", "Maven repository cache: downloaded again as needed", true),
        (".cocoapods/repos", "CocoaPods spec repos: cloned again by pod install", true),
    ]
}

/// Where each known cache is, for the delete-time check that a cache item is really one.
pub fn known_cache_paths(home: &Path) -> Vec<PathBuf> {
    known_caches().iter().map(|(p, _, _)| home.join(p)).collect()
}

fn top_level(dir: &Path, hidden: bool) -> Vec<PathBuf> {
    std::fs::read_dir(dir).map(|rd| rd.flatten().filter(|e| hidden || !e.file_name().to_string_lossy().starts_with('.')).map(|e| e.path()).collect()).unwrap_or_default()
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn system_jobs(env: &Env) -> Vec<Job> {
    let home = &env.home;
    let mut jobs: Vec<Job> = vec![];
    let known: Vec<PathBuf> = known_caches().iter().map(|(p, _, _)| home.join(p)).collect();
    for (rel, note, ticked) in known_caches() {
        let p = home.join(rel);
        // Named by where it is ("~/.gradle/caches"), since "caches" or "repository" alone say nothing.
        jobs.push(job_for_cache(p.clone(), rel.strip_prefix("Library/").unwrap_or(rel).to_string(), note.to_string(), ticked, Kind::Cache, Removal::Permanent, 0));
    }
    for entry in top_level(&home.join("Library/Developer/Xcode/DerivedData"), false) {
        jobs.push(job_for_cache(entry.clone(), format!("DerivedData/{}", file_name(&entry)), "Xcode build output for one project: rebuilt by the next build".into(), true, Kind::Cache, Removal::Permanent, 0));
    }
    for root in ["Library/Caches", "Library/Logs"] {
        for entry in top_level(&home.join(root), false) {
            if known.contains(&entry) || file_name(&entry) == "CoreSimulator" && root == "Library/Logs" {
                continue;
            }
            let (note, label) = if root == "Library/Logs" { ("Log files: apps write new ones", "Logs") } else { ("An app's cache: the app rebuilds it", "Caches") };
            jobs.push(job_for_cache(entry.clone(), format!("{label}/{}", file_name(&entry)), note.into(), true, Kind::Cache, Removal::Permanent, 1_000_000));
        }
    }
    for entry in top_level(&home.join("Downloads"), false) {
        jobs.push(job_for_cache(entry.clone(), format!("Downloads/{}", file_name(&entry)), "In your Downloads folder. It goes to the Trash.".into(), false, Kind::Download, Removal::Trash, DOWNLOAD_MIN_BYTES));
    }
    jobs.push(Box::new(|env, _| simulators(env)));
    jobs
}

/// What is in the Trash, each entry its own item: deleting these is what gives the space back.
pub fn trash_items(env: &Env) -> Vec<Item> {
    let cancel = AtomicBool::new(false);
    top_level(&env.home.join(".Trash"), true)
        .into_iter()
        .filter(|p| file_name(p) != ".DS_Store")
        .filter_map(|p| {
            let u = usage(&p, &cancel);
            if u.bytes == 0 {
                return None;
            }
            let mut item = Item::new(Kind::Trash, &p, format!("Trash/{}", file_name(&p)), u.bytes, Removal::Permanent, "Already in the Trash: deleting it here is for good.");
            item.ticked = true;
            item.idle_days = Some(days_since(env, std::fs::symlink_metadata(&p).map(|m| m.mtime()).unwrap_or(0)));
            Some(item)
        })
        .collect()
}

// ---------- simulators ----------

/// "com.apple.CoreSimulator.SimRuntime.iOS-26-1" as "iOS 26.1".
fn runtime_name(id: &str) -> String {
    let token = id.rsplit('.').next().unwrap_or(id);
    let mut parts = token.split('-');
    match parts.next() {
        Some(os) => format!("{os} {}", parts.collect::<Vec<_>>().join(".")).trim().to_string(),
        None => token.to_string(),
    }
}

/// "2026-10-15T07:49:17Z" as seconds since the epoch.
pub fn parse_iso(s: &str) -> Option<i64> {
    let (date, time) = s.trim_end_matches('Z').split_once('T')?;
    let mut d = date.split('-').map(|n| n.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let mut t = time.split(':').map(|n| n.parse::<i64>().ok());
    let (hh, mm, ss) = (t.next()??, t.next()??, t.next()??);
    // Days since 1970-01-01 (Howard Hinnant's civil-days algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400 + hh * 3600 + mm * 60 + ss)
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36 && s.chars().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() })
}

pub fn uuid_ok(s: &str) -> bool {
    is_uuid(s)
}

/// Simulator devices that can't be used or haven't been for a long while, and the runtimes (several GB each) nobody is using.
pub fn simulators(env: &Env) -> Scanned {
    let mut out = Scanned::default();
    let Ok(devices) = run_program("/usr/bin/xcrun", &["simctl", "list", "devices", "--json"], Duration::from_secs(30)) else { return out };
    let Ok(devices) = serde_json::from_str::<serde_json::Value>(&devices) else { return out };
    let mut booted_on: HashSet<String> = HashSet::new();
    let mut count_on: std::collections::HashMap<String, usize> = Default::default();
    if let Some(map) = devices["devices"].as_object() {
        for (runtime, list) in map {
            for d in list.as_array().into_iter().flatten() {
                let (Some(udid), Some(name)) = (d["udid"].as_str(), d["name"].as_str()) else { continue };
                if !is_uuid(udid) {
                    continue;
                }
                *count_on.entry(runtime.clone()).or_default() += 1;
                if d["state"].as_str() != Some("Shutdown") {
                    booted_on.insert(runtime.clone());
                    continue;
                }
                let bytes = d["dataPathSize"].as_u64().unwrap_or(0) + d["logPathSize"].as_u64().unwrap_or(0);
                let available = d["isAvailable"].as_bool().unwrap_or(true);
                let idle = d["lastBootedAt"].as_str().and_then(parse_iso).map(|t| days_since(env, t));
                let path = env.home.join("Library/Developer/CoreSimulator/Devices").join(udid);
                let label = format!("{name} ({})", runtime_name(runtime));
                if !available {
                    let mut item = Item::new(Kind::Simulator, &path, label, bytes, Removal::SimulatorDevice, "Its runtime is gone, so Xcode can't use it.");
                    item.ticked = true;
                    item.idle_days = idle;
                    item.handle = Some(udid.to_string());
                    out.items.push(item);
                } else if bytes >= 50_000_000 && idle.is_some_and(|d| d >= SIMULATOR_IDLE_DAYS) {
                    let mut item = Item::new(Kind::Simulator, &path, label, bytes, Removal::SimulatorDevice, "A simulator device: its apps and data go with it; Xcode makes new ones on demand.");
                    item.risk = Risk::Review;
                    item.warning = Some(format!("Not booted for {} days; its apps and data are lost.", idle.unwrap_or(0)));
                    item.idle_days = idle;
                    item.handle = Some(udid.to_string());
                    out.items.push(item);
                }
            }
        }
    }
    if let Ok(runtimes) = run_program("/usr/bin/xcrun", &["simctl", "runtime", "list", "-j"], Duration::from_secs(30)) {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&runtimes) {
            for (_, r) in map {
                let (Some(id), Some(rid)) = (r["identifier"].as_str(), r["runtimeIdentifier"].as_str()) else { continue };
                if !is_uuid(id) || r["deletable"].as_bool() != Some(true) || r["state"].as_str() != Some("Ready") {
                    continue;
                }
                let bytes = r["sizeBytes"].as_u64().unwrap_or(0);
                let idle = r["lastUsedAt"].as_str().and_then(parse_iso).map(|t| days_since(env, t));
                let name = format!("{} simulator runtime", runtime_name(rid));
                let devices_on = count_on.get(rid).copied().unwrap_or(0);
                let path = PathBuf::from(r["path"].as_str().unwrap_or("/Library/Developer/CoreSimulator"));
                let mut item = Item::new(Kind::Simulator, &path, name, bytes, Removal::SimulatorRuntime, format!("The iOS/watchOS software simulators run on ({devices_on} device(s) use it). Xcode downloads it again if you need it."));
                item.idle_days = idle;
                item.handle = Some(id.to_string());
                item.risk = Risk::Review;
                item.warning = Some(format!("Last used {} day(s) ago; downloading it again takes a while.", idle.unwrap_or(0)));
                if booted_on.contains(rid) {
                    item.risk = Risk::Blocked;
                    item.warning = Some("A simulator on it is running.".into());
                }
                out.items.push(item);
            }
        }
    }
    out
}

/// How many local Time Machine snapshots there are. macOS counts them as System Data and keeps them until it needs the
/// room, so deleting files can seem to free nothing. Best effort: any failure is none.
pub fn local_snapshots() -> usize {
    run_program("/usr/bin/tmutil", &["listlocalsnapshots", "/"], Duration::from_secs(15)).map(|o| o.lines().filter(|l| l.contains("com.apple.TimeMachine.")).count()).unwrap_or(0)
}

// ---------- the scan ----------

/// Runs every scanner, `WORKERS` at a time, and returns the items biggest first.
pub fn scan(env: &Env, cancel: &AtomicBool, progress: &(dyn Fn(String) + Sync)) -> Scanned {
    progress("Looking for projects…".into());
    let found = discover(&env.home, cancel);
    let mut jobs: Vec<Job> = system_jobs(env);
    jobs.extend(found.repos.into_iter().map(job_for_repo));
    jobs.extend(found.artifacts.into_iter().map(|(p, what)| job_for_artifact(p, what)));
    let total = jobs.len();
    let jobs: Vec<Mutex<Option<Job>>> = jobs.into_iter().map(|j| Mutex::new(Some(j))).collect();
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let results: Mutex<Vec<Scanned>> = Mutex::new(vec![]);
    const WORKERS: usize = 4;
    std::thread::scope(|s| {
        for _ in 0..WORKERS {
            s.spawn(|| loop {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                let i = next.fetch_add(1, Ordering::SeqCst);
                let Some(slot) = jobs.get(i) else { break };
                let Some(job) = slot.lock().unwrap_or_else(|e| e.into_inner()).take() else { continue };
                let out = job(env, cancel);
                results.lock().unwrap_or_else(|e| e.into_inner()).push(out);
                let n = done.fetch_add(1, Ordering::SeqCst) + 1;
                if n % 10 == 0 || n == total {
                    progress(format!("Measured {n} of {total} places"));
                }
            });
        }
    });
    let mut all = Scanned::default();
    for r in results.into_inner().unwrap_or_default() {
        all.items.extend(r.items);
        all.notes.extend(r.notes);
    }
    all.items.extend(trash_items(env));
    if std::fs::read_dir(env.home.join(".Trash")).is_err() && env.home.join(".Trash").exists() {
        all.notes.push("Lantern can't read the Trash: give it Full Disk Access in System Settings to list it here.".into());
    }
    // Several things can be found twice (a cache both listed and inside a project): keep the first of an id.
    let mut seen = HashSet::new();
    all.items.retain(|i| seen.insert(i.id.clone()));
    link_within(&mut all.items);
    all.items.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    all
}

/// Marks what is inside a worktree or a project another item covers, so a total doesn't count it twice.
fn link_within(items: &mut [Item]) {
    let holders: Vec<(String, PathBuf)> = items.iter().filter(|i| matches!(i.kind, Kind::Worktree | Kind::Repo)).map(|i| (i.id.clone(), PathBuf::from(&i.path))).collect();
    for item in items.iter_mut().filter(|i| matches!(i.kind, Kind::BuildOutput)) {
        let p = PathBuf::from(&item.path);
        item.within = holders.iter().find(|(_, h)| p.starts_with(h)).map(|(id, _)| id.clone());
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::process::Command;

    pub(crate) fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"]).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A repository with a commit, a bare remote it is pushed to, and a home to put it in.
    pub(crate) struct World {
        pub _home: tempfile::TempDir,
        pub repo: PathBuf,
        pub env: Env,
    }

    pub(crate) fn world() -> World {
        let home = tempfile::tempdir().unwrap();
        let home_path = std::fs::canonicalize(home.path()).unwrap();
        let remote = home_path.join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        git(&remote, &["init", "--bare", "-b", "main"]);
        let repo = home_path.join("dev/app");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "hello").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "first"]);
        git(&repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&repo, &["push", "-u", "origin", "main"]);
        let env = Env { home: home_path, path_env: None, now: now_secs(), in_use: vec![] };
        World { _home: home, repo, env }
    }

    fn add_worktree(w: &World, name: &str, branch: &str) -> PathBuf {
        let path = w.env.home.join("wt").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        git(&w.repo, &["worktree", "add", "-b", branch, path.to_str().unwrap()]);
        std::fs::canonicalize(&path).unwrap()
    }

    fn wt_of(w: &World, path: &Path) -> Wt {
        worktrees(&w.repo, &w.env).into_iter().find(|t| std::fs::canonicalize(&t.path).ok().as_deref() == Some(path)).unwrap()
    }

    fn set_old(path: &Path, days: i64) {
        let t = std::time::SystemTime::now() - Duration::from_secs(days as u64 * 86_400);
        let f = std::fs::File::open(path).unwrap();
        f.set_modified(t).unwrap();
    }

    #[test]
    fn worktrees_are_read_from_the_nul_separated_list_whatever_their_paths_hold() {
        let text = "worktree /a b\n/main\0HEAD abc\0branch refs/heads/main\0\0worktree /w1\0HEAD def\0detached\0locked why\0\0";
        let list = parse_worktrees(text);
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].path.to_str().unwrap(), list[0].branch.as_deref()), ("/a b\n/main", Some("main")));
        assert!(list[1].detached && list[1].locked && list[1].branch.is_none());
    }

    #[test]
    fn a_clean_worktree_is_safe_and_ticked_and_a_dirty_one_is_blocked() {
        let w = world();
        let clean = add_worktree(&w, "clean", "feat/clean");
        let dirty = add_worktree(&w, "dirty", "feat/dirty");
        std::fs::write(dirty.join("new.txt"), "unsaved").unwrap();
        // Idle for a while, so only the git state decides.
        for p in [&clean, &dirty] {
            set_old(&p.join("a.txt"), 10);
            for f in std::fs::read_dir(p).unwrap().flatten() {
                let _ = std::fs::File::open(f.path()).and_then(|f| f.set_modified(std::time::SystemTime::now() - Duration::from_secs(10 * 86_400)));
            }
            set_old(p, 10);
        }
        let cancel = AtomicBool::new(false);
        let item = worktree_item(&w.repo, &wt_of(&w, &clean), &w.env, &cancel).unwrap();
        assert_eq!((item.risk, item.ticked), (Risk::Safe, true), "{:?}", item.warning);
        let item = worktree_item(&w.repo, &wt_of(&w, &dirty), &w.env, &cancel).unwrap();
        assert_eq!((item.risk, item.ticked), (Risk::Blocked, false));
        assert!(item.warning.unwrap().contains("uncommitted"));
    }

    #[test]
    fn a_worktree_touched_today_or_holding_an_env_file_needs_a_look() {
        let w = world();
        let fresh = add_worktree(&w, "fresh", "feat/fresh");
        let cancel = AtomicBool::new(false);
        let item = worktree_item(&w.repo, &wt_of(&w, &fresh), &w.env, &cancel).unwrap();
        assert_eq!((item.risk, item.ticked), (Risk::Review, false));
        assert!(item.warning.unwrap().contains("last day"));
        // An ignored .env that git doesn't keep.
        std::fs::write(w.repo.join(".gitignore"), ".env\n").unwrap();
        git(&w.repo, &["add", "."]);
        git(&w.repo, &["commit", "-m", "ignore"]);
        let other = add_worktree(&w, "other", "feat/other");
        std::fs::write(other.join(".env"), "SECRET=1").unwrap();
        let item = worktree_item(&w.repo, &wt_of(&w, &other), &w.env, &cancel).unwrap();
        assert_eq!(item.risk, Risk::Review);
        assert!(item.warning.unwrap().contains(".env"));
    }

    #[test]
    fn a_detached_worktree_is_blocked_only_when_its_commits_are_nowhere_else() {
        let w = world();
        let path = w.env.home.join("wt/det");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        git(&w.repo, &["worktree", "add", "--detach", path.to_str().unwrap()]);
        let path = std::fs::canonicalize(&path).unwrap();
        let cancel = AtomicBool::new(false);
        // At a commit a branch has: nothing is lost by removing it.
        let item = worktree_item(&w.repo, &wt_of(&w, &path), &w.env, &cancel).unwrap();
        assert_ne!(item.risk, Risk::Blocked, "{:?}", item.warning);
        std::fs::write(path.join("b.txt"), "b").unwrap();
        git(&path, &["add", "."]);
        git(&path, &["commit", "-m", "only here"]);
        let item = worktree_item(&w.repo, &wt_of(&w, &path), &w.env, &cancel).unwrap();
        assert_eq!(item.risk, Risk::Blocked);
        assert!(item.warning.unwrap().contains("detached HEAD"));
    }

    #[test]
    fn a_project_is_stale_only_when_old_and_everything_in_it_is_saved() {
        let w = world();
        let cancel = AtomicBool::new(false);
        // Used today: not offered.
        assert!(repo_item(&w.repo, &w.env, &cancel).is_none());
        // 90 days on, pushed and clean: safe.
        let later = Env { home: w.env.home.clone(), path_env: None, now: w.env.now + 90 * 86_400, in_use: vec![] };
        let item = repo_item(&w.repo, &later, &cancel).unwrap();
        assert_eq!((item.risk, item.ticked, item.removal), (Risk::Safe, true, Removal::Trash), "{:?}", item.warning);
        // An unpushed commit blocks it.
        std::fs::write(w.repo.join("c.txt"), "c").unwrap();
        git(&w.repo, &["add", "."]);
        git(&w.repo, &["commit", "-m", "local only"]);
        let item = repo_item(&w.repo, &later, &cancel).unwrap();
        assert_eq!(item.risk, Risk::Blocked);
        assert!(item.warning.unwrap().contains("no remote has"));
        // So does an uncommitted change, a stash, and having no remote at all.
        git(&w.repo, &["push"]);
        assert!(repo_blockers(&w.repo, &later).is_none());
        std::fs::write(w.repo.join("c.txt"), "changed").unwrap();
        assert!(repo_blockers(&w.repo, &later).unwrap().contains("uncommitted"));
        git(&w.repo, &["stash"]);
        assert!(repo_blockers(&w.repo, &later).unwrap().contains("stash"));
        git(&w.repo, &["remote", "remove", "origin"]);
        assert!(repo_blockers(&w.repo, &later).unwrap().contains("no remote"));
    }

    #[test]
    fn a_worktree_or_project_a_chat_is_running_in_is_blocked_and_a_stopped_ones_is_not() {
        let w = world();
        let wt = add_worktree(&w, "live", "feat/live");
        let cancel = AtomicBool::new(false);
        // A chat open in a subfolder of the worktree counts as in it.
        std::fs::create_dir_all(wt.join("sub")).unwrap();
        let live = Env { in_use: vec![wt.join("sub")], ..clone_env(&w.env) };
        let item = worktree_item(&w.repo, &wt_of(&w, &wt), &live, &cancel).unwrap();
        assert_eq!(item.risk, Risk::Blocked);
        assert!(item.warning.unwrap().contains("working in it"));
        // The repository holding the chat's folder is busy too (its worktrees aren't).
        assert!(repo_blockers(&w.repo, &Env { in_use: vec![w.repo.join("src")], ..clone_env(&w.env) }).unwrap().contains("working in it"));
        assert!(repo_blockers(&w.repo, &Env { in_use: vec![wt.clone()], ..clone_env(&w.env) }).unwrap().contains("linked worktrees"));
        // No chat in it: only its own state decides.
        let free = Env { in_use: vec![w.repo.clone()], ..clone_env(&w.env) };
        assert_ne!(worktree_item(&w.repo, &wt_of(&w, &wt), &free, &cancel).unwrap().warning.as_deref(), Some("A chat or an agent is working in it right now."));
    }

    fn clone_env(e: &Env) -> Env {
        Env { home: e.home.clone(), path_env: e.path_env.clone(), now: e.now, in_use: e.in_use.clone() }
    }

    #[test]
    fn a_cache_written_this_week_is_shown_but_not_ticked() {
        let home = tempfile::tempdir().unwrap();
        let env = Env { home: std::fs::canonicalize(home.path()).unwrap(), path_env: None, now: now_secs(), in_use: vec![] };
        let fresh = env.home.join("Library/Developer/Xcode/DerivedData/App-abc");
        std::fs::create_dir_all(&fresh).unwrap();
        std::fs::write(fresh.join("x"), vec![1u8; 10_000]).unwrap();
        let job = job_for_cache(fresh.clone(), "DerivedData/App-abc".into(), "n".into(), true, Kind::Cache, Removal::Permanent, 0);
        let item = job(&env, &AtomicBool::new(false)).items.remove(0);
        assert!(!item.ticked && item.warning.unwrap().contains("in use"));
        // Old: ticked.
        std::fs::File::open(&fresh).unwrap().set_modified(std::time::SystemTime::now() - Duration::from_secs(30 * 86_400)).unwrap();
        let job = job_for_cache(fresh, "DerivedData/App-abc".into(), "n".into(), true, Kind::Cache, Removal::Permanent, 0);
        assert!(job(&env, &AtomicBool::new(false)).items.remove(0).ticked);
    }

    #[test]
    fn a_project_with_a_linked_worktree_is_blocked_until_the_worktree_is_gone() {
        let w = world();
        add_worktree(&w, "x", "feat/x");
        assert!(repo_blockers(&w.repo, &w.env).unwrap().contains("linked worktrees"));
    }

    #[test]
    fn build_output_is_found_beside_its_manifest_and_a_linked_worktree_is_left_to_its_repository() {
        let home = tempfile::tempdir().unwrap();
        let h = std::fs::canonicalize(home.path()).unwrap();
        let mk = |p: &str| std::fs::create_dir_all(h.join(p)).unwrap();
        mk("dev/rust-app/target");
        std::fs::write(h.join("dev/rust-app/Cargo.toml"), "").unwrap();
        mk("dev/plain/target");
        mk("dev/web/node_modules/pkg");
        mk("dev/web/.next");
        mk("Documents/skipped/node_modules");
        mk("Library/Caches/skipped/node_modules");
        mk(".hidden/node_modules");
        mk("dev/wt");
        std::fs::write(h.join("dev/wt/.git"), "gitdir: /elsewhere").unwrap();
        mk("dev/wt/node_modules");
        let found = discover(&h, &AtomicBool::new(false));
        let mut names: Vec<String> = found.artifacts.iter().map(|(p, _)| p.strip_prefix(&h).unwrap().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["dev/rust-app/target", "dev/web/.next", "dev/web/node_modules"]);
    }

    #[test]
    fn usage_counts_allocated_blocks_once_per_hard_link_and_ignores_build_folders_for_idleness() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a"), vec![1u8; 10_000]).unwrap();
        std::fs::hard_link(dir.path().join("a"), dir.path().join("b")).unwrap();
        std::fs::create_dir(dir.path().join("target")).unwrap();
        std::fs::write(dir.path().join("target/x"), vec![1u8; 10_000]).unwrap();
        set_old(&dir.path().join("target/x"), 100);
        let u = usage(dir.path(), &AtomicBool::new(false));
        assert!(u.bytes >= 20_000 && u.bytes < 40_000, "{}", u.bytes);
        // The file in target/ is old, but it doesn't count toward when the project last changed; `a` is new.
        assert!(u.newest > now_secs() - 60);
    }

    /// Not run with the others: scans the real home folder (read-only) and prints what it finds, for a look by hand.
    /// `cargo test --lib scan_this_mac -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn scan_this_mac() {
        let env = Env { home: PathBuf::from(std::env::var("HOME").unwrap()), path_env: None, now: now_secs(), in_use: vec![] };
        let started = std::time::Instant::now();
        let out = scan(&env, &AtomicBool::new(false), &|p| eprintln!("  {p}"));
        eprintln!("{} items in {:?}", out.items.len(), started.elapsed());
        for i in out.items.iter().take(40) {
            eprintln!("{:>9} {:?} {:?} ticked={} within={} idle={:?} {} | {}", crate::storage::size_text(i.bytes), i.kind, i.risk, i.ticked, i.within.is_some(), i.idle_days, i.name, i.warning.clone().unwrap_or_default());
        }
        let total: u64 = out.items.iter().filter(|i| i.within.is_none() && i.risk != Risk::Blocked).map(|i| i.bytes).sum();
        eprintln!("clearable: {} · notes: {:?}", crate::storage::size_text(total), out.notes);
    }

    #[test]
    fn dates_and_runtime_names_are_read_from_simctl() {
        assert_eq!(parse_iso("1970-01-02T00:00:01Z"), Some(86_401));
        assert_eq!(parse_iso("2026-10-15T07:49:17Z"), Some(1_792_050_557));
        assert_eq!(parse_iso("nonsense"), None);
        assert_eq!(runtime_name("com.apple.CoreSimulator.SimRuntime.iOS-26-1"), "iOS 26.1");
        assert!(is_uuid("5A207D10-248E-4610-BECC-DB95BF1C7E99") && !is_uuid("../../etc") && !is_uuid("5A207D10"));
    }
}
