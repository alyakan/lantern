//! Dashboards: a folder's own admin screens, written by Claude (or by hand) as JSON in `.lantern/dashboards/`, shown in the
//! Dashboard tab. A dashboard is panels: a form whose button runs a command, a result panel showing what the last run printed,
//! and a history panel listing past runs.
//!
//! The spec comes from the folder, so it is untrusted until the user has looked at its commands (see the trust step in the
//! runner). Everything that could let a form value change *what* runs is therefore refused here, while the file is read:
//! commands are argument lists (no shell), the program can't come from a form value, and a free-text value can only sit
//! inside an argument after literal text, so it can't be read as a flag. This module only reads and checks files; it never
//! runs anything.
//!
//! All checking is done here, once. The UI renders what [`load`] returns: a spec, or a list of issues with their paths, which
//! also go back to Claude so it can fix the file.

use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Read;
use std::path::Path;

/// Where a folder's dashboards live, relative to the folder.
pub const DIR: [&str; 2] = [".lantern", "dashboards"];

/// A spec file larger than this isn't read (its issues go back to Claude, so the cap also bounds that).
const MAX_FILE_BYTES: u64 = 256 << 10;
/// Files read from the folder; the rest are left alone.
const MAX_FILES: usize = 20;
const MAX_PANELS: usize = 32;
const MAX_FIELDS: usize = 32;
const MAX_OPTIONS: usize = 200;
const MAX_ARGS: usize = 64;
/// Longest title, label, option or confirm text.
const MAX_LABEL: usize = 200;
/// Longest argument, and longest default for a text field.
const MAX_ARG: usize = 1024;
/// Issues reported per file; a file this broken needs rewriting, not a longer list.
const MAX_ISSUES: usize = 25;

