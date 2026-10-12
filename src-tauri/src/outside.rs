//! Files that change without going through Claude's Edit/Write tools: a `cp` or `mv` in a Bash command, a download,
//! something dragged in from Finder. The change tracker only hears about tool edits, so this compares the folder with
//! how it was when the chat started. In a git checkout that's `git status`; elsewhere, the list of files.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Bigger files, and binary ones, aren't worth a diff.
const MAX_BYTES: u64 = 5 << 20;
/// Without git, a folder with more files than this isn't listed.
const MAX_FILES: usize = 100_000;

pub enum Baseline {
    /// The paths `git status` already reported when the chat started (changed before it, so not the chat's doing).
    Git { folder: PathBuf, prefix: String, dirty: HashSet<String> },
    /// Every file there was when the chat started.
    Files { folder: PathBuf, files: HashSet<String> },
}

fn git(folder: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let out = Command::new("git").arg("-C").arg(folder).args(args).output().ok()?;
    out.status.success().then_some(out.stdout)
}

/// A `git status` entry: (two-letter code, path from the repo root, the path a rename or copy came from).
type Entry = (String, String, Option<String>);

/// `git status` entries.
fn status(folder: &Path) -> Option<Vec<Entry>> {
    let out = git(folder, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."])?;
    Some(parse_status(&out))
}

/// Porcelain v1 `-z` output: "XY path" records, a rename or copy followed by the path it came from.
fn parse_status(out: &[u8]) -> Vec<Entry> {
    let mut fields = out.split(|b| *b == 0).filter(|f| !f.is_empty()).map(|f| String::from_utf8_lossy(f).into_owned());
    let mut entries = vec![];
    while let Some(f) = fields.next() {
        if f.len() < 4 {
            continue;
        }
        let (code, path) = (f[..2].to_string(), f[3..].to_string());
        let from = if code.starts_with('R') || code.starts_with('C') { fields.next() } else { None };
        entries.push((code, path, from));
    }
    entries
}

fn looks_textual(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return true };
    if meta.len() > MAX_BYTES {
        return false;
    }
    let Ok(bytes) = std::fs::read(path) else { return true };
    !bytes.iter().take(8000).any(|b| *b == 0)
}

/// The files under `folder`, walked as the file tree walks them: hidden files listed, .gitignore honoured even outside
/// a git checkout, and the folders it never shows left out.
fn list_files(folder: &Path) -> HashSet<String> {
    ignore::WalkBuilder::new(folder)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| !crate::files::ALWAYS_HIDDEN.contains(&e.file_name().to_string_lossy().as_ref()))
        .build()
        .flatten()
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .take(MAX_FILES)
        .map(|e| e.path().to_string_lossy().into_owned())
        .collect()
}

impl Baseline {
    /// How `folder` is now, to compare with later.
    pub fn take(folder: &Path) -> Baseline {
        let prefix = git(folder, &["rev-parse", "--show-prefix"]).map(|p| String::from_utf8_lossy(&p).trim().to_string());
        match (prefix, status(folder)) {
            (Some(prefix), Some(entries)) => Baseline::Git { folder: folder.to_path_buf(), prefix, dirty: entries.into_iter().flat_map(|(_, path, from)| [Some(path), from]).flatten().collect() },
            _ => Baseline::Files { folder: folder.to_path_buf(), files: list_files(folder) },
        }
    }

