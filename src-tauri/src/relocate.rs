//! Moving a project folder. Claude Code keeps a folder's sessions in a directory named after its path, so when the folder
//! moves its history stays where it was. Lantern remembers where each folder was (its aliases) and lists and reads those
//! sessions from there. Opening one that's only there copies it into the folder's own directory first: a copy, never a
//! move, never over a file. What Claude Code keeps per path (the project's entry in ~/.claude.json, the auto-memory) can be
//! carried over too, as can Lantern's own permission rules. Nothing is deleted.

use crate::history::{self, encode_folder, valid_id, RecentFolder};
use crate::permission::rules::{self, FolderRules, Matcher, Rule};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

/// Which paths a folder was at before: the folder's current path to its aliases, most recent first.
pub type Aliases = BTreeMap<String, Vec<String>>;

/// The registered moves, saved in app data. A file that doesn't parse is moved aside, not overwritten.
pub struct Relocations {
    path: Option<PathBuf>,
    aliases: Mutex<Aliases>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Entry {
    pub folder: String,
    pub aliases: Vec<String>,
}

impl Relocations {
    pub fn load(path: Option<PathBuf>) -> Self {
        let aliases = path.as_deref().map(read_aliases).unwrap_or_default();
        Self { path, aliases: Mutex::new(aliases) }
    }

    pub fn list(&self) -> Vec<Entry> {
        self.aliases.lock().unwrap().iter().map(|(folder, aliases)| Entry { folder: folder.clone(), aliases: aliases.clone() }).collect()
    }

    /// The paths a folder was at before, most recent first (empty for a folder that never moved).
    pub fn aliases_of(&self, folder: &str) -> Vec<String> {
        self.aliases.lock().unwrap().get(folder).cloned().unwrap_or_default()
    }

    /// Records that the folder now at `new` was at `old`, and saves it.
    pub fn register(&self, old: &str, new: &str) {
        let mut aliases = self.aliases.lock().unwrap();
        register(&mut aliases, old, new);
        self.save(&aliases);
    }

