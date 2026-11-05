//! The linked worktree a chat is working in when Claude entered one itself (`EnterWorktree`, or a `git worktree add`
//! it then worked inside): the chat stays open on its project's folder, but its changes are in the worktree.
//!
//! A chat can also be put in one, which wins over where it last edited: Claude calls `enter_worktree` (Claude Code's own
//! `EnterWorktree` needs a consent notice Lantern's cards can't show), or the user picks one in the Changes pane. Only a
//! linked worktree of the chat's own repository can be chosen, whoever asks: `resolve` checks it against `git worktree list`.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// The tool Claude is offered.
pub const TOOL: &str = "enter_worktree";

/// The worktree a chat was put in (its canonical path), shared by the chat's slot and its permission bridge. It is checked
/// again each time it is read, so a worktree that has since been removed is not followed.
pub type Pin = Arc<Mutex<Option<PathBuf>>>;

/// A worktree the Changes pane can read from instead of the chat's folder.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorkFolder {
    pub path: String,
    /// The folder's name, for the chip.
    pub name: String,
    /// Its checked-out branch, when it is on one.
    pub branch: Option<String>,
}

/// The linked worktrees of `folder`'s repository (not the main one) as (path, branch), from `git worktree list`.
fn linked(folder: &Path) -> Vec<(PathBuf, Option<String>)> {
    let Ok(out) = Command::new("git").arg("-C").arg(folder).args(["worktree", "list", "--porcelain"]).output() else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    parse(&String::from_utf8_lossy(&out.stdout))
}

/// The porcelain list's entries after the first, which is the main worktree. A prunable one (its folder is gone) is left out.
fn parse(text: &str) -> Vec<(PathBuf, Option<String>)> {
    text.split("\n\n")
        .skip(1)
        .filter_map(|block| {
            let mut path = None;
            let mut branch = None;
            let mut prunable = false;
            for line in block.lines() {
                if let Some(p) = line.strip_prefix("worktree ") {
                    path = Some(PathBuf::from(p));
                } else if let Some(b) = line.strip_prefix("branch ") {
                    branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
                } else if line.starts_with("prunable") {
                    prunable = true;
                }
            }
            path.filter(|_| !prunable).map(|p| (p, branch))
        })
        .collect()
}

/// The linked worktree of `folder`'s repository that holds `last_edit`, the file the chat edited most recently: the chat
/// is working there until it edits something outside it (leaving the worktree puts it back on the folder).
pub fn find(folder: &Path, last_edit: Option<&str>) -> Option<WorkFolder> {
    let edit = std::fs::canonicalize(last_edit?).ok().or_else(|| last_edit.map(PathBuf::from))?;
    // A chat already in a linked worktree (a Team worker's) is in its own folder, not in another one. The deepest
    // worktree holding the file wins, so one nested in another doesn't lose it.
    let own = std::fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
    let mut best: Option<(PathBuf, Option<String>)> = None;
    for (path, branch) in linked(folder) {
        let real = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if real != own && edit.starts_with(&real) && best.as_ref().is_none_or(|(b, _)| real.components().count() > b.components().count()) {
            best = Some((real, branch));
        }
    }
    let (path, branch) = best?;
    Some(work_folder(path, branch))
}

fn work_folder(path: PathBuf, branch: Option<String>) -> WorkFolder {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    WorkFolder { path: path.to_string_lossy().into_owned(), name, branch }
}

/// `folder`'s repository's linked worktrees by their real paths, without `folder` itself (a chat is already in its own folder).
fn others(folder: &Path) -> Vec<WorkFolder> {
    let own = std::fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
    linked(folder)
        .into_iter()
        .map(|(path, branch)| (std::fs::canonicalize(&path).unwrap_or(path), branch))
        .filter(|(real, _)| *real != own)
        .map(|(real, branch)| work_folder(real, branch))
        .collect()
}

/// The worktrees the Changes pane's picker offers: the repository's linked ones, by real path.
pub fn list(folder: &Path) -> Vec<WorkFolder> {
    others(folder)
}

