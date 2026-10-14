//! An MCP server's stored settings, as Settings edits them. They're read from where Claude Code keeps them (the user's
//! ~/.claude.json, or the folder's .mcp.json) and written back with `claude mcp add-json`. Secret values never go to the
//! webview: the form shows them as MASK, and a MASK left in the form keeps the value that's stored.

use crate::shell::split_words;
use crate::McpServerSpec;
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::Path;

/// What a secret value looks like in the form.
pub const MASK: &str = "•••";

/// A server as the form shows it: the fields of a new server, with env and header values masked.
#[derive(Serialize, Debug, PartialEq)]
pub struct Form {
    pub name: String,
    pub transport: String,
    pub target: String,
    pub scope: String,
    /// "KEY=•••", one per line.
    pub env: Vec<String>,
    /// "Name: •••", one per line.
    pub headers: Vec<String>,
}

fn read_json(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(Value::Null),
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{} isn't valid JSON: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.to_string()),
    }
}

/// The stored entry for `name` in `scope`, or None if there isn't one. `claude_json` is Claude Code's own settings file;
/// `folder` is the chat's folder (its local scope is keyed by it there, and its project scope is its .mcp.json).
pub fn read_entry(claude_json: &Path, folder: &Path, name: &str, scope: &str) -> Result<Option<Value>, String> {
    let entry = match scope {
        "user" => read_json(claude_json)?.get("mcpServers").and_then(|s| s.get(name)).cloned(),
        "local" => {
            let all = read_json(claude_json)?;
            // Claude Code keys a folder by its real path, which may differ from the path Lantern was given (a link).
            let real = std::fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
            let key = [real, folder.to_path_buf()].iter().find_map(|p| all.get("projects")?.get(p.to_string_lossy().as_ref()));
            key.and_then(|p| p.get("mcpServers")?.get(name)).cloned()
        }
        "project" => read_json(&folder.join(".mcp.json"))?.get("mcpServers").and_then(|s| s.get(name)).cloned(),
        other => return Err(format!("There's no scope called {other}.")),
    };
    Ok(entry)
}

/// One word of a command line, quoted when the shell would split it: what split_words reads back.
fn shell_word(word: &str) -> String {
    let plain = !word.is_empty() && word.chars().all(|c| c.is_ascii_alphanumeric() || "_-./:=@%+,".contains(c));
    if plain {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

/// `KEY=•••` or `Name: •••` lines for each key of an env or headers object.
fn masked(section: Option<&Value>, sep: &str) -> Vec<String> {
    section.and_then(Value::as_object).into_iter().flatten().map(|(k, _)| format!("{k}{sep}{MASK}")).collect()
}

/// The form for a stored entry. Only the three transports Settings writes can be edited; others are named as refused.
pub fn to_form(name: &str, scope: &str, config: &Value) -> Result<Form, String> {
    let transport = config.get("type").and_then(Value::as_str).unwrap_or("stdio");
    let target = match transport {
        "stdio" => {
            let command = config.get("command").and_then(Value::as_str).ok_or("This server has no command to show.")?;
            let args = config.get("args").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str);
            std::iter::once(command).chain(args).map(shell_word).collect::<Vec<_>>().join(" ")
        }
        "http" | "sse" => config.get("url").and_then(Value::as_str).unwrap_or_default().to_string(),
        other => return Err(format!("Settings can't edit a {other} server. Change it with claude mcp in a terminal.")),
    };
    Ok(Form {
        name: name.to_string(),
        transport: transport.to_string(),
        target,
        scope: scope.to_string(),
        env: masked(config.get("env"), "="),
        headers: masked(config.get("headers"), ": "),
    })
}

/// The `KEY=value` (or `Name: value`) lines of the form as an object. A MASK keeps the value stored under that key.
fn values(lines: &[String], sep: char, stored: Option<&Value>) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    for line in lines.iter().map(|l| l.trim()).filter(|l| !l.is_empty()) {
        let (key, value) = line.split_once(sep).ok_or_else(|| format!("“{line}” should be written as {}.", if sep == '=' { "KEY=value" } else { "Name: value" }))?;
        let (key, value) = (key.trim(), value.trim());
        if key.is_empty() {
            return Err(format!("“{line}” has no name before the {sep}."));
        }
        let kept = stored.and_then(|s| s.get(key)).cloned();
        let value = match (value == MASK, kept) {
            (true, Some(kept)) => kept,
            (true, None) => return Err(format!("Give {key} a value.")),
            (false, _) => Value::String(value.to_string()),
        };
        out.insert(key.to_string(), value);
    }
    Ok(out)
}

