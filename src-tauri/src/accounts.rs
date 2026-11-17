//! Claude accounts: a second (third...) sign-in a chat can run on. Claude Code keeps its login, and which account it is, in its
//! config folder (`CLAUDE_CONFIG_DIR`, default `~/.claude`), so an account here is a name and a folder of its own. A chat picks
//! one when it starts and Claude Code is launched with that folder; the window sends the account's id and never a path.
//!
//! A new account's folder starts empty, so it would have no CLAUDE.md, skills, plugins, hooks or history. `create` links the
//! user's own setup into it (see `SHARED`) and leaves the login and `.claude.json` (which say who the account is) separate.
//! Sharing `projects/` is what keeps resume, history, search and Insights reading one place.
//!
//! The folder's name is made from the account's id, which Lantern makes: a label typed by the user is never part of a path.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_ACCOUNTS: usize = 5;

/// What is linked from the user's own Claude folder into a new account's. A list of what to share, not of what to leave out:
/// a file Claude Code adds later (a token, a cache) stays separate until it is chosen here.
pub const SHARED: &[&str] = &["CLAUDE.md", "settings.json", "settings.local.json", "keybindings.json", "skills", "agents", "commands", "hooks", "rules", "output-styles", "plugins", "projects"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    /// Made once, from the first name, and never changed: chats saved against it survive a rename.
    #[serde(default)]
    pub id: String,
    pub name: String,
}

/// The accounts the user has added, kept in the app's data folder, and each one's Claude folder under `root`.
pub struct AccountStore {
    path: Option<PathBuf>,
    root: PathBuf,
    items: Mutex<Vec<Account>>,
}

/// A name as the user wrote it, made safe to show and to keep, or why it can't be.
pub fn clean_name(name: &str) -> Result<String, String> {
    let name: String = name.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string();
    if name.is_empty() || name.chars().count() > 30 {
        return Err("An account needs a name of up to 30 characters.".into());
    }
    Ok(name)
}

/// An id from a name: lower-case letters and digits with '-', made unique among `taken` by a number.
fn make_id(name: &str, taken: &[String]) -> String {
    let slug: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let slug = slug.split('-').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-");
    // Cut to length, then the dash a cut can leave at the end goes too.
    let cut: String = slug.chars().take(24).collect();
    let slug = cut.trim_end_matches('-').to_string();
    let slug = if slug.is_empty() { "account".to_string() } else { slug };
    let mut id = slug.clone();
    let mut n = 2;
    while taken.contains(&id) {
        id = format!("{slug}-{n}");
        n += 1;
    }
    id
}

/// An id as we make them (`make_id` and a number): lower-case letters, digits and '-', so it is never more than a folder's name.
fn valid_id(id: &str) -> bool {
    (1..=32).contains(&id.len()) && !id.starts_with('-') && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

impl AccountStore {
    /// What is saved at `path` (none: a missing or unreadable file is no accounts). An id that isn't one of ours (a file edited by
    /// hand) is left out: it would otherwise be part of a path.
    pub fn load(path: Option<PathBuf>, root: PathBuf) -> AccountStore {
        let items = path
            .as_deref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<Vec<Account>>(&b).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|a| valid_id(&a.id) && clean_name(&a.name).is_ok())
            .collect();
        AccountStore { path, root, items: Mutex::new(items) }
    }

    pub fn list(&self) -> Vec<Account> {
        self.items.lock().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Option<Account> {
        self.items.lock().unwrap().iter().find(|a| a.id == id).cloned()
    }

    /// Where account `id` keeps its Claude folder (whether or not there is such an account).
    pub fn dir_of(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }

    /// The Claude folder of the account `id`, or why there is none. A removed account is an error: a chat never starts on the
    /// default login instead of the account it was given.
    pub fn dir_for(&self, id: &str) -> Result<PathBuf, String> {
        self.get(id).map(|a| self.dir_of(&a.id)).ok_or_else(|| "That Claude account is gone. Pick another in the chat's settings, or add it again in Settings.".to_string())
    }

    /// Adds an account called `name`, with a folder that has the user's setup linked in (`share_from`: their own Claude folder).
    pub fn create(&self, name: &str, share_from: Option<&Path>) -> Result<Account, String> {
        let name = clean_name(name)?;
        let mut items = self.items.lock().unwrap();
        if items.len() >= MAX_ACCOUNTS {
            return Err(format!("Up to {MAX_ACCOUNTS} accounts."));
        }
        if items.iter().any(|a| a.name.eq_ignore_ascii_case(&name)) {
            return Err(format!("There is already an account called {name:?}."));
        }
        let id = make_id(&name, &items.iter().map(|a| a.id.clone()).collect::<Vec<_>>());
        let dir = self.root.join(&id);
        std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make the account's folder: {e}"))?;
        if let Some(from) = share_from {
            share(from, &dir)?;
        }
        let account = Account { id, name };
        let mut next = items.clone();
        next.push(account.clone());
        self.save(&next)?;
        *items = next;
        Ok(account)
    }

    /// Takes account `id` out, and its folder with it: the links in it (never what they point at) and its own files.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut items = self.items.lock().unwrap();
        if !items.iter().any(|a| a.id == id) {
            return Ok(());
        }
        let next: Vec<Account> = items.iter().filter(|a| a.id != id).cloned().collect();
        self.save(&next)?;
        *items = next;
        remove_folder(&self.root.join(id));
        Ok(())
    }

    fn save(&self, accounts: &[Account]) -> Result<(), String> {
        let Some(path) = &self.path else { return Ok(()) };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't save the accounts: {e}"))?;
        }
        let tmp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(accounts).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path)).map_err(|e| format!("Couldn't save the accounts: {e}"))
    }
}