/// The linked worktree of `folder`'s repository that `want` names: its absolute path, its folder's name, or its branch. Nothing
/// else is accepted, so a path outside the repository's own worktrees (or a folder inside one) is never read from.
pub fn resolve(folder: &Path, want: &str) -> Result<WorkFolder, String> {
    let want = want.trim();
    if want.is_empty() || want.len() > 500 || want.chars().any(char::is_control) {
        return Err("Name a worktree by its absolute path, its folder's name or its branch.".into());
    }
    let all = others(folder);
    let wanted = if Path::new(want).is_absolute() {
        let Ok(real) = std::fs::canonicalize(want) else { return Err(format!("{want} is not a folder that exists.")) };
        all.iter().filter(|w| Path::new(&w.path) == real).cloned().collect::<Vec<_>>()
    } else {
        all.iter().filter(|w| w.name == want || w.branch.as_deref() == Some(want)).cloned().collect::<Vec<_>>()
    };
    match wanted.as_slice() {
        [one] => Ok(one.clone()),
        [] => Err(if all.is_empty() {
            "This project has no linked worktrees (git worktree list shows only its own folder). Create one first, such as with git worktree add.".to_string()
        } else {
            let names: Vec<String> = all.iter().map(|w| format!("{} ({})", w.path, w.branch.as_deref().unwrap_or("detached"))).collect();
            format!("{want} is not a linked worktree of this project. Its worktrees: {}.", names.join(", "))
        }),
        _ => Err(format!("More than one worktree is called {want}: give its absolute path.")),
    }
}

/// The worktree the chat is in: the one it was put in (`pin`) while that is still a linked worktree of the project, else the
/// one holding its latest edit (see `find`).
pub fn current(folder: &Path, pin: Option<&Path>, last_edit: Option<&str>) -> Option<WorkFolder> {
    pin.and_then(|p| resolve(folder, &p.to_string_lossy()).ok()).or_else(|| find(folder, last_edit))
}

/// What `enter_worktree` does: puts the chat in the worktree `path` names (the Changes pane then reads Git and Branch from it,
/// at once), or with no path lets the chat's latest edit decide again. The user's choice of the chat's own folder is undone.
pub fn call(folder: Option<&str>, pin: &Pin, view_main: &AtomicBool, input: &Value) -> Result<String, String> {
    let folder = folder.map(Path::new).ok_or("This chat has no folder open yet.")?;
    match &input["path"] {
        Value::Null => {
            *pin.lock().unwrap() = None;
            view_main.store(false, Ordering::Relaxed);
            Ok("The Changes pane follows the files you edit again.".into())
        }
        Value::String(want) => {
            let w = resolve(folder, want)?;
            *pin.lock().unwrap() = Some(PathBuf::from(&w.path));
            view_main.store(false, Ordering::Relaxed);
            let branch = w.branch.as_deref().map(|b| format!(" on {b}")).unwrap_or_default();
            Ok(format!("The Changes pane shows the worktree {}{branch} now: its Git and Branch read from {}. This is the view only: your own folder is unchanged, so edit by absolute path.", w.name, w.path))
        }
        _ => Err("`path` is a worktree's absolute path, its folder's name or its branch; leave it out to follow your edits again.".into()),
    }
}

