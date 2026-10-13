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

/// Whether an entry carries a secret written out in the file, rather than a reference such as "${API_KEY}". Such an
/// entry can't go into the project's .mcp.json, which is committed.
pub fn has_literal_secret(config: &Value) -> bool {
    ["env", "headers"].iter().filter_map(|s| config.get(*s)).filter_map(Value::as_object).flat_map(|o| o.values()).any(|v| v.as_str().is_some_and(|s| !s.contains("${")))
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
    fn a_literal_secret_is_told_from_a_variable_reference() {
        assert!(has_literal_secret(&json!({"env": {"K": "s3cret"}})));
        assert!(!has_literal_secret(&json!({"env": {"K": "${K}"}, "headers": {"Authorization": "Bearer ${TOKEN}"}})));
        assert!(has_literal_secret(&json!({"headers": {"Authorization": "Bearer t0k"}})));
        assert!(!has_literal_secret(&json!({"command": "npx"})));
    }
}
