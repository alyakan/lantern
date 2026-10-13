//! The skills, custom slash commands and agents on disk, so the app can tell them apart in claude's command list (which
//! names skills and commands alike) and show where each comes from: yours (~/.claude), the project's (.claude in the
//! folder), a plugin's, or claude.ai's synced skills. Claude decides what's loaded; this only says what each name is.

use crate::files;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Entry {
    /// As claude lists it: "grill-me", "frontend:review", "superpowers:brainstorming".
    pub name: String,
    /// "skill", "command" or "agent".
    pub kind: &'static str,
    /// "user", "project", "plugin" or "synced" (claude.ai's skills, in ~/.claude/skills/synced).
    pub source: &'static str,
    pub plugin: Option<String>,
    pub path: String,
    pub description: String,
    /// The plugin is turned off in settings, so claude doesn't load it.
    pub disabled: bool,
}

/// Claude Code's own folder (it honours CLAUDE_CONFIG_DIR).
pub fn config_dir() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) => Some(PathBuf::from(dir)),
        None => std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude")),
    }
}

/// A markdown file's frontmatter field (`name: …` between the leading `---` lines). A YAML block scalar (`>` or `|`,
/// with chomping or indentation marks) is the indented lines under the key.
fn front(text: &str, key: &str) -> Option<String> {
    let rest = text.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let lines: Vec<&str> = rest[..end].lines().collect();
    let at = lines.iter().position(|l| l.strip_prefix(key).and_then(|l| l.strip_prefix(':')).is_some())?;
    let value = lines[at].strip_prefix(key)?.strip_prefix(':')?.trim();
    let block = value.chars().next().filter(|c| matches!(*c, '>' | '|')).filter(|_| value[1..].chars().all(|c| matches!(c, '+' | '-') || c.is_ascii_digit()));
    if let Some(style) = block {
        let body: Vec<&str> = lines[at + 1..].iter().take_while(|l| l.trim().is_empty() || l.starts_with(' ')).copied().collect();
        return Some(block_scalar(style, &body));
    }
    Some(unquote(value))
}

/// A plain or quoted YAML scalar's text: "…" and '…' go, with the escapes they carry (\" and \\ in double quotes, '' in
/// single quotes), so a description written by `skill_create` reads back as it was typed.
fn unquote(value: &str) -> String {
    if value.len() >= 2 {
        if let Some(inner) = value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')) {
            return inner.replace("''", "'");
        }
    }
    let Some(inner) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')).filter(|_| value.len() >= 2) else {
        return value.to_string();
    };
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some(n @ ('"' | '\\')) => out.push(n),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// The text of a block scalar: folded (`>`) joins each paragraph's lines with spaces and keeps the blank lines between
/// paragraphs; literal (`|`) keeps the lines. The common indentation goes; chomping only changes trailing newlines,
/// which are trimmed.
fn block_scalar(style: char, lines: &[&str]) -> String {
    let indent = lines.iter().filter(|l| !l.trim().is_empty()).map(|l| l.len() - l.trim_start_matches(' ').len()).min().unwrap_or(0);
    let lines: Vec<&str> = lines.iter().map(|&l| if l.trim().is_empty() { "" } else { &l[indent..] }).collect();
    let text = if style == '|' {
        lines.join("\n")
    } else {
        lines.split(|l| l.is_empty()).map(|para| para.join(" ")).filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n")
    };
    text.trim().to_string()
}

fn head(path: &Path) -> String {
    use std::io::Read;
    let mut buf = Vec::new();
    if let Ok(f) = std::fs::File::open(path) {
        let _ = f.take(8192).read_to_end(&mut buf);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// The folders directly inside `dir` whose names don't start with a dot (synced folders keep hidden buckets beside
/// the real ones), sorted so the same name always resolves the same way.
fn visible_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(read) = std::fs::read_dir(dir) else { return vec![] };
    let mut dirs: Vec<PathBuf> = read.flatten().map(|e| e.path()).filter(|p| p.is_dir() && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))).collect();
    dirs.sort();
    dirs
}

