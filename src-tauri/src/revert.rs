//! Reverting Claude's edits: a file goes back to how it stood before a turn, a range of turns, or the chat. The write is
//! the editor's guarded one, so a file changed since the user was shown it is reported as a conflict and left alone. A
//! file Claude created goes to the Trash rather than being deleted.

use crate::changes::{is_stamp, ChangeTracker, Scope, MAX_TRACKED_BYTES};
use crate::files::{self, Written, BOM};
use serde::{Deserialize, Serialize};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Moves a path to the Trash and returns where it went (`trash::move_to_trash`, or a test's folder).
pub type Trash<'a> = &'a dyn Fn(&Path) -> Result<PathBuf, String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// The file holds its earlier text, or is absent again if it was created in the range.
    Reverted,
    /// A file Claude created: it's in the Trash now.
    Trashed,
    /// The file changed since the user was shown it: left as it is.
    Conflict,
    /// This file can't be reverted from here (`reason` says why).
    NotRevertible,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Outcome {
    pub path: String,
    pub status: Status,
    /// What the file held before (None: it was absent). Undo writes it back.
    pub before: Option<String>,
    /// What it holds now (None: absent). Undo only acts if the file still holds this.
    pub after: Option<String>,
    pub reason: Option<String>,
}

/// A file the user chose to revert, with the text they were shown as its current text (None: shown as deleted).
#[derive(Debug, Deserialize)]
pub struct Shown {
    pub path: String,
    pub expected: Option<String>,
}

/// A file to put back to `target` (None: absent), if it still holds `expected`: what an Undo was given.
#[derive(Debug, Deserialize)]
pub struct Undo {
    pub path: String,
    pub target: Option<String>,
    pub expected: Option<String>,
}

fn refuse(path: &str, reason: impl Into<String>) -> Outcome {
    Outcome { path: path.into(), status: Status::NotRevertible, before: None, after: None, reason: Some(reason.into()) }
}

/// The text without its byte-order mark: the editor's view of a file, which `write_file` compares by.
fn unmarked(text: Option<&str>) -> Option<&str> {
    text.map(|t| t.strip_prefix(BOM).unwrap_or(t))
}

/// Makes `path` (inside `root`) hold `target` (None: absent) if it still holds `expected`. Nothing else is touched.
pub fn apply(root: &Path, path: &str, target: Option<&str>, expected: Option<&str>, trash: Trash) -> Outcome {
    // A link is refused before resolving: the write would replace the link itself with a file.
    let given = if Path::new(path).is_absolute() { PathBuf::from(path) } else { root.join(path) };
    if std::fs::symlink_metadata(&given).is_ok_and(|m| m.file_type().is_symlink()) {
        return refuse(path, "It's a link, so it isn't reverted from here.");
    }
    let full = match files::inside_or_new(root, &given) {
        Ok(full) => full,
        Err(e) => return refuse(path, e),
    };
    match std::fs::symlink_metadata(&full) {
        Ok(meta) if !meta.is_file() => return refuse(path, "That isn't a regular file."),
        Ok(meta) if meta.len() > MAX_TRACKED_BYTES => return refuse(path, "It's too large to revert from here."),
        _ => {}
    }
    let current = match std::fs::read(&full) {
        Ok(bytes) if bytes.contains(&0) => return refuse(path, "It's binary, so it isn't reverted from here."),
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => Some(text),
            Err(_) => return refuse(path, "It isn't UTF-8 text, so it isn't reverted from here."),
        },
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(e) => return refuse(path, e.to_string()),
    };
    if unmarked(current.as_deref()) != unmarked(expected) {
        return Outcome { path: path.into(), status: Status::Conflict, before: None, after: None, reason: Some("It changed since you saw it, so it's left as it is.".into()) };
    }
    match target {
        None => match current {
            None => Outcome { path: path.into(), status: Status::Reverted, before: None, after: None, reason: None },
            Some(text) => match trash(&full) {
                Ok(_) => Outcome { path: path.into(), status: Status::Trashed, before: Some(text), after: None, reason: None },
                Err(e) => refuse(path, e),
            },
        },
        Some(text) => {
            // write_file puts back the byte-order mark the file has, so the text must not carry a second one.
            let disk_mark = current.as_deref().is_some_and(|t| t.starts_with(BOM));
            let text = if disk_mark { text.strip_prefix(BOM).unwrap_or(text) } else { text };
            match files::write_file(root, &given, text, expected) {
                Ok(Written::Saved { .. }) => {
                    let after = if disk_mark { format!("{BOM}{text}") } else { text.to_string() };
                    Outcome { path: path.into(), status: Status::Reverted, before: current, after: Some(after), reason: None }
                }
                Ok(Written::Conflict { .. }) => Outcome {
                    path: path.into(),
                    status: Status::Conflict,
                    before: None,
                    after: None,
                    reason: Some("It changed since you saw it, so it's left as it is.".into()),
                },
                Err(e) => refuse(path, e),
            }
        }
    }
}