    fn save(&self, aliases: &Aliases) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Written beside the file and renamed over it, so a write cut short can't leave a truncated file.
        let tmp = path.with_extension("json.tmp");
        if let Ok(json) = serde_json::to_string_pretty(aliases) {
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }
}

/// The registered moves saved at `path`, sanitised: an alias must be an absolute path, different from its folder and
/// from the other folders, and listed once.
fn read_aliases(path: &Path) -> Aliases {
    let Ok(bytes) = std::fs::read(path) else { return Aliases::new() };
    match serde_json::from_slice::<Aliases>(&bytes) {
        Ok(saved) => {
            let folders: Vec<String> = saved.keys().cloned().collect();
            saved
                .into_iter()
                .filter_map(|(folder, list)| {
                    let mut kept: Vec<String> = Vec::new();
                    for alias in list {
                        if alias != folder && Path::new(&alias).is_absolute() && !folders.contains(&alias) && !kept.contains(&alias) {
                            kept.push(alias);
                        }
                    }
                    (!kept.is_empty()).then_some((folder, kept))
                })
                .collect()
        }
        Err(_) => {
            let _ = std::fs::rename(path, path.with_extension("json.corrupt"));
            Aliases::new()
        }
    }
}

/// Records that the folder now at `new` was at `old`. A folder registered at `old` brings its own history along, so a
/// chain (A to B, then B to C) leaves C with the aliases B and A. `old` stops being an alias of any folder (its history is
/// this folder's now), and `new` stops being one (it's the folder's path again).
pub fn register(aliases: &mut Aliases, old: &str, new: &str) {
    let mut moved = vec![old.to_string()];
    if let Some(earlier) = aliases.remove(old) {
        moved.extend(earlier);
    }
    for list in aliases.values_mut() {
        list.retain(|a| a != old && a != new);
    }
    // Most recent first: the path just left, then what came before it, then what `new` already had.
    let list = aliases.entry(new.to_string()).or_default();
    let mut merged: Vec<String> = Vec::new();
    for alias in moved.into_iter().chain(std::mem::take(list)) {
        if alias != new && !merged.contains(&alias) {
            merged.push(alias);
        }
    }
    *list = merged;
    aliases.retain(|_, list| !list.is_empty());
}

/// The path a folder was at: absolute and plain (no `..`; a trailing slash is dropped). It needn't exist any more.
pub fn plain_path(old: &str) -> Result<String, String> {
    let path = Path::new(old);
    if !path.is_absolute() || path.components().any(|c| !matches!(c, Component::RootDir | Component::Normal(_))) {
        return Err(format!("{old} is not a plain absolute path."));
    }
    Ok(path.components().collect::<PathBuf>().to_string_lossy().into_owned())
}

/// The folder the user picked as the new place: an existing folder, by its real path.
pub fn existing_folder(new: &str) -> Result<String, String> {
    if !Path::new(new).is_absolute() {
        return Err(format!("{new} is not an absolute path."));
    }
    let real = std::fs::canonicalize(new).map_err(|_| format!("{new} doesn't exist."))?;
    if !real.is_dir() {
        return Err(format!("{new} is not a folder."));
    }
    Ok(real.to_string_lossy().into_owned())
}

/// Both paths of a move, checked: `old` plain, `new` an existing folder, and not the same folder.
pub fn validate_pair(old: &str, new: &str) -> Result<(String, String), String> {
    let old = plain_path(old)?;
    let new = existing_folder(new)?;
    if old == new || std::fs::canonicalize(&old).is_ok_and(|real| real.to_string_lossy() == new) {
        return Err("The folder is in the same place: pick where it is now.".into());
    }
    Ok((old, new))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Moved {
    pub old: String,
    /// The one place it probably went: exactly one other recent folder that exists has the same last name.
    pub suggested: Option<String>,
}

/// The recent folders whose path is gone, each with where it probably went. A folder already moved (its old path is an
/// alias) isn't listed.
pub fn moved_candidates(recent: &[RecentFolder], aliases: &[String]) -> Vec<Moved> {
    recent
        .iter()
        .filter(|r| !Path::new(&r.path).is_dir() && !aliases.contains(&r.path))
        .map(|gone| {
            let name = Path::new(&gone.path).file_name();
            let same_name: Vec<&RecentFolder> = recent.iter().filter(|c| c.path != gone.path && Path::new(&c.path).is_dir() && Path::new(&c.path).file_name() == name).collect();
            let suggested = match same_name.as_slice() {
                [only] => Some(only.path.clone()),
                _ => None,
            };
            Moved { old: gone.path.clone(), suggested }
        })
        .collect()
}

/// A place a folder's sessions were started in, for bringing them over.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OldLocation {
    pub path: String,
    pub exists: bool,
    pub sessions: usize,
    pub updated_ms: u64,
    /// A place the folder was already brought over from (one of its aliases): its sessions are in History already.
    pub already: bool,
}

/// Whether two paths are the same folder: equal, or the same real path when both exist (a link to it, say).
pub fn same_place(a: &str, b: &str) -> bool {
    a == b || matches!((std::fs::canonicalize(a), std::fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

/// The last component of a path, lowercased: how folders are matched by name.
fn name_key(path: &str) -> String {
    Path::new(path).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// The places `dest` may have been before: each folder with sessions (see history::session_folders) whose last name is
/// `dest`'s, ignoring case, and each of `dest`'s aliases. `dest` itself is never listed. Newest first.
/// (moved_candidates only suggests a folder with the same last name, so a gone folder it suggests for `dest` is one of
/// these already.)
pub fn old_locations(folders: &[history::FolderSessions], dest: &str, aliases: &[String]) -> Vec<OldLocation> {
    let mut found: Vec<OldLocation> = folders
        .iter()
        .filter(|f| !same_place(&f.path, dest))
        .filter_map(|f| {
            let already = aliases.iter().any(|a| same_place(a, &f.path));
            let named_alike = name_key(&f.path) == name_key(dest);
            (already || named_alike).then(|| OldLocation { path: f.path.clone(), exists: f.exists, sessions: f.sessions, updated_ms: f.updated_ms, already })
        })
        .collect();
    found.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms).then_with(|| a.path.cmp(&b.path)));
    found
}

/// What a move would bring, read without changing anything.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Preview {
    /// Transcripts in the old folder's project directory, and their size (with each session's subagent and tool files).
    pub sessions: usize,
    pub bytes: u64,
    /// Whether ~/.claude.json has a project entry for the old folder.
    pub project_entry: bool,
    pub memory_files: usize,
    pub rules: usize,
    /// Links among the transcripts and memory files, which are skipped rather than copied.
    pub linked: usize,
}

pub fn preview(projects_root: &Path, claude_json: &Path, rules: &FolderRules, old: &str) -> Preview {
    let (sessions, bytes, linked) = match history::project_dir(projects_root, Path::new(old)) {
        Some(dir) => session_files(&dir, old),
        None => (0, 0, 0),
    };
    let (memory, memory_linked) = memory_files(projects_root, old);
    Preview {
        sessions,
        bytes,
        project_entry: project_entry(claude_json, old).is_some(),
        memory_files: memory.len(),
        rules: rules.for_folder(&rules::folder_key(Path::new(old))).len(),
        linked: linked + memory_linked,
    }
}

/// Whether a directory entry is a link (of any kind). Links are never copied.
fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// The sessions of `folder` in a project directory, the bytes they and their `<id>/` directories take, and the links
/// skipped. Sessions are the ones the history lists for the folder (a typed prompt, started in it).
fn session_files(dir: &Path, folder: &str) -> (usize, u64, usize) {
    let (mut sessions, mut bytes) = (0, 0);
    for (started_in, found) in history::user_sessions_in(dir) {
        if started_in == folder {
            sessions += 1;
            bytes += std::fs::metadata(&found.path).map_or(0, |m| m.len());
            bytes += tree_bytes(&found.path.with_extension(""));
        }
    }
    let linked = std::fs::read_dir(dir).map_or(0, |entries| {
        entries.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jsonl") && is_link(p)).count()
    });
    (sessions, bytes, linked)
}

/// The size of everything under `path` (0 if it isn't a real directory). Links aren't followed.
fn tree_bytes(path: &Path) -> u64 {
    if !history::is_real_dir(path) {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries
        .filter_map(Result::ok)
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => tree_bytes(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map_or(0, |m| m.len()),
            _ => 0,
        })
        .sum()
}

/// The project's entry in Claude Code's settings file, if there is one (a missing or broken file has none).
fn project_entry(claude_json: &Path, folder: &str) -> Option<Value> {
    let doc: Value = serde_json::from_slice(&std::fs::read(claude_json).ok()?).ok()?;
    doc.get("projects")?.get(folder).cloned()
}

fn memory_dir(projects_root: &Path, folder: &str) -> PathBuf {
    projects_root.join(encode_folder(Path::new(folder))).join("memory")
}

/// The real files in a folder's auto-memory directory, and how many links there were (skipped).
fn memory_files(projects_root: &Path, folder: &str) -> (Vec<String>, usize) {
    let dir = memory_dir(projects_root, folder);
    if !history::is_real_dir(&dir) {
        return (vec![], 0);
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return (vec![], 0) };
    let (mut files, mut linked) = (Vec::new(), 0);
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if is_link(&path) {
            linked += 1;
        } else if history::is_regular_file(&path) {
            files.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    (files, linked)
}

/// The suffix of the temporary file a copy is made in before it's linked into place.
const COPY_TMP: &str = ".lantern-copy";

/// Copies `src` to `dst` unless `dst` exists. The copy is made beside `dst` and checked by size, then hard-linked into
/// place: a link fails rather than replacing a file, so nothing is overwritten. False when `dst` was already there.
fn copy_new(src: &Path, dst: &Path) -> io::Result<bool> {
    if !history::is_regular_file(src) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "it is not a regular file"));
    }
    let name = dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dst.with_file_name(format!("{name}{COPY_TMP}"));
    // Created new and never followed: a file or link already at that name is an error, and nothing is written through it.
    let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    let copied = std::fs::File::open(src).and_then(|mut from| io::copy(&mut from, &mut out));
    drop(out);
    let linked = copied.and_then(|_| {
        if std::fs::metadata(src)?.len() != std::fs::metadata(&tmp)?.len() {
            return Err(io::Error::other("the copy is not the size of the original"));
        }
        std::fs::hard_link(&tmp, dst)
    });
    let _ = std::fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

/// Copies a directory tree with `copy_new` for each file: what's already there is kept. Links are left out, and so is
/// anything where the copy's directory would be a link (it would lead the copy wherever it points).
fn copy_tree_new(src: &Path, dst: &Path) -> io::Result<()> {
    if std::fs::symlink_metadata(dst).is_ok() && !history::is_real_dir(dst) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "a link is where the copy goes"));
    }
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let (from, to) = (entry.path(), dst.join(entry.file_name()));
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree_new(&from, &to)?;
        } else if kind.is_file() {
            copy_new(&from, &to)?;
        }
    }
    Ok(())
}

/// What `ready_session` found: the transcript to resume, or (when it couldn't be copied) the original to read only.
#[derive(Debug, PartialEq)]
pub enum Ready {
    Resumable(PathBuf),
    ReadOnly { source: PathBuf, reason: String },
}

/// Makes a session resumable in `folder`. When its transcript is only in the directory of a place the folder was before
/// (`aliases`), copies it into the folder's own project directory, with its `<id>/` directory (subagent transcripts, tool
/// results). What's already there is kept, and the original is left as it is. A copy that fails leaves the session
/// readable from where it is, but not resumable.
pub fn ready_session(projects_root: &Path, folder: &Path, aliases: &[PathBuf], id: &str) -> Result<Ready, String> {
    if !valid_id(id) {
        return Err("That is not a session id.".into());
    }
    let own_dir = projects_root.join(encode_folder(folder));
    let own = own_dir.join(format!("{id}.jsonl"));
    if std::fs::symlink_metadata(&own).is_ok() {
        return if history::is_regular_file(&own) { Ok(Ready::Resumable(own)) } else { Err("That session's file in this folder is a link, not a transcript.".into()) };
    }
    let source = history::transcript_path_with_aliases(projects_root, folder, aliases, id)?;
    match copy_session(&source, &own_dir, id) {
        Ok(()) => Ok(Ready::Resumable(own)),
        Err(e) => {
            let reason = format!(
                "Lantern couldn't copy this session into {}, so it's open to read but not resumed ({e}). It's still in {}.",
                folder.display(),
                source.parent().map(|p| p.display().to_string()).unwrap_or_default()
            );
            Ok(Ready::ReadOnly { source, reason })
        }
    }
}

