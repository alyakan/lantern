//! Deleting. The only way anything is removed, and only the Storage tab's Delete reaches it, with an id from this app's own
//! last scan: no path from the webview or from Claude is ever used. Each item is checked again here, at the moment of the
//! delete, whatever the scan said: it may have changed, or been swapped for a link, since.

use super::scan::{self, Env};
use super::{is_protected, run_program, Item, Kind, Removal, Risk};
use crate::git;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

#[derive(Clone, Debug, Serialize)]
pub struct Outcome {
    pub id: String,
    pub name: String,
    pub ok: bool,
    /// What it took on disk when it was scanned; 0 when it was already gone.
    pub freed: u64,
    pub error: Option<String>,
}

pub fn remove(env: &Env, item: &Item) -> Outcome {
    let result = try_remove(env, item);
    Outcome { id: item.id.clone(), name: item.name.clone(), ok: result.is_ok(), freed: result.as_ref().copied().unwrap_or(0), error: result.err() }
}

fn try_remove(env: &Env, item: &Item) -> Result<u64, String> {
    if item.risk == Risk::Blocked {
        return Err(item.warning.clone().unwrap_or_else(|| "It has work in it that exists nowhere else.".into()));
    }
    match item.removal {
        Removal::Permanent | Removal::Trash => {
            let path = Path::new(&item.path);
            // What an earlier delete in this batch took along (a build folder inside a worktree) is already gone.
            if std::fs::symlink_metadata(path).is_err() {
                return Ok(0);
            }
            let canon = guard(env, item.kind, path)?;
            if item.kind == Kind::Repo {
                if let Some(why) = scan::repo_blockers(&canon, env) {
                    return Err(why);
                }
            }
            if item.removal == Removal::Trash {
                crate::trash::move_to_trash(&canon)?;
            } else if std::fs::symlink_metadata(&canon).is_ok_and(|m| m.is_dir()) {
                std::fs::remove_dir_all(&canon).map_err(|e| format!("Could not delete {}: {e}", item.name))?;
            } else {
                std::fs::remove_file(&canon).map_err(|e| format!("Could not delete {}: {e}", item.name))?;
            }
            Ok(item.bytes)
        }
        Removal::Worktree => remove_worktree(env, item),
        Removal::SimulatorDevice => {
            let udid = item.handle.as_deref().filter(|h| scan::uuid_ok(h)).ok_or("That isn't a simulator.")?;
            run_program("/usr/bin/xcrun", &["simctl", "delete", udid], Duration::from_secs(120))?;
            Ok(item.bytes)
        }
        Removal::SimulatorRuntime => {
            let id = item.handle.as_deref().filter(|h| scan::uuid_ok(h)).ok_or("That isn't a simulator runtime.")?;
            run_program("/usr/bin/xcrun", &["simctl", "runtime", "delete", id], Duration::from_secs(600))?;
            Ok(item.bytes)
        }
    }
}

/// Where each kind of item may be: the folders a scan looks in, so nothing else is ever removed under that kind's name.
fn shape_ok(home: &Path, kind: Kind, canon: &Path) -> bool {
    let inside = |dir: &str| canon.starts_with(home.join(dir)) && canon != home.join(dir);
    match kind {
        Kind::BuildOutput => canon.file_name().and_then(|n| n.to_str()).is_some_and(|n| scan::BUILD_DIRS.contains(&n)),
        Kind::Cache => scan::known_cache_paths(home).iter().any(|p| canon == p.as_path()) || inside("Library/Caches") || inside("Library/Logs") || inside("Library/Developer/Xcode/DerivedData"),
        Kind::Download => inside("Downloads"),
        Kind::Trash => inside(".Trash"),
        Kind::Repo => canon.join(".git").is_dir(),
        Kind::Worktree | Kind::Simulator => false,
    }
}

/// The real path of `path` if it is safe to remove: a real folder or file (not a link, nor reached through one) strictly
/// inside the home folder, outside what is protected, and of the shape its kind has.
fn guard(env: &Env, kind: Kind, path: &Path) -> Result<PathBuf, String> {
    let home = std::fs::canonicalize(&env.home).map_err(|e| e.to_string())?;
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("It is a link now: Lantern won't delete through a link.".into());
    }
    let canon = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let rel = path.strip_prefix(&env.home).map_err(|_| "It isn't inside your home folder.")?;
    if canon != home.join(rel) {
        return Err("It is reached through a link now: Lantern won't delete through a link.".into());
    }
    if canon == home || !canon.starts_with(&home) {
        return Err("It isn't inside your home folder.".into());
    }
    if is_protected(&home, &canon) {
        return Err("It is in a folder Lantern never deletes from (Documents, Desktop, iCloud and the like).".into());
    }
    if !shape_ok(&home, kind, &canon) {
        return Err("It isn't where a scan finds this kind of thing.".into());
    }
    Ok(canon)
}

