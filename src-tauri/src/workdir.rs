//! The linked worktree a chat is working in when Claude entered one itself (`EnterWorktree`, or a `git worktree add`
//! it then worked inside): the chat stays open on its project's folder, but its changes are in the worktree.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

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
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Some(WorkFolder { path: path.to_string_lossy().into_owned(), name, branch })
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
}