fn copy_session(source: &Path, own_dir: &Path, id: &str) -> io::Result<()> {
    std::fs::create_dir_all(own_dir)?;
    let siblings = source.with_extension("");
    if history::is_real_dir(&siblings) {
        copy_tree_new(&siblings, &own_dir.join(id))?;
    }
    copy_new(source, &own_dir.join(format!("{id}.jsonl")))?;
    Ok(())
}

/// The place a session was started in, when that's one of the folder's aliases: the paths its earlier messages name.
pub fn moved_from(projects_root: &Path, folder: &Path, aliases: &[PathBuf], id: &str) -> Option<String> {
    let path = history::transcript_path_with_aliases(projects_root, folder, aliases, id).ok()?;
    let started = history::started_in(&path)?;
    aliases.iter().any(|a| a.to_string_lossy() == started).then_some(started)
}

/// What the move copied from Claude Code's project entry (`projects[old]` in ~/.claude.json) into `projects[new]`: the
/// keys the new entry doesn't have yet.
pub fn carry_project_entry(claude_json: &Path, old: &str, new: &str) -> Result<Vec<String>, String> {
    carry_project_entry_with(claude_json, old, new, || {})
}

/// `between_read_and_write` runs after the file is read and backed up, before it's checked again: a test can change the
/// file there.
fn carry_project_entry_with(claude_json: &Path, old: &str, new: &str, between_read_and_write: impl FnOnce()) -> Result<Vec<String>, String> {
    let original = match std::fs::read(claude_json) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("Couldn't read {}: {e}", claude_json.display())),
    };
    let mut doc: Value = serde_json::from_slice(&original).map_err(|e| format!("{} isn't valid JSON, so nothing was changed: {e}", claude_json.display()))?;
    let Some(projects) = doc.get_mut("projects").and_then(Value::as_object_mut) else { return Ok(vec![]) };
    let Some(from) = projects.get(old).and_then(Value::as_object).cloned() else { return Ok(vec![]) };
    let Some(to) = projects.entry(new.to_string()).or_insert_with(|| json!({})).as_object_mut() else {
        return Err(format!("The entry for {new} in {} isn't an object, so nothing was changed.", claude_json.display()));
    };
    let mut copied = Vec::new();
    for (key, value) in from {
        if !to.contains_key(&key) {
            to.insert(key.clone(), value);
            copied.push(key);
        }
    }
    if copied.is_empty() {
        return Ok(copied);
    }
    write_claude_json(claude_json, &original, &doc, between_read_and_write)?;
    Ok(copied)
}

/// Writes `bytes` to `path`, made with `mode` from the start rather than changed afterwards: ~/.claude.json can hold
/// secrets (MCP env values), so a copy of it is never readable by others, not even for a moment.
fn write_with_mode(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(mode).open(path)?;
    // A file that was already there keeps its old mode when opened, so the mode is set before anything goes in.
    file.set_permissions(std::fs::Permissions::from_mode(mode))?;
    file.write_all(bytes)
}

/// Backs the file up, then writes `doc` in its place: through a temporary file, with the original's permissions. Nothing is
/// written if the file changed since `original` was read (Claude Code writes it often).
fn write_claude_json(path: &Path, original: &[u8], doc: &Value, between_read_and_write: impl FnOnce()) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| ".claude.json".into());
    let mode = std::fs::metadata(path).map_err(|e| e.to_string())?.permissions().mode() & 0o777;
    let backup = path.with_file_name(format!("{name}.lantern-backup"));
    write_with_mode(&backup, original, mode).map_err(|e| format!("Couldn't back up {} first, so nothing was changed: {e}", path.display()))?;
    between_read_and_write();
    let now = std::fs::read(path).map_err(|e| format!("Couldn't read {} again: {e}", path.display()))?;
    if now != original {
        return Err(format!("{name} changed while Lantern was copying it, so nothing was written. Try again."));
    }
    let mut text = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    text.push('\n');
    let tmp = path.with_file_name(format!("{name}.lantern-tmp"));
    let written = write_with_mode(&tmp, text.as_bytes(), mode).and_then(|()| std::fs::rename(&tmp, path));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Couldn't write {}: {e}. The copy before the change is {}.", path.display(), backup.display()));
    }
    Ok(())
}

/// Copies the auto-memory files of `old` into `new`'s, keeping any file `new` already has. Returns how many were copied.
pub fn carry_memory(projects_root: &Path, old: &str, new: &str) -> Result<usize, String> {
    let (files, _) = memory_files(projects_root, old);
    if files.is_empty() {
        return Ok(0);
    }
    let (from, to) = (memory_dir(projects_root, old), memory_dir(projects_root, new));
    if std::fs::symlink_metadata(&to).is_ok() && !history::is_real_dir(&to) {
        return Err("The new folder's memory directory is a link, so nothing was copied.".into());
    }
    std::fs::create_dir_all(&to).map_err(|e| e.to_string())?;
    let mut copied = 0;
    for name in files {
        if copy_new(&from.join(&name), &to.join(&name)).map_err(|e| format!("Couldn't copy {name}: {e}"))? {
            copied += 1;
        }
    }
    Ok(copied)
}

/// Copies Lantern's "Always allow" rules for `old` to `new`, keeping the ones `new` has. A rule for a folder inside the old
/// one is made for the same place in the new one. Each is checked again as it's made. Returns how many were copied.
pub fn carry_rules(rules: &FolderRules, old: &str, new: &str) -> usize {
    let (old_key, new_key) = (rules::folder_key(Path::new(old)), rules::folder_key(Path::new(new)));
    let mut copied = 0;
    for rule in rules.for_folder(&old_key) {
        let Ok(valid) = rules::validate(&rebase(rule, &old_key, &new_key)) else { continue };
        if !rules.for_folder(&new_key).contains(&valid) {
            rules.add(&new_key, valid);
            copied += 1;
        }
    }
    copied
}

/// A folder rule's path, moved from inside `from` to the same place inside `to`. Any other rule is kept as it is.
fn rebase(rule: Rule, from: &str, to: &str) -> Rule {
    let moved = match &rule.matcher {
        Matcher::Dir { path } => path.strip_prefix(from).filter(|rest| rest.is_empty() || rest.starts_with('/')).map(|rest| format!("{to}{rest}")),
        _ => None,
    };
    match moved {
        Some(path) => Rule { tool: rule.tool, matcher: Matcher::Dir { path } },
        None => rule,
    }
}

