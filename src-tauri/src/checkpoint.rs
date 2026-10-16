//! Restore points: before each message the user sends, the folder's files (tracked ones with their edits, and untracked
//! ones that aren't ignored) are kept as a commit under a hidden ref, so the folder can be put back to how it stood
//! before any of the chat's messages. Nothing of the user's is touched to make one: the files are added to a private
//! index (a copy of the repository's own, kept in its git directory), so the branch, the index, the stash list and the
//! working tree stay as they are, and the commit is on no branch, so `git log` and `git status` don't show it.
//!
//! An untracked file over 20 MB is not kept (a build output, a database, a video: copying it before every message would
//! be slow and fill the repository). It is left alone by a restore too: never written over, never moved to the Trash.
//!
//! Putting the folder back writes only files inside the chat's folder, never through a link, never in a `.git` folder,
//! and never ignored files (they are in no restore point). A file Claude created since is moved to the Trash. Before it
//! writes anything it makes a restore point of what is there, which Undo puts back.

use crate::git::{self, At, Checked};
use crate::revert::Trash;
use serde::Serialize;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How many restore points a chat keeps: the last ones, which matter. Older refs are deleted.
const KEEP: usize = 50;
/// Restore points a run left behind (the app quit, the chat closed) go once they are this old.
const STALE: Duration = Duration::from_secs(14 * 24 * 60 * 60);
/// Longer than this and the checkpoint is given up: it is never worth holding a message back for.
const LIMIT: Duration = Duration::from_secs(60);
const REFS: &str = "refs/lantern/checkpoints";
/// An untracked file bigger than this is not kept in a restore point, and a restore leaves it as it is.
const BIG_FILE: u64 = 20 * 1024 * 1024;
const BIG_REASON: &str = "It is over 20 MB, so restore points don't keep it and it is left alone.";
/// Who a restore point's commit is by, so it never fails for want of a configured name.
const WHO: [(&str, &str); 4] = [("GIT_AUTHOR_NAME", "Lantern"), ("GIT_AUTHOR_EMAIL", "lantern@localhost"), ("GIT_COMMITTER_NAME", "Lantern"), ("GIT_COMMITTER_EMAIL", "lantern@localhost")];

/// Where git runs for a chat's folder: the repository's top, and how git is told to get there.
pub struct Place {
    how: How,
    /// The top of the checkout, as a real path.
    top: PathBuf,
    /// The chat's folder inside it ("" at the top): all that a restore touches.
    prefix: PathBuf,
    /// The folder as the chat has it, which is what the paths shown to the user start with.
    folder: PathBuf,
}

enum How {
    /// The user's own checkout: git finds its repository from the folder.
    Dir,
    /// A linked worktree, checked (see `git::verify_worktree`): git is told where its repository is.
    Worktree(Checked),
}

impl Place {
    /// The checkout `folder` is in, or None when it isn't in a git repository (or git can't be trusted there). Found on
    /// disk, not by asking git. A linked worktree is only used once checked against its main repository: `main` is the
    /// Lead's folder for a worker's, and without it the repository the worktree itself points at.
    pub fn find(folder: &Path, main: Option<&Path>, path_env: Option<&str>) -> Option<Place> {
        let root = folder.ancestors().find(|d| d.join(".git").symlink_metadata().is_ok())?;
        let kind = root.join(".git").symlink_metadata().ok()?.file_type();
        let (how, top) = if kind.is_dir() {
            (How::Dir, std::fs::canonicalize(root).ok()?)
        } else if kind.is_file() {
            let repo = main.map(Path::to_path_buf).or_else(|| repo_of_worktree(root))?;
            let checked = git::verify_worktree(&repo, root, path_env).ok()?;
            let top = checked.root().to_path_buf();
            (How::Worktree(checked), top)
        } else {
            return None;
        };
        let prefix = std::fs::canonicalize(folder).ok()?.strip_prefix(&top).ok()?.to_path_buf();
        Some(Place { how, top, prefix, folder: folder.to_path_buf() })
    }

    fn at(&self) -> At<'_> {
        match &self.how {
            How::Dir => At::Dir(&self.top),
            How::Worktree(wt) => At::Worktree(wt),
        }
    }

    /// The directory the index, and Lantern's private files next to it, live in.
    fn git_dir(&self) -> PathBuf {
        match &self.how {
            How::Dir => self.top.join(".git"),
            How::Worktree(wt) => wt.admin().to_path_buf(),
        }
    }

    /// A path from the top of the checkout, as the chat shows it.
    fn shown(&self, rel: &str) -> String {
        self.folder.join(Path::new(rel).strip_prefix(&self.prefix).unwrap_or(Path::new(rel))).display().to_string()
    }
}

/// The main repository a linked worktree's own `.git` file points back to, for a worktree without a Lead to say.
fn repo_of_worktree(root: &Path) -> Option<PathBuf> {
    let pointer = std::fs::read_to_string(root.join(".git")).ok()?;
    let admin = std::fs::canonicalize(root.join(pointer.trim().strip_prefix("gitdir:")?.trim())).ok()?;
    let common = std::fs::canonicalize(admin.join(std::fs::read_to_string(admin.join("commondir")).ok()?.trim())).ok()?;
    (common.file_name()? == ".git").then(|| common.parent().map(Path::to_path_buf))?
}

fn git(place: &Place, args: &[&str], env: &[(&str, &OsStr)], path_env: Option<&str>) -> Result<String, String> {
    git::run_with(place.at(), args, path_env, LIMIT, env)
}

/// A file git wrote for a moment (a private index), removed when it goes out of scope.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// One restore point.
#[derive(Clone)]
struct Point {
    id: u64,
    /// The message it was taken before (None: taken before a restore).
    turn: Option<usize>,
    tree: String,
}

/// What the last restore left, for Undo.
struct Undo {
    id: u64,
    /// How the folder stood before the restore.
    before: String,
    /// How it stood right after it.
    after: String,
}

#[derive(Default)]
struct State {
    /// When this run began (seconds), so its refs are told from an earlier run's.
    run: u64,
    next: u64,
    points: Vec<Point>,
    /// The latest tree and the commit made for it: a message sent with nothing changed since reuses it.
    last: Option<(String, String)>,
    swept: bool,
    /// The private index this chat keeps: it remembers the files' times, so a checkpoint only reads what changed.
    index: Option<PathBuf>,
    undo: Option<Undo>,
    /// The untracked files over BIG_FILE the last snapshot left out.
    large: HashSet<String>,
    /// For each tree kept, the big files that were left out of it: a restore to it leaves them alone, even once they are small.
    left_out: std::collections::HashMap<String, HashSet<String>>,
}