// MARK: - The spec

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Issue {
    /// Where in the file, like `panels[0].fields[2].default`; empty for the whole file.
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Spec {
    pub title: String,
    pub panels: Vec<Panel>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Panel {
    Form(Form),
    /// What the last run of a form printed.
    Result(Link),
    /// The past runs of a form.
    History(Link),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Form {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub fields: Vec<Field>,
    pub action: Action,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Link {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The id of the form this panel belongs to.
    pub of: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Text,
    Number,
    Select,
    Multiselect,
    Toggle,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Field {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Output {
    /// The last line of stdout is JSON, shown as a list or a table; anything else falls back to the log.
    Json,
    Text,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Action {
    /// The program and its arguments, one string each. `{field}` is replaced by that field's value, inside one argument.
    pub command: Vec<String>,
    /// Shown, with the values filled in, before the command runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirm: Option<String>,
    pub output: Output,
}

// MARK: - Checking a spec

struct Issues(Vec<Issue>);

impl Issues {
    fn add(&mut self, path: &str, message: impl Into<String>) {
        if self.0.len() < MAX_ISSUES {
            self.0.push(Issue { path: path.to_string(), message: message.into() });
        }
    }

    /// Keys the format doesn't have are mistakes (a typo would otherwise silently do nothing).
    fn only_keys(&mut self, path: &str, object: &Map<String, Value>, allowed: &[&str]) {
        for key in object.keys() {
            if !allowed.contains(&key.as_str()) {
                self.add(&join(path, key), format!("not a known key here (use {})", allowed.join(", ")));
            }
        }
    }
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() { key.to_string() } else { format!("{path}.{key}") }
}

/// Reads a spec's text. Errors are every problem found (up to a few), never just the first.
pub fn parse(text: &str) -> Result<Spec, Vec<Issue>> {
    let value: Value = serde_json::from_str(text).map_err(|e| vec![Issue { path: String::new(), message: format!("not valid JSON: {e}") }])?;
    let mut issues = Issues(Vec::new());
    let spec = check_spec(&value, &mut issues);
    match spec {
        Some(spec) if issues.0.is_empty() => Ok(spec),
        _ => Err(issues.0),
    }
}

fn check_spec(value: &Value, issues: &mut Issues) -> Option<Spec> {
    let Some(root) = value.as_object() else {
        issues.add("", "must be a JSON object with a title and panels");
        return None;
    };
    issues.only_keys("", root, &["title", "panels"]);
    let title = text_at(issues, "title", root.get("title"), true, MAX_LABEL).unwrap_or_default();
    let Some(raw_panels) = root.get("panels").and_then(Value::as_array) else {
        issues.add("panels", "must be a list of panels");
        return None;
    };
    if raw_panels.is_empty() || raw_panels.len() > MAX_PANELS {
        issues.add("panels", format!("needs between 1 and {MAX_PANELS} panels"));
    }
    let mut panels = Vec::new();
    // Panel ids must be unique, and result and history panels must name a form that exists (checked once all forms are read).
    let mut ids: HashSet<String> = HashSet::new();
    let mut form_ids: HashSet<String> = HashSet::new();
    let mut links: Vec<(String, String)> = Vec::new();
    for (i, raw) in raw_panels.iter().take(MAX_PANELS).enumerate() {
        let path = format!("panels[{i}]");
        let Some(object) = raw.as_object() else {
            issues.add(&path, "must be an object");
            continue;
        };
        let kind = object.get("type").and_then(Value::as_str);
        let panel = match kind {
            Some("form") => check_form(issues, &path, object).map(|form| {
                form_ids.insert(form.id.clone());
                Panel::Form(form)
            }),
            Some(k @ ("result" | "history")) => {
                issues.only_keys(&path, object, &["type", "id", "title", "of"]);
                let id = optional_id(issues, &join(&path, "id"), object.get("id"));
                let title = text_at(issues, &join(&path, "title"), object.get("title"), false, MAX_LABEL);
                let of = id_at(issues, &join(&path, "of"), object.get("of"));
                if let Some(of) = &of {
                    links.push((join(&path, "of"), of.clone()));
                }
                of.map(|of| {
                    let link = Link { id, title, of };
                    if k == "result" { Panel::Result(link) } else { Panel::History(link) }
                })
            }
            Some(other) => {
                issues.add(&join(&path, "type"), format!("unknown panel type '{}' (use form, result or history)", clip(other)));
                None
            }
            None => {
                issues.add(&join(&path, "type"), "needs a type: form, result or history");
                None
            }
        };
        if let Some(panel) = panel {
            let id = match &panel {
                Panel::Form(f) => Some(f.id.clone()),
                Panel::Result(l) | Panel::History(l) => l.id.clone(),
            };
            if let Some(id) = id {
                if !ids.insert(id.clone()) {
                    issues.add(&join(&path, "id"), format!("'{id}' is used by another panel; ids must be unique"));
                }
            }
            panels.push(panel);
        }
    }
    for (path, of) in links {
        if !form_ids.contains(&of) {
            issues.add(&path, format!("there is no form with the id '{of}'"));
        }
    }
    Some(Spec { title, panels })
}

fn check_form(issues: &mut Issues, path: &str, object: &Map<String, Value>) -> Option<Form> {
    issues.only_keys(path, object, &["type", "id", "title", "fields", "action"]);
    let id = id_at(issues, &join(path, "id"), object.get("id"));
    let title = text_at(issues, &join(path, "title"), object.get("title"), false, MAX_LABEL);
    let mut fields = Vec::new();
    match object.get("fields") {
        None => {}
        Some(Value::Array(raw)) => {
            if raw.len() > MAX_FIELDS {
                issues.add(&join(path, "fields"), format!("at most {MAX_FIELDS} fields"));
            }
            let mut seen = HashSet::new();
            for (i, raw) in raw.iter().take(MAX_FIELDS).enumerate() {
                let field_path = format!("{}[{i}]", join(path, "fields"));
                if let Some(field) = check_field(issues, &field_path, raw) {
                    if !seen.insert(field.id.clone()) {
                        issues.add(&join(&field_path, "id"), format!("'{}' is used by another field in this form", field.id));
                    }
                    fields.push(field);
                }
            }
        }
        Some(_) => issues.add(&join(path, "fields"), "must be a list of fields"),
    }
    let action = match object.get("action") {
        Some(raw) => check_action(issues, &join(path, "action"), raw, &fields),
        None => {
            issues.add(&join(path, "action"), "a form needs an action: the command its button runs");
            None
        }
    };
    Some(Form { id: id?, title, fields, action: action? })
}

fn check_field(issues: &mut Issues, path: &str, raw: &Value) -> Option<Field> {
    let Some(object) = raw.as_object() else {
        issues.add(path, "must be an object");
        return None;
    };
    issues.only_keys(path, object, &["id", "type", "label", "required", "default", "options", "min", "max"]);
    let id = id_at(issues, &join(path, "id"), object.get("id"));
    let label = text_at(issues, &join(path, "label"), object.get("label"), false, MAX_LABEL);
    let kind = match object.get("type").and_then(Value::as_str) {
        Some("text") => Some(Kind::Text),
        Some("number") => Some(Kind::Number),
        Some("select") => Some(Kind::Select),
        Some("multiselect") => Some(Kind::Multiselect),
        Some("toggle") => Some(Kind::Toggle),
        Some(other) => {
            issues.add(&join(path, "type"), format!("unknown field type '{}' (use text, number, select, multiselect or toggle)", clip(other)));
            None
        }
        None => {
            issues.add(&join(path, "type"), "needs a type: text, number, select, multiselect or toggle");
            None
        }
    };
    let required = match object.get("required") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => {
            issues.add(&join(path, "required"), "must be true or false");
            false
        }
    };
    let kind = kind?;
    let options = check_options(issues, path, object, kind);
    let (min, max) = check_range(issues, path, object, kind);
    let default = check_default(issues, &join(path, "default"), object.get("default"), kind, &options, min, max);
    Some(Field { id: id?, kind, label, required, default, options, min, max })
}

fn check_options(issues: &mut Issues, path: &str, object: &Map<String, Value>, kind: Kind) -> Vec<String> {
    let choice = matches!(kind, Kind::Select | Kind::Multiselect);
    let at = join(path, "options");
    let Some(raw) = object.get("options") else {
        if choice {
            issues.add(&at, "a select needs a list of options");
        }
        return Vec::new();
    };
    if !choice {
        issues.add(&at, "only a select or multiselect has options");
        return Vec::new();
    }
    let Some(raw) = raw.as_array().filter(|a| !a.is_empty() && a.len() <= MAX_OPTIONS) else {
        issues.add(&at, format!("must be a list of 1 to {MAX_OPTIONS} strings"));
        return Vec::new();
    };
    let mut options: Vec<String> = Vec::new();
    for (i, option) in raw.iter().enumerate() {
        let at = format!("{at}[{i}]");
        match option.as_str() {
            Some(s) if s.is_empty() || s.chars().count() > MAX_LABEL => issues.add(&at, format!("must be 1 to {MAX_LABEL} characters")),
            // A multiselect's values are joined with commas, so a comma inside one would split it into two.
            Some(s) if s.contains(',') => issues.add(&at, "can't contain a comma (selected options are joined with commas)"),
            Some(s) if options.iter().any(|o| o == s) => issues.add(&at, format!("'{s}' is listed twice")),
            Some(s) => options.push(s.to_string()),
            None => issues.add(&at, "must be a string"),
        }
    }
    options
}

fn check_range(issues: &mut Issues, path: &str, object: &Map<String, Value>, kind: Kind) -> (Option<f64>, Option<f64>) {
    let mut bound = |key: &str| -> Option<f64> {
        let raw = object.get(key)?;
        let at = join(path, key);
        if kind != Kind::Number {
            issues.add(&at, "only a number field has a min or max");
            return None;
        }
        match raw.as_f64().filter(|n| n.is_finite()) {
            Some(n) => Some(n),
            None => {
                issues.add(&at, "must be a number");
                None
            }
        }
    };
    let min = bound("min");
    let max = bound("max");
    if let (Some(lo), Some(hi)) = (min, max) {
        if lo > hi {
            issues.add(&join(path, "min"), "is larger than max");
        }
    }
    (min, max)
}

fn check_default(issues: &mut Issues, path: &str, raw: Option<&Value>, kind: Kind, options: &[String], min: Option<f64>, max: Option<f64>) -> Option<Value> {
    let raw = raw?;
    let ok = match (kind, raw) {
        (Kind::Text, Value::String(s)) => s.chars().count() <= MAX_ARG || fail(issues, path, format!("longer than {MAX_ARG} characters")),
        (Kind::Number, Value::Number(n)) => match n.as_f64() {
            Some(n) if min.is_some_and(|m| n < m) || max.is_some_and(|m| n > m) => fail(issues, path, "is outside the field's min and max"),
            _ => true,
        },
        (Kind::Select, Value::String(s)) => options.contains(s) || fail(issues, path, format!("'{}' isn't one of the options", clip(s))),
        (Kind::Multiselect, Value::Array(items)) => {
            let mut seen = HashSet::new();
            items.iter().all(|item| match item.as_str() {
                Some(s) if options.iter().any(|o| o == s) => seen.insert(s) || fail(issues, path, format!("'{s}' is listed twice")),
                Some(s) => fail(issues, path, format!("'{}' isn't one of the options", clip(s))),
                None => fail(issues, path, "must be a list of option strings"),
            })
        }
        (Kind::Toggle, Value::Bool(_)) => true,
        (kind, _) => fail(issues, path, format!("doesn't match the field type ({})", match kind {
            Kind::Text => "a string",
            Kind::Number => "a number",
            Kind::Select => "one of the options",
            Kind::Multiselect => "a list of options",
            Kind::Toggle => "true or false",
        })),
    };
    ok.then(|| raw.clone())
}

fn fail(issues: &mut Issues, path: &str, message: impl Into<String>) -> bool {
    issues.add(path, message);
    false
}

fn check_action(issues: &mut Issues, path: &str, raw: &Value, fields: &[Field]) -> Option<Action> {
    let Some(object) = raw.as_object() else {
        issues.add(path, "must be an object with a command");
        return None;
    };
    issues.only_keys(path, object, &["command", "confirm", "output"]);
    let command_at = join(path, "command");
    let mut command: Vec<String> = Vec::new();
    match object.get("command").and_then(Value::as_array) {
        Some(raw) if !raw.is_empty() && raw.len() <= MAX_ARGS => {
            for (i, arg) in raw.iter().enumerate() {
                let at = format!("{command_at}[{i}]");
                match arg.as_str() {
                    Some(s) if s.chars().count() > MAX_ARG => issues.add(&at, format!("longer than {MAX_ARG} characters")),
                    Some(s) => {
                        check_placeholders(issues, &at, s, fields, i > 0);
                        command.push(s.to_string());
                    }
                    None => issues.add(&at, "must be a string (the command is a list of strings, not a shell line)"),
                }
            }
            match command.first() {
                // A form value must never choose the program.
                Some(program) if program.is_empty() => issues.add(&format!("{command_at}[0]"), "the program can't be empty"),
                Some(program) if !placeholders(program).is_empty() => issues.add(&format!("{command_at}[0]"), "the program can't contain a {field}; only arguments can"),
                _ => {}
            }
        }
        _ => issues.add(&command_at, format!("must be a list of 1 to {MAX_ARGS} strings: the program, then its arguments")),
    }
    let confirm = text_at(issues, &join(path, "confirm"), object.get("confirm"), false, MAX_LABEL).inspect(|text| {
        check_placeholders(issues, &join(path, "confirm"), text, fields, false);
    });
    let output = match object.get("output").map(|v| v.as_str()) {
        None => Output::Text,
        Some(Some("json")) => Output::Json,
        Some(Some("text")) => Output::Text,
        Some(_) => {
            issues.add(&join(path, "output"), "must be \"json\" or \"text\"");
            Output::Text
        }
    };
    // A command with a bad argument has already been reported, which fails the whole file.
    (!command.is_empty()).then_some(Action { command, confirm, output })
}

/// The `{field}` markers in `text`: where each starts, and the field id.
pub fn placeholders(text: &str) -> Vec<(usize, String)> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            let name_end = bytes[i + 1..].iter().position(|b| !(b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')).map(|n| i + 1 + n);
            if let Some(end) = name_end.filter(|&end| end > i + 1 && bytes[end] == b'}') {
                found.push((i, text[i + 1..end].to_string()));
                i = end;
            }
        }
        i += 1;
    }
    found
}

/// Every `{field}` in `text` has to name a field of this form; and in an argument, a text field's value has to come after
/// literal text (`--name={name}`), so a value like `--admins=99` can't become a flag of its own.
fn check_placeholders(issues: &mut Issues, path: &str, text: &str, fields: &[Field], in_argument: bool) {
    let found = placeholders(text);
    for (start, id) in &found {
        let Some(field) = fields.iter().find(|f| &f.id == id) else {
            issues.add(path, format!("{{{id}}} isn't a field of this form"));
            continue;
        };
        if in_argument && field.kind == Kind::Text && only_values_before(&found, *start) {
            issues.add(path, format!("the text field {{{id}}} can't start an argument; write it after a flag, like --{id}={{{id}}}, so its value can't be read as a flag"));
        }
    }
}

/// True when nothing but other fields' values comes before `start` (no literal text to hold a free-text value back).
fn only_values_before(found: &[(usize, String)], start: usize) -> bool {
    let mut at = 0;
    while at < start {
        match found.iter().find(|(s, _)| *s == at) {
            Some((s, name)) => at = s + name.len() + 2,
            None => return false,
        }
    }
    true
}

fn clip(text: &str) -> String {
    text.chars().take(40).collect()
}

fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= 32 && chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn id_at(issues: &mut Issues, path: &str, raw: Option<&Value>) -> Option<String> {
    match raw.and_then(Value::as_str) {
        Some(id) if valid_id(id) => Some(id.to_string()),
        Some(_) => {
            issues.add(path, "must start with a letter and use only letters, digits, - and _ (at most 32 characters)");
            None
        }
        None => {
            issues.add(path, "needs an id");
            None
        }
    }
}

fn optional_id(issues: &mut Issues, path: &str, raw: Option<&Value>) -> Option<String> {
    raw.and_then(|_| id_at(issues, path, raw))
}

/// A string of 1 to `max` characters; `required` says whether it may be missing.
fn text_at(issues: &mut Issues, path: &str, raw: Option<&Value>, required: bool, max: usize) -> Option<String> {
    match raw {
        None if required => {
            issues.add(path, "is required");
            None
        }
        None => None,
        Some(Value::String(s)) if !s.trim().is_empty() && s.chars().count() <= max => Some(s.clone()),
        Some(_) => {
            issues.add(path, format!("must be a string of 1 to {max} characters"));
            None
        }
    }
}

// MARK: - Reading a folder

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    /// The file's name inside `.lantern/dashboards/`.
    pub file: String,
    /// SHA-256 of the exact bytes that were read and checked. Trusting a dashboard is trusting this hash, so an edit (or a
    /// swap between the check and the run) is a different dashboard.
    pub hash: String,
    pub spec: Option<Spec>,
    pub issues: Vec<Issue>,
}

impl Dashboard {
    /// The form with this id, in a dashboard that checked out.
    pub fn form(&self, id: &str) -> Option<&Form> {
        self.spec.as_ref()?.panels.iter().find_map(|p| match p {
            Panel::Form(f) if f.id == id => Some(f),
            _ => None,
        })
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn broken(file: &str, message: &str) -> Dashboard {
    Dashboard { file: file.to_string(), hash: String::new(), spec: None, issues: vec![Issue { path: String::new(), message: message.to_string() }] }
}

/// Reads and checks one file's bytes.
fn read_one(path: &Path, file: &str) -> Dashboard {
    let Ok(handle) = std::fs::File::open(path) else { return broken(file, "couldn't be opened") };
    let mut bytes = Vec::new();
    // One byte past the cap, so a file that grew since its size was read is still refused.
    if handle.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).is_err() {
        return broken(file, "couldn't be read");
    }
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return broken(file, &format!("is larger than {} KB, so it isn't read", MAX_FILE_BYTES >> 10));
    }
    let hash = hex(&Sha256::digest(&bytes));
    let Ok(text) = String::from_utf8(bytes) else {
        return Dashboard { hash, ..broken(file, "isn't UTF-8 text") };
    };
    match parse(&text) {
        Ok(spec) => Dashboard { file: file.to_string(), hash, spec: Some(spec), issues: Vec::new() },
        Err(issues) => Dashboard { file: file.to_string(), hash, spec: None, issues },
    }
}

/// The folder's dashboards, by file name. Only regular `.json` files directly inside `.lantern/dashboards/` are read, and
/// none of the folders on the way may be a symlink, so a dashboard can't point the reader at something outside the folder.
pub fn load(folder: &Path) -> Vec<Dashboard> {
    let mut dir = folder.to_path_buf();
    for part in DIR {
        dir.push(part);
        match std::fs::symlink_metadata(&dir) {
            Ok(m) if m.is_dir() => {}
            _ => return Vec::new(),
        }
    }
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut names: Vec<(String, std::fs::FileType)> = entries
        .flatten()
        .filter_map(|e| Some((e.file_name().into_string().ok()?, e.file_type().ok()?)))
        .filter(|(name, _)| name.ends_with(".json") && !name.starts_with('.'))
        .collect();
    names.sort_by(|a, b| a.0.cmp(&b.0));
    names
        .into_iter()
        .take(MAX_FILES)
        .map(|(name, kind)| {
            if kind.is_symlink() {
                broken(&name, "is a symlink, and links aren't followed")
            } else if kind.is_file() {
                read_one(&dir.join(&name), &name)
            } else {
                broken(&name, "isn't a regular file")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn errors(spec: Value) -> Vec<String> {
        match parse(&spec.to_string()) {
            Ok(_) => Vec::new(),
            Err(issues) => issues.into_iter().map(|i| format!("{}: {}", i.path, i.message)).collect(),
        }
    }

    fn has(spec: Value, path: &str, part: &str) -> bool {
        match parse(&spec.to_string()) {
            Ok(_) => false,
            Err(issues) => issues.iter().any(|i| i.path == path && i.message.contains(part)),
        }
    }

    /// A good spec to break one thing in.
    fn base() -> Value {
        json!({
            "title": "Staging",
            "panels": [
                { "type": "form", "id": "org", "fields": [
                    { "id": "staging", "type": "select", "options": ["1", "2"], "required": true },
                    { "id": "users", "type": "number", "default": 2, "min": 1 },
                    { "id": "addons", "type": "multiselect", "options": ["approvals", "sso"], "default": ["sso"] },
                    { "id": "name", "type": "text" },
                    { "id": "loud", "type": "toggle", "default": false }
                ], "action": {
                    "command": ["python3", "run.py", "--staging", "{staging}", "--users", "{users}", "--enable", "{addons}", "--name={name}"],
                    "confirm": "Creates an org on staging {staging}", "output": "json" } },
                { "type": "result", "of": "org" },
                { "type": "history", "of": "org" }
            ]
        })
    }

    fn with(edit: impl FnOnce(&mut Value)) -> Value {
        let mut spec = base();
        edit(&mut spec);
        spec
    }

    #[test]
    fn the_base_spec_is_valid() {
        let spec = parse(&base().to_string()).unwrap();
        assert_eq!(spec.title, "Staging");
        assert_eq!(spec.panels.len(), 3);
    }

    #[test]
    fn broken_json_and_wrong_shapes_say_what_is_wrong() {
        assert!(parse("{").unwrap_err()[0].message.contains("not valid JSON"));
        assert!(has(json!([]), "", "JSON object"));
        assert!(has(json!({ "title": "x" }), "panels", "list of panels"));
        assert!(has(json!({ "panels": [] }), "title", "required"));
        assert!(has(json!({ "title": "x", "panels": [] }), "panels", "between 1 and"));
        assert!(has(with(|s| s["extra"] = json!(1)), "extra", "not a known key"));
    }

    #[test]
    fn a_program_can_not_come_from_a_form_value() {
        assert!(has(with(|s| s["panels"][0]["action"]["command"][0] = json!("{staging}")), "panels[0].action.command[0]", "program can't contain"));
        assert!(has(with(|s| s["panels"][0]["action"]["command"][0] = json!("/bin/{users}x")), "panels[0].action.command[0]", "program can't contain"));
        assert!(has(with(|s| s["panels"][0]["action"]["command"][0] = json!("")), "panels[0].action.command[0]", "can't be empty"));
    }

    #[test]
    fn a_command_is_a_list_of_strings() {
        assert!(has(with(|s| s["panels"][0]["action"]["command"] = json!("python3 run.py")), "panels[0].action.command", "list of 1 to"));
        assert!(has(with(|s| s["panels"][0]["action"]["command"] = json!([])), "panels[0].action.command", "list of 1 to"));
        assert!(has(with(|s| s["panels"][0]["action"]["command"][2] = json!({ "repeat": "addons" })), "panels[0].action.command[2]", "must be a string"));
        assert!(has(with(|s| s["panels"][0]["action"]["command"][2] = json!(7)), "panels[0].action.command[2]", "must be a string"));
        assert!(has(with(|s| s["panels"][0]["action"]["command"] = json!(vec!["x"; 65])), "panels[0].action.command", "list of 1 to"));
    }

    #[test]
    fn placeholders_must_name_a_field_of_the_form() {
        assert!(has(with(|s| s["panels"][0]["action"]["command"][3] = json!("{nope}")), "panels[0].action.command[3]", "isn't a field"));
        assert!(has(with(|s| s["panels"][0]["action"]["confirm"] = json!("on {nope}")), "panels[0].action.confirm", "isn't a field"));
        // Braces that aren't a marker are literal text.
        assert!(errors(with(|s| s["panels"][0]["action"]["command"][3] = json!("{\"a\": 1}"))).is_empty());
    }

    #[test]
    fn a_text_value_can_not_start_an_argument() {
        let at = "panels[0].action.command[3]";
        assert!(has(with(|s| s["panels"][0]["action"]["command"][3] = json!("{name}")), at, "can't start an argument"));
        assert!(has(with(|s| s["panels"][0]["action"]["command"][3] = json!("{users}{name}")), at, "can't start an argument"));
        assert!(errors(with(|s| s["panels"][0]["action"]["command"][3] = json!("--name={name}"))).is_empty());
        // Numbers and options are constrained by their field, so they may stand alone (the base spec does).
        assert!(errors(base()).is_empty());
    }

    #[test]
    fn options_can_not_hold_a_comma_or_repeat() {
        assert!(has(with(|s| s["panels"][0]["fields"][2]["options"][0] = json!("a,b")), "panels[0].fields[2].options[0]", "comma"));
        assert!(has(with(|s| s["panels"][0]["fields"][2]["options"][1] = json!("approvals")), "panels[0].fields[2].options[1]", "twice"));
        assert!(has(with(|s| s["panels"][0]["fields"][2]["options"][0] = json!("")), "panels[0].fields[2].options[0]", "1 to"));
        assert!(has(with(|s| { s["panels"][0]["fields"][0].as_object_mut().unwrap().remove("options"); }), "panels[0].fields[0].options", "needs a list"));
        assert!(has(with(|s| s["panels"][0]["fields"][3]["options"] = json!(["a"])), "panels[0].fields[3].options", "only a select"));
    }

    #[test]
    fn ids_must_be_valid_and_unique() {
        assert!(has(with(|s| s["panels"][0]["id"] = json!("1org")), "panels[0].id", "start with a letter"));
        assert!(has(with(|s| s["panels"][0]["id"] = json!("a b")), "panels[0].id", "start with a letter"));
        assert!(has(with(|s| s["panels"][0]["fields"][1]["id"] = json!("staging")), "panels[0].fields[1].id", "another field"));
        assert!(has(with(|s| { s["panels"][1]["id"] = json!("org"); }), "panels[1].id", "another panel"));
        assert!(has(with(|s| s["panels"][1]["of"] = json!("ghost")), "panels[1].of", "no form with the id"));
        assert!(has(with(|s| { s["panels"][0]["fields"][0].as_object_mut().unwrap().remove("id"); }), "panels[0].fields[0].id", "needs an id"));
    }

    #[test]
    fn unknown_types_and_keys_are_named() {
        assert!(has(with(|s| s["panels"][1]["type"] = json!("chart")), "panels[1].type", "unknown panel type"));
        assert!(has(with(|s| { s["panels"][1].as_object_mut().unwrap().remove("type"); }), "panels[1].type", "needs a type"));
        assert!(has(with(|s| s["panels"][0]["fields"][0]["type"] = json!("date")), "panels[0].fields[0].type", "unknown field type"));
        assert!(has(with(|s| s["panels"][0]["fields"][0]["colour"] = json!("red")), "panels[0].fields[0].colour", "not a known key"));
        assert!(has(with(|s| s["panels"][0]["action"]["comand"] = json!([])), "panels[0].action.comand", "not a known key"));
        assert!(has(with(|s| s["panels"][0]["action"]["output"] = json!("xml")), "panels[0].action.output", "json"));
        assert!(has(with(|s| s["panels"][2] = json!(5)), "panels[2]", "must be an object"));
    }

    #[test]
    fn a_form_needs_its_action() {
        assert!(has(with(|s| { s["panels"][0].as_object_mut().unwrap().remove("action"); }), "panels[0].action", "needs an action"));
        assert!(has(with(|s| s["panels"][0]["action"] = json!("run")), "panels[0].action", "must be an object"));
    }

    #[test]
    fn defaults_must_fit_their_field() {
        assert!(has(with(|s| s["panels"][0]["fields"][1]["default"] = json!("two")), "panels[0].fields[1].default", "doesn't match"));
        assert!(has(with(|s| s["panels"][0]["fields"][1]["default"] = json!(0)), "panels[0].fields[1].default", "outside"));
        assert!(has(with(|s| s["panels"][0]["fields"][0]["default"] = json!("9")), "panels[0].fields[0].default", "isn't one of"));
        assert!(has(with(|s| s["panels"][0]["fields"][2]["default"] = json!(["sso", "sso"])), "panels[0].fields[2].default", "twice"));
        assert!(has(with(|s| s["panels"][0]["fields"][2]["default"] = json!(["x"])), "panels[0].fields[2].default", "isn't one of"));
        assert!(has(with(|s| s["panels"][0]["fields"][4]["default"] = json!("yes")), "panels[0].fields[4].default", "doesn't match"));
        assert!(has(with(|s| s["panels"][0]["fields"][3]["default"] = json!("x".repeat(1025))), "panels[0].fields[3].default", "longer than"));
    }

    #[test]
    fn ranges_are_checked() {
        assert!(has(with(|s| s["panels"][0]["fields"][1]["max"] = json!(0)), "panels[0].fields[1].min", "larger than max"));
        assert!(has(with(|s| s["panels"][0]["fields"][1]["min"] = json!("a")), "panels[0].fields[1].min", "must be a number"));
        assert!(has(with(|s| s["panels"][0]["fields"][3]["min"] = json!(1)), "panels[0].fields[3].min", "only a number"));
    }

    #[test]
    fn the_list_of_issues_is_capped() {
        let spec = json!({ "title": "x", "panels": (0..30).map(|_| json!(1)).collect::<Vec<_>>() });
        assert_eq!(errors(spec).len(), MAX_ISSUES);
    }

    #[test]
    fn placeholders_are_found_where_they_are() {
        assert_eq!(placeholders("--a={b}-{c_d}"), vec![(4, "b".to_string()), (8, "c_d".to_string())]);
        assert!(placeholders("{}").is_empty());
        assert!(placeholders("{a b}").is_empty());
        assert!(placeholders("{unclosed").is_empty());
        assert!(placeholders("{{a}").len() == 1);
    }

    #[test]
    fn the_shared_fixture_matches_what_the_checker_makes_of_it() {
        // src/lib/dashboard.test.ts reads the same two files, so the TypeScript types can't drift from what this produces.
        // To regenerate the output after changing the format: UPDATE_FIXTURES=1 cargo test dashboard::tests::the_shared_fixture
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let input = std::fs::read_to_string(dir.join("dashboard.input.json")).unwrap();
        let made = serde_json::to_string_pretty(&parse(&input).unwrap()).unwrap() + "\n";
        let output = dir.join("dashboard.spec.json");
        if std::env::var("UPDATE_FIXTURES").is_ok() {
            std::fs::write(&output, &made).unwrap();
        }
        assert_eq!(made, std::fs::read_to_string(&output).unwrap(), "dashboard.spec.json is out of date; rerun with UPDATE_FIXTURES=1");
    }

    // MARK: - Reading a folder

    fn folder_with(files: &[(&str, &str)]) -> tempfile::TempDir {
        let folder = tempfile::tempdir().unwrap();
        let dir = folder.path().join(".lantern/dashboards");
        std::fs::create_dir_all(&dir).unwrap();
        for (name, text) in files {
            std::fs::write(dir.join(name), text).unwrap();
        }
        folder
    }

    #[test]
    fn a_folder_without_dashboards_has_none() {
        assert!(load(tempfile::tempdir().unwrap().path()).is_empty());
        assert!(load(folder_with(&[]).path()).is_empty());
    }

    #[test]
    fn files_are_read_by_name_and_only_json_ones() {
        let good = base().to_string();
        let folder = folder_with(&[("b.json", &good), ("a.json", "{"), ("notes.txt", "x"), (".hidden.json", &good)]);
        let found = load(folder.path());
        assert_eq!(found.iter().map(|d| d.file.as_str()).collect::<Vec<_>>(), ["a.json", "b.json"]);
        assert!(found[0].spec.is_none() && found[0].issues[0].message.contains("not valid JSON"));
        assert!(found[1].spec.is_some() && found[1].issues.is_empty());
    }

    #[test]
    fn the_hash_is_of_the_bytes_that_were_read() {
        let good = base().to_string();
        let one = load(folder_with(&[("a.json", &good)]).path());
        let same = load(folder_with(&[("a.json", &good)]).path());
        let edited = load(folder_with(&[("a.json", &format!("{good} "))]).path());
        assert_eq!(one[0].hash.len(), 64);
        assert_eq!(one[0].hash, same[0].hash);
        assert_ne!(one[0].hash, edited[0].hash);
        // The hash is known for a file that doesn't check out too (so an edited file is never "the trusted one").
        assert!(!load(folder_with(&[("a.json", "{")]).path())[0].hash.is_empty());
    }

    #[test]
    fn a_big_or_binary_file_is_refused() {
        let big = " ".repeat(MAX_FILE_BYTES as usize + 1);
        let folder = folder_with(&[("big.json", &big)]);
        std::fs::write(folder.path().join(".lantern/dashboards/bin.json"), [0xff, 0xfe, 0x00]).unwrap();
        let found = load(folder.path());
        assert!(found[0].file == "big.json" && found[0].issues[0].message.contains("larger than"));
        assert!(found[1].file == "bin.json" && found[1].issues[0].message.contains("UTF-8"));
        assert!(found.iter().all(|d| d.spec.is_none()));
    }

    #[test]
    fn symlinks_are_not_followed() {
        use std::os::unix::fs::symlink;
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.json"), base().to_string()).unwrap();
        // A linked file.
        let folder = folder_with(&[]);
        symlink(outside.path().join("secret.json"), folder.path().join(".lantern/dashboards/linked.json")).unwrap();
        let found = load(folder.path());
        assert!(found[0].spec.is_none() && found[0].issues[0].message.contains("symlink"));
        // A linked dashboards folder, and a linked .lantern folder.
        let linked_dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(linked_dir.path().join(".lantern")).unwrap();
        symlink(outside.path(), linked_dir.path().join(".lantern/dashboards")).unwrap();
        assert!(load(linked_dir.path()).is_empty());
        let linked_root = tempfile::tempdir().unwrap();
        symlink(outside.path(), linked_root.path().join(".lantern")).unwrap();
        assert!(load(linked_root.path()).is_empty());
    }

    #[test]
    fn only_the_first_files_are_read() {
        let good = base().to_string();
        let names: Vec<String> = (0..MAX_FILES + 3).map(|i| format!("d{i:02}.json")).collect();
        let files: Vec<(&str, &str)> = names.iter().map(|n| (n.as_str(), good.as_str())).collect();
        assert_eq!(load(folder_with(&files).path()).len(), MAX_FILES);
    }
}