/// Which of the optional parts of a move to carry over. The alias always is. `project_settings` covers every kind of
/// permission: Claude Code's entry for the folder and Lantern's own "Always allow" rules, so unchecking it brings none.
#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize)]
pub struct Options {
    #[serde(default)]
    pub project_settings: bool,
    #[serde(default)]
    pub memory: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Outcome {
    pub project_keys: Vec<String>,
    pub memory_files: usize,
    pub rules: usize,
}

/// Moves `old` to `new` (both checked by `validate_pair`): carries over what was chosen, then records the move. If a step
/// fails the move isn't recorded; every step copies without replacing, so trying again is safe.
pub fn relocate(projects_root: &Path, claude_json: &Path, rules: &FolderRules, relocations: &Relocations, old: &str, new: &str, options: Options) -> Result<Outcome, String> {
    let project_keys = if options.project_settings { carry_project_entry(claude_json, old, new)? } else { vec![] };
    let memory_files = if options.memory { carry_memory(projects_root, old, new)? } else { 0 };
    // Allowing things without asking is part of a project's permissions: it follows the same choice.
    let rules = if options.project_settings { carry_rules(rules, old, new) } else { 0 };
    relocations.register(old, new);
    Ok(Outcome { project_keys, memory_files, rules })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::rules::{Matcher, Rule};

    fn map(pairs: &[(&str, &[&str])]) -> Aliases {
        pairs.iter().map(|(k, v)| (k.to_string(), v.iter().map(|s| s.to_string()).collect())).collect()
    }

    #[test]
    fn a_chain_of_moves_leaves_the_newest_folder_with_every_earlier_path() {
        let mut a = Aliases::new();
        register(&mut a, "/w/a", "/w/b");
        assert_eq!(a, map(&[("/w/b", &["/w/a"])]));
        register(&mut a, "/w/b", "/w/c");
        assert_eq!(a, map(&[("/w/c", &["/w/b", "/w/a"])]));
    }

    #[test]
    fn moving_back_makes_the_old_path_current_again() {
        let mut a = map(&[("/w/b", &["/w/a"])]);
        register(&mut a, "/w/b", "/w/a");
        assert_eq!(a, map(&[("/w/a", &["/w/b"])]));
    }

    #[test]
    fn an_alias_is_never_a_current_path_and_never_a_folder_itself() {
        // /w/a was an alias of /w/b; it's a folder again, so it leaves /w/b's list and takes no place in its own.
        let mut a = map(&[("/w/b", &["/w/a", "/w/z"])]);
        register(&mut a, "/w/x", "/w/a");
        assert_eq!(a, map(&[("/w/a", &["/w/x"]), ("/w/b", &["/w/z"])]));
        // A folder moved to where it already was does nothing.
        register(&mut a, "/w/q", "/w/q");
        assert_eq!(a, map(&[("/w/a", &["/w/x"]), ("/w/b", &["/w/z"])]));
    }

    #[test]
    fn a_path_is_listed_once() {
        let mut a = map(&[("/w/c", &["/w/b", "/w/a"])]);
        register(&mut a, "/w/a", "/w/c");
        assert_eq!(a, map(&[("/w/c", &["/w/a", "/w/b"])]));
        register(&mut a, "/w/d", "/w/c");
        assert_eq!(a, map(&[("/w/c", &["/w/d", "/w/a", "/w/b"])]));
    }

    #[test]
    fn the_store_saves_and_loads_its_moves() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub/relocations.json");
        let first = Relocations::load(Some(path.clone()));
        first.register("/w/a", "/w/b");
        first.register("/w/b", "/w/c");
        let again = Relocations::load(Some(path.clone()));
        assert_eq!(again.aliases_of("/w/c"), vec!["/w/b".to_string(), "/w/a".to_string()]);
        assert!(again.aliases_of("/w/b").is_empty());
        assert_eq!(again.list(), vec![Entry { folder: "/w/c".into(), aliases: vec!["/w/b".into(), "/w/a".into()] }]);
        assert!(!dir.path().join("sub/relocations.json.tmp").exists());
    }