    /// Files that changed since, as (absolute path, content before the chat; None = new). Modified and deleted files
    /// come from git: they were clean when the chat started, so their last commit is how they were. Paths `known`
    /// says are already tracked are skipped before reading anything.
    pub fn changes(&self, known: impl Fn(&str) -> bool) -> Vec<(String, Option<String>)> {
        match self {
            Baseline::Git { folder, prefix, dirty } => {
                let Some(entries) = status(folder) else { return vec![] };
                let mut found = vec![];
                for (code, path, from) in entries {
                    // A rename's new path is a file the chat didn't have; its old path is gone, and HEAD still has it.
                    let mut paths = vec![(path, code == "??" || code.starts_with(['A', 'R', 'C']))];
                    if code.starts_with('R') {
                        paths.extend(from.map(|old| (old, false)));
                    }
                    for (rel, new) in paths {
                        // Paths come from the repo root; the chat's own paths are under its folder as given.
                        let Some(local) = rel.strip_prefix(prefix.as_str()) else { continue };
                        let abs = folder.join(local);
                        if dirty.contains(&rel) || known(&abs.to_string_lossy()) {
                            continue;
                        }
                        let original = if new {
                            if !looks_textual(&abs) {
                                continue;
                            }
                            None
                        } else {
                            match git(folder, &["show", &format!("HEAD:{rel}")]) {
                                Some(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
                                None => continue,
                            }
                        };
                        found.push((abs.to_string_lossy().into_owned(), original));
                    }
                }
                found
            }
            Baseline::Files { folder, files } => list_files(folder)
                .into_iter()
                .filter(|p| !files.contains(p) && !known(p) && looks_textual(Path::new(p)))
                .map(|p| (p, None))
                .collect(),
        }
    }
}

/// The folder's path from the repository root ("" at the root, "app/" in a subfolder); None outside a git checkout.
fn prefix(folder: &Path) -> Option<String> {
    git(folder, &["rev-parse", "--show-prefix"]).map(|p| String::from_utf8_lossy(&p).trim().to_string())
}

/// An uncommitted file: (absolute path, created, deleted, lines added, lines removed).
pub type Uncommitted = (String, bool, bool, usize, usize);

/// Everything uncommitted in the folder (compared with HEAD), whoever changed it: (absolute path, created, deleted,
/// lines added, lines removed). None when the folder isn't in a git checkout.
pub fn uncommitted(folder: &Path) -> Option<Vec<Uncommitted>> {
    let prefix = prefix(folder)?;
    let entries = status(folder)?;
    // Line counts for tracked files in one go: "added<TAB>removed<TAB>path", "-" for binary.
    let numstat = git(folder, &["diff", "HEAD", "--numstat", "-z", "--no-renames", "--", "."]).unwrap_or_default();
    let mut counts = std::collections::HashMap::new();
    for record in numstat.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let line = String::from_utf8_lossy(record);
        let mut f = line.splitn(3, '\t');
        if let (Some(a), Some(r), Some(p)) = (f.next(), f.next(), f.next()) {
            if let (Ok(a), Ok(r)) = (a.parse::<usize>(), r.parse::<usize>()) {
                counts.insert(p.to_string(), (a, r));
            }
        }
    }
    let mut rows = vec![];
    for (code, path, from) in entries {
        let untracked = code == "??";
        // A rename's old path is listed too, as deleted: the numstat is --no-renames, so it has its own line count.
        let mut paths = vec![(path, untracked || code.starts_with(['A', 'R', 'C']))];
        if code.starts_with('R') {
            paths.extend(from.map(|old| (old, false)));
        }
        for (rel, created) in paths {
            let Some(local) = rel.strip_prefix(prefix.as_str()) else { continue };
            let abs = folder.join(local);
            let deleted = !abs.exists();
            let (added, removed) = match counts.get(&rel) {
                Some(c) => *c,
                None if untracked && looks_textual(&abs) => (std::fs::read_to_string(&abs).map(|t| t.lines().count()).unwrap_or(0), 0),
                // Binary or too big to count (an untracked file).
                _ if untracked => continue,
                _ => (0, 0),
            };
            rows.push((abs.to_string_lossy().into_owned(), created, deleted, added, removed));
        }
    }
    Some(rows)
}