/// Reverts `files` to how they stood before the scope's turns (`turn` and `to_turn`, as `change_summary` takes them, or
/// the whole session). A file the scope doesn't change is refused rather than written. An error means the scope has no
/// baseline to revert to, so nothing was written.
pub fn revert_files(root: &Path, changes: &Mutex<ChangeTracker>, scope: Scope, turn: Option<usize>, to_turn: Option<usize>, files: &[Shown], trash: Trash) -> Result<Vec<Outcome>, String> {
    if !matches!(scope, Scope::Session | Scope::Turn) {
        return Err("Only Claude's own changes can be reverted here.".into());
    }
    // The baselines are read under the lock; the files are written without it, as edits are.
    let baselines = {
        let tracker = changes.lock().unwrap();
        files.iter().map(|f| tracker.original(&f.path, scope, turn, to_turn)).collect::<Result<Vec<_>, _>>()?
    };
    Ok(files
        .iter()
        .zip(baselines)
        .map(|(f, baseline)| {
            let Some(before) = baseline else { return refuse(&f.path, "It wasn't changed in this scope.") };
            if is_stamp(before.as_deref()) {
                return refuse(&f.path, "It was too large to keep a copy of, so it can't be reverted.");
            }
            // Lossy decoding put replacement characters (or NULs, for binary) in what isn't text.
            if before.as_deref().is_some_and(|t| t.contains('\0') || t.contains('\u{fffd}')) {
                return refuse(&f.path, "It isn't UTF-8 text, so it can't be reverted.");
            }
            apply(root, &f.path, before.as_deref(), f.expected.as_deref(), trash)
        })
        .collect())
}