    #[test]
    fn a_corrupt_store_is_kept_aside_and_a_hand_edited_one_is_cleaned() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relocations.json");
        std::fs::write(&path, r#"{"/w/c": ["/w/b"#).unwrap();
        assert!(Relocations::load(Some(path.clone())).list().is_empty());
        assert_eq!(std::fs::read_to_string(dir.path().join("relocations.json.corrupt")).unwrap(), r#"{"/w/c": ["/w/b"#);
        std::fs::write(&path, r#"{"/w/c": ["/w/c", "relative", "/w/b", "/w/b"], "/w/b": ["/w/x"]}"#).unwrap();
        // An alias that is itself a folder, a relative one and a duplicate are dropped, so /w/c is left with nothing.
        assert_eq!(Relocations::load(Some(path)).list(), vec![Entry { folder: "/w/b".into(), aliases: vec!["/w/x".into()] }]);
    }

    #[test]
    fn candidates_are_the_gone_folders_with_one_same_named_folder_that_exists() {
        let dir = tempfile::tempdir().unwrap();
        let (gone, other) = (dir.path().join("dev/lantern"), dir.path().join("docs/lantern"));
        let exists = |p: &Path| RecentFolder { path: p.to_string_lossy().into_owned(), updated_ms: 1 };
        std::fs::create_dir_all(dir.path().join("docs/lantern")).unwrap();
        std::fs::create_dir_all(dir.path().join("dev/web")).unwrap();
        // One match: suggested.
        let recent = vec![exists(&gone), exists(&other)];
        assert_eq!(moved_candidates(&recent, &[]), vec![Moved { old: gone.to_string_lossy().into_owned(), suggested: Some(other.to_string_lossy().into_owned()) }]);
        // Two existing folders named the same: no suggestion.
        let second = dir.path().join("elsewhere/lantern");
        std::fs::create_dir_all(&second).unwrap();
        let recent = vec![exists(&gone), exists(&other), exists(&second)];
        assert_eq!(moved_candidates(&recent, &[])[0].suggested, None);
        // None with the same name: no suggestion either. A folder that exists isn't a candidate.
        let recent = vec![exists(&gone), exists(&dir.path().join("dev/web"))];
        assert_eq!(moved_candidates(&recent, &[]).len(), 1);
        assert_eq!(moved_candidates(&recent, &[])[0].suggested, None);
        assert!(moved_candidates(&[exists(&other)], &[]).is_empty());
        // Already moved (its path is an alias): not listed.
        assert!(moved_candidates(&[exists(&gone), exists(&other)], &[gone.to_string_lossy().into_owned()]).is_empty());
    }

    #[test]
    fn paths_are_checked_before_anything_is_recorded() {
        assert_eq!(plain_path("/Users/me/dev/app/").as_deref(), Ok("/Users/me/dev/app"));
        assert!(plain_path("relative/app").is_err());
        assert!(plain_path("/Users/me/../you").is_err());
        let dir = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(dir.path()).unwrap();
        let file = real.join("notes.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(existing_folder(&real.join("missing").to_string_lossy()).is_err());
        assert!(existing_folder(&file.to_string_lossy()).unwrap_err().contains("not a folder"));
        assert!(existing_folder("relative").is_err());
        let old = real.join("old");
        assert_eq!(validate_pair(&old.to_string_lossy(), &real.to_string_lossy()).unwrap().1, real.to_string_lossy());
        assert!(validate_pair(&real.to_string_lossy(), &real.to_string_lossy()).is_err());
    }

    /// A projects root with one session in `folder`'s directory and one in `alias`'s, each recording its folder as cwd.
    fn session(projects: &Path, folder: &Path, id: &str, cwd: &str, text: &str) {
        let dir = projects.join(encode_folder(folder));
        std::fs::create_dir_all(&dir).unwrap();
        let line = json!({"type": "user", "cwd": cwd, "entrypoint": "cli", "message": {"role": "user", "content": text}});
        std::fs::write(dir.join(format!("{id}.jsonl")), line.to_string()).unwrap();
    }

    #[test]
    fn a_moved_session_is_listed_from_the_old_directory_and_resumed_by_copy() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        let (old, new) = (root.path().join("old-app"), root.path().join("new-app"));
        std::fs::create_dir_all(&new).unwrap();
        let (old_s, new_s) = (old.to_string_lossy().into_owned(), new.to_string_lossy().into_owned());
        session(&projects, &new, "aaaa-1", &new_s, "new work");
        session(&projects, &old, "bbbb-2", &old_s, "old work");
        let aliases = vec![old.clone()];
        let listed = history::list_sessions_with_aliases(&projects, &new, &aliases, &Default::default(), &Default::default());
        let ids: Vec<&str> = listed.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids.len(), 2, "{ids:?}");
        assert!(ids.contains(&"bbbb-2"));
        // Without the alias, the old session isn't this folder's.
        assert_eq!(history::list_sessions(&projects, &new, &Default::default(), &Default::default()).len(), 1);

        assert_eq!(moved_from(&projects, &new, &aliases, "bbbb-2"), Some(old_s.clone()));
        assert_eq!(moved_from(&projects, &new, &aliases, "aaaa-1"), None);
        let before = std::fs::read(projects.join(encode_folder(&old)).join("bbbb-2.jsonl")).unwrap();
        let ready = ready_session(&projects, &new, &aliases, "bbbb-2").unwrap();
        let copied = projects.join(encode_folder(&new)).join("bbbb-2.jsonl");
        assert_eq!(ready, Ready::Resumable(copied.clone()));
        assert_eq!(std::fs::read(&copied).unwrap(), before, "the copy is the original, byte for byte");
        assert_eq!(std::fs::read(projects.join(encode_folder(&old)).join("bbbb-2.jsonl")).unwrap(), before, "the original is untouched");
        // Now it's in the folder's own directory, listed once and from there.
        assert_eq!(history::list_sessions_with_aliases(&projects, &new, &aliases, &Default::default(), &Default::default()).len(), 2);
        assert_eq!(ready_session(&projects, &new, &aliases, "bbbb-2").unwrap(), Ready::Resumable(copied));
        assert!(ready_session(&projects, &new, &aliases, "ffff-9").is_err());
        assert!(ready_session(&projects, &new, &aliases, "../x").is_err());
    }

    #[test]
    fn a_file_copy_never_replaces_what_is_there() {
        let dir = tempfile::tempdir().unwrap();
        let (src, dst) = (dir.path().join("src.txt"), dir.path().join("dst.txt"));
        std::fs::write(&src, "original").unwrap();
        std::fs::write(&dst, "kept").unwrap();
        assert!(!copy_new(&src, &dst).unwrap());
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "kept");
        std::fs::remove_file(&dst).unwrap();
        assert!(copy_new(&src, &dst).unwrap());
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "original");
        assert!(!dir.path().join("dst.txt.lantern-copy").exists());
    }

    #[test]
    fn a_copy_takes_the_sibling_directory_and_never_overwrites() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        let (old, new) = (root.path().join("old-app"), root.path().join("new-app"));
        std::fs::create_dir_all(&new).unwrap();
        let old_s = old.to_string_lossy().into_owned();
        session(&projects, &old, "cccc-3", &old_s, "old work");
        let old_dir = projects.join(encode_folder(&old));
        std::fs::create_dir_all(old_dir.join("cccc-3/subagents")).unwrap();
        std::fs::create_dir_all(old_dir.join("cccc-3/tool-results")).unwrap();
        std::fs::write(old_dir.join("cccc-3/subagents/agent-1.jsonl"), "sub").unwrap();
        std::fs::write(old_dir.join("cccc-3/subagents/agent-1.meta.json"), "{}").unwrap();
        std::fs::write(old_dir.join("cccc-3/tool-results/t.txt"), "out").unwrap();
        // The new directory already has a sibling file with other content: it's kept.
        let new_dir = projects.join(encode_folder(&new));
        std::fs::create_dir_all(new_dir.join("cccc-3/subagents")).unwrap();
        std::fs::write(new_dir.join("cccc-3/subagents/agent-1.jsonl"), "mine").unwrap();

        let ready = ready_session(&projects, &new, std::slice::from_ref(&old), "cccc-3").unwrap();
        assert_eq!(ready, Ready::Resumable(new_dir.join("cccc-3.jsonl")));
        assert_eq!(std::fs::read_to_string(new_dir.join("cccc-3/subagents/agent-1.jsonl")).unwrap(), "mine");
        assert_eq!(std::fs::read_to_string(new_dir.join("cccc-3/subagents/agent-1.meta.json")).unwrap(), "{}");
        assert_eq!(std::fs::read_to_string(new_dir.join("cccc-3/tool-results/t.txt")).unwrap(), "out");
        assert!(old_dir.join("cccc-3/subagents/agent-1.jsonl").is_file(), "the original sibling stays");
        // A transcript that already sits in the new directory is kept, not replaced.
        std::fs::write(new_dir.join("dddd-4.jsonl"), "newer").unwrap();
        session(&projects, &old, "dddd-4", &old_s, "old copy");
        assert_eq!(ready_session(&projects, &new, std::slice::from_ref(&old), "dddd-4").unwrap(), Ready::Resumable(new_dir.join("dddd-4.jsonl")));
        assert_eq!(std::fs::read_to_string(new_dir.join("dddd-4.jsonl")).unwrap(), "newer");
        // No temporary files are left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&new_dir).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().contains("lantern-copy")).collect();
        assert!(leftovers.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_copy_that_cannot_be_made_opens_the_session_read_only() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        let (old, new) = (root.path().join("old-app"), root.path().join("new-app"));
        std::fs::create_dir_all(&new).unwrap();
        let old_s = old.to_string_lossy().into_owned();
        session(&projects, &old, "eeee-5", &old_s, "old work");
        let new_dir = projects.join(encode_folder(&new));
        std::fs::create_dir_all(&new_dir).unwrap();
        std::fs::set_permissions(&new_dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let ready = ready_session(&projects, &new, std::slice::from_ref(&old), "eeee-5");
        std::fs::set_permissions(&new_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let Ready::ReadOnly { source, reason } = ready.unwrap() else { panic!("expected read only") };
        assert_eq!(source, projects.join(encode_folder(&old)).join("eeee-5.jsonl"));
        assert!(reason.contains("not resumed"), "{reason}");
        assert!(!new_dir.join("eeee-5.jsonl").exists());
    }

    fn claude_json(dir: &Path, text: &str) -> PathBuf {
        let path = dir.join(".claude.json");
        std::fs::write(&path, text).unwrap();
        path
    }

    #[test]
    fn the_project_entry_is_copied_without_overwriting_and_everything_else_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let text = json!({
            "numStartups": 12,
            "mcpServers": {"global": {"type": "http", "url": "https://g.dev"}},
            "projects": {
                "/w/old": {"allowedTools": ["Bash(npm test)"], "mcpServers": {"linear": {"type": "http", "url": "https://l.dev"}}, "hasTrustDialogAccepted": true},
                "/w/new": {"hasTrustDialogAccepted": false},
                "/w/other": {"allowedTools": []}
            }
        })
        .to_string();
        let path = claude_json(dir.path(), &text);
        let mut copied = carry_project_entry(&path, "/w/old", "/w/new").unwrap();
        copied.sort();
        assert_eq!(copied, vec!["allowedTools", "mcpServers"]);
        let after: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let expected = json!({
            "numStartups": 12,
            "mcpServers": {"global": {"type": "http", "url": "https://g.dev"}},
            "projects": {
                "/w/old": {"allowedTools": ["Bash(npm test)"], "mcpServers": {"linear": {"type": "http", "url": "https://l.dev"}}, "hasTrustDialogAccepted": true},
                "/w/new": {"hasTrustDialogAccepted": false, "allowedTools": ["Bash(npm test)"], "mcpServers": {"linear": {"type": "http", "url": "https://l.dev"}}},
                "/w/other": {"allowedTools": []}
            }
        });
        assert_eq!(after, expected);
        // The backup is the file as it was, and a second copy finds nothing new to take.
        assert_eq!(std::fs::read_to_string(dir.path().join(".claude.json.lantern-backup")).unwrap(), text);
        assert!(carry_project_entry(&path, "/w/old", "/w/new").unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn the_settings_file_keeps_its_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = claude_json(dir.path(), r#"{"projects": {"/w/old": {"allowedTools": []}}}"#);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        carry_project_entry(&path, "/w/old", "/w/new").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn the_backup_is_private_even_when_an_open_old_one_was_not() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = claude_json(dir.path(), r#"{"projects": {"/w/old": {"allowedTools": []}}}"#);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        // A backup left by an earlier run, readable by others: it must not stay that way with the new content in it.
        let backup = dir.path().join(".claude.json.lantern-backup");
        std::fs::write(&backup, "old").unwrap();
        std::fs::set_permissions(&backup, std::fs::Permissions::from_mode(0o644)).unwrap();
        carry_project_entry(&path, "/w/old", "/w/new").unwrap();
        assert_eq!(std::fs::metadata(&backup).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(std::fs::read_to_string(&backup).unwrap().contains("allowedTools"));
        // And no temporary file is left behind.
        assert!(!dir.path().join(".claude.json.lantern-tmp").exists());
    }

    #[test]
    fn nothing_is_written_when_the_file_changed_while_it_was_being_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = claude_json(dir.path(), r#"{"projects": {"/w/old": {"allowedTools": []}}}"#);
        let changed = r#"{"projects": {"/w/old": {"allowedTools": []}, "/w/x": {}}, "startups": 2}"#;
        let err = carry_project_entry_with(&path, "/w/old", "/w/new", || std::fs::write(&path, changed).unwrap()).unwrap_err();
        assert!(err.contains("changed while Lantern was copying it"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), changed, "Claude Code's newer write is kept");
    }

    #[test]
    fn a_file_that_is_missing_has_no_project_or_is_broken_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("none.json");
        assert!(carry_project_entry(&missing, "/w/old", "/w/new").unwrap().is_empty());
        let no_project = claude_json(dir.path(), r#"{"projects": {"/w/x": {}}}"#);
        assert!(carry_project_entry(&no_project, "/w/old", "/w/new").unwrap().is_empty());
        assert!(!dir.path().join(".claude.json.lantern-backup").exists(), "nothing to back up when nothing changes");
        let broken = claude_json(dir.path(), "{not json");
        assert!(carry_project_entry(&broken, "/w/old", "/w/new").unwrap_err().contains("nothing was changed"));
        assert_eq!(std::fs::read_to_string(&broken).unwrap(), "{not json");
    }

    #[test]
    fn memory_is_copied_and_a_file_already_there_is_kept() {
        let root = tempfile::tempdir().unwrap();
        let (old, new) = (root.path().join("old-app"), root.path().join("new-app"));
        let projects = root.path().join("projects");
        let old_mem = memory_dir(&projects, &old.to_string_lossy());
        std::fs::create_dir_all(&old_mem).unwrap();
        std::fs::write(old_mem.join("a.md"), "from old").unwrap();
        std::fs::write(old_mem.join("b.md"), "old b").unwrap();
        let new_mem = memory_dir(&projects, &new.to_string_lossy());
        std::fs::create_dir_all(&new_mem).unwrap();
        std::fs::write(new_mem.join("b.md"), "new b").unwrap();
        assert_eq!(carry_memory(&projects, &old.to_string_lossy(), &new.to_string_lossy()).unwrap(), 1);
        assert_eq!(std::fs::read_to_string(new_mem.join("a.md")).unwrap(), "from old");
        assert_eq!(std::fs::read_to_string(new_mem.join("b.md")).unwrap(), "new b");
        assert_eq!(std::fs::read_to_string(old_mem.join("b.md")).unwrap(), "old b");
        assert_eq!(carry_memory(&projects, "/nowhere", &new.to_string_lossy()).unwrap(), 0);
    }

    #[test]
    fn rules_are_copied_to_the_new_folder_once_and_folder_rules_move_with_it() {
        let root = tempfile::tempdir().unwrap();
        let (old, new) = (root.path().join("old-app"), root.path().join("new-app"));
        std::fs::create_dir_all(old.join("src")).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        let rules = FolderRules::load(None);
        let old_key = rules::folder_key(&old);
        let new_key = rules::folder_key(&new);
        rules.add(&old_key, Rule { tool: "Bash".into(), matcher: Matcher::Exact { text: "npm run build".into() } });
        rules.add(&old_key, Rule { tool: "Edit".into(), matcher: Matcher::Dir { path: format!("{old_key}/src") } });
        assert_eq!(carry_rules(&rules, &old.to_string_lossy(), &new.to_string_lossy()), 2);
        let moved = rules.for_folder(&new_key);
        assert!(moved.contains(&Rule { tool: "Bash".into(), matcher: Matcher::Exact { text: "npm run build".into() } }));
        assert!(moved.contains(&Rule { tool: "Edit".into(), matcher: Matcher::Dir { path: format!("{new_key}/src") } }), "{moved:?}");
        assert_eq!(carry_rules(&rules, &old.to_string_lossy(), &new.to_string_lossy()), 0, "no duplicates");
        assert_eq!(rules.for_folder(&old_key).len(), 2, "the old folder keeps its own");
    }

    #[test]
    fn a_preview_counts_what_a_move_would_bring() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        let old = root.path().join("old-app");
        let old_s = old.to_string_lossy().into_owned();
        let claude = claude_json(root.path(), &json!({"projects": {old_s.clone(): {}}}).to_string());
        session(&projects, &old, "gggg-6", &old_s, "hi");
        std::fs::create_dir_all(projects.join(encode_folder(&old)).join("gggg-6/subagents")).unwrap();
        std::fs::write(projects.join(encode_folder(&old)).join("gggg-6/subagents/a.jsonl"), "12345").unwrap();
        std::fs::create_dir_all(memory_dir(&projects, &old_s)).unwrap();
        std::fs::write(memory_dir(&projects, &old_s).join("m.md"), "m").unwrap();
        let rules = FolderRules::load(None);
        let p = preview(&projects, &claude, &rules, &old_s);
        assert_eq!(p.sessions, 1);
        assert_eq!(p.bytes, std::fs::metadata(projects.join(encode_folder(&old)).join("gggg-6.jsonl")).unwrap().len() + 5);
        assert!(p.project_entry);
        assert_eq!(p.memory_files, 1);
        assert_eq!(p.rules, 0);
        let none = preview(&projects, &root.path().join("missing.json"), &rules, "/nowhere");
        assert_eq!(none, Preview { sessions: 0, bytes: 0, project_entry: false, memory_files: 0, rules: 0, linked: 0 });
    }

    #[test]
    fn a_preview_counts_the_sessions_the_history_lists_for_the_folder() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        let old = root.path().join("old-app");
        let old_s = old.to_string_lossy().into_owned();
        let claude = claude_json(root.path(), "{}");
        session(&projects, &old, "p1", &old_s, "hi");
        // Automation with no typed prompt, in the same directory: not one of the folder's sessions.
        let line = json!({"type": "user", "cwd": old_s, "entrypoint": "cli", "isMeta": true, "message": {"role": "user", "content": "meta"}});
        std::fs::write(projects.join(encode_folder(&old)).join("bot.jsonl"), line.to_string()).unwrap();
        assert_eq!(preview(&projects, &claude, &FolderRules::load(None), &old_s).sessions, 1);
    }

    fn folder_sessions(path: &Path, sessions: usize, updated_ms: u64) -> history::FolderSessions {
        history::FolderSessions { path: path.to_string_lossy().into_owned(), exists: path.is_dir(), sessions, updated_ms }
    }

    #[test]
    fn the_same_named_folder_is_found_in_every_place_it_was_newest_first() {
        // Inside the crate's target dir: a temp dir's path is a scratch place, which the listing leaves out.
        let work = tempfile::tempdir_in(crate::scratch_dir()).unwrap();
        let w = work.path();
        let (dest, old, laptop, upper, unrelated) = (w.join("projects/acme-api"), w.join("old/acme-api"), w.join("laptop/acme-api"), w.join("src/ACME-API"), w.join("src/web"));
        for d in [&dest, &old, &upper, &unrelated] {
            std::fs::create_dir_all(d).unwrap();
        }
        let folders = [folder_sessions(&unrelated, 4, 50), folder_sessions(&upper, 2, 30), folder_sessions(&laptop, 5, 40), folder_sessions(&old, 3, 10), folder_sessions(&dest, 9, 90)];
        let found = old_locations(&folders, &dest.to_string_lossy(), &[]);
        let shape: Vec<(String, bool, usize, bool)> = found.iter().map(|l| (l.path.clone(), l.exists, l.sessions, l.already)).collect();
        assert_eq!(
            shape,
            vec![
                (laptop.to_string_lossy().into_owned(), false, 5, false),
                (upper.to_string_lossy().into_owned(), true, 2, false),
                (old.to_string_lossy().into_owned(), true, 3, false),
            ]
        );
    }

    #[test]
    fn a_place_already_brought_over_is_listed_as_done_even_with_another_name() {
        let w = std::path::PathBuf::from("/Users/me/code");
        let (dest, alias) = (w.join("acme-api"), w.join("acme-old"));
        let found = old_locations(&[folder_sessions(&alias, 4, 20)], &dest.to_string_lossy(), &[alias.to_string_lossy().into_owned()]);
        assert_eq!(found, vec![OldLocation { path: alias.to_string_lossy().into_owned(), exists: false, sessions: 4, updated_ms: 20, already: true }]);
        // Without the alias, the same folder isn't a candidate: its name differs.
        assert!(old_locations(&[folder_sessions(&alias, 4, 20)], &dest.to_string_lossy(), &[]).is_empty());
    }

    #[test]
    fn the_places_are_found_from_real_transcripts_and_a_copy_counts_once() {
        let work = tempfile::tempdir_in(crate::scratch_dir()).unwrap();
        let (w, projects) = (work.path(), work.path().join("projects"));
        let (dest, same_case, gone, alias, web) = (w.join("now/acme-api"), w.join("src/ACME-API"), w.join("laptop/acme-api"), w.join("before/old-name"), w.join("src/web"));
        for d in [&dest, &same_case, &web] {
            std::fs::create_dir_all(d).unwrap();
        }
        let s = |p: &Path| p.to_string_lossy().into_owned();
        session(&projects, &dest, "d1", &s(&dest), "mine");
        session(&projects, &same_case, "u1", &s(&same_case), "one");
        session(&projects, &gone, "g1", &s(&gone), "two");
        session(&projects, &gone, "g2", &s(&gone), "three");
        session(&projects, &alias, "a1", &s(&alias), "four");
        session(&projects, &web, "w1", &s(&web), "five");
        session(&projects, Path::new("/tmp/acme-api"), "t1", "/tmp/acme-api", "probe");
        // Automation with no typed prompt, in the gone folder's directory.
        let bot = json!({"type": "user", "cwd": s(&gone), "entrypoint": "cli", "isMeta": true, "message": {"role": "user", "content": "meta"}});
        std::fs::write(projects.join(encode_folder(&gone)).join("bot.jsonl"), bot.to_string()).unwrap();
        // Copy-on-open: g1 was copied into the destination's directory, keeping its first cwd (the gone folder).
        std::fs::copy(projects.join(encode_folder(&gone)).join("g1.jsonl"), projects.join(encode_folder(&dest)).join("g1.jsonl")).unwrap();

        let folders = history::session_folders(&projects);
        let found = old_locations(&folders, &s(&dest), &[s(&alias)]);
        let mut shape: Vec<(String, bool, usize, bool)> = found.iter().map(|l| (l.path.clone(), l.exists, l.sessions, l.already)).collect();
        shape.sort();
        assert_eq!(
            shape,
            vec![(s(&alias), false, 1, true), (s(&gone), false, 2, false), (s(&same_case), true, 1, false)],
            "the destination, the web folder and the temp folder are left out; the copy of g1 counts once, for the gone folder"
        );
        // The destination's own sessions: its one prompted session, not the copy of g1 that's in its directory.
        assert_eq!(folders.iter().find(|f| f.path == s(&dest)).map(|f| f.sessions), Some(1));
    }

    #[test]
    fn the_destination_is_never_listed_not_even_through_a_link() {
        let work = tempfile::tempdir_in(crate::scratch_dir()).unwrap();
        let (dest, link) = (work.path().join("projects/acme-api"), work.path().join("links/acme-api"));
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&dest, &link).unwrap();
        let found = old_locations(&[folder_sessions(&dest, 9, 90), folder_sessions(&link, 3, 10)], &dest.to_string_lossy(), &[]);
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn a_move_records_the_alias_and_carries_only_what_was_chosen() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        let old = root.path().join("old-app");
        let new = root.path().join("new-app");
        let claude = claude_json(root.path(), &json!({"projects": {old.to_string_lossy(): {"allowedTools": []}}}).to_string());
        std::fs::create_dir_all(&new).unwrap();
        std::fs::create_dir_all(memory_dir(&projects, &old.to_string_lossy())).unwrap();
        std::fs::write(memory_dir(&projects, &old.to_string_lossy()).join("m.md"), "m").unwrap();
        let rules = FolderRules::load(None);
        let relocations = Relocations::load(None);
        let none = relocate(&projects, &claude, &rules, &relocations, &old.to_string_lossy(), &new.to_string_lossy(), Options::default()).unwrap();
        assert_eq!(none, Outcome { project_keys: vec![], memory_files: 0, rules: 0 });
        assert!(!memory_dir(&projects, &new.to_string_lossy()).exists());
        assert_eq!(relocations.aliases_of(&new.to_string_lossy()), vec![old.to_string_lossy().into_owned()]);
        let all = relocate(&projects, &claude, &rules, &relocations, &old.to_string_lossy(), &new.to_string_lossy(), Options { project_settings: true, memory: true }).unwrap();
        assert_eq!(all.project_keys, vec!["allowedTools"]);
        assert_eq!(all.memory_files, 1);
    }

    #[test]
    fn always_allow_rules_follow_the_permissions_choice() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        let (old, new) = (root.path().join("old-app"), root.path().join("new-app"));
        std::fs::create_dir_all(&new).unwrap();
        let claude = claude_json(root.path(), &json!({"projects": {}}).to_string());
        let rules = FolderRules::load(None);
        let (old_key, new_key) = (rules::folder_key(&old), rules::folder_key(&new));
        rules.add(&old_key, Rule { tool: "Bash".into(), matcher: Matcher::Exact { text: "npm run build".into() } });
        let relocations = Relocations::load(None);
        let (old_s, new_s) = (old.to_string_lossy(), new.to_string_lossy());
        // Permissions unchecked: no "Always allow" is brought over, though the move itself is still recorded.
        let without = relocate(&projects, &claude, &rules, &relocations, &old_s, &new_s, Options { project_settings: false, memory: true }).unwrap();
        assert_eq!(without.rules, 0);
        assert!(rules.for_folder(&new_key).is_empty());
        assert_eq!(relocations.aliases_of(&new_s), vec![old_s.clone().into_owned()]);
        // Checked: they come along.
        let with = relocate(&projects, &claude, &rules, &relocations, &old_s, &new_s, Options { project_settings: true, memory: false }).unwrap();
        assert_eq!(with.rules, 1);
        assert_eq!(rules.for_folder(&new_key).len(), 1);
    }

    /// A folder with a secret outside it, and the old folder's transcript directory (`root/projects`).
    #[cfg(unix)]
    fn with_secret() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        let (old, new) = (root.path().join("old-app"), root.path().join("new-app"));
        std::fs::create_dir_all(&new).unwrap();
        std::fs::create_dir_all(&projects).unwrap();
        (root, projects, old, new)
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_sibling_directory_is_not_copied() {
        let (root, projects, old, new) = with_secret();
        let old_s = old.to_string_lossy().into_owned();
        session(&projects, &old, "cafe-7", &old_s, "old work");
        let secrets = root.path().join("home-secrets");
        std::fs::create_dir_all(&secrets).unwrap();
        std::fs::write(secrets.join("token.txt"), "secret").unwrap();
        let old_dir = projects.join(encode_folder(&old));
        std::os::unix::fs::symlink(&secrets, old_dir.join("cafe-7")).unwrap();
        let new_dir = projects.join(encode_folder(&new));
        let ready = ready_session(&projects, &new, std::slice::from_ref(&old), "cafe-7").unwrap();
        assert_eq!(ready, Ready::Resumable(new_dir.join("cafe-7.jsonl")));
        assert!(new_dir.join("cafe-7.jsonl").is_file(), "the transcript itself is still copied");
        assert!(!new_dir.join("cafe-7").exists(), "a linked sibling directory is not copied");
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_transcript_is_not_a_session_of_the_folder() {
        let (root, projects, old, new) = with_secret();
        let real = root.path().join("elsewhere.jsonl");
        std::fs::write(&real, json!({"type": "user", "cwd": old.to_string_lossy(), "entrypoint": "cli", "message": {"role": "user", "content": "x"}}).to_string()).unwrap();
        let old_dir = projects.join(encode_folder(&old));
        std::fs::create_dir_all(&old_dir).unwrap();
        std::os::unix::fs::symlink(&real, old_dir.join("beef-8.jsonl")).unwrap();
        let new_dir = projects.join(encode_folder(&new));
        assert!(ready_session(&projects, &new, std::slice::from_ref(&old), "beef-8").is_err());
        assert!(!new_dir.join("beef-8.jsonl").exists());
        assert!(history::list_sessions_with_aliases(&projects, &new, std::slice::from_ref(&old), &Default::default(), &Default::default()).is_empty());
        // Nor does a link in the folder's own directory count as the session being there.
        std::fs::create_dir_all(&new_dir).unwrap();
        std::os::unix::fs::symlink(&real, new_dir.join("dead-9.jsonl")).unwrap();
        assert!(ready_session(&projects, &new, &[], "dead-9").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_memory_file_is_not_copied_and_the_preview_says_so() {
        let (root, projects, old, new) = with_secret();
        let (old_s, new_s) = (old.to_string_lossy().into_owned(), new.to_string_lossy().into_owned());
        let secret = root.path().join("secret.md");
        std::fs::write(&secret, "secret").unwrap();
        let old_mem = memory_dir(&projects, &old_s);
        std::fs::create_dir_all(&old_mem).unwrap();
        std::fs::write(old_mem.join("m.md"), "m").unwrap();
        std::os::unix::fs::symlink(&secret, old_mem.join("linked.md")).unwrap();
        assert_eq!(carry_memory(&projects, &old_s, &new_s).unwrap(), 1);
        assert!(!memory_dir(&projects, &new_s).join("linked.md").exists());
        let claude = root.path().join("none.json");
        let p = preview(&projects, &claude, &FolderRules::load(None), &old_s);
        assert_eq!((p.memory_files, p.linked), (1, 1));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_planted_at_the_temporary_name_is_not_written_through() {
        let dir = tempfile::tempdir().unwrap();
        let (src, dst, target) = (dir.path().join("src.jsonl"), dir.path().join("dst.jsonl"), dir.path().join("target.txt"));
        std::fs::write(&src, "data").unwrap();
        std::fs::write(&target, "keep").unwrap();
        std::os::unix::fs::symlink(&target, dir.path().join("dst.jsonl.lantern-copy")).unwrap();
        assert!(copy_new(&src, &dst).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
        assert!(!dst.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_where_a_sibling_directory_would_be_copied_is_not_followed() {
        let (root, projects, old, new) = with_secret();
        let old_s = old.to_string_lossy().into_owned();
        session(&projects, &old, "face-10", &old_s, "old work");
        let old_dir = projects.join(encode_folder(&old));
        std::fs::create_dir_all(old_dir.join("face-10/subagents")).unwrap();
        std::fs::write(old_dir.join("face-10/subagents/a.jsonl"), "sub").unwrap();
        // The new directory's sibling is a link to somewhere else: nothing may be written through it.
        let elsewhere = root.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let new_dir = projects.join(encode_folder(&new));
        std::fs::create_dir_all(&new_dir).unwrap();
        std::os::unix::fs::symlink(&elsewhere, new_dir.join("face-10")).unwrap();
        let ready = ready_session(&projects, &new, std::slice::from_ref(&old), "face-10").unwrap();
        assert!(matches!(ready, Ready::ReadOnly { .. }), "{ready:?}");
        assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none(), "nothing was written through the link");
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_entry_in_a_sibling_tree_is_left_out() {
        let dir = tempfile::tempdir().unwrap();
        let (tree, out, secret) = (dir.path().join("tree"), dir.path().join("out"), dir.path().join("secret.txt"));
        std::fs::create_dir_all(tree.join("sub")).unwrap();
        std::fs::write(tree.join("a.txt"), "a").unwrap();
        std::fs::write(&secret, "secret").unwrap();
        std::os::unix::fs::symlink(&secret, tree.join("sub").join("link.txt")).unwrap();
        std::os::unix::fs::symlink(dir.path(), tree.join("linkdir")).unwrap();
        copy_tree_new(&tree, &out).unwrap();
        assert_eq!(std::fs::read_to_string(out.join("a.txt")).unwrap(), "a");
        assert!(!out.join("sub").join("link.txt").exists());
        assert!(!out.join("linkdir").exists());
    }

    #[test]
    fn a_failed_step_records_nothing() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        let claude = claude_json(root.path(), "{broken");
        let relocations = Relocations::load(None);
        let rules = FolderRules::load(None);
        let err = relocate(&projects, &claude, &rules, &relocations, "/w/old", root.path().to_str().unwrap(), Options { project_settings: true, memory: false });
        assert!(err.is_err());
        assert!(relocations.list().is_empty());
    }
}
