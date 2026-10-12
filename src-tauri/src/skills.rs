//! The skills and custom slash commands on disk, so the app can tell them apart in claude's command list (which
//! names both alike) and show where each comes from: yours (~/.claude), the project's (.claude in the folder), or a
//! plugin's. Claude decides what's loaded; this only says what each name is.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Entry {
    /// As claude lists it: "grill-me", "frontend:review", "superpowers:brainstorming".
    pub name: String,
    /// "skill" or "command".
    pub kind: &'static str,
    /// "user", "project" or "plugin".
    pub source: &'static str,
    pub plugin: Option<String>,
    pub path: String,
    pub description: String,
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
    Some(value.trim_matches(|c| c == '"' || c == '\'').to_string())
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

/// Skills in `dir`: each folder with a SKILL.md, named by its frontmatter or else the folder.
fn skills_in(dir: &Path, prefix: &str, source: &'static str, plugin: Option<&str>, out: &mut Vec<Entry>) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for e in read.flatten() {
        let file = e.path().join("SKILL.md");
        if !file.is_file() {
            continue;
        }
        let text = head(&file);
        let name = front(&text, "name").filter(|n| !n.is_empty()).unwrap_or_else(|| e.file_name().to_string_lossy().into_owned());
        out.push(Entry { name: format!("{prefix}{name}"), kind: "skill", source, plugin: plugin.map(String::from), path: file.display().to_string(), description: front(&text, "description").unwrap_or_default() });
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
                out.push(Entry { name: format!("{prefix}{at}{stem}"), kind: "command", source, plugin: plugin.map(String::from), path: path.display().to_string(), description: front(&head(&path), "description").unwrap_or_default() });
            }
        }
    }
    walk(dir, "", prefix, source, plugin, out, 0);
}

/// Installed plugins (from Claude Code's installed_plugins.json): name and where each version lives, newest last.
fn plugins(config: &Path) -> Vec<(String, PathBuf)> {
    let Ok(text) = std::fs::read_to_string(config.join("plugins/installed_plugins.json")) else { return vec![] };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return vec![] };
    let mut out = vec![];
    for (key, installs) in v["plugins"].as_object().into_iter().flatten() {
        let name = key.split('@').next().unwrap_or(key).to_string();
        for i in installs.as_array().into_iter().flatten() {
            if let Some(p) = i["installPath"].as_str() {
                let p = PathBuf::from(p);
                if !out.iter().any(|(_, q)| q == &p) {
                    out.push((name.clone(), p));
                }
            }
        }
    }
    out
}

/// Every skill and command found for `folder`: yours, the project's, then plugins'. A name found twice keeps the first.
pub fn index(config: &Path, folder: Option<&Path>) -> Vec<Entry> {
    let mut out = vec![];
    skills_in(&config.join("skills"), "", "user", None, &mut out);
    commands_in(&config.join("commands"), "", "user", None, &mut out);
    if let Some(f) = folder {
        skills_in(&f.join(".claude/skills"), "", "project", None, &mut out);
        commands_in(&f.join(".claude/commands"), "", "project", None, &mut out);
    }
    for (name, path) in plugins(config) {
        let prefix = format!("{name}:");
        skills_in(&path.join("skills"), &prefix, "plugin", Some(&name), &mut out);
        commands_in(&path.join("commands"), &prefix, "plugin", Some(&name), &mut out);
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|e| seen.insert(e.name.clone()));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
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

        let found = index(config, Some(project.path()));
        let summary: Vec<(&str, &str, &str, Option<&str>, &str)> = found.iter().map(|e| (e.name.as_str(), e.kind, e.source, e.plugin.as_deref(), e.description.as_str())).collect();
        let mut summary = summary;
        summary.sort();
        assert_eq!(
            summary,
            vec![
                ("deploy", "skill", "project", None, "Ship it"),
                ("frontend:review", "command", "user", None, "Review the UI"),
                ("grill-me", "skill", "user", None, "Interview the user"),
                ("no-front", "skill", "user", None, ""),
                ("superpowers:brainstorming", "skill", "plugin", Some("superpowers"), "Explore first"),
                ("superpowers:plan", "command", "plugin", Some("superpowers"), ""),
            ]
        );
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
}