/// Puts files back as an earlier revert found them (`before`), or takes away what it created. Each is checked against
/// what that revert left (`after`), so anything changed since is a conflict.
pub fn undo(root: &Path, files: &[Undo], trash: Trash) -> Vec<Outcome> {
    files.iter().map(|f| apply(root, &f.path, f.target.as_deref(), f.expected.as_deref(), trash)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A folder to work in, and a Trash folder inside the temp dir (never the user's).
    struct Fixture {
        dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            Self { dir: tempfile::tempdir().unwrap() }
        }
        fn root(&self) -> PathBuf {
            self.dir.path().join("project")
        }
        fn path(&self, name: &str) -> String {
            self.root().join(name).display().to_string()
        }
        fn trash(&self) -> impl Fn(&Path) -> Result<PathBuf, String> + '_ {
            let trash = self.dir.path().join("trash");
            move |p: &Path| crate::trash::trash_into(p, &trash)
        }
        fn write(&self, name: &str, text: &str) {
            fs::create_dir_all(self.root()).unwrap();
            fs::write(self.root().join(name), text).unwrap();
        }
        fn read(&self, name: &str) -> Option<String> {
            fs::read_to_string(self.root().join(name)).ok()
        }
        fn shown(&self, name: &str, expected: Option<&str>) -> Shown {
            Shown { path: self.path(name), expected: expected.map(String::from) }
        }
    }

    /// A chat that edited `a.txt` ("a0" to "a1") in turn 0 and created `new.txt` in turn 1.
    fn two_turns(f: &Fixture) -> Mutex<ChangeTracker> {
        f.write("a.txt", "a0\n");
        let mut t = ChangeTracker::default();
        t.start_turn();
        t.record(&f.path("a.txt"), Some("a0\n".into()));
        f.write("a.txt", "a1\n");
        t.start_turn();
        t.record(&f.path("new.txt"), None);
        f.write("new.txt", "fresh\n");
        Mutex::new(t)
    }

    #[test]
    fn a_session_revert_restores_the_file_to_its_first_original() {
        let f = Fixture::new();
        let changes = two_turns(&f);
        let trash = f.trash();
        let out = revert_files(&f.root(), &changes, Scope::Session, None, None, &[f.shown("a.txt", Some("a1\n"))], &trash).unwrap();
        assert_eq!(out, vec![Outcome { path: f.path("a.txt"), status: Status::Reverted, before: Some("a1\n".into()), after: Some("a0\n".into()), reason: None }]);
        assert_eq!(f.read("a.txt").as_deref(), Some("a0\n"));
    }

    #[test]
    fn a_file_changed_since_it_was_shown_is_a_conflict_and_untouched() {
        let f = Fixture::new();
        let changes = two_turns(&f);
        let trash = f.trash();
        f.write("a.txt", "a2 by hand\n");
        let out = revert_files(&f.root(), &changes, Scope::Session, None, None, &[f.shown("a.txt", Some("a1\n"))], &trash).unwrap();
        assert_eq!(out[0].status, Status::Conflict);
        assert_eq!(f.read("a.txt").as_deref(), Some("a2 by hand\n"));
    }

    #[test]
    fn a_created_file_goes_to_the_trash_and_a_newer_edit_to_it_is_a_conflict() {
        let f = Fixture::new();
        let changes = two_turns(&f);
        let trash = f.trash();
        let conflict = revert_files(&f.root(), &changes, Scope::Session, None, None, &[f.shown("new.txt", Some("other\n"))], &trash).unwrap();
        assert_eq!(conflict[0].status, Status::Conflict);
        assert!(f.read("new.txt").is_some());
        let out = revert_files(&f.root(), &changes, Scope::Session, None, None, &[f.shown("new.txt", Some("fresh\n"))], &trash).unwrap();
        assert_eq!((out[0].status, out[0].before.as_deref(), out[0].after.as_deref()), (Status::Trashed, Some("fresh\n"), None));
        assert!(f.read("new.txt").is_none());
        assert_eq!(fs::read_to_string(f.dir.path().join("trash/new.txt")).unwrap(), "fresh\n");
    }

    #[test]
    fn a_created_file_already_gone_is_reverted_without_a_trash_move() {
        let f = Fixture::new();
        let changes = two_turns(&f);
        let trash = f.trash();
        fs::remove_file(f.root().join("new.txt")).unwrap();
        let out = revert_files(&f.root(), &changes, Scope::Session, None, None, &[f.shown("new.txt", None)], &trash).unwrap();
        assert_eq!(out[0].status, Status::Reverted);
        assert!(!f.dir.path().join("trash").exists());
    }

    #[test]
    fn a_file_claude_deleted_is_brought_back() {
        let f = Fixture::new();
        let changes = two_turns(&f);
        let trash = f.trash();
        fs::remove_file(f.root().join("a.txt")).unwrap();
        let out = revert_files(&f.root(), &changes, Scope::Session, None, None, &[f.shown("a.txt", None)], &trash).unwrap();
        assert_eq!((out[0].status, out[0].before.clone()), (Status::Reverted, None));
        assert_eq!(f.read("a.txt").as_deref(), Some("a0\n"));
    }

    #[test]
    fn a_turn_range_reverts_to_how_the_range_began() {
        let f = Fixture::new();
        let changes = two_turns(&f);
        let trash = f.trash();
        // Turn 1 only: new.txt didn't exist when it began, so it goes. a.txt was already tracked when turn 1 began, so
        // its baseline is what it was then, which is what it is now: nothing to write.
        let out = revert_files(&f.root(), &changes, Scope::Turn, Some(1), None, &[f.shown("new.txt", Some("fresh\n")), f.shown("a.txt", Some("a1\n"))], &trash).unwrap();
        assert_eq!(out[0].status, Status::Trashed);
        assert_eq!(out[1].status, Status::Reverted);
        assert_eq!((out[1].before.as_deref(), out[1].after.as_deref()), (Some("a1\n"), Some("a1\n")));
        assert_eq!(f.read("a.txt").as_deref(), Some("a1\n"));
        // A turn the chat doesn't have, or one before a reopened session's last turn, has no baseline.
        assert!(revert_files(&f.root(), &changes, Scope::Turn, Some(7), None, &[f.shown("a.txt", Some("a1\n"))], &trash).is_err());
        // Turn 0 reverts a.txt to what it was before the chat's first edit.
        let out = revert_files(&f.root(), &changes, Scope::Turn, Some(0), None, &[f.shown("a.txt", Some("a1\n"))], &trash).unwrap();
        assert_eq!(out[0].status, Status::Reverted);
        assert_eq!(f.read("a.txt").as_deref(), Some("a0\n"));
    }

    #[test]
    fn a_range_whose_baseline_is_unknown_is_an_error_and_writes_nothing() {
        let f = Fixture::new();
        let changes = two_turns(&f);
        let trash = f.trash();
        // A reopened session keeps only its last turn (as turn 0): the turns before it, as the UI numbers them, are gone.
        changes.lock().unwrap().restore(vec![(f.path("a.txt"), Some("a0\n".into()))], 0);
        assert!(revert_files(&f.root(), &changes, Scope::Turn, Some(1), None, &[f.shown("a.txt", Some("a1\n"))], &trash).is_err());
        assert_eq!(f.read("a.txt").as_deref(), Some("a1\n"));
        // Git scopes are never reverted.
        assert!(revert_files(&f.root(), &changes, Scope::Git, None, None, &[], &trash).is_err());
    }

    #[test]
    fn stamps_binary_and_big_files_are_not_revertible() {
        let f = Fixture::new();
        let mut t = ChangeTracker::default();
        // A file too large to keep a copy of: its original is a stamp.
        f.write("big.log", "x");
        t.record(&f.path("big.log"), Some(format!("\0lantern-too-large:{}:0", MAX_TRACKED_BYTES + 1)));
        // A binary file: its original has a NUL.
        f.write("blob.bin", "text");
        t.record(&f.path("blob.bin"), Some("text\0".into()));
        // A file whose current bytes are binary.
        f.write("now-binary.txt", "fine");
        t.record(&f.path("now-binary.txt"), Some("fine".into()));
        fs::write(f.root().join("now-binary.txt"), [0u8, 1, 2]).unwrap();
        let changes = Mutex::new(t);
        let trash = f.trash();
        let files = [f.shown("big.log", Some("x")), f.shown("blob.bin", Some("text")), f.shown("now-binary.txt", Some("fine"))];
        let out = revert_files(&f.root(), &changes, Scope::Session, None, None, &files, &trash).unwrap();
        assert!(out.iter().all(|o| o.status == Status::NotRevertible), "{out:?}");
        assert_eq!(f.read("blob.bin").as_deref(), Some("text"));
        assert_eq!(fs::read(f.root().join("now-binary.txt")).unwrap(), [0u8, 1, 2]);
    }

    #[test]
    fn paths_outside_the_folder_or_untracked_are_refused_and_nothing_is_written() {
        let f = Fixture::new();
        let changes = two_turns(&f);
        let trash = f.trash();
        let outside = f.dir.path().join("outside.txt");
        fs::write(&outside, "keep\n").unwrap();
        // A link inside the folder that points out of it, edited by Claude (so it's tracked and has a baseline).
        std::os::unix::fs::symlink(&outside, f.root().join("link.txt")).unwrap();
        changes.lock().unwrap().record(&f.path("link.txt"), Some("was\n".into()));
        let escape = Shown { path: f.root().join("../outside.txt").display().to_string(), expected: Some("keep\n".into()) };
        let link = f.shown("link.txt", Some("keep\n"));
        let absolute = Shown { path: outside.display().to_string(), expected: Some("keep\n".into()) };
        let untracked = f.shown("never-edited.txt", None);
        let out = revert_files(&f.root(), &changes, Scope::Session, None, None, &[escape, link, absolute, untracked], &trash).unwrap();
        assert!(out.iter().all(|o| o.status == Status::NotRevertible), "{out:?}");
        assert_eq!(fs::read_to_string(&outside).unwrap(), "keep\n");
        assert!(fs::symlink_metadata(f.root().join("link.txt")).unwrap().file_type().is_symlink());
    }

    #[test]
    fn a_byte_order_mark_is_kept_once() {
        let f = Fixture::new();
        let mut t = ChangeTracker::default();
        f.write("bom.txt", "\u{feff}v1\n");
        t.record(&f.path("bom.txt"), Some("\u{feff}v0\n".into()));
        let changes = Mutex::new(t);
        let trash = f.trash();
        let out = revert_files(&f.root(), &changes, Scope::Session, None, None, &[f.shown("bom.txt", Some("v1\n"))], &trash).unwrap();
        assert_eq!(out[0].status, Status::Reverted);
        assert_eq!(f.read("bom.txt").as_deref(), Some("\u{feff}v0\n"));
    }

    #[test]
    fn undo_puts_back_what_a_revert_changed_and_checks_it_is_still_that() {
        let f = Fixture::new();
        let changes = two_turns(&f);
        let trash = f.trash();
        let out = revert_files(&f.root(), &changes, Scope::Session, None, None, &[f.shown("a.txt", Some("a1\n")), f.shown("new.txt", Some("fresh\n"))], &trash).unwrap();
        assert_eq!(out.iter().map(|o| o.status).collect::<Vec<_>>(), vec![Status::Reverted, Status::Trashed]);
        let undo_list: Vec<Undo> = out.iter().map(|o| Undo { path: o.path.clone(), target: o.before.clone(), expected: o.after.clone() }).collect();
        // The user edits a.txt after the revert: its undo is a conflict, the other comes back.
        f.write("a.txt", "a0 then by hand\n");
        let back = undo(&f.root(), &undo_list, &trash);
        assert_eq!(back[0].status, Status::Conflict);
        assert_eq!(back[1].status, Status::Reverted);
        assert_eq!(f.read("new.txt").as_deref(), Some("fresh\n"));
        assert_eq!(f.read("a.txt").as_deref(), Some("a0 then by hand\n"));
    }

    #[test]
    fn undo_of_a_revert_that_created_a_file_takes_it_away_again() {
        let f = Fixture::new();
        let trash = f.trash();
        // The revert brought back a file Claude had deleted.
        let undo = Undo { path: f.path("gone.txt"), target: None, expected: Some("back\n".into()) };
        f.write("gone.txt", "back\n");
        let out = super::undo(&f.root(), &[undo], &trash);
        assert_eq!(out[0].status, Status::Trashed);
        assert!(f.read("gone.txt").is_none());
    }
}