/// The tool Claude is offered.
pub fn tool_list() -> Vec<Value> {
    vec![json!({
        "name": TOOL,
        "description": "Put this chat in one of the project's git worktrees: Lantern's Changes tab then shows that worktree's Git and Branch diffs at once, without you editing a file there first. Use it when the user asks you to enter, switch to or show a worktree, instead of the built-in EnterWorktree (which Lantern can't show a consent notice for). Only a linked worktree of this project works. It changes what the user sees; your own folder stays the same, so work in the worktree by absolute path. Leave `path` out to go back to showing the files you edit.",
        "inputSchema": {"type": "object", "properties": {
            "path": {"type": ["string", "null"], "maxLength": 500, "description": "The worktree's absolute path, its folder's name, or its branch (from git worktree list). Leave it out, or null, to follow your edits again."}
        }, "additionalProperties": false}
    })]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_in(dir: &Path, args: &[&str]) {
        let out = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    fn the_porcelain_list_skips_the_main_worktree_and_prunable_ones() {
        let text = "worktree /p\nHEAD a\nbranch refs/heads/main\n\nworktree /p/.claude/worktrees/x\nHEAD b\nbranch refs/heads/feat/x\n\nworktree /gone\nHEAD c\ndetached\nprunable gitdir file points to non-existent location\n";
        assert_eq!(parse(text), vec![(PathBuf::from("/p/.claude/worktrees/x"), Some("feat/x".to_string()))]);
    }

    #[test]
    fn a_chat_is_in_the_worktree_that_holds_its_latest_edit_and_back_on_the_folder_when_it_edits_there() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        std::fs::create_dir(&main).unwrap();
        git_in(&main, &["init", "-q", "-b", "main"]);
        std::fs::write(main.join("a.txt"), "a").unwrap();
        git_in(&main, &["add", "."]);
        git_in(&main, &["commit", "-q", "-m", "one"]);
        let wt = dir.path().join("wt");
        git_in(&main, &["worktree", "add", "-q", "-b", "feat", wt.to_str().unwrap()]);
        std::fs::write(wt.join("b.txt"), "b").unwrap();

        let found = find(&main, wt.join("b.txt").to_str()).unwrap();
        assert_eq!(found.name, "wt");
        assert_eq!(found.branch.as_deref(), Some("feat"));
        assert_eq!(found.path, std::fs::canonicalize(&wt).unwrap().to_string_lossy());
        assert_eq!(find(&main, main.join("a.txt").to_str()), None);
        assert_eq!(find(&main, None), None);
        // A chat opened on the worktree itself (a Team worker) is in its own folder, not in a worktree of it.
        assert_eq!(find(&wt, wt.join("b.txt").to_str()), None);
        // A folder that isn't a repository has no worktrees.
        assert_eq!(find(dir.path(), wt.join("b.txt").to_str()), None);
    }

    /// A repository `main` with linked worktrees `wt` (branch feat) and `other` (branch topic/other), and a second repository.
    struct Repos {
        _dir: tempfile::TempDir,
        main: PathBuf,
        wt: PathBuf,
        other: PathBuf,
        stranger: PathBuf,
    }

    fn repos() -> Repos {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let init = |name: &str| {
            let p = root.join(name);
            std::fs::create_dir(&p).unwrap();
            git_in(&p, &["init", "-q", "-b", "main"]);
            std::fs::write(p.join("a.txt"), "a").unwrap();
            git_in(&p, &["add", "."]);
            git_in(&p, &["commit", "-q", "-m", "one"]);
            p
        };
        let main = init("main");
        let stranger = init("stranger");
        let wt = root.join("wt");
        git_in(&main, &["worktree", "add", "-q", "-b", "feat", wt.to_str().unwrap()]);
        let other = root.join("other");
        git_in(&main, &["worktree", "add", "-q", "-b", "topic/other", other.to_str().unwrap()]);
        Repos { _dir: dir, main, wt, other, stranger }
    }

    #[test]
    fn a_worktree_is_named_by_its_path_its_folder_or_its_branch() {
        let r = repos();
        for want in [r.wt.to_str().unwrap(), "wt", "feat"] {
            let w = resolve(&r.main, want).unwrap();
            assert_eq!((w.path.as_str(), w.name.as_str(), w.branch.as_deref()), (r.wt.to_str().unwrap(), "wt", Some("feat")), "{want}");
        }
        assert_eq!(resolve(&r.main, "topic/other").unwrap().name, "other");
        // A chat in a linked worktree of its own can pick the others, but not itself.
        assert_eq!(resolve(&r.wt, "other").unwrap().path, r.other.to_str().unwrap());
        assert!(resolve(&r.wt, r.wt.to_str().unwrap()).is_err());
    }

    #[test]
    fn nothing_but_a_linked_worktree_of_the_chats_own_project_can_be_chosen() {
        let r = repos();
        let main = r.main.to_str().unwrap();
        // Its own folder, a folder inside a worktree, another repository, a path that isn't there, and what isn't a name.
        let inside = r.wt.join("sub");
        std::fs::create_dir(&inside).unwrap();
        for want in [main, inside.to_str().unwrap(), r.stranger.to_str().unwrap(), "/nonexistent/wt", "", "  ", "nope", "../wt", "main", "/"] {
            assert!(resolve(&r.main, want).is_err(), "{want:?} was accepted");
        }
        assert!(resolve(&r.main, &"x".repeat(501)).is_err());
        assert!(resolve(&r.main, "w\u{7}t").is_err());
        // A link to another repository resolves there, so it is refused; one to a worktree is that worktree.
        let evil = r.main.join("evil");
        std::os::unix::fs::symlink(&r.stranger, &evil).unwrap();
        assert!(resolve(&r.main, evil.to_str().unwrap()).is_err());
        let good = r.main.join("good");
        std::os::unix::fs::symlink(&r.wt, &good).unwrap();
        assert_eq!(resolve(&r.main, good.to_str().unwrap()).unwrap().path, r.wt.to_str().unwrap());
        // Another project's worktrees aren't this one's.
        assert!(resolve(&r.stranger, "wt").is_err());
        assert!(list(&r.stranger).is_empty());
    }

    #[test]
    fn a_name_two_worktrees_share_is_not_guessed() {
        let r = repos();
        let twin = r.other.parent().unwrap().join("twin");
        std::fs::create_dir(&twin).unwrap();
        let nested = twin.join("wt");
        git_in(&r.main, &["worktree", "add", "-q", "-b", "deeper", nested.to_str().unwrap()]);
        let err = resolve(&r.main, "wt").unwrap_err();
        assert!(err.contains("More than one") && err.contains("absolute path"), "{err}");
        assert_eq!(resolve(&r.main, nested.to_str().unwrap()).unwrap().branch.as_deref(), Some("deeper"));
    }

    #[test]
    fn the_chosen_worktree_beats_where_the_chat_last_edited_and_is_left_once_it_is_gone() {
        let r = repos();
        std::fs::write(r.other.join("b.txt"), "b").unwrap();
        let edit = r.other.join("b.txt");
        assert_eq!(current(&r.main, None, edit.to_str()).unwrap().name, "other");
        let pin = r.wt.clone();
        assert_eq!(current(&r.main, Some(&pin), edit.to_str()).unwrap().name, "wt");
        assert_eq!(current(&r.main, Some(&pin), None).unwrap().name, "wt");
        // Removed: it falls back to the latest edit, and to nothing when there is none.
        git_in(&r.main, &["worktree", "remove", "--force", r.wt.to_str().unwrap()]);
        assert_eq!(current(&r.main, Some(&pin), edit.to_str()).unwrap().name, "other");
        assert_eq!(current(&r.main, Some(&pin), None), None);
    }

    #[test]
    fn enter_worktree_puts_the_chat_in_one_and_no_path_lets_its_edits_decide_again() {
        let r = repos();
        let main = r.main.to_str().unwrap();
        let (pin, view_main) = (Pin::default(), AtomicBool::new(true));
        let said = call(Some(main), &pin, &view_main, &json!({"path": "feat"})).unwrap();
        assert!(said.contains("worktree wt on feat") && said.contains("edit by absolute path"), "{said}");
        assert_eq!(pin.lock().unwrap().as_deref(), Some(r.wt.as_path()));
        assert!(!view_main.load(Ordering::Relaxed), "the user's choice of the folder was kept");
        view_main.store(true, Ordering::Relaxed);
        call(Some(main), &pin, &view_main, &json!({"path": r.other.to_str().unwrap()})).unwrap();
        assert_eq!(pin.lock().unwrap().as_deref(), Some(r.other.as_path()));
        assert!(!view_main.load(Ordering::Relaxed));
        // A refusal leaves the choice as it was.
        for bad in [json!({"path": "nope"}), json!({"path": 3}), json!({"path": r.stranger.to_str().unwrap()})] {
            assert!(call(Some(main), &pin, &view_main, &bad).is_err(), "{bad}");
        }
        assert!(call(None, &pin, &view_main, &json!({"path": "feat"})).is_err());
        assert_eq!(pin.lock().unwrap().as_deref(), Some(r.other.as_path()));
        for none in [json!({}), json!({"path": null})] {
            *pin.lock().unwrap() = Some(r.wt.clone());
            call(Some(main), &pin, &view_main, &none).unwrap();
            assert_eq!(*pin.lock().unwrap(), None);
        }
    }

    #[test]
    fn the_tool_takes_one_optional_path_and_nothing_else() {
        let tools = tool_list();
        assert_eq!((tools.len(), tools[0]["name"].clone(), tools[0]["inputSchema"]["additionalProperties"].clone(), tools[0]["inputSchema"].get("required").cloned()), (1, json!(TOOL), json!(false), None));
    }
}