/// The entry to store for `spec`, made from the stored one: the fields the form sets are replaced and everything else
/// (oauth settings, timeouts, and so on) is kept.
pub(crate) fn to_config(spec: &McpServerSpec, stored: &Value) -> Result<Value, String> {
    let mut config: Map<String, Value> = stored.as_object().cloned().unwrap_or_default();
    for key in ["type", "command", "args", "url", "env", "headers"] {
        config.remove(key);
    }
    if spec.transport == "stdio" {
        let words = split_words(&spec.target)?;
        let (command, args) = words.split_first().ok_or("Which command starts the server?")?;
        config.insert("type".into(), "stdio".into());
        config.insert("command".into(), command.clone().into());
        config.insert("args".into(), args.iter().cloned().map(Value::String).collect::<Vec<_>>().into());
        let env = values(&spec.env, '=', stored.get("env"))?;
        if !env.is_empty() {
            config.insert("env".into(), env.into());
        }
    } else {
        let url = spec.target.trim();
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err("The server's address starts with https://.".into());
        }
        config.insert("type".into(), spec.transport.clone().into());
        config.insert("url".into(), url.into());
        let headers = values(&spec.headers, ':', stored.get("headers"))?;
        if !headers.is_empty() {
            config.insert("headers".into(), headers.into());
        }
    }
    Ok(Value::Object(config))
}

/// One change to Claude Code's MCP settings: add an entry (its JSON), or remove one.
#[derive(Debug, PartialEq)]
pub(crate) enum Step {
    Add { scope: String, name: String, json: String },
    Remove { scope: String, name: String },
}

/// An edit as two steps, in order, and the step that takes back the first one when the second fails.
#[derive(Debug, PartialEq)]
pub(crate) struct Plan {
    pub steps: [Step; 2],
    pub undo: Step,
}

/// The plan for moving the server `from` (name, scope) to `to`. A name can't be added twice in one scope, so a server that
/// keeps both is removed first, and its stored entry is put back if the new one can't be added. Otherwise the new entry is
/// added first, so a failed removal leaves the server in place, with the new entry taken back out again.
pub(crate) fn edit_plan(from: (&str, &str), to: (&str, &str), new_json: String, stored_json: String) -> Plan {
    let (from_name, from_scope) = (from.0.to_string(), from.1.to_string());
    let (to_name, to_scope) = (to.0.to_string(), to.1.to_string());
    if from == to {
        Plan {
            steps: [Step::Remove { scope: from_scope.clone(), name: from_name.clone() }, Step::Add { scope: to_scope, name: to_name, json: new_json }],
            undo: Step::Add { scope: from_scope, name: from_name, json: stored_json },
        }
    } else {
        Plan {
            steps: [Step::Add { scope: to_scope.clone(), name: to_name.clone(), json: new_json }, Step::Remove { scope: from_scope, name: from_name }],
            undo: Step::Remove { scope: to_scope, name: to_name },
        }
    }
}