/// Whether two paths are the same folder, through symlinks too (a project may be opened by its link).
fn same_dir(a: &Path, b: &Path) -> bool {
    a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

/// A plugin's name from its .claude-plugin/plugin.json, if it has one.
fn manifest_name(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(".claude-plugin/plugin.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v["name"].as_str().filter(|n| !n.is_empty()).map(String::from)
}

/// Skills in `dir`: each folder with a SKILL.md, named by its frontmatter or else the folder. A folder that is itself a
/// plugin (made with `claude plugin init`) is a plugin, not a skill.
fn skills_in(dir: &Path, prefix: &str, source: &'static str, plugin: Option<&str>, out: &mut Vec<Entry>) {
    for folder in visible_dirs(dir) {
        let file = folder.join("SKILL.md");
        if !file.is_file() || folder.join(".claude-plugin").is_dir() {
            continue;
        }
        let text = head(&file);
        let fallback = folder.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let name = front(&text, "name").filter(|n| !n.is_empty()).unwrap_or(fallback);
        out.push(Entry { name: format!("{prefix}{name}"), kind: "skill", source, plugin: plugin.map(String::from), path: file.display().to_string(), description: front(&text, "description").unwrap_or_default(), disabled: false });
    }
}

/// Commands in `dir`: each .md file, with subfolders as "sub:name", as Claude Code names them.
fn commands_in(dir: &Path, prefix: &str, source: &'static str, plugin: Option<&str>, out: &mut Vec<Entry>) {
    fn walk(dir: &Path, at: &str, prefix: &str, source: &'static str, plugin: Option<&str>, out: &mut Vec<Entry>, depth: usize) {
        let Ok(read) = std::fs::read_dir(dir) else { return };
        for e in read.flatten() {
            let path = e.path();
            let file = e.file_name().to_string_lossy().into_owned();
            if path.is_dir() && depth < 3 {
                walk(&path, &format!("{at}{file}:"), prefix, source, plugin, out, depth + 1);
            } else if let Some(stem) = file.strip_suffix(".md") {
                out.push(Entry { name: format!("{prefix}{at}{stem}"), kind: "command", source, plugin: plugin.map(String::from), path: path.display().to_string(), description: front(&head(&path), "description").unwrap_or_default(), disabled: false });
            }
        }
    }
    walk(dir, "", prefix, source, plugin, out, 0);
}

/// Agents in `dir`: each .md file, subfolders included, named by its frontmatter or else the file.
fn agents_in(dir: &Path, prefix: &str, source: &'static str, plugin: Option<&str>, out: &mut Vec<Entry>) {
    fn walk(dir: &Path, prefix: &str, source: &'static str, plugin: Option<&str>, out: &mut Vec<Entry>, depth: usize) {
        let Ok(read) = std::fs::read_dir(dir) else { return };
        for e in read.flatten() {
            let path = e.path();
            if path.is_dir() && depth < 3 {
                walk(&path, prefix, source, plugin, out, depth + 1);
            } else if path.extension().is_some_and(|x| x == "md") {
                let text = head(&path);
                let stem = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
                let name = front(&text, "name").filter(|n| !n.is_empty()).unwrap_or(stem);
                out.push(Entry { name: format!("{prefix}{name}"), kind: "agent", source, plugin: plugin.map(String::from), path: path.display().to_string(), description: front(&text, "description").unwrap_or_default(), disabled: false });
            }
        }
    }
    walk(dir, prefix, source, plugin, out, 0);
}

/// A plugin claude loads for a folder: its name, its folder, and whether it's turned on.
struct Plugin {
    name: String,
    dir: PathBuf,
    enabled: bool,
}

/// Whether claude has a plugin turned on: the last `enabledPlugins` setting for it, from the user's settings, then the
/// folder's shared settings and then its local ones. None when no settings mention it.
fn enabled_in(config: &Path, folder: Option<&Path>, id: &str) -> Option<bool> {
    let mut files = vec![config.join("settings.json")];
    if let Some(f) = folder {
        files.push(f.join(".claude/settings.json"));
        files.push(f.join(".claude/settings.local.json"));
    }
    files.iter().filter_map(|p| std::fs::read_to_string(p).ok()).filter_map(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).filter_map(|v| v["enabledPlugins"][id].as_bool()).next_back()
}

/// The plugins claude loads for `folder`: installed ones (the user's, and those installed for this folder), the ones
/// claude.ai synced, and skills-dir plugins made in ~/.claude/skills. An installed plugin is on only if settings turn it
/// on; a synced one and a skills-dir one are on unless settings turn them off.
fn plugins(config: &Path, folder: Option<&Path>) -> Vec<Plugin> {
    let mut out: Vec<Plugin> = vec![];
    let installed = std::fs::read_to_string(config.join("plugins/installed_plugins.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    for (id, installs) in installed.as_ref().and_then(|v| v["plugins"].as_object()).into_iter().flatten() {
        let name = id.split('@').next().unwrap_or(id).to_string();
        let enabled = enabled_in(config, folder, id).unwrap_or(false);
        for i in installs.as_array().into_iter().flatten() {
            // A user's plugin is everywhere; a project's (local or project scope) only in the folder it was installed for.
            let here = match i["scope"].as_str() {
                Some("user") => true,
                Some("local" | "project") => folder.is_some_and(|f| i["projectPath"].as_str().is_some_and(|p| same_dir(Path::new(p), f))),
                _ => false,
            };
            if let Some(dir) = i["installPath"].as_str().map(PathBuf::from).filter(|_| here) {
                out.push(Plugin { name: name.clone(), dir, enabled });
            }
        }
    }
    for bucket in visible_dirs(&config.join("plugins/synced")) {
        for dir in visible_dirs(&bucket) {
            if !dir.join(".claude-plugin/plugin.json").is_file() {
                continue;
            }
            let name = manifest_name(&dir).unwrap_or_else(|| dir.file_name().unwrap_or_default().to_string_lossy().into_owned());
            let enabled = enabled_in(config, folder, &format!("{name}@synced")).unwrap_or(true);
            out.push(Plugin { name, dir, enabled });
        }
    }
    for dir in visible_dirs(&config.join("skills")) {
        if let Some(name) = manifest_name(&dir) {
            let enabled = enabled_in(config, folder, &format!("{name}@skills-dir")).unwrap_or(true);
            out.push(Plugin { name, dir, enabled });
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(p.dir.clone()));
    out
}

/// Every skill, command and agent found for `folder`: yours, the project's, claude.ai's synced skills, then plugins'. A
/// name found twice keeps the first; skills and commands share one namespace, agents have their own.
pub fn index(config: &Path, folder: Option<&Path>) -> Vec<Entry> {
    let mut out = vec![];
    skills_in(&config.join("skills"), "", "user", None, &mut out);
    commands_in(&config.join("commands"), "", "user", None, &mut out);
    agents_in(&config.join("agents"), "", "user", None, &mut out);
    for bucket in visible_dirs(&config.join("skills/synced")) {
        skills_in(&bucket, "anthropic-skills:", "synced", None, &mut out);
    }
    if let Some(f) = folder {
        skills_in(&f.join(".claude/skills"), "", "project", None, &mut out);
        commands_in(&f.join(".claude/commands"), "", "project", None, &mut out);
        agents_in(&f.join(".claude/agents"), "", "project", None, &mut out);
    }
    for p in plugins(config, folder) {
        let prefix = format!("{}:", p.name);
        let from = out.len();
        skills_in(&p.dir.join("skills"), &prefix, "plugin", Some(&p.name), &mut out);
        commands_in(&p.dir.join("commands"), &prefix, "plugin", Some(&p.name), &mut out);
        agents_in(&p.dir.join("agents"), &prefix, "plugin", Some(&p.name), &mut out);
        for e in &mut out[from..] {
            e.disabled = !p.enabled;
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|e| seen.insert(if e.kind == "agent" { format!("agent:{}", e.name) } else { e.name.clone() }));
    out
}

/// A skill or command file, for showing it: only markdown under Claude Code's folder or the project's .claude.
pub fn read(config: &Path, folder: Option<&Path>, path: &Path) -> Result<String, String> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    let mut roots = vec![config.to_path_buf()];
    if let Some(f) = folder {
        roots.push(f.join(".claude"));
    }
    let allowed = path.extension().is_some_and(|x| x == "md") && roots.iter().filter_map(|r| r.canonicalize().ok()).any(|r| path.starts_with(r));
    if !allowed {
        return Err("That isn't a skill or command file.".into());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Yours (~/.claude) and the project's (.claude in the folder): the only places Settings changes a skill or command.
/// Plugins', claude.ai's and agents are read-only.
fn owned_roots(config: &Path, folder: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = vec![config.to_path_buf()];
    roots.extend(folder.map(|f| f.join(".claude")));
    roots
}

/// A file Settings may change: a skill's SKILL.md (in a folder of `skills`) or a command's .md (in `commands`, subfolders
/// too). Checked through links: the file and its folder aren't links, and where the file really lies is one of those
/// places. A plugin's, claude.ai's or another folder's file doesn't pass, nor does a link to one.
struct Owned {
    /// The root it's under, as given: a write is checked against it.
    root: PathBuf,
    /// A SKILL.md, whose folder is the skill.
    skill: bool,
}

fn owned(config: &Path, folder: Option<&Path>, path: &Path) -> Result<Owned, String> {
    let refused = || "Only your skills and commands, and this project's, can be changed here.".to_string();
    if !path.is_absolute() {
        return Err(refused());
    }
    // symlink_metadata doesn't follow a link, so a link fails here: moving or writing it would change what it points to.
    if !std::fs::symlink_metadata(path).map_err(|_| refused())?.is_file() {
        return Err(refused());
    }
    let real = path.canonicalize().map_err(|_| refused())?;
    let skill = path.file_name().is_some_and(|n| n == "SKILL.md");
    for root in owned_roots(config, folder) {
        let Ok(base) = root.canonicalize() else { continue };
        if skill {
            let Ok(skills) = base.join("skills").canonicalize() else { continue };
            let Some(skill_dir) = path.parent() else { continue };
            let dir_is_link = std::fs::symlink_metadata(skill_dir).map_or(true, |m| m.file_type().is_symlink());
            // A folder with a .claude-plugin is a plugin made in skills, not a skill.
            if real.parent().and_then(Path::parent) == Some(skills.as_path()) && !dir_is_link && !skill_dir.join(".claude-plugin").exists() {
                return Ok(Owned { root: root.clone(), skill });
            }
        } else if real.extension().is_some_and(|x| x == "md") && base.join("commands").canonicalize().is_ok_and(|commands| real.starts_with(commands)) {
            return Ok(Owned { root: root.clone(), skill });
        }
    }
    Err(refused())
}

/// Whether a name can be a skill's or command's: lowercase letters and digits, with single dashes between them.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.split('-').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

/// Writes a new file, refusing one that's already there: it's created exclusively, so nothing is overwritten.
fn write_new(path: &Path, text: &str, what: &str) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!("There's already a {what} with that name there."),
        _ => format!("Couldn't create it: {e}"),
    })?;
    file.write_all(text.as_bytes()).map_err(|e| format!("Couldn't write it: {e}"))
}

/// Makes a skill (a folder with a SKILL.md) or a command (a .md file) in yours (`scope` "user") or the project's, from a
/// name and one line about it, with a short template to fill in. Refuses a name that's taken there. Returns its file.
pub fn create(config: &Path, folder: Option<&Path>, kind: &str, scope: &str, name: &str, description: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err("A name is lowercase letters, digits and dashes, like daily-notes.".into());
    }
    let description = description.split_whitespace().collect::<Vec<_>>().join(" ");
    if description.is_empty() {
        return Err("Say what it's for, in a line.".into());
    }
    let base = match scope {
        "user" => config.to_path_buf(),
        "project" => folder.map(|f| f.join(".claude")).ok_or("Open a folder to make a skill for its project.")?,
        _ => return Err("Put it in yours or in this project's folder.".into()),
    };
    // A JSON string is a valid YAML double-quoted scalar, so any quotes or backslashes in the line come out as typed.
    let quoted = serde_json::to_string(&description).map_err(|e| e.to_string())?;
    match kind {
        "skill" => {
            let dir = base.join("skills");
            std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
            let skill_dir = dir.join(name);
            std::fs::create_dir(&skill_dir).map_err(|e| match e.kind() {
                std::io::ErrorKind::AlreadyExists => format!("There's already a skill called {name} there."),
                _ => format!("Couldn't create it: {e}"),
            })?;
            let file = skill_dir.join("SKILL.md");
            let text = format!("---\nname: {name}\ndescription: {quoted}\n---\n\n# {name}\n\nSay what Claude should do when this skill is used, step by step.\n");
            if let Err(e) = write_new(&file, &text, "skill") {
                let _ = std::fs::remove_dir(&skill_dir);
                return Err(e);
            }
            Ok(file)
        }
        "command" => {
            let dir = base.join("commands");
            std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
            let file = dir.join(format!("{name}.md"));
            let text = format!("---\ndescription: {quoted}\n---\n\nSay what Claude should do when this command runs. $ARGUMENTS is whatever is typed after it.\n");
            write_new(&file, &text, "command")?;
            Ok(file)
        }
        _ => Err("Make a skill or a command.".into()),
    }
}

/// What deleting a skill or command moves to the Trash: a skill's folder, or a command's file. Only yours or the
/// project's; a plugin's or claude.ai's is refused, and so is a root or anything reached through a link.
pub fn trash_target(config: &Path, folder: Option<&Path>, path: &Path) -> Result<PathBuf, String> {
    let owned = owned(config, folder, path)?;
    Ok(if owned.skill { path.parent().unwrap_or(path).to_path_buf() } else { path.to_path_buf() })
}

/// Moves a skill's folder (or a command's file) to the Trash, where Finder can put it back. Returns where it went.
pub fn delete(config: &Path, folder: Option<&Path>, path: &Path) -> Result<PathBuf, String> {
    let target = trash_target(config, folder, path)?;
    crate::trash::move_to_trash(&target)
}

/// Saves the text of a skill or command file if it's still `expected`, what Settings read: nothing is written otherwise.
pub fn save(config: &Path, folder: Option<&Path>, path: &Path, text: &str, expected: &str) -> Result<files::Written, String> {
    let owned = owned(config, folder, path)?;
    files::write_file(&owned.root, path, text, Some(expected))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// (name, kind, source, disabled) for each entry, sorted.
    fn summary(found: &[Entry]) -> Vec<(String, &'static str, &'static str, bool)> {
        let mut rows: Vec<_> = found.iter().map(|e| (e.name.clone(), e.kind, e.source, e.disabled)).collect();
        rows.sort();
        rows
    }

    fn row(name: &str, kind: &'static str, source: &'static str, disabled: bool) -> (String, &'static str, &'static str, bool) {
        (name.to_string(), kind, source, disabled)
    }

    #[test]
    fn finds_yours_the_projects_and_plugins_with_their_names() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let config = home.path();
        write(&config.join("skills/grill/SKILL.md"), "---\nname: grill-me\ndescription: \"Interview the user\"\n---\nbody");
        write(&config.join("skills/no-front/SKILL.md"), "Just text");
        write(&config.join("skills/empty-dir/README.md"), "not a skill");
        write(&config.join("commands/frontend/review.md"), "---\ndescription: Review the UI\n---\n");
        write(&project.path().join(".claude/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: Ship it\n---\n");
        let plugin = config.join("plugins/cache/mkt/superpowers/1.0");
        write(&plugin.join("skills/brainstorming/SKILL.md"), "---\nname: brainstorming\ndescription: Explore first\n---\n");
        write(&plugin.join("commands/plan.md"), "Plan it");
        write(&config.join("plugins/installed_plugins.json"), &format!(r#"{{"version":2,"plugins":{{"superpowers@mkt":[{{"scope":"user","installPath":"{}"}}]}}}}"#, plugin.display()));
        write(&config.join("settings.json"), r#"{"enabledPlugins":{"superpowers@mkt":true}}"#);

        let found = index(config, Some(project.path()));
        assert_eq!(
            summary(&found),
            vec![
                row("deploy", "skill", "project", false),
                row("frontend:review", "command", "user", false),
                row("grill-me", "skill", "user", false),
                row("no-front", "skill", "user", false),
                row("superpowers:brainstorming", "skill", "plugin", false),
                row("superpowers:plan", "command", "plugin", false),
            ]
        );
        let brainstorming = found.iter().find(|e| e.name == "superpowers:brainstorming").unwrap();
        assert_eq!(brainstorming.plugin.as_deref(), Some("superpowers"));
        assert_eq!(brainstorming.description, "Explore first");
    }

    #[test]
    fn plugins_load_by_scope_and_are_marked_off_when_settings_turn_them_off() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let config = home.path();
        let install = |name: &str| config.join("plugins/cache/m").join(name);
        write(&install("off").join("skills/a/SKILL.md"), "---\nname: a\n---\n");
        write(&install("on").join("skills/b/SKILL.md"), "---\nname: b\n---\n");
        write(&install("here").join("skills/c/SKILL.md"), "---\nname: c\n---\n");
        write(&install("elsewhere").join("skills/d/SKILL.md"), "---\nname: d\n---\n");
        // Installed without settings naming them: off (the CLI lists such a plugin as disabled too).
        write(&install("unset").join("skills/e/SKILL.md"), "---\nname: e\n---\n");
        let entry = |scope: &str, project_path: Option<&Path>, dir: PathBuf| {
            let mut v = serde_json::json!({ "scope": scope, "installPath": dir.display().to_string() });
            if let Some(p) = project_path {
                v["projectPath"] = serde_json::json!(p.display().to_string());
            }
            serde_json::json!([v])
        };
        let plugins_json = serde_json::json!({
            "off@m": entry("user", None, install("off")),
            "on@m": entry("user", None, install("on")),
            "here@m": entry("project", Some(project.path()), install("here")),
            "elsewhere@m": entry("project", Some(other.path()), install("elsewhere")),
            "unset@m": entry("user", None, install("unset")),
        });
        write(&config.join("plugins/installed_plugins.json"), &serde_json::json!({ "version": 2, "plugins": plugins_json }).to_string());
        write(&config.join("settings.json"), r#"{"enabledPlugins":{"on@m":true,"off@m":false}}"#);
        write(&project.path().join(".claude/settings.json"), r#"{"enabledPlugins":{"here@m":true}}"#);

        let found = index(config, Some(project.path()));
        assert_eq!(
            summary(&found),
            vec![
                row("here:c", "skill", "plugin", false),
                row("off:a", "skill", "plugin", true),
                row("on:b", "skill", "plugin", false),
                row("unset:e", "skill", "plugin", true),
            ]
        );
        // With no folder, a project's plugin isn't loaded at all: only the user's come through.
        let none = index(config, None);
        assert_eq!(summary(&none), vec![row("off:a", "skill", "plugin", true), row("on:b", "skill", "plugin", false), row("unset:e", "skill", "plugin", true)]);
    }

    #[test]
    fn indexes_synced_plugins_claude_ai_skills_and_agents() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let config = home.path();
        // claude.ai's synced plugin (figma): on unless settings turn it off.
        let figma = config.join("plugins/synced/bucket-1/figma");
        write(&figma.join(".claude-plugin/plugin.json"), r#"{"name":"figma"}"#);
        write(&figma.join("skills/figma-use/SKILL.md"), "---\nname: figma-use\ndescription: Use Figma\n---\n");
        write(&config.join("plugins/synced/.bucket-hidden/ignored/skills/x/SKILL.md"), "---\nname: x\n---\n");
        // claude.ai's synced skills, in ~/.claude/skills/synced.
        write(&config.join("skills/synced/bucket-1/docs/SKILL.md"), "---\nname: docs\ndescription: Write docs\n---\n");
        // A skills-dir plugin made in ~/.claude/skills: a plugin, not a skill named after its folder.
        write(&config.join("skills/tool/.claude-plugin/plugin.json"), r#"{"name":"tool"}"#);
        write(&config.join("skills/tool/skills/inner/SKILL.md"), "---\nname: inner\n---\n");
        // Agents: yours, the project's, and a plugin's.
        write(&config.join("agents/reviewer.md"), "---\nname: reviewer\ndescription: Reviews code\n---\nbody");
        write(&config.join("agents/nested/quiet.md"), "No frontmatter");
        write(&project.path().join(".claude/agents/build.md"), "---\ndescription: Builds\n---\n");
        write(&figma.join("agents/scout.md"), "---\nname: scout\n---\n");
        write(&config.join("settings.json"), r#"{"enabledPlugins":{"figma@synced":false}}"#);

        let found = index(config, Some(project.path()));
        assert_eq!(
            summary(&found),
            vec![
                row("anthropic-skills:docs", "skill", "synced", false),
                row("build", "agent", "project", false),
                row("figma:figma-use", "skill", "plugin", true),
                row("figma:scout", "agent", "plugin", true),
                row("quiet", "agent", "user", false),
                row("reviewer", "agent", "user", false),
                row("tool:inner", "skill", "plugin", false),
            ]
        );
        let docs = found.iter().find(|e| e.name == "anthropic-skills:docs").unwrap();
        assert_eq!(docs.description, "Write docs");
        let reviewer = found.iter().find(|e| e.name == "reviewer").unwrap();
        assert_eq!(reviewer.description, "Reviews code");
    }

    #[test]
    fn an_agent_and_a_skill_with_one_name_are_both_kept() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path();
        write(&config.join("skills/review/SKILL.md"), "---\nname: review\n---\n");
        write(&config.join("agents/review.md"), "---\nname: review\n---\n");
        write(&config.join("commands/review.md"), "Command");
        let names: Vec<_> = summary(&index(config, None)).into_iter().map(|r| (r.0, r.1)).collect();
        assert_eq!(names, vec![("review".to_string(), "agent"), ("review".to_string(), "skill")]);
    }

    #[test]
    fn reads_only_markdown_under_claudes_folders() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        write(&home.path().join("skills/a/SKILL.md"), "hello");
        write(&project.path().join(".claude/skills/b/SKILL.md"), "project");
        write(&project.path().join("secret.md"), "nope");
        write(&home.path().join("settings.json"), "{}");
        assert_eq!(read(home.path(), Some(project.path()), &home.path().join("skills/a/SKILL.md")).unwrap(), "hello");
        assert_eq!(read(home.path(), Some(project.path()), &project.path().join(".claude/skills/b/SKILL.md")).unwrap(), "project");
        assert!(read(home.path(), Some(project.path()), &project.path().join("secret.md")).is_err());
        assert!(read(home.path(), Some(project.path()), &home.path().join("settings.json")).is_err());
        assert!(read(home.path(), Some(project.path()), &home.path().join("skills/../skills/a/../../settings.json")).is_err());
    }

    #[test]
    fn reads_a_frontmatter_value_written_as_a_yaml_block_scalar() {
        let folded = "---\nname: review\ndescription: >-\n  Reviews a change\n  for security issues.\n\n  Second paragraph.\nallowed-tools: Read\n---\nbody";
        assert_eq!(front(folded, "description").as_deref(), Some("Reviews a change for security issues.\nSecond paragraph."));
        assert_eq!(front(folded, "allowed-tools").as_deref(), Some("Read"));
        let literal = "---\ndescription: |\n    line one\n      indented\n    line two\n---\n";
        assert_eq!(front(literal, "description").as_deref(), Some("line one\n  indented\nline two"));
        let indicator = "---\ndescription: |2-\n   kept\n---\n";
        assert_eq!(front(indicator, "description").as_deref(), Some("kept"));
        assert_eq!(front("---\nname: \"quoted\"\n---\n", "name").as_deref(), Some("quoted"));
        assert_eq!(front("---\ndescription: >\n---\n", "description").as_deref(), Some(""));
    }

    #[test]
    fn a_new_skill_or_command_is_indexed_with_its_description_as_typed() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let line = r#"Keeps "daily" notes \ tidy"#;
        let skill = create(home.path(), Some(project.path()), "skill", "user", "daily-notes", line).unwrap();
        assert_eq!(skill, home.path().join("skills/daily-notes/SKILL.md"));
        assert!(std::fs::read_to_string(&skill).unwrap().starts_with("---\nname: daily-notes\ndescription: \"Keeps \\\"daily\\\" notes \\\\ tidy\"\n---\n"));
        let command = create(home.path(), Some(project.path()), "command", "project", "ship", "Ship the build").unwrap();
        assert_eq!(command, project.path().join(".claude/commands/ship.md"));
        let found = index(home.path(), Some(project.path()));
        let daily = found.iter().find(|e| e.name == "daily-notes").unwrap();
        assert_eq!((daily.kind, daily.source, daily.description.as_str()), ("skill", "user", line));
        let ship = found.iter().find(|e| e.name == "ship").unwrap();
        assert_eq!((ship.kind, ship.source, ship.description.as_str()), ("command", "project", "Ship the build"));
    }

    #[test]
    fn create_refuses_a_bad_name_an_empty_line_a_taken_name_and_a_project_without_a_folder() {
        let home = tempfile::tempdir().unwrap();
        for bad in ["", "Daily", "a--b", "-a", "a-", "a_b", "é", &"x".repeat(65)] {
            assert!(!valid_name(bad), "{bad}");
        }
        assert!(valid_name("daily-notes-2"));
        assert!(create(home.path(), None, "skill", "user", "bad name", "x").is_err());
        assert!(create(home.path(), None, "skill", "user", "fine", "   ").is_err());
        assert!(create(home.path(), None, "skill", "project", "fine", "x").is_err());
        assert!(create(home.path(), None, "agent", "user", "fine", "x").is_err());
        create(home.path(), None, "command", "user", "review", "Review").unwrap();
        assert!(create(home.path(), None, "command", "user", "review", "Again").is_err());
        assert!(std::fs::read_to_string(home.path().join("commands/review.md")).unwrap().contains("Review"));
        create(home.path(), None, "skill", "user", "twice", "One").unwrap();
        assert!(create(home.path(), None, "skill", "user", "twice", "Two").is_err());
    }

    #[test]
    fn only_yours_and_the_projects_skills_and_commands_can_be_changed() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let config = home.path();
        let f = Some(project.path());
        write(&config.join("skills/grill/SKILL.md"), "x");
        write(&config.join("skills/SKILL.md"), "x");
        write(&config.join("commands/frontend/review.md"), "x");
        write(&config.join("settings.json"), "{}");
        write(&project.path().join(".claude/skills/deploy/SKILL.md"), "x");
        write(&project.path().join(".claude/commands/ship.md"), "x");
        write(&project.path().join("notes.md"), "x");
        write(&config.join("plugins/cache/m/superpowers/1/skills/brainstorm/SKILL.md"), "x");
        write(&config.join("skills/synced/bucket/docs/SKILL.md"), "x");
        write(&config.join("skills/tool/.claude-plugin/plugin.json"), r#"{"name":"tool"}"#);
        write(&config.join("skills/tool/SKILL.md"), "x");
        write(&outside.path().join("SKILL.md"), "x");
        write(&outside.path().join("x.md"), "x");
        std::os::unix::fs::symlink(outside.path(), config.join("skills/linked")).unwrap();
        std::os::unix::fs::symlink(config.join("skills/grill"), config.join("skills/alias")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("x.md"), config.join("commands/evil.md")).unwrap();

        assert_eq!(trash_target(config, f, &config.join("skills/grill/SKILL.md")).unwrap(), config.join("skills/grill"));
        assert_eq!(trash_target(config, f, &config.join("commands/frontend/review.md")).unwrap(), config.join("commands/frontend/review.md"));
        assert_eq!(trash_target(config, f, &project.path().join(".claude/skills/deploy/SKILL.md")).unwrap(), project.path().join(".claude/skills/deploy"));
        assert_eq!(trash_target(config, f, &project.path().join(".claude/commands/ship.md")).unwrap(), project.path().join(".claude/commands/ship.md"));
        for refused in [
            config.join("plugins/cache/m/superpowers/1/skills/brainstorm/SKILL.md"),
            config.join("skills/synced/bucket/docs/SKILL.md"),
            config.join("skills/tool/SKILL.md"),
            config.join("skills/SKILL.md"),
            config.join("skills"),
            config.join("skills/linked/SKILL.md"),
            config.join("skills/alias/SKILL.md"),
            config.join("commands/evil.md"),
            config.join("skills/grill/../../settings.json"),
            config.join("skills/grill/../../plugins/cache/m/superpowers/1/skills/brainstorm/SKILL.md"),
            PathBuf::from("relative/SKILL.md"),
            project.path().join("notes.md"),
            outside.path().join("SKILL.md"),
        ] {
            assert!(trash_target(config, f, &refused).is_err(), "{}", refused.display());
        }
        // Without a folder open, the project's skill isn't reachable at all.
        assert!(trash_target(config, None, &project.path().join(".claude/skills/deploy/SKILL.md")).is_err());
    }

    #[test]
    fn a_skill_edit_saves_only_if_the_file_is_still_what_was_read() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path();
        let file = config.join("skills/grill/SKILL.md");
        write(&file, "---\nname: grill\n---\nold\n");
        let saved = save(config, None, &file, "---\nname: grill\n---\nnew\n", "---\nname: grill\n---\nold\n").unwrap();
        assert!(matches!(saved, files::Written::Saved { changed: true, .. }));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "---\nname: grill\n---\nnew\n");
        // Changed meanwhile (Claude, git): nothing is written and what's there comes back.
        std::fs::write(&file, "theirs\n").unwrap();
        assert_eq!(save(config, None, &file, "mine\n", "---\nname: grill\n---\nnew\n").unwrap(), files::Written::Conflict { current: Some("theirs\n".into()) });
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "theirs\n");
        // A file outside the roots is refused outright.
        let outside = tempfile::tempdir().unwrap();
        write(&outside.path().join("SKILL.md"), "x");
        assert!(save(config, None, &outside.path().join("SKILL.md"), "y", "x").is_err());
    }

    #[test]
    fn a_quoted_value_reads_back_with_its_escapes() {
        assert_eq!(front("---\ndescription: \"say \\\"hi\\\" in C:\\\\tmp\"\n---\n", "description").as_deref(), Some("say \"hi\" in C:\\tmp"));
        assert_eq!(front("---\ndescription: 'it''s fine'\n---\n", "description").as_deref(), Some("it's fine"));
        assert_eq!(front("---\ndescription: \"\"\n---\n", "description").as_deref(), Some(""));
        assert_eq!(front("---\ndescription: \"\\n stays\"\n---\n", "description").as_deref(), Some("\\n stays"));
    }
}