/// A chat's restore points. Lives as long as the chat's slot.
#[derive(Default)]
pub struct Checkpoints {
    state: Mutex<State>,
    /// A turn is running: files are changing, so nothing is restored.
    running: AtomicBool,
}

/// What putting the folder back would do.
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Plan {
    /// Files that go back to how they were (changed since, or deleted since).
    pub put_back: Vec<String>,
    /// Files made since: they go to the Trash.
    pub removed: Vec<String>,
    /// Files that are left alone, and why.
    pub skipped: Vec<Skipped>,
    /// The lines changed since, which are lost.
    pub lines: u64,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

/// What a restore (or its undo) did.
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Restored {
    /// What Undo is asked with (None: nothing to undo, or it can't be).
    pub id: Option<u64>,
    pub put_back: Vec<String>,
    pub removed: Vec<String>,
    pub skipped: Vec<Skipped>,
    /// Files an Undo left as they are because they were edited after the restore.
    pub kept: Vec<String>,
}

#[derive(PartialEq)]
enum Kind {
    /// The restore point has the file: it is written.
    Put,
    /// The restore point doesn't: the file is a newer one.
    Remove,
}

struct Change {
    kind: Kind,
    old_mode: String,
    new_mode: String,
    path: String,
}

/// What a set of changes comes to once each path has been checked.
#[derive(Default)]
struct Work {
    /// (as shown, as git has it)
    put: Vec<(String, String)>,
    /// (as shown, on disk, as git has it)
    remove: Vec<(String, PathBuf, String)>,
    skipped: Vec<Skipped>,
    kept: Vec<String>,
}

fn skip(place: &Place, rel: &str, reason: impl Into<String>) -> Skipped {
    Skipped { path: place.shown(rel), reason: reason.into() }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Drop for Checkpoints {
    fn drop(&mut self) {
        if let Some(index) = self.state.get_mut().ok().and_then(|s| s.index.take()) {
            let _ = std::fs::remove_file(index);
        }
    }
}

impl State {
    fn key(&mut self, slot: &str) -> Result<String, String> {
        // The slot ids the UI makes (see slots::valid_slot): they end up in a ref name and a file name.
        if !(1..=16).contains(&slot.len()) || !slot.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(format!("{slot:?} is not a chat id."));
        }
        if self.run == 0 {
            self.run = now();
        }
        Ok(format!("{slot}-{:x}", self.run))
    }

    /// The tree of every file there is now, in the way described above.
    fn snapshot(&mut self, place: &Place, slot: &str, path_env: Option<&str>) -> Result<String, String> {
        let key = self.key(slot)?;
        let dir = place.git_dir();
        if !self.swept {
            self.swept = true;
            sweep(place, &dir, &key, path_env);
        }
        let index = dir.join(format!("lantern-index-{key}"));
        if !index.exists() {
            // Seeded from the repository's own, so the files it knows aren't read again; none yet is an empty one.
            let _ = std::fs::copy(dir.join("index"), &index);
        }
        self.index = Some(index.clone());
        let env: [(&str, &OsStr); 1] = [("GIT_INDEX_FILE", index.as_os_str())];
        let large = large_untracked(place, path_env);
        match add_all_but(place, &large, &env, path_env).and_then(|_| git(place, &["write-tree"], &env, path_env)) {
            Ok(tree) => {
                let tree = tree.trim().to_string();
                self.left_out.entry(tree.clone()).or_default().extend(large.iter().cloned());
                self.large = large;
                Ok(tree)
            }
            Err(e) => {
                // Started again from the repository's index next time.
                let _ = std::fs::remove_file(&index);
                Err(e)
            }
        }
    }

    /// Keeps `tree` as a restore point under a ref of its own.
    fn record(&mut self, place: &Place, slot: &str, turn: Option<usize>, tree: String, message: &str, path_env: Option<&str>) -> Result<Point, String> {
        let commit = match &self.last {
            Some((t, c)) if *t == tree => c.clone(),
            _ => {
                let env: Vec<(&str, &OsStr)> = WHO.iter().map(|(k, v)| (*k, OsStr::new(*v))).collect();
                git(place, &["commit-tree", "--no-gpg-sign", "-m", message, &tree], &env, path_env)?.trim().to_string()
            }
        };
        let key = self.key(slot)?;
        let id = self.next;
        self.next += 1;
        git(place, &["update-ref", &format!("{REFS}/{key}/{id}"), &commit], &[], path_env)?;
        self.last = Some((tree.clone(), commit));
        let point = Point { id, turn, tree };
        self.points.push(point.clone());
        while self.points.len() > KEEP {
            let old = self.points.remove(0);
            let _ = git(place, &["update-ref", "-d", &format!("{REFS}/{key}/{}", old.id)], &[], path_env);
        }
        Ok(point)
    }

    /// The files a restore to `tree` leaves alone for being big: those the folder has now, and those left out of `tree`.
    fn left_alone(&self, tree: &str) -> HashSet<String> {
        self.large.iter().chain(self.left_out.get(tree).into_iter().flatten()).cloned().collect()
    }

    fn point(&self, turn: usize) -> Result<Point, String> {
        self.points.iter().rev().find(|p| p.turn == Some(turn)).cloned().ok_or_else(|| "There is no restore point for that message.".to_string())
    }
}

/// The untracked files git doesn't ignore that are over BIG_FILE, as git names them. Found with git's own list and each
/// file's size on disk (the link itself for a link, never what it points to; only plain files count).
fn large_untracked(place: &Place, path_env: Option<&str>) -> HashSet<String> {
    let Ok(listed) = git(place, &["ls-files", "--others", "--exclude-standard", "-z"], &[], path_env) else { return HashSet::new() };
    listed
        .split('\0')
        .filter(|rel| !rel.is_empty() && !rel.contains('\u{fffd}'))
        .filter(|rel| place.top.join(rel).symlink_metadata().is_ok_and(|m| m.file_type().is_file() && m.len() > BIG_FILE))
        .map(String::from)
        .collect()
}

/// `git add -A` into the private index of everything but `large` (which are also taken out of it, in case an earlier
/// checkpoint kept them when they were small). The names go in a file, so a long list can't outgrow a command line.
fn add_all_but(place: &Place, large: &HashSet<String>, env: &[(&str, &OsStr)], path_env: Option<&str>) -> Result<(), String> {
    if large.is_empty() {
        return git(place, &["add", "-A"], env, path_env).map(drop);
    }
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let (drop_list, add_list) = (Scratch(place.git_dir().join(format!("lantern-drop-{}-{nanos:x}", std::process::id()))), Scratch(place.git_dir().join(format!("lantern-add-{}-{nanos:x}", std::process::id()))));
    let mut names: Vec<&String> = large.iter().collect();
    names.sort();
    let (mut drops, mut adds) = (String::new(), String::from(".\0"));
    for rel in names {
        drops.push_str(&format!(":(literal){rel}\0"));
        adds.push_str(&format!(":(exclude,literal){rel}\0"));
    }
    std::fs::write(&drop_list.0, drops).map_err(|e| e.to_string())?;
    std::fs::write(&add_list.0, adds).map_err(|e| e.to_string())?;
    let from = |list: &Scratch| {
        let mut flag = OsStr::new("--pathspec-from-file=").to_os_string();
        flag.push(list.0.as_os_str());
        flag
    };
    let (drop_flag, add_flag) = (from(&drop_list), from(&add_list));
    // Nothing is read of the big files: they leave the index by name, and the add skips them.
    git(place, &["rm", "--cached", "-f", "-q", "--ignore-unmatch", "--pathspec-file-nul", drop_flag.to_str().ok_or("The folder's name isn't plain text.")?], env, path_env)?;
    git(place, &["add", "-A", "--pathspec-file-nul", add_flag.to_str().ok_or("The folder's name isn't plain text.")?], env, path_env)?;
    Ok(())
}

/// Deletes the restore points (and private indexes) that earlier runs left in this repository once they are old.
fn sweep(place: &Place, dir: &Path, own: &str, path_env: Option<&str>) {
    let Ok(listed) = git(place, &["for-each-ref", "--format=%(refname) %(committerdate:unix)", REFS], &[], path_env) else { return };
    let cutoff = now().saturating_sub(STALE.as_secs());
    for line in listed.lines() {
        let Some((name, date)) = line.rsplit_once(' ') else { continue };
        if !name.contains(&format!("/{own}/")) && date.parse::<u64>().is_ok_and(|d| d < cutoff) {
            let _ = git(place, &["update-ref", "-d", name], &[], path_env);
        }
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > STALE);
        if name.starts_with("lantern-index-") && name != format!("lantern-index-{own}") && old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Every file that differs between two trees, inside the chat's folder.
fn changes(place: &Place, from: &str, to: &str, path_env: Option<&str>) -> Result<Vec<Change>, String> {
    let out = diff_tree(place, "--raw", from, to, path_env)?;
    let mut parts = out.split('\0');
    let mut found = vec![];
    while let Some(head) = parts.next() {
        if head.is_empty() {
            continue;
        }
        let path = parts.next().ok_or("git's list of changed files was cut short")?;
        // ":100644 100644 <old> <new> M"
        let fields: Vec<&str> = head.trim_start_matches(':').split(' ').collect();
        if fields.len() < 5 {
            return Err("git's list of changed files can't be read".into());
        }
        found.push(Change { kind: if fields[4].starts_with('D') { Kind::Remove } else { Kind::Put }, old_mode: fields[0].into(), new_mode: fields[1].into(), path: path.into() });
    }
    Ok(found)
}

/// The lines added and removed between two trees, inside the chat's folder (binary files count none).
fn lines_between(place: &Place, from: &str, to: &str, path_env: Option<&str>) -> u64 {
    let Ok(out) = diff_tree(place, "--numstat", from, to, path_env) else { return 0 };
    out.split('\0')
        .filter_map(|entry| {
            let mut f = entry.splitn(3, '\t');
            Some(f.next()?.parse::<u64>().ok()? + f.next()?.parse::<u64>().ok()?)
        })
        .sum()
}

fn diff_tree(place: &Place, format: &str, from: &str, to: &str, path_env: Option<&str>) -> Result<String, String> {
    let mut args = vec!["diff-tree", "-r", format, "-z", "--no-renames", "--no-abbrev", from, to];
    let prefix = place.prefix.to_str().ok_or("The folder's name isn't plain text.")?.to_string();
    if !prefix.is_empty() {
        args.push("--");
        args.push(&prefix);
    }
    // The folder's name is a path, not a pattern.
    git(place, &args, &[("GIT_LITERAL_PATHSPECS", OsStr::new("1"))], path_env)
}

/// Checks that `rel` (a path from the top of the checkout) can be written or removed: it is inside the chat's folder, none
/// of it is `.git`, and nothing on the way to it, or at it, is a link. A folder, or a file in a folder's place, is in the
/// way too. Returns where it is on disk.
fn vet(place: &Place, rel: &str) -> Result<PathBuf, String> {
    let path = Path::new(rel);
    if !path.starts_with(&place.prefix) {
        return Err("It is outside the folder.".into());
    }
    let parts: Vec<&OsStr> = path
        .components()
        .map(|c| match c {
            Component::Normal(name) if !name.eq_ignore_ascii_case(".git") => Ok(name),
            _ => Err("It isn't a path inside the folder."),
        })
        .collect::<Result<_, _>>()?;
    let mut full = place.top.clone();
    for (i, name) in parts.iter().enumerate() {
        full.push(name);
        match full.symlink_metadata() {
            Ok(m) if m.file_type().is_symlink() => return Err("A link is in the way, so it isn't restored from here.".into()),
            Ok(m) if i + 1 < parts.len() && !m.is_dir() => return Err("A file is where its folder should be.".into()),
            Ok(m) if i + 1 == parts.len() && m.is_dir() => return Err("A folder is where it should be.".into()),
            Ok(_) => {}
            // Nothing from here on exists yet.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                parts[i + 1..].iter().for_each(|n| full.push(n));
                break;
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(full)
}

/// Sorts changes into what is written, what is removed and what is left alone. `big` are the files restore points don't keep
/// (see BIG_FILE): they are never written or removed, however they differ.
fn sort(place: &Place, found: &[Change], keep: &HashSet<String>, big: &HashSet<String>) -> Work {
    let mut work = Work::default();
    for c in found {
        if keep.contains(&c.path) {
            work.kept.push(place.shown(&c.path));
        } else if big.contains(&c.path) {
            work.skipped.push(skip(place, &c.path, BIG_REASON));
        } else if [&c.old_mode, &c.new_mode].iter().any(|m| m.starts_with("120") || m.starts_with("160")) {
            work.skipped.push(skip(place, &c.path, "It is a link, or another repository, so it isn't restored from here."));
        } else if c.path.contains('\u{fffd}') {
            work.skipped.push(skip(place, &c.path, "Its name isn't plain text, so it isn't restored from here."));
        } else {
            match vet(place, &c.path) {
                Err(why) => work.skipped.push(skip(place, &c.path, why)),
                Ok(_) if c.kind == Kind::Put => work.put.push((place.shown(&c.path), c.path.clone())),
                // Already gone: nothing to do.
                Ok(full) if full.symlink_metadata().is_err() => {}
                Ok(full) => work.remove.push((place.shown(&c.path), full, c.path.clone())),
            }
        }
    }
    work
}

/// The files of `list` that git ignores now (None: it couldn't be told). git answers a list with the ignored ones' names, in
/// quotes when they are odd, so when it finds any, each is asked about on its own.
fn ignored_among(place: &Place, list: &[(String, PathBuf, String)], path_env: Option<&str>) -> Option<HashSet<String>> {
    let mut found = HashSet::new();
    for batch in list.chunks(200) {
        let mut args = vec!["check-ignore", "--"];
        args.extend(batch.iter().map(|(_, _, rel)| rel.as_str()));
        match git(place, &args, &[], path_env) {
            // Nothing ignored is exit 1 with nothing said; anything said is git failing.
            Err(e) if e.is_empty() => {}
            Err(_) => return None,
            Ok(_) => {
                for (_, _, rel) in batch {
                    match git(place, &["check-ignore", "-q", "--", rel], &[], path_env) {
                        Ok(_) => {
                            found.insert(rel.clone());
                        }
                        Err(e) if e.is_empty() => {}
                        Err(_) => return None,
                    }
                }
            }
        }
    }
    Some(found)
}

/// `put` in runs that fit on a command line.
fn batches(put: &[(String, String)]) -> Vec<&[(String, String)]> {
    let (mut out, mut from, mut size) = (vec![], 0, 0);
    for (i, (_, rel)) in put.iter().enumerate() {
        if size + rel.len() > 64 * 1024 {
            out.push(&put[from..i]);
            (from, size) = (i, 0);
        }
        size += rel.len() + 1;
    }
    out.push(&put[from..]);
    out
}

/// Carries `work` out, putting files back as `target` has them. Returns what was put back, what went to the Trash, and
/// what couldn't be done.
fn apply(place: &Place, work: &Work, target: &str, trash: Trash, path_env: Option<&str>) -> (Vec<String>, Vec<String>, Vec<Skipped>) {
    let (mut put_back, mut removed, mut skipped) = (vec![], vec![], vec![]);
    if !work.put.is_empty() {
        // The files are written by git from a private index of the restore point's tree: its own modes and line endings.
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
        let scratch = Scratch(place.git_dir().join(format!("lantern-restore-{}-{nanos:x}", std::process::id())));
        let env: [(&str, &OsStr); 1] = [("GIT_INDEX_FILE", scratch.0.as_os_str())];
        match git(place, &["read-tree", target], &env, path_env) {
            Err(e) => skipped.extend(work.put.iter().map(|(shown, _)| Skipped { path: shown.clone(), reason: format!("Could not read the restore point: {e}") })),
            Ok(_) => {
                // In batches, so a long list can't outgrow what a command line takes.
                for batch in batches(&work.put) {
                    let mut args = vec!["checkout-index", "-f", "-q", "--"];
                    args.extend(batch.iter().map(|(_, rel)| rel.as_str()));
                    match git(place, &args, &env, path_env) {
                        Ok(_) => put_back.extend(batch.iter().map(|(shown, _)| shown.clone())),
                        Err(e) => skipped.extend(batch.iter().map(|(shown, _)| Skipped { path: shown.clone(), reason: format!("Could not put it back: {e}") })),
                    }
                }
            }
        }
    }
    // Only now, with the restore point's own ignore rules back in place: a file they ignore is not Lantern's to remove, even
    // if the rules were different when it was made.
    let ignored = ignored_among(place, &work.remove, path_env);
    let folder = place.top.join(&place.prefix);
    for (shown, full, rel) in &work.remove {
        if ignored.as_ref().is_none_or(|paths| paths.contains(rel)) {
            skipped.push(Skipped { path: shown.clone(), reason: "It is ignored by git, so it is left alone.".into() });
            continue;
        }
        match trash(full) {
            Ok(_) => {
                removed.push(shown.clone());
                // A folder it leaves empty goes too, as far as the chat's folder.
                for dir in full.ancestors().skip(1).take_while(|d| *d != folder && d.starts_with(&folder)) {
                    if std::fs::remove_dir(dir).is_err() {
                        break;
                    }
                }
            }
            Err(e) => skipped.push(Skipped { path: shown.clone(), reason: e }),
        }
    }
    (put_back, removed, skipped)
}

impl Checkpoints {
    /// A message was sent: the chat's turn is running until `turn_ended`.
    pub fn turn_started(&self) {
        self.running.store(true, Ordering::SeqCst);
    }

    pub fn turn_ended(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    fn check_idle(&self) -> Result<(), String> {
        if self.running.load(Ordering::SeqCst) {
            return Err("Claude is still working in this chat. Wait for it to finish, then try again.".into());
        }
        Ok(())
    }

    /// Records how the folder stands just before message number `turn` is sent. An error means no restore point was made;
    /// the caller sends the message all the same.
    pub fn take(&self, place: &Place, slot: &str, turn: usize, path_env: Option<&str>) -> Result<(), String> {
        self.take_unless(place, slot, turn, path_env, &AtomicBool::new(false))
    }

    /// `take`, but nothing is kept if `late` was set meanwhile: the message went out without waiting, so what the folder
    /// holds by now may be the turn's own edits.
    pub fn take_unless(&self, place: &Place, slot: &str, turn: usize, path_env: Option<&str>, late: &AtomicBool) -> Result<(), String> {
        let mut st = self.state.lock().unwrap();
        let tree = st.snapshot(place, slot, path_env)?;
        if late.load(Ordering::SeqCst) {
            return Err("It took too long, so the message went without one.".into());
        }
        st.record(place, slot, Some(turn), tree, &format!("Lantern: before message {}", turn + 1), path_env)?;
        Ok(())
    }

    /// The messages that have a restore point.
    pub fn turns(&self) -> Vec<usize> {
        self.state.lock().unwrap().points.iter().filter_map(|p| p.turn).collect()
    }

    /// A new conversation in the chat: its messages are numbered again, so the old ones can't be asked for any more (their
    /// refs stay until they are old).
    pub fn forget(&self) {
        let mut st = self.state.lock().unwrap();
        st.points.clear();
        st.undo = None;
        st.left_out.clear();
    }

    /// What putting the folder back to before message `turn` would do.
    pub fn plan(&self, place: &Place, slot: &str, turn: usize, path_env: Option<&str>) -> Result<Plan, String> {
        let mut st = self.state.lock().unwrap();
        let target = st.point(turn)?.tree;
        let current = st.snapshot(place, slot, path_env)?;
        let found = changes(place, &current, &target, path_env)?;
        let work = sort(place, &found, &HashSet::new(), &st.left_alone(&target));
        Ok(Plan {
            put_back: work.put.into_iter().map(|(shown, _)| shown).collect(),
            removed: work.remove.into_iter().map(|(shown, ..)| shown).collect(),
            skipped: work.skipped,
            lines: lines_between(place, &current, &target, path_env),
        })
    }

    /// Puts the folder back to before message `turn`, after making a restore point of how it stands.
    pub fn restore(&self, place: &Place, slot: &str, turn: usize, trash: Trash, path_env: Option<&str>) -> Result<Restored, String> {
        self.check_idle()?;
        let mut st = self.state.lock().unwrap();
        let target = st.point(turn)?.tree;
        let before = st.snapshot(place, slot, path_env)?;
        let saved = st.record(place, slot, None, before.clone(), "Lantern: before restoring", path_env)?;
        let work = sort(place, &changes(place, &before, &target, path_env)?, &HashSet::new(), &st.left_alone(&target));
        let (put_back, removed, mut skipped) = apply(place, &work, &target, trash, path_env);
        skipped.extend(work.skipped);
        // What Undo is checked against. If it can't be made, the restore stands and can't be undone from here.
        st.undo = st.snapshot(place, slot, path_env).ok().map(|after| Undo { id: saved.id, before, after });
        Ok(Restored { id: st.undo.as_ref().map(|u| u.id), put_back, removed, skipped, kept: vec![] })
    }

    /// Takes a restore back: the folder goes to how it stood before it, except files edited since (they stay as they are).
    pub fn undo(&self, place: &Place, slot: &str, id: u64, trash: Trash, path_env: Option<&str>) -> Result<Restored, String> {
        self.check_idle()?;
        let mut st = self.state.lock().unwrap();
        let (before, after) = match &st.undo {
            Some(u) if u.id == id => (u.before.clone(), u.after.clone()),
            _ => return Err("There is nothing to undo.".into()),
        };
        let current = st.snapshot(place, slot, path_env)?;
        let edited: HashSet<String> = changes(place, &after, &current, path_env)?.into_iter().map(|c| c.path).collect();
        let work = sort(place, &changes(place, &current, &before, path_env)?, &edited, &st.left_alone(&before));
        let (put_back, removed, mut skipped) = apply(place, &work, &before, trash, path_env);
        skipped.extend(work.skipped);
        st.undo = None;
        Ok(Restored { id: None, put_back, removed, skipped, kept: work.kept })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn git_in(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"]).args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A repository with `a.txt` and `b.txt` committed, and a `.gitignore` for `*.log`.
    struct Repo {
        dir: tempfile::TempDir,
        /// Where the Trash is, outside the repository.
        elsewhere: tempfile::TempDir,
    }

    impl Repo {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let repo = Self { dir, elsewhere: tempfile::tempdir().unwrap() };
            git_in(&repo.root(), &["init", "-q"]);
            repo.write(".gitignore", "*.log\n");
            repo.write("a.txt", "a0\n");
            repo.write("b.txt", "b0\n");
            git_in(&repo.root(), &["add", "-A"]);
            git_in(&repo.root(), &["commit", "-q", "-m", "first"]);
            repo
        }
        fn root(&self) -> PathBuf {
            fs::canonicalize(self.dir.path()).unwrap()
        }
        fn write(&self, name: &str, text: &str) {
            let path = self.root().join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        fn read(&self, name: &str) -> Option<String> {
            fs::read_to_string(self.root().join(name)).ok()
        }
        fn place(&self) -> Place {
            Place::find(&self.root(), None, None).expect("a repository")
        }
        fn trash(&self) -> PathBuf {
            self.elsewhere.path().join("trash")
        }
    }

    fn trash_into(dir: PathBuf) -> impl Fn(&Path) -> Result<PathBuf, String> {
        move |p: &Path| crate::trash::trash_into(p, &dir)
    }

    #[test]
    fn a_folder_is_put_back_to_before_a_message_and_the_restore_can_be_undone() {
        let repo = Repo::new();
        let (place, points) = (repo.place(), Checkpoints::default());
        let (trash_dir, branch_before) = (repo.trash(), git_in(&repo.root(), &["rev-parse", "HEAD"]));
        let trash = trash_into(trash_dir.clone());
        // How the folder stands when message 0 is sent: a tracked edit, an untracked file and an ignored one.
        repo.write("a.txt", "a1\n");
        repo.write("new0.txt", "n0\n");
        repo.write("debug.log", "log0\n");
        let status_then = git_in(&repo.root(), &["status", "--porcelain"]);
        points.take(&place, "s1", 0, None).unwrap();
        // The turn: edits, a created file (in a new folder), a deleted file, and an ignored file changed.
        repo.write("a.txt", "a2\n");
        repo.write("b.txt", "b2\n");
        repo.write("new0.txt", "n1\n");
        repo.write("deep/new1.txt", "made\n");
        repo.write("debug.log", "log1\n");

        let plan = points.plan(&place, "s1", 0, None).unwrap();
        let name = |n: &str| repo.root().join(n).display().to_string();
        let mut put = plan.put_back.clone();
        put.sort();
        assert_eq!(put, vec![name("a.txt"), name("b.txt"), name("new0.txt")]);
        assert_eq!(plan.removed, vec![name("deep/new1.txt")]);
        assert!(plan.skipped.is_empty());
        assert!(plan.lines >= 4, "{plan:?}");

        let done = points.restore(&place, "s1", 0, &trash, None).unwrap();
        assert_eq!(done.removed, vec![name("deep/new1.txt")]);
        assert_eq!(repo.read("a.txt").as_deref(), Some("a1\n"));
        assert_eq!(repo.read("b.txt").as_deref(), Some("b0\n"));
        assert_eq!(repo.read("new0.txt").as_deref(), Some("n0\n"));
        assert!(repo.read("deep/new1.txt").is_none());
        assert!(!repo.root().join("deep").exists(), "the folder it left empty goes too");
        assert_eq!(fs::read_to_string(trash_dir.join("new1.txt")).unwrap(), "made\n");
        // Ignored files and the repository itself are as they were.
        assert_eq!(repo.read("debug.log").as_deref(), Some("log1\n"));
        assert_eq!(git_in(&repo.root(), &["rev-parse", "HEAD"]), branch_before);
        assert_eq!(git_in(&repo.root(), &["status", "--porcelain"]), status_then);

        // Undo brings back what the restore changed.
        let id = done.id.expect("it can be undone");
        let undone = points.undo(&place, "s1", id, &trash, None).unwrap();
        assert!(undone.kept.is_empty() && undone.skipped.is_empty(), "{undone:?}");
        assert_eq!(repo.read("a.txt").as_deref(), Some("a2\n"));
        assert_eq!(repo.read("b.txt").as_deref(), Some("b2\n"));
        assert_eq!(repo.read("new0.txt").as_deref(), Some("n1\n"));
        assert_eq!(repo.read("deep/new1.txt").as_deref(), Some("made\n"));
        // It can't be undone twice.
        assert!(points.undo(&place, "s1", id, &trash, None).is_err());
    }

    #[test]
    fn a_checkpoint_leaves_no_trace_in_the_users_git() {
        let repo = Repo::new();
        let (place, points) = (repo.place(), Checkpoints::default());
        repo.write("a.txt", "a1\n");
        repo.write("untracked.txt", "u\n");
        git_in(&repo.root(), &["add", "b.txt"]);
        let (status, index) = (git_in(&repo.root(), &["status", "--porcelain=v2"]), fs::read(repo.root().join(".git/index")).unwrap());
        points.take(&place, "s1", 0, None).unwrap();
        assert_eq!(git_in(&repo.root(), &["status", "--porcelain=v2"]), status);
        assert_eq!(fs::read(repo.root().join(".git/index")).unwrap(), index, "the real index isn't written");
        assert_eq!(git_in(&repo.root(), &["log", "--oneline"]).lines().count(), 1);
        assert_eq!(git_in(&repo.root(), &["stash", "list"]), "");
        assert_eq!(git_in(&repo.root(), &["branch", "--format=%(refname:short)"]), "main");
        assert_eq!(git_in(&repo.root(), &["for-each-ref", "--format=%(refname)"]).lines().filter(|r| r.starts_with("refs/lantern/checkpoints/s1-")).count(), 1);
        // The checkpoint holds the tracked edit and the untracked file.
        let tree = git_in(&repo.root(), &["for-each-ref", "--format=%(objectname)", "refs/lantern/checkpoints"]);
        assert_eq!(git_in(&repo.root(), &["show", &format!("{tree}:a.txt")]), "a1");
        assert_eq!(git_in(&repo.root(), &["show", &format!("{tree}:untracked.txt")]), "u");
    }

    /// A sparse file of `megabytes`: it takes no room on disk, but its size is what `metadata` says.
    fn sparse(repo: &Repo, name: &str, megabytes: u64) {
        let path = repo.root().join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::File::create(path).unwrap().set_len(megabytes * 1024 * 1024).unwrap();
    }

    fn size(repo: &Repo, name: &str) -> Option<u64> {
        repo.root().join(name).symlink_metadata().ok().map(|m| m.len())
    }

    fn last_tree(repo: &Repo) -> String {
        git_in(&repo.root(), &["for-each-ref", "--sort=-refname", "--count=1", "--format=%(objectname)", "refs/lantern/checkpoints"])
    }

    #[test]
    fn an_untracked_file_over_twenty_megabytes_is_not_kept_and_the_rest_is() {
        let repo = Repo::new();
        let (place, points) = (repo.place(), Checkpoints::default());
        sparse(&repo, "build/huge.bin", 30);
        sparse(&repo, "just-under.bin", 19);
        repo.write("small.txt", "s\n");
        // A big file that git ignores or that is tracked is not the checkpoint's to decide on: ignored stays out as before.
        sparse(&repo, "ignored.log", 30);
        points.take(&place, "s1", 0, None).unwrap();
        let commit = last_tree(&repo);
        let files = git_in(&repo.root(), &["ls-tree", "-r", "--name-only", &commit]);
        let files: Vec<&str> = files.lines().collect();
        assert!(files.contains(&"small.txt") && files.contains(&"just-under.bin") && files.contains(&"a.txt"), "{files:?}");
        assert!(!files.contains(&"build/huge.bin") && !files.contains(&"ignored.log"), "{files:?}");
        // Nothing of the private lists is left lying in the repository.
        let left: Vec<String> = fs::read_dir(repo.root().join(".git")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("lantern-") && !n.starts_with("lantern-index-")).collect();
        assert!(left.is_empty(), "{left:?}");
        // The file itself is untouched.
        assert_eq!(size(&repo, "build/huge.bin"), Some(30 * 1024 * 1024));
    }

    #[test]
    fn a_link_to_a_big_file_is_kept_as_a_link_and_the_big_file_behind_it_is_never_followed() {
        let repo = Repo::new();
        let (place, points) = (repo.place(), Checkpoints::default());
        let outside = tempfile::tempdir().unwrap();
        fs::File::create(outside.path().join("big.bin")).unwrap().set_len(40 * 1024 * 1024).unwrap();
        std::os::unix::fs::symlink(outside.path().join("big.bin"), repo.root().join("link.bin")).unwrap();
        assert!(large_untracked(&place, None).is_empty());
        points.take(&place, "s1", 0, None).unwrap();
        assert_eq!(git_in(&repo.root(), &["ls-tree", &last_tree(&repo), "link.bin"]).split(' ').next(), Some("120000"));
    }

    #[test]
    fn a_restore_never_trashes_or_overwrites_a_file_that_was_left_out_for_its_size() {
        let repo = Repo::new();
        let (place, points) = (repo.place(), Checkpoints::default());
        let trash_dir = repo.trash();
        let trash = trash_into(trash_dir.clone());
        // Big when message 0 is sent (so it is not in the restore point), and one that is small then and big after.
        sparse(&repo, "was-big.bin", 25);
        repo.write("grows.dat", "tiny\n");
        repo.write("a.txt", "a1\n");
        points.take(&place, "s1", 0, None).unwrap();
        // The turn: the first becomes small (so a snapshot would hold it, and the point doesn't), the second becomes big.
        fs::write(repo.root().join("was-big.bin"), "now small\n").unwrap();
        sparse(&repo, "grows.dat", 22);
        repo.write("a.txt", "a2\n");
        repo.write("made.txt", "made\n");

        let name = |n: &str| repo.root().join(n).display().to_string();
        let plan = points.plan(&place, "s1", 0, None).unwrap();
        let mut skipped: Vec<(String, String)> = plan.skipped.iter().map(|s| (s.path.clone(), s.reason.clone())).collect();
        skipped.sort();
        assert_eq!(skipped, vec![(name("grows.dat"), BIG_REASON.to_string()), (name("was-big.bin"), BIG_REASON.to_string())]);
        assert_eq!(plan.put_back, vec![name("a.txt")]);
        assert_eq!(plan.removed, vec![name("made.txt")]);

        let done = points.restore(&place, "s1", 0, &trash, None).unwrap();
        assert_eq!(done.put_back, vec![name("a.txt")]);
        assert_eq!(done.removed, vec![name("made.txt")]);
        assert_eq!(done.skipped.len(), 2, "{done:?}");
        assert_eq!(repo.read("a.txt").as_deref(), Some("a1\n"));
        // Both are exactly as the turn left them, and nothing of them went to the Trash.
        assert_eq!(repo.read("was-big.bin").as_deref(), Some("now small\n"));
        assert_eq!(size(&repo, "grows.dat"), Some(22 * 1024 * 1024));
        let trashed: Vec<String> = fs::read_dir(&trash_dir).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        assert_eq!(trashed, vec!["made.txt".to_string()]);

        // Undo does not touch them either.
        let undone = points.undo(&place, "s1", done.id.unwrap(), &trash, None).unwrap();
        assert_eq!(repo.read("was-big.bin").as_deref(), Some("now small\n"));
        assert_eq!(size(&repo, "grows.dat"), Some(22 * 1024 * 1024));
        assert_eq!(repo.read("a.txt").as_deref(), Some("a2\n"));
        assert!(undone.skipped.iter().all(|s| s.reason == BIG_REASON), "{undone:?}");
    }

    #[test]
    fn a_big_file_that_an_earlier_checkpoint_kept_small_is_taken_out_of_the_next_one() {
        let repo = Repo::new();
        let (place, points) = (repo.place(), Checkpoints::default());
        repo.write("data.bin", "small\n");
        points.take(&place, "s1", 0, None).unwrap();
        assert!(git_in(&repo.root(), &["ls-tree", "-r", "--name-only", &last_tree(&repo)]).lines().any(|f| f == "data.bin"));
        sparse(&repo, "data.bin", 21);
        points.take(&place, "s1", 1, None).unwrap();
        assert!(!git_in(&repo.root(), &["ls-tree", "-r", "--name-only", &last_tree(&repo)]).lines().any(|f| f == "data.bin"));
    }

    #[test]
    fn a_checkpoint_with_nothing_changed_reuses_the_commit_and_only_the_last_fifty_are_kept() {
        let repo = Repo::new();
        let (place, points) = (repo.place(), Checkpoints::default());
        points.take(&place, "s1", 0, None).unwrap();
        points.take(&place, "s1", 1, None).unwrap();
        let shas = git_in(&repo.root(), &["for-each-ref", "--format=%(objectname)", "refs/lantern/checkpoints"]);
        assert_eq!(shas.lines().count(), 2);
        assert_eq!(shas.lines().collect::<HashSet<_>>().len(), 1, "the same state is one commit");
        for turn in 2..60 {
            repo.write("a.txt", &format!("a{turn}\n"));
            points.take(&place, "s1", turn, None).unwrap();
        }
        assert_eq!(points.turns(), (10..60).collect::<Vec<_>>());
        assert_eq!(git_in(&repo.root(), &["for-each-ref", "refs/lantern/checkpoints"]).lines().count(), 50);
        assert!(points.plan(&place, "s1", 3, None).is_err(), "a pruned restore point can't be asked for");
        assert!(points.plan(&place, "s1", 10, None).is_ok());
    }

    #[test]
    fn a_file_the_restored_ignore_rules_ignore_is_not_removed() {
        let repo = Repo::new();
        let (place, points) = (repo.place(), Checkpoints::default());
        repo.write("debug.log", "log0\n");
        points.take(&place, "s1", 0, None).unwrap();
        // Claude drops the rule: the file shows up as a new one. The restore brings the rule back, which ignores it again.
        fs::remove_file(repo.root().join(".gitignore")).unwrap();
        repo.write("made.txt", "m\n");
        let done = points.restore(&place, "s1", 0, &trash_into(repo.trash()), None).unwrap();
        assert_eq!(repo.read(".gitignore").as_deref(), Some("*.log\n"));
        assert_eq!(repo.read("debug.log").as_deref(), Some("log0\n"));
        assert!(repo.read("made.txt").is_none());
        assert_eq!(done.skipped.len(), 1, "{done:?}");
    }

    #[test]
    fn a_folder_that_is_not_a_repository_has_no_place() {
        let dir = tempfile::tempdir().unwrap();
        assert!(Place::find(dir.path(), None, None).is_none());
        // A folder inside a repository is found from it.
        let repo = Repo::new();
        repo.write("sub/x.txt", "x\n");
        assert!(Place::find(&repo.root().join("sub"), None, None).is_some());
    }

    #[test]
    fn a_chat_in_a_subfolder_only_touches_its_own_folder() {
        let repo = Repo::new();
        repo.write("sub/x.txt", "x0\n");
        git_in(&repo.root(), &["add", "-A"]);
        git_in(&repo.root(), &["commit", "-q", "-m", "sub"]);
        let (place, points) = (Place::find(&repo.root().join("sub"), None, None).unwrap(), Checkpoints::default());
        points.take(&place, "s1", 0, None).unwrap();
        repo.write("sub/x.txt", "x1\n");
        repo.write("sub/y.txt", "y\n");
        repo.write("a.txt", "a elsewhere\n");
        let done = points.restore(&place, "s1", 0, &trash_into(repo.trash()), None).unwrap();
        assert_eq!(done.put_back.len() + done.removed.len(), 2);
        assert_eq!(repo.read("sub/x.txt").as_deref(), Some("x0\n"));
        assert!(repo.read("sub/y.txt").is_none());
        assert_eq!(repo.read("a.txt").as_deref(), Some("a elsewhere\n"), "outside the chat's folder");
        // The paths shown are the chat's: under its folder.
        assert!(done.put_back[0].starts_with(&repo.root().join("sub").display().to_string()));
    }

    #[test]
    fn links_are_never_followed_or_restored() {
        let repo = Repo::new();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep.txt"), "keep\n").unwrap();
        repo.write("d/x.txt", "x0\n");
        std::os::unix::fs::symlink(outside.path().join("keep.txt"), repo.root().join("file-link")).unwrap();
        let (place, points) = (repo.place(), Checkpoints::default());
        points.take(&place, "s1", 0, None).unwrap();
        // The folder is replaced by a link to somewhere else, and the link to a file by a plain file.
        fs::remove_dir_all(repo.root().join("d")).unwrap();
        std::os::unix::fs::symlink(outside.path(), repo.root().join("d")).unwrap();
        fs::remove_file(repo.root().join("file-link")).unwrap();
        repo.write("file-link", "plain\n");
        let plan = points.plan(&place, "s1", 0, None).unwrap();
        assert!(plan.skipped.len() >= 2, "{plan:?}");
        let done = points.restore(&place, "s1", 0, &trash_into(repo.trash()), None).unwrap();
        assert!(done.put_back.iter().all(|p| !p.ends_with("x.txt")), "{done:?}");
        assert!(!outside.path().join("x.txt").exists(), "nothing was written through the link");
        assert_eq!(fs::read_to_string(outside.path().join("keep.txt")).unwrap(), "keep\n");
        assert!(repo.root().join("d").symlink_metadata().unwrap().file_type().is_symlink(), "the link itself is left alone");
        assert_eq!(repo.read("file-link").as_deref(), Some("plain\n"));
    }

    #[test]
    fn a_restore_is_refused_while_a_turn_runs_and_an_undo_leaves_files_edited_since() {
        let repo = Repo::new();
        let (place, points, trash) = (repo.place(), Checkpoints::default(), trash_into(repo.trash()));
        points.take(&place, "s1", 0, None).unwrap();
        repo.write("a.txt", "a1\n");
        repo.write("b.txt", "b1\n");
        points.turn_started();
        assert!(points.restore(&place, "s1", 0, &trash, None).unwrap_err().contains("still working"));
        assert_eq!(repo.read("a.txt").as_deref(), Some("a1\n"));
        points.turn_ended();
        let id = points.restore(&place, "s1", 0, &trash, None).unwrap().id.unwrap();
        assert_eq!(repo.read("a.txt").as_deref(), Some("a0\n"));
        // a.txt is edited by hand after the restore: Undo keeps that edit and brings back the rest.
        repo.write("a.txt", "by hand\n");
        let undone = points.undo(&place, "s1", id, &trash, None).unwrap();
        assert_eq!(undone.kept, vec![repo.root().join("a.txt").display().to_string()]);
        assert_eq!(repo.read("a.txt").as_deref(), Some("by hand\n"));
        assert_eq!(repo.read("b.txt").as_deref(), Some("b1\n"));
        // A message with no restore point, and a chat id that isn't one.
        assert!(points.plan(&place, "s1", 9, None).is_err());
        assert!(points.take(&place, "../x", 1, None).is_err());
    }

    #[test]
    fn a_workers_worktree_is_restored_in_its_own_folder() {
        let repo = Repo::new();
        let wt = repo.elsewhere.path().join("worker-wt");
        git_in(&repo.root(), &["worktree", "add", "-q", "-b", "lantern/w", &wt.display().to_string()]);
        let wt = fs::canonicalize(&wt).unwrap();
        let (place, points) = (Place::find(&wt, Some(&repo.root()), None).expect("a checked worktree"), Checkpoints::default());
        fs::write(wt.join("a.txt"), "worker a1\n").unwrap();
        points.take(&place, "w1", 0, None).unwrap();
        fs::write(wt.join("a.txt"), "worker a2\n").unwrap();
        fs::write(wt.join("made.txt"), "m\n").unwrap();
        repo.write("a.txt", "main checkout edit\n");
        points.restore(&place, "w1", 0, &trash_into(repo.trash()), None).unwrap();
        assert_eq!(fs::read_to_string(wt.join("a.txt")).unwrap(), "worker a1\n");
        assert!(!wt.join("made.txt").exists());
        assert_eq!(repo.read("a.txt").as_deref(), Some("main checkout edit\n"), "the main checkout isn't touched");
        // Found without a Lead too, from the pointer the worktree itself holds.
        assert!(Place::find(&wt, None, None).is_some());
        // A worktree whose pointer was rewritten to another repository isn't trusted.
        let other = Repo::new();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", other.root().join(".git").display())).unwrap();
        assert!(Place::find(&wt, Some(&repo.root()), None).is_none());
        assert!(Place::find(&wt, None, None).is_none());
    }

    /// `LANTERN_CHECKPOINT_DIR=<folder> cargo test checkpoint_timing -- --ignored --nocapture`: how long a checkpoint takes.
    #[test]
    #[ignore]
    fn checkpoint_timing() {
        let folder = PathBuf::from(std::env::var("LANTERN_CHECKPOINT_DIR").expect("a folder"));
        let (place, points) = (Place::find(&folder, None, None).expect("a repository"), Checkpoints::default());
        for turn in 0..3 {
            let started = std::time::Instant::now();
            points.take(&place, "bench", turn, None).unwrap();
            println!("checkpoint {turn}: {:?}", started.elapsed());
        }
    }
}