/// Links each of `SHARED` that `from` has into `dir`.
fn share(from: &Path, dir: &Path) -> Result<(), String> {
    for name in SHARED {
        let source = from.join(name);
        let link = dir.join(name);
        if source.symlink_metadata().is_err() || link.symlink_metadata().is_ok() {
            continue;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&source, &link).map_err(|e| format!("Couldn't share {name} with the account: {e}"))?;
    }
    Ok(())
}

/// Deletes an account's folder: its links first, so that what they point at (the user's own setup) is never touched, then the rest.
fn remove_folder(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_symlink()) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lantern-accounts-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_id_is_made_from_the_name_and_never_a_path() {
        assert_eq!(make_id("Work", &[]), "work");
        assert_eq!(make_id("../../etc", &[]), "etc");
        assert_eq!(make_id("Work", &["work".into()]), "work-2");
        assert_eq!(make_id("???", &[]), "account");
    }

    #[test]
    fn an_account_shares_the_users_setup_but_not_their_login() {
        let home = scratch("share-home");
        std::fs::write(home.join("CLAUDE.md"), "rules").unwrap();
        std::fs::write(home.join(".credentials.json"), "secret").unwrap();
        std::fs::write(home.join(".claude.json"), "identity").unwrap();
        std::fs::create_dir_all(home.join("projects")).unwrap();
        let root = scratch("share-root");
        let store = AccountStore::load(None, root.clone());
        let a = store.create("Work", Some(&home)).unwrap();
        let dir = store.dir_of(&a.id);
        assert!(dir.join("CLAUDE.md").symlink_metadata().unwrap().file_type().is_symlink());
        assert!(dir.join("projects").symlink_metadata().unwrap().file_type().is_symlink());
        assert!(dir.join(".credentials.json").symlink_metadata().is_err());
        assert!(dir.join(".claude.json").symlink_metadata().is_err());
        // Removing the account takes the links, not what they point at.
        store.remove(&a.id).unwrap();
        assert!(!dir.exists());
        assert!(home.join("CLAUDE.md").exists() && home.join("projects").exists());
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_gone_account_is_an_error_not_the_default_login() {
        let store = AccountStore::load(None, scratch("gone"));
        assert!(store.dir_for("work").is_err());
        let a = store.create("Work", None).unwrap();
        assert!(store.dir_for(&a.id).is_ok());
        store.remove(&a.id).unwrap();
        assert!(store.dir_for(&a.id).is_err());
    }

    #[test]
    fn names_are_limited_and_unique() {
        let store = AccountStore::load(None, scratch("names"));
        assert!(store.create("  ", None).is_err());
        assert!(store.create(&"x".repeat(31), None).is_err());
        store.create("Work", None).unwrap();
        assert!(store.create("work", None).is_err());
    }

    #[test]
    fn long_and_colliding_names_are_still_there_after_a_restart() {
        let root = scratch("restart");
        let file = root.join("accounts.json");
        let store = AccountStore::load(Some(file.clone()), root.join("dirs"));
        for name in ["My company work account one", "My company work account two", "My company work account three"] {
            store.create(name, None).unwrap();
        }
        let ids: Vec<String> = store.list().into_iter().map(|a| a.id).collect();
        assert_eq!(ids.len(), 3);
        assert!(ids.iter().all(|id| valid_id(id)) && !ids[0].ends_with('-'), "{ids:?}");
        // A fresh store reads the same file, as after a restart.
        let again = AccountStore::load(Some(file), root.join("dirs"));
        assert_eq!(again.list().into_iter().map(|a| a.id).collect::<Vec<_>>(), ids);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn what_is_saved_comes_back_and_a_hand_edited_id_does_not() {
        let root = scratch("saved");
        let file = root.join("accounts.json");
        std::fs::write(&file, r#"[{"id":"work","name":"Work"},{"id":"../evil","name":"Evil"}]"#).unwrap();
        let store = AccountStore::load(Some(file), root.join("dirs"));
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.list()[0].id, "work");
    }
}