fn remove_worktree(env: &Env, item: &Item) -> Result<u64, String> {
    let repo = item.repo.as_deref().ok_or("It has no repository.")?;
    let home = std::fs::canonicalize(&env.home).map_err(|e| e.to_string())?;
    let repo = std::fs::canonicalize(repo).map_err(|_| "Its repository is gone.")?;
    if !repo.starts_with(&home) || repo == home || is_protected(&home, &repo) || !repo.join(".git").is_dir() {
        return Err("Its repository isn't a project of yours that Lantern may touch.".into());
    }
    let path = Path::new(&item.path);
    let Ok(canon) = std::fs::canonicalize(path) else { return Ok(0) };
    if canon != path || std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("It is a link now: Lantern won't delete through a link.".into());
    }
    // Never a folder that holds the home folder or the repository itself.
    if home.starts_with(&canon) || repo.starts_with(&canon) {
        return Err("That folder holds more than a worktree.".into());
    }
    // git still lists it as a linked worktree of this repository (never the main one), and it still checks out.
    let listed = scan::worktrees(&repo, env);
    let wt = listed.iter().skip(1).find(|w| std::fs::canonicalize(&w.path).ok().as_deref() == Some(&canon)).ok_or("git doesn't list it as a worktree of that repository any more.")?;
    // Assessed again, now: what was clean may not be.
    let fresh = scan::worktree_item(&repo, wt, env, &AtomicBool::new(false)).ok_or("git can't vouch for it any more.")?;
    if fresh.risk == Risk::Blocked {
        return Err(fresh.warning.unwrap_or_else(|| "It has work in it that exists nowhere else.".into()));
    }
    // Not forced: git itself refuses a worktree with loose changes or a lock.
    git::run(&repo, &["worktree", "remove", "--", &item.path], env.path_env.as_deref())?;
    Ok(item.bytes)
}

#[cfg(test)]
mod tests {
    use super::super::scan::tests::{git, world};
    use super::super::{now_secs, Item};
    use super::*;

    fn env_of(home: &Path) -> Env {
        Env { home: std::fs::canonicalize(home).unwrap(), path_env: None, now: now_secs(), in_use: vec![] }
    }

    fn item(kind: Kind, removal: Removal, path: &Path) -> Item {
        Item::new(kind, path, "x".into(), 4096, removal, "")
    }

    #[test]
    fn build_output_is_deleted_for_good_and_gone_is_not_an_error() {
        let home = tempfile::tempdir().unwrap();
        let env = env_of(home.path());
        let nm = env.home.join("dev/web/node_modules");
        std::fs::create_dir_all(nm.join("pkg")).unwrap();
        std::fs::write(nm.join("pkg/index.js"), "x").unwrap();
        let it = item(Kind::BuildOutput, Removal::Permanent, &nm);
        assert!(remove(&env, &it).ok);
        assert!(!nm.exists());
        let again = remove(&env, &it);
        assert!(again.ok && again.freed == 0);
    }