/// Refuses a config that would write a literal secret into the project's committed .mcp.json. A value is fine when it's
/// a reference such as "${API_KEY}", or when it's already in the file unchanged: `stored_in_scope` is the entry the
/// config replaces, when that entry is in the project file already. Names the keys, never the values.
pub(crate) fn check_committed(config: &Value, to_scope: &str, stored_in_scope: Option<&Value>) -> Result<(), String> {
    if to_scope != "project" {
        return Ok(());
    }
    let mut keys = Vec::new();
    for section in ["env", "headers"] {
        for (key, value) in config.get(section).and_then(Value::as_object).into_iter().flatten() {
            let Some(text) = value.as_str() else { continue };
            if text.contains("${") {
                continue;
            }
            let already = stored_in_scope.and_then(|s| s.get(section)?.get(key)).and_then(Value::as_str) == Some(text);
            if !already {
                keys.push(key.clone());
            }
        }
    }
    if keys.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "The project's .mcp.json is committed, so {} can't be written into it as a literal value. Use ${{NAME}} for a value Claude Code reads from your environment, or keep the server in your own settings.",
            keys.join(", ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn spec(name: &str, transport: &str, target: &str, scope: &str, env: &[&str], headers: &[&str]) -> McpServerSpec {
        McpServerSpec {
            name: name.into(),
            transport: transport.into(),
            target: target.into(),
            scope: scope.into(),
            env: env.iter().map(|s| s.to_string()).collect(),
            headers: headers.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// A fresh folder under the temp dir, so the tests don't share files.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lantern-mcp-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_form_masks_secrets_and_quotes_words_with_spaces() {
        let stored = json!({"type": "stdio", "command": "npx", "args": ["-y", "my server", "it's"], "env": {"API_KEY": "s3cret"}});
        let f = to_form("fs", "user", &stored).unwrap();
        assert_eq!(f.transport, "stdio");
        assert_eq!(f.target, "npx -y 'my server' 'it'\\''s'");
        assert_eq!(f.env, ["API_KEY=•••"]);
        assert!(!format!("{f:?}").contains("s3cret"));
    }

    #[test]
    fn the_form_of_a_web_server_masks_its_headers() {
        let stored = json!({"type": "http", "url": "https://x.dev/mcp", "headers": {"Authorization": "Bearer t0k"}});
        let f = to_form("api", "local", &stored).unwrap();
        assert_eq!((f.transport.as_str(), f.target.as_str()), ("http", "https://x.dev/mcp"));
        assert_eq!(f.headers, ["Authorization: •••"]);
    }

    #[test]
    fn other_transports_are_refused_rather_than_rewritten() {
        assert!(to_form("ws", "user", &json!({"type": "ws", "url": "wss://x"})).unwrap_err().contains("ws"));
    }

    #[test]
    fn a_mask_keeps_the_stored_value_and_other_settings_survive() {
        let stored = json!({"type": "stdio", "command": "old", "env": {"API_KEY": "s3cret"}, "timeout": 5000});
        let s = spec("fs", "stdio", "npx -y server", "user", &["API_KEY=•••", "B=2"], &[]);
        let config = to_config(&s, &stored).unwrap();
        assert_eq!(config, json!({"type": "stdio", "command": "npx", "args": ["-y", "server"], "env": {"API_KEY": "s3cret", "B": "2"}, "timeout": 5000}));
    }

    #[test]
    fn a_removed_key_is_removed_and_a_mask_with_nothing_stored_is_refused() {
        let stored = json!({"type": "http", "url": "https://x.dev", "headers": {"X-A": "1"}});
        let s = spec("api", "http", "https://x.dev/mcp", "user", &[], &["X-B: •••"]);
        assert_eq!(to_config(&s, &stored).unwrap_err(), "Give X-B a value.");
        let kept = spec("api", "http", "https://x.dev/mcp", "user", &[], &["X-A: •••"]);
        assert_eq!(to_config(&kept, &stored).unwrap(), json!({"type": "http", "url": "https://x.dev/mcp", "headers": {"X-A": "1"}}));
        let none = spec("api", "http", "https://x.dev/mcp", "user", &[], &[]);
        assert!(to_config(&none, &stored).unwrap().get("headers").is_none());
    }

    #[test]
    fn a_new_value_replaces_and_a_bad_line_is_named() {
        let s = spec("api", "sse", "https://x.dev/sse", "project", &[], &["Authorization: Bearer new"]);
        assert_eq!(to_config(&s, &json!({})).unwrap()["headers"], json!({"Authorization": "Bearer new"}));
        let bad = spec("fs", "stdio", "server", "user", &["NOEQUALS"], &[]);
        assert_eq!(to_config(&bad, &json!({})).unwrap_err(), "“NOEQUALS” should be written as KEY=value.");
    }

    #[test]
    fn reads_the_user_local_and_project_entries_from_where_claude_keeps_them() {
        let dir = scratch("read");
        let folder = dir.join("project");
        std::fs::create_dir_all(&folder).unwrap();
        let claude_json = dir.join(".claude.json");
        let real = std::fs::canonicalize(&folder).unwrap();
        let file = json!({
            "mcpServers": {"u": {"type": "stdio", "command": "u"}},
            "projects": {real.to_string_lossy(): {"mcpServers": {"l": {"type": "http", "url": "https://l.dev"}}}}
        });
        std::fs::write(&claude_json, file.to_string()).unwrap();
        std::fs::write(folder.join(".mcp.json"), json!({"mcpServers": {"p": {"type": "sse", "url": "https://p.dev"}}}).to_string()).unwrap();
        assert_eq!(read_entry(&claude_json, &folder, "u", "user").unwrap().unwrap()["command"], "u");
        assert_eq!(read_entry(&claude_json, &folder, "l", "local").unwrap().unwrap()["url"], "https://l.dev");
        assert_eq!(read_entry(&claude_json, &folder, "p", "project").unwrap().unwrap()["url"], "https://p.dev");
        assert_eq!(read_entry(&claude_json, &folder, "u", "local").unwrap(), None);
        assert!(read_entry(&claude_json, &folder, "u", "global").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_missing_settings_file_has_no_entries_and_a_broken_one_is_an_error() {
        let dir = scratch("missing");
        assert_eq!(read_entry(&dir.join("none.json"), &dir, "x", "user").unwrap(), None);
        std::fs::write(dir.join("broken.json"), "{nope").unwrap();
        assert!(read_entry(&dir.join("broken.json"), &dir, "x", "user").unwrap_err().contains("isn't valid JSON"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_literal_secret_cannot_go_into_the_project_file_but_a_reference_can() {
        let literal = json!({"env": {"API_KEY": "s3cret"}});
        assert_eq!(check_committed(&literal, "project", None).unwrap_err().matches("API_KEY").count(), 1);
        assert!(!check_committed(&literal, "project", None).unwrap_err().contains("s3cret"));
        assert!(check_committed(&json!({"env": {"API_KEY": "${API_KEY}"}, "headers": {"Authorization": "Bearer ${TOKEN}"}}), "project", None).is_ok());
        assert!(check_committed(&json!({"command": "npx"}), "project", None).is_ok());
    }

    #[test]
    fn an_edit_inside_the_project_file_may_keep_a_secret_already_there() {
        let stored = json!({"env": {"API_KEY": "s3cret"}});
        let masked_kept = json!({"env": {"API_KEY": "s3cret"}});
        assert!(check_committed(&masked_kept, "project", Some(&stored)).is_ok());
    }

    #[test]
    fn an_edit_in_the_project_file_adding_or_changing_a_secret_is_refused() {
        let stored = json!({"env": {"API_KEY": "s3cret"}});
        let new_key = json!({"env": {"API_KEY": "s3cret", "OTHER": "fresh"}});
        assert_eq!(check_committed(&new_key, "project", Some(&stored)).unwrap_err().matches("OTHER").count(), 1);
        let changed = json!({"env": {"API_KEY": "rotated"}});
        assert!(check_committed(&changed, "project", Some(&stored)).unwrap_err().contains("API_KEY"));
    }

    #[test]
    fn a_move_into_the_project_file_has_nothing_kept_so_every_literal_counts() {
        // The stored entry is in the user's settings, not the project file, so it isn't passed in.
        let headers = json!({"headers": {"Authorization": "Bearer t0k"}});
        assert!(check_committed(&headers, "project", None).unwrap_err().contains("Authorization"));
    }

    #[test]
    fn an_edit_that_keeps_name_and_scope_removes_first_and_restores_the_stored_entry_if_the_add_fails() {
        let plan = edit_plan(("fs", "user"), ("fs", "user"), "NEW".into(), "OLD".into());
        assert_eq!(
            plan,
            Plan {
                steps: [Step::Remove { scope: "user".into(), name: "fs".into() }, Step::Add { scope: "user".into(), name: "fs".into(), json: "NEW".into() }],
                undo: Step::Add { scope: "user".into(), name: "fs".into(), json: "OLD".into() },
            }
        );
    }

    #[test]
    fn a_rename_or_a_scope_change_adds_first_and_takes_the_new_entry_back_if_the_remove_fails() {
        let rename = edit_plan(("fs", "user"), ("files", "user"), "NEW".into(), "OLD".into());
        assert_eq!(rename.steps[0], Step::Add { scope: "user".into(), name: "files".into(), json: "NEW".into() });
        assert_eq!(rename.steps[1], Step::Remove { scope: "user".into(), name: "fs".into() });
        assert_eq!(rename.undo, Step::Remove { scope: "user".into(), name: "files".into() });
        let moved = edit_plan(("fs", "local"), ("fs", "user"), "NEW".into(), "OLD".into());
        assert_eq!(moved.steps[0], Step::Add { scope: "user".into(), name: "fs".into(), json: "NEW".into() });
        assert_eq!(moved.steps[1], Step::Remove { scope: "local".into(), name: "fs".into() });
    }

    #[test]
    fn a_secret_kept_in_the_project_file_is_fine_and_a_new_one_is_refused() {
        let stored = json!({"env": {"API_KEY": "s3cret"}});
        // Project to project, the value left as it is.
        assert!(check_committed(&stored, "project", Some(&stored)).is_ok());
        // Local or user into the project: nothing is kept there, so the literal is refused.
        assert!(check_committed(&stored, "project", None).is_err());
    }

    #[test]
    fn user_and_local_scopes_are_never_refused() {
        let literal = json!({"env": {"API_KEY": "s3cret"}, "headers": {"Authorization": "Bearer t0k"}});
        assert!(check_committed(&literal, "user", None).is_ok());
        assert!(check_committed(&literal, "local", None).is_ok());
    }

    #[test]
    fn adding_to_the_project_with_a_literal_secret_is_refused_and_a_reference_accepted() {
        let literal = spec("fs", "stdio", "npx server", "project", &["API_KEY=s3cret"], &[]);
        let config = to_config(&literal, &Value::Null).unwrap();
        assert!(check_committed(&config, "project", None).unwrap_err().contains("API_KEY"));
        let referenced = spec("fs", "stdio", "npx server", "project", &["API_KEY=${API_KEY}"], &[]);
        assert!(check_committed(&to_config(&referenced, &Value::Null).unwrap(), "project", None).is_ok());
    }
}