/// A file as it is in the last commit: None if it isn't there (new). Err when the folder isn't in a git checkout.
pub fn committed(folder: &Path, path: &Path) -> Result<Option<String>, String> {
    let prefix = prefix(folder).ok_or("This folder isn't in a git repository.")?;
    let rel = path.strip_prefix(folder).map_err(|_| "That file is outside the open folder.")?;
    let spec = format!("HEAD:{prefix}{}", rel.to_string_lossy());
    Ok(git(folder, &["show", &spec]).map(|b| String::from_utf8_lossy(&b).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) {
        assert!(Command::new("git").arg("-C").arg(dir).args(args).output().unwrap().status.success(), "git {args:?}");
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        sh(dir.path(), &["init", "-q"]);
        sh(dir.path(), &["config", "user.email", "t@t"]);
        sh(dir.path(), &["config", "user.name", "t"]);
        std::fs::write(dir.path().join("kept.txt"), "kept\n").unwrap();
        std::fs::write(dir.path().join("edited.txt"), "before\n").unwrap();
        std::fs::write(dir.path().join("gone.txt"), "gone\n").unwrap();
        sh(dir.path(), &["add", "."]);
        sh(dir.path(), &["commit", "-qm", "init"]);
        dir
    }

    fn names(mut changes: Vec<(String, Option<String>)>) -> Vec<(String, Option<String>)> {
        changes.sort();
        changes.into_iter().map(|(p, o)| (p.rsplit('/').next().unwrap().to_string(), o)).collect()
    }

    #[test]
    fn in_git_finds_new_edited_and_deleted_files_but_not_what_was_dirty_before() {
        let dir = repo();
        let d = dir.path();
        std::fs::write(d.join("already.txt"), "untracked before the chat\n").unwrap();
        let base = Baseline::take(d);
        assert!(base.changes(|_| false).is_empty());
        std::fs::write(d.join("copied.txt"), "copied in\n").unwrap();
        std::fs::write(d.join("edited.txt"), "after\n").unwrap();
        std::fs::remove_file(d.join("gone.txt")).unwrap();
        std::fs::write(d.join("blob.bin"), [0u8, 1, 2, 3]).unwrap();
        assert_eq!(
            names(base.changes(|_| false)),
            vec![("copied.txt".into(), None), ("edited.txt".into(), Some("before\n".into())), ("gone.txt".into(), Some("gone\n".into()))]
        );
    }

    #[test]
    fn in_a_subfolder_of_a_repo_paths_are_under_that_folder() {
        let dir = repo();
        let sub = dir.path().join("app");
        std::fs::create_dir(&sub).unwrap();
        let base = Baseline::take(&sub);
        std::fs::write(sub.join("new.ts"), "x\n").unwrap();
        std::fs::write(dir.path().join("outside.txt"), "not in the folder\n").unwrap();
        let changes = base.changes(|_| false);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].0, sub.join("new.ts").to_string_lossy());
    }

    #[test]
    fn without_git_finds_new_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("old.txt"), "old\n").unwrap();
        let base = Baseline::take(dir.path());
        std::fs::write(dir.path().join("new.txt"), "new\n").unwrap();
        assert_eq!(names(base.changes(|_| false)), vec![("new.txt".into(), None)]);
    }

    #[test]
    fn lists_everything_uncommitted_with_counts_and_reads_the_committed_version() {
        let dir = repo();
        let d = dir.path();
        std::fs::write(d.join("edited.txt"), "before\nmore\n").unwrap();
        std::fs::remove_file(d.join("gone.txt")).unwrap();
        std::fs::write(d.join("new.txt"), "a\nb\nc\n").unwrap();
        let mut rows = uncommitted(d).unwrap();
        rows.sort();
        let rows: Vec<_> = rows.into_iter().map(|(p, c, del, a, r)| (p.rsplit('/').next().unwrap().to_string(), c, del, a, r)).collect();
        assert_eq!(rows, vec![("edited.txt".into(), false, false, 1, 0), ("gone.txt".into(), false, true, 0, 1), ("new.txt".into(), true, false, 3, 0)]);
        assert_eq!(committed(d, &d.join("edited.txt")).unwrap().as_deref(), Some("before\n"));
        assert_eq!(committed(d, &d.join("new.txt")).unwrap(), None);
        let plain = tempfile::tempdir().unwrap();
        assert!(uncommitted(plain.path()).is_none());
        assert!(committed(plain.path(), &plain.path().join("x")).is_err());
    }

    #[test]
    fn porcelain_renames_carry_the_path_they_came_from() {
        assert_eq!(parse_status(b"R  new.txt\0old.txt\0?? x.txt\0"), vec![("R ".into(), "new.txt".into(), Some("old.txt".into())), ("??".into(), "x.txt".into(), None)]);
    }

    #[test]
    fn a_git_mv_shows_as_the_new_file_created_and_the_old_one_deleted() {
        let dir = repo();
        let d = dir.path();
        let base = Baseline::take(d);
        sh(d, &["mv", "kept.txt", "renamed.txt"]);
        assert_eq!(names(base.changes(|_| false)), vec![("kept.txt".into(), Some("kept\n".into())), ("renamed.txt".into(), None)]);
        let mut rows = uncommitted(d).unwrap();
        rows.sort();
        let rows: Vec<_> = rows.into_iter().map(|(p, c, del, a, r)| (p.rsplit('/').next().unwrap().to_string(), c, del, a, r)).collect();
        assert_eq!(rows, vec![("kept.txt".into(), false, true, 0, 1), ("renamed.txt".into(), true, false, 1, 0)]);
    }

    #[test]
    fn without_git_the_walk_follows_the_gitignore_and_skips_node_modules_but_not_dotfiles() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        std::fs::write(d.join(".gitignore"), "build/\n").unwrap();
        let base = Baseline::take(d);
        std::fs::create_dir_all(d.join("node_modules/pkg")).unwrap();
        std::fs::create_dir(d.join("build")).unwrap();
        std::fs::write(d.join("node_modules/pkg/index.js"), "x\n").unwrap();
        std::fs::write(d.join("build/out.js"), "x\n").unwrap();
        std::fs::write(d.join(".env"), "KEY=1\n").unwrap();
        assert_eq!(names(base.changes(|_| false)), vec![(".env".into(), None)]);
    }
}