    #[test]
    fn nothing_outside_its_kind_or_in_a_protected_place_is_deleted() {
        let home = tempfile::tempdir().unwrap();
        let env = env_of(home.path());
        let docs = env.home.join("Documents/proj/node_modules");
        let other = env.home.join("dev/important");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        // Protected, even with the right name; and a folder that isn't build output, even claimed as such.
        assert!(remove(&env, &item(Kind::BuildOutput, Removal::Permanent, &docs)).error.unwrap().contains("never deletes"));
        assert!(remove(&env, &item(Kind::BuildOutput, Removal::Permanent, &other)).error.unwrap().contains("where a scan finds"));
        assert!(remove(&env, &item(Kind::Cache, Removal::Permanent, &other)).error.unwrap().contains("where a scan finds"));
        // The home folder itself, and a path outside it.
        assert!(remove(&env, &item(Kind::Cache, Removal::Permanent, &env.home)).error.is_some());
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("node_modules")).unwrap();
        assert!(remove(&env, &item(Kind::BuildOutput, Removal::Permanent, &outside.path().join("node_modules"))).error.is_some());
        assert!(other.exists() && docs.exists() && outside.path().join("node_modules").exists());
    }

    #[test]
    fn a_link_swapped_in_after_the_scan_is_not_followed() {
        let home = tempfile::tempdir().unwrap();
        let env = env_of(home.path());
        let precious = env.home.join("dev/precious");
        std::fs::create_dir_all(&precious).unwrap();
        std::fs::write(precious.join("file"), "keep").unwrap();
        std::fs::create_dir_all(env.home.join("dev/web")).unwrap();
        let nm = env.home.join("dev/web/node_modules");
        std::os::unix::fs::symlink(&precious, &nm).unwrap();
        assert!(remove(&env, &item(Kind::BuildOutput, Removal::Permanent, &nm)).error.unwrap().contains("link"));
        // Or a parent that became a link.
        let real = env.home.join("dev/real/node_modules");
        std::fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(env.home.join("dev/real"), env.home.join("dev/alias")).unwrap();
        assert!(remove(&env, &item(Kind::BuildOutput, Removal::Permanent, &env.home.join("dev/alias/node_modules"))).error.unwrap().contains("link"));
        assert!(precious.join("file").exists() && real.exists());
    }

    #[test]
    fn a_blocked_item_is_refused_whatever_the_caller_says() {
        let home = tempfile::tempdir().unwrap();
        let env = env_of(home.path());
        let nm = env.home.join("dev/web/node_modules");
        std::fs::create_dir_all(&nm).unwrap();
        let mut it = item(Kind::BuildOutput, Removal::Permanent, &nm);
        it.risk = Risk::Blocked;
        it.warning = Some("unsaved".into());
        assert_eq!(remove(&env, &it).error.as_deref(), Some("unsaved"));
        assert!(nm.exists());
    }

    #[test]
    fn a_worktree_is_removed_through_git_and_its_branch_stays() {
        let w = world();
        let path = w.env.home.join("wt/done");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        git(&w.repo, &["worktree", "add", "-b", "feat/done", path.to_str().unwrap()]);
        let path = std::fs::canonicalize(&path).unwrap();
        let wt = scan::worktrees(&w.repo, &w.env).into_iter().find(|t| std::fs::canonicalize(&t.path).ok().as_deref() == Some(&path)).unwrap();
        let mut it = scan::worktree_item(&w.repo, &wt, &w.env, &AtomicBool::new(false)).unwrap();
        it.risk = Risk::Safe;
        let out = remove(&w.env, &it);
        assert!(out.ok, "{:?}", out.error);
        assert!(!path.exists());
        assert!(git(&w.repo, &["branch", "--list", "feat/done"]).contains("feat/done"));
        assert_eq!(scan::worktrees(&w.repo, &w.env).len(), 1);
    }

    #[test]
    fn a_worktree_that_got_unsaved_work_after_the_scan_is_not_removed() {
        let w = world();
        let path = w.env.home.join("wt/busy");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        git(&w.repo, &["worktree", "add", "-b", "feat/busy", path.to_str().unwrap()]);
        let path = std::fs::canonicalize(&path).unwrap();
        let wt = scan::worktrees(&w.repo, &w.env).into_iter().find(|t| std::fs::canonicalize(&t.path).ok().as_deref() == Some(&path)).unwrap();
        let mut it = scan::worktree_item(&w.repo, &wt, &w.env, &AtomicBool::new(false)).unwrap();
        it.risk = Risk::Safe;
        // The scan said safe; then the user (or an agent) changed something.
        std::fs::write(path.join("unsaved.txt"), "mine").unwrap();
        let out = remove(&w.env, &it);
        assert!(!out.ok && out.error.unwrap().contains("uncommitted"));
        assert!(path.join("unsaved.txt").exists());
    }

    #[test]
    fn a_worktree_a_chat_started_in_after_the_scan_is_not_removed_from_under_it() {
        let w = world();
        let path = w.env.home.join("wt/live");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        git(&w.repo, &["worktree", "add", "-b", "feat/live", path.to_str().unwrap()]);
        let path = std::fs::canonicalize(&path).unwrap();
        let wt = scan::worktrees(&w.repo, &w.env).into_iter().find(|t| std::fs::canonicalize(&t.path).ok().as_deref() == Some(&path)).unwrap();
        let mut it = scan::worktree_item(&w.repo, &wt, &w.env, &AtomicBool::new(false)).unwrap();
        it.risk = Risk::Safe;
        let busy = Env { home: w.env.home.clone(), path_env: None, now: w.env.now, in_use: vec![path.clone()] };
        let out = remove(&busy, &it);
        assert!(!out.ok && out.error.unwrap().contains("working in it"));
        assert!(path.exists());
    }

    #[test]
    fn a_worktree_claimed_for_a_folder_git_doesnt_list_is_refused() {
        let w = world();
        let stranger = w.env.home.join("dev/stranger");
        std::fs::create_dir_all(&stranger).unwrap();
        std::fs::write(stranger.join("keep.txt"), "x").unwrap();
        let mut it = item(Kind::Worktree, Removal::Worktree, &std::fs::canonicalize(&stranger).unwrap());
        it.repo = Some(w.repo.clone());
        let out = remove(&w.env, &it);
        assert!(!out.ok && out.error.unwrap().contains("doesn't list it"));
        // And one that holds the repository.
        let mut holds = item(Kind::Worktree, Removal::Worktree, &w.env.home);
        holds.repo = Some(w.repo.clone());
        assert!(remove(&w.env, &holds).error.unwrap().contains("holds more"));
        assert!(stranger.join("keep.txt").exists());
    }

    #[test]
    fn a_stale_project_goes_to_the_trash_only_while_everything_in_it_is_saved() {
        let w = world();
        std::fs::write(w.repo.join("loose.txt"), "unsaved").unwrap();
        let mut it = item(Kind::Repo, Removal::Trash, &w.repo);
        it.risk = Risk::Safe;
        let out = remove(&w.env, &it);
        assert!(!out.ok && out.error.unwrap().contains("uncommitted"));
        assert!(w.repo.exists());
    }
}
