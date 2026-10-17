//! "Always allow" rules. A rule answers a permission request in the app, without a card, when the request is one it
//! matches. Rules only ever allow: Deny always asks. They're Lantern's own (never written to Claude Code's settings),
//! and a folder's are saved in app data. A rule is conservative by design: when in doubt it doesn't match, and the card
//! comes up as it would have anyway.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::os::unix::fs::MetadataExt;
use std::sync::Mutex;

/// Where a rule applies: this chat only (kept in memory with the chat), or every chat in a folder (saved).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Chat,
    Folder,
}

/// What a rule matches within its tool's input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Matcher {
    /// Every call to the tool. Not for Bash, which always needs a command to match.
    Any,
    /// Bash: exactly this command.
    Exact { text: String },
    /// Bash: a command that starts with these one or two words, followed by anything.
    Prefix { text: String },
    /// A file tool: a file at or under this absolute folder.
    Dir { path: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    pub tool: String,
    #[serde(flatten)]
    pub matcher: Matcher,
}

/// A rule the user made on a card, and where it applies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewRule {
    pub scope: Scope,
    #[serde(flatten)]
    pub rule: Rule,
}

/// A rule as Settings lists it. `folder` is the folder a folder rule is for (None for a chat rule).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleEntry {
    pub scope: Scope,
    pub folder: Option<String>,
    #[serde(flatten)]
    pub rule: Rule,
}

/// Tools no rule answers: their card carries something the user must read or answer (a plan, a question, a bug to
/// reproduce, an action to approve: an approval is for that one call, so nothing can be remembered for it).
const NEVER_AUTO: &[&str] = &["ExitPlanMode", "AskUserQuestion", "Reproduce", "Approval"];
/// Lantern's own MCP tools (its permission prompt, reproduce and approval requests), which are never a rule's tool.
const OWN_TOOL_PREFIX: &str = "mcp__lantern__";
/// Claude Code's file tools: each one's path key (the key it acts on), and every key its input may have. A rule checks
/// the path under the tool's own key, and an input with any other key isn't one to allow by rule.
const FILE_TOOLS: &[(&str, &str, &[&str])] = &[
    ("Read", "file_path", &["file_path", "offset", "limit", "pages"]),
    ("Write", "file_path", &["file_path", "content"]),
    ("Edit", "file_path", &["file_path", "old_string", "new_string", "replace_all"]),
    ("MultiEdit", "file_path", &["file_path", "edits"]),
    ("NotebookEdit", "notebook_path", &["notebook_path", "cell_id", "cell_type", "edit_mode", "new_source"]),
];
/// The Bash input keys a rule can read. Any other (`dangerouslyDisableSandbox`, say) means the call isn't one to allow
/// by rule.
const BASH_KEYS: &[&str] = &["command", "description", "timeout", "run_in_background"];
/// Programs that run other commands. A rule for one of them would allow whatever it's given, so none can be made.
const WRAPPERS: &[&str] = &["sh", "bash", "zsh", "dash", "fish", "ksh", "env", "sudo", "su", "doas", "xargs", "eval", "exec", "command", "nohup", "time", "timeout", "nice", "ssh", "npx", "bunx", "pnpx", "uvx", "pipx"];
/// Programs a Prefix can't start with: interpreters, and tools whose flags run or destroy things (find -delete, sed -i,
/// curl -o). An Exact rule for one command is still fine.
const DENIED_FIRST: &[&str] = &[
    "python", "node", "deno", "bun", "ruby", "perl", "php", "awk", "gawk", "sed", "find", "rm", "rmdir", "mv", "cp", "dd", "chmod", "chown", "curl", "wget", "tee", "make", "osascript", "open", "ln", "truncate", "shred", "tar", "unzip", "rsync", "scp", "nc", "ncat", "telnet", "kill", "killall", "pkill", "launchctl", "defaults", "security", "networksetup", "diskutil", "hdiutil", "crontab", "at", "tmux", "screen", "script", "expect", "swift", "xcodebuild", "gcc", "clang", "cc",
];
/// The Bash prefixes a rule can be made of: a program and the subcommand after it, or for the programs that only read, the
/// program alone. Read-only, build and test commands only. Anything else (runners, installs, pushes, a program not here)
/// can only be an Exact rule for one command. The first word is matched exactly, so a path, a version or another
/// spelling of one of these isn't one of them.
///
/// Not here, though they look harmless: `npm install`, `npm ci`, `yarn install` and `pnpm install` run the project's
/// dependency scripts, and `npm audit` can fix (its prefix covers `audit fix`). Those are Exact-only.
const VETTED: &[(&str, &[&str])] = &[
    ("git", &["status", "diff", "log", "show", "branch", "rev-parse"]),
    ("npm", &["test"]),
    ("cargo", &["test", "check", "build", "clippy"]),
    ("go", &["test", "vet"]),
    ("ls", &[]),
    ("pwd", &[]),
    ("which", &[]),
    ("whoami", &[]),
    ("date", &[]),
];

/// The flags a vetted command takes after its prefix. Any other flag (one with a value, --output, --target-dir, -C...)
/// means the rule doesn't match and the card comes up. A list of flags that are known to only read or to build here, not
/// a denylist: a test runner can write files through many flags, so none is trusted that isn't listed. For `git` also
/// `-n`, `-<digits>` (like -5) and `--format=<plain token>` (see `flag_allowed`).
fn benign_flags(prefix: &str) -> &'static [&'static str] {
    match prefix {
        "git status" | "git diff" | "git log" | "git show" | "git branch" => &["--oneline", "--stat", "--name-only", "--name-status", "--porcelain", "--short", "--no-color", "--cached"],
        "ls" => &["-l", "-a", "-la", "-lh", "-R"],
        "cargo test" | "cargo check" | "cargo build" | "cargo clippy" => &["--release", "--all", "--workspace", "--lib", "--quiet", "-q"],
        "go test" | "go vet" => &["-v"],
        _ => &[],
    }
}

/// A plain token: letters, digits and `_ - . / : @ + ,`. Nothing that a shell would expand or group.
fn plain_token(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_-./:@+,".contains(c))
}

/// Whether a flag after a vetted prefix is one it takes.
fn flag_allowed(prefix: &str, flag: &str) -> bool {
    if benign_flags(prefix).contains(&flag) {
        return true;
    }
    if !prefix.starts_with("git ") {
        return false;
    }
    flag == "-n"
        || flag.strip_prefix('-').is_some_and(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit()))
        || flag.strip_prefix("--format=").is_some_and(plain_token)
}

/// Whether the arguments after a vetted prefix are all allowed: flags it takes, and positional tokens that are plain and
/// stay inside the folder (no absolute path, no `..`). `git branch` takes none, since a name would create a branch.
fn arguments_allowed(prefix: &str, args: &[&str]) -> bool {
    args.iter().all(|arg| {
        if arg.starts_with('-') {
            flag_allowed(prefix, arg)
        } else {
            !(prefix == "git branch" || arg.starts_with('/') || arg.contains("..")) && plain_token(arg)
        }
    })
}
/// The characters a rule's words can have. Anything else (quotes, operators, globs, `$`) keeps a command from matching.
const WORD_CHARS: &str = "-_./:@=+,";

/// Whether a command is plain enough to match a rule: no shell operators, substitutions, globs or escapes, and no
/// control characters, so that a space is the only thing that separates its words.
pub fn is_plain(command: &str) -> bool {
    !command.chars().any(|c| c.is_control() || ";&|<>()$`\\*?[]{}".contains(c))
}

/// The program a first word names, spelled plainly: lowercase, without a directory, a version (python3.12 is python)
/// or a "js" (nodejs is node). Spellings only ever reduce to a listed name, so the lists match more of them.
fn program_name(word: &str) -> String {
    let mut name = word.rsplit('/').next().unwrap_or(word).to_ascii_lowercase();
    loop {
        let trimmed = name.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
        let next = trimmed.strip_suffix("js").filter(|s| !s.is_empty()).unwrap_or(trimmed);
        if next.len() == name.len() {
            return name;
        }
        name = next.to_string();
    }
}

/// Whether a prefix's words are a vetted command (see VETTED): one program that only reads, or a program and its subcommand.
fn vetted(words: &[&str]) -> bool {
    let (program, sub) = match words {
        [program] => (*program, None),
        [program, sub] => (*program, Some(*sub)),
        _ => return false,
    };
    VETTED.iter().any(|(name, subs)| *name == program && sub.map_or(subs.is_empty(), |s| subs.contains(&s)))
}

/// A Bash prefix's words, if it can be one: a vetted command (VETTED) of plain characters, none of them an option. The
/// program must also not be a wrapper or a denied program (DENIED_FIRST, judged by its normalised name): a second layer,
/// behind the list.
fn prefix_words(text: &str) -> Option<Vec<&str>> {
    let words: Vec<&str> = text.split(' ').collect();
    let name = program_name(words[0]);
    let ok = text.len() >= 2
        && vetted(&words)
        && !WRAPPERS.contains(&name.as_str())
        && !DENIED_FIRST.contains(&name.as_str())
        && words.iter().all(|w| !w.is_empty() && !w.starts_with('-') && w.chars().all(|c| c.is_ascii_alphanumeric() || WORD_CHARS.contains(c)));
    ok.then_some(words)
}

fn prefix_matches(text: &str, command: &str) -> bool {
    let Some(words) = prefix_words(text) else { return false };
    // A quote groups words the way the shell does, not the way the split below does, so a command with one is left to a card.
    if !is_plain(command) || command.contains(['\'', '"']) {
        return false;
    }
    let given: Vec<&str> = command.split(' ').filter(|w| !w.is_empty()).collect();
    given.len() >= words.len() && given[..words.len()] == words[..] && arguments_allowed(text, &given[words.len()..])
}

/// The command of a Bash call, if its input has only keys a rule can read.
fn bash_command<'a>(tool: &str, input: &'a Value) -> Option<&'a str> {
    if tool != "Bash" {
        return None;
    }
    let obj = input.as_object()?;
    if obj.keys().any(|k| !BASH_KEYS.contains(&k.as_str())) {
        return None;
    }
    obj.get("command")?.as_str()
}

/// Names that no file-tool rule covers: git's own config, hooks and attributes, and the config of Claude Code, editors and
/// git helpers. A write to one of these can make a later command that's allowed run code (a git config's pager or
/// fsmonitor, a hook), so a rule that reached one would compose into code execution. The check is on the resolved path.
/// Also the build and package files that the vetted commands run or read (`npm test` runs package.json's scripts, `cargo
/// build` runs build.rs and reads .cargo/config.toml, `make` runs Makefile): a rule doesn't cover those either.
const PROTECTED_NAMES: &[&str] = &[
    ".git", ".claude", ".mcp.json", ".vscode", ".idea", ".husky", ".gitmodules", ".gitattributes", ".gitconfig", ".envrc", ".cargo", ".npmrc", ".yarnrc", ".yarnrc.yml", ".yarn", ".pnpmfile.cjs", ".githooks", ".pre-commit-config.yaml", ".cursor", ".zed", "package.json", "Cargo.toml", "build.rs", "Makefile", "go.mod",
];

/// Whether a path has a component no file-tool rule covers (see PROTECTED_NAMES). Names match in any case: macOS
/// filesystems are case-insensitive by default, so `.GIT` is `.git`.
fn protected(path: &str) -> bool {
    Path::new(path).components().any(|c| matches!(c, Component::Normal(name) if name.to_str().is_some_and(|s| PROTECTED_NAMES.iter().any(|p| s.eq_ignore_ascii_case(p)))))
}

/// A path that is absolute and has no `..` in it.
fn plain_path(path: &str) -> bool {
    let p = Path::new(path);
    p.is_absolute() && !path.contains('\0') && !p.components().any(|c| matches!(c, Component::ParentDir))
}

/// The file a file tool acts on, if its input is one a rule can read: only the keys that tool takes, and a plain path
/// under the key it acts on.
fn file_path<'a>(tool: &str, input: &'a Value) -> Option<&'a str> {
    let (key, keys) = file_tool(tool)?;
    let obj = input.as_object()?;
    if obj.keys().any(|k| !keys.contains(&k.as_str())) {
        return None;
    }
    let path = obj.get(key)?.as_str()?;
    plain_path(path).then_some(path)
}

/// A file tool's path key and the keys its input may have, if it's a file tool.
fn file_tool(tool: &str) -> Option<(&'static str, &'static [&'static str])> {
    FILE_TOOLS.iter().find(|(name, _, _)| *name == tool).map(|(_, key, keys)| (*key, *keys))
}

/// `path` with symlinks resolved. A part that doesn't exist yet has no links in it, so it's kept as written. A link
/// that goes nowhere (or can't be followed) gives None: nothing matches through it, since the file it leads to can't
/// be told apart from one outside the folder.
pub fn resolve(path: &Path) -> Option<PathBuf> {
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    let mut at = path;
    loop {
        match std::fs::symlink_metadata(at) {
            // Exists, a link included: followed to where it really is.
            Ok(_) => {
                let real = std::fs::canonicalize(at).ok()?;
                // A hard link is a second name for a file that may sit anywhere (a .git config, say), and its own path doesn't
                // show that. A file with more than one name isn't one a rule can place, so nothing matches it.
                if std::fs::metadata(&real).is_ok_and(|m| m.is_file() && m.nlink() > 1) {
                    return None;
                }
                return Some(rest.iter().rev().fold(real, |acc, part| acc.join(part)));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                rest.push(at.file_name()?.to_os_string());
                at = at.parent()?;
            }
            Err(_) => return None,
        }
    }
}

/// The input as rules see it: a file tool's path resolved (see `resolve`), so a link inside a folder can't pass as a
/// file in it. Matched on this; the tool still gets its input as Claude sent it. A path that can't be resolved becomes
/// null, which matches nothing.
pub fn for_matching(tool: &str, input: &Value) -> Value {
    let Some((key, _)) = file_tool(tool) else { return input.clone() };
    if !input.is_object() {
        return input.clone();
    }
    let mut out = input.clone();
    out[key] = match file_path(tool, input).and_then(|p| resolve(Path::new(p))) {
        Some(real) => Value::String(real.display().to_string()),
        None => Value::Null,
    };
    out
}

/// The key a folder is saved under: its real path, as the chat sees it.
pub fn folder_key(folder: &Path) -> String {
    resolve(folder).unwrap_or_else(|| folder.to_path_buf()).display().to_string()
}

/// Whether `rule` allows this call. `input` should come through `for_matching`. False for any tool a rule can't answer,
/// and for input this can't read.
///
/// A file path is resolved when the request arrives, and the tool runs after that answer. A rule can't see a link that's
/// changed while the command is starting, so a link swapped in between the check and the write isn't caught. Nothing in
/// Lantern can close that gap; a folder rule covers the files you expect to see, not a sandbox.
pub fn matches(rule: &Rule, tool: &str, input: &Value) -> bool {
    if rule.tool != tool || NEVER_AUTO.contains(&tool) || tool.starts_with(OWN_TOOL_PREFIX) || !input.is_object() {
        return false;
    }
    match &rule.matcher {
        Matcher::Any if tool == "Bash" => false,
        Matcher::Any if file_tool(tool).is_some() => file_path(tool, input).is_some_and(|p| !protected(p)),
        Matcher::Any => true,
        Matcher::Exact { text } => bash_command(tool, input).is_some_and(|c| c == text.as_str() && is_plain(text)),
        Matcher::Prefix { text } => bash_command(tool, input).is_some_and(|c| prefix_matches(text, c)),
        Matcher::Dir { path } => file_path(tool, input).is_some_and(|p| Path::new(p).starts_with(path) && !protected(p)),
    }
}

/// The rule as it will be kept (a folder's path resolved), or why it can't be. Only rules this accepts are made, and
/// loaded rules are checked against it again.
pub fn validate(rule: &Rule) -> Result<Rule, String> {
    let tool = rule.tool.as_str();
    if tool.is_empty() || tool.len() > 100 || tool.chars().any(char::is_control) || NEVER_AUTO.contains(&tool) || tool.starts_with(OWN_TOOL_PREFIX) {
        return Err(format!("Lantern can't make a rule for {tool:?}."));
    }
    let matcher = match &rule.matcher {
        Matcher::Any if tool != "Bash" => Matcher::Any,
        Matcher::Exact { text } if tool == "Bash" && text.len() >= 2 && is_plain(text) => rule.matcher.clone(),
        Matcher::Prefix { text } if tool == "Bash" && prefix_words(text).is_some() => rule.matcher.clone(),
        Matcher::Dir { path } if file_tool(tool).is_some() && plain_path(path) && path != "/" && path.len() <= 4096 => {
            let real = resolve(Path::new(path)).ok_or("That folder's path goes through a link that leads nowhere.")?.display().to_string();
            if protected(&real) {
                return Err("Lantern doesn't make folder rules over git, editor or Claude config folders (.git, .claude, .vscode...).".into());
            }
            Matcher::Dir { path: real }
        }
        _ => return Err(format!("A rule for {tool} can't match that way.")),
    };
    Ok(Rule { tool: rule.tool.clone(), matcher })
}

/// The folder rules, saved as JSON by folder (the chat's folder key). A file that doesn't parse is moved aside, not
/// overwritten, like titles.json.
pub struct FolderRules {
    path: Option<PathBuf>,
    rules: Mutex<BTreeMap<String, Vec<Rule>>>,
}

impl FolderRules {
    pub fn load(path: Option<PathBuf>) -> Self {
        let rules = path.as_deref().map(read_rules).unwrap_or_default();
        Self { path, rules: Mutex::new(rules) }
    }

    pub fn for_folder(&self, folder: &str) -> Vec<Rule> {
        self.rules.lock().unwrap().get(folder).cloned().unwrap_or_default()
    }

    pub fn all(&self) -> Vec<(String, Vec<Rule>)> {
        self.rules.lock().unwrap().iter().map(|(f, r)| (f.clone(), r.clone())).collect()
    }

    /// Adds a validated rule for a folder (a rule already there isn't added twice).
    pub fn add(&self, folder: &str, rule: Rule) {
        let mut rules = self.rules.lock().unwrap();
        let list = rules.entry(folder.to_string()).or_default();
        if !list.contains(&rule) {
            list.push(rule);
        }
        self.save(&rules);
    }

    pub fn remove(&self, folder: &str, rule: &Rule) {
        let mut rules = self.rules.lock().unwrap();
        if let Some(list) = rules.get_mut(folder) {
            list.retain(|r| r != rule);
            if list.is_empty() {
                rules.remove(folder);
            }
        }
        self.save(&rules);
    }

    fn save(&self, rules: &BTreeMap<String, Vec<Rule>>) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Written beside the file and renamed over it, so a write cut short can't leave a truncated file.
        let tmp = path.with_extension("json.tmp");
        if let Ok(json) = serde_json::to_string_pretty(rules) {
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }
}

/// The rules saved at `path`, each checked again (a hand-edited one that wouldn't be made is dropped).
fn read_rules(path: &Path) -> BTreeMap<String, Vec<Rule>> {
    let Ok(bytes) = std::fs::read(path) else { return BTreeMap::new() };
    match serde_json::from_slice::<BTreeMap<String, Vec<Rule>>>(&bytes) {
        Ok(saved) => saved.into_iter().map(|(folder, rules)| (folder, rules.iter().filter_map(|r| validate(r).ok()).collect())).filter(|(_, r): &(String, Vec<Rule>)| !r.is_empty()).collect(),
        Err(_) => {
            let _ = std::fs::rename(path, path.with_extension("json.corrupt"));
            BTreeMap::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bash(matcher: Matcher) -> Rule {
        Rule { tool: "Bash".into(), matcher }
    }
    fn prefix(text: &str) -> Rule {
        bash(Matcher::Prefix { text: text.into() })
    }
    fn exact(text: &str) -> Rule {
        bash(Matcher::Exact { text: text.into() })
    }
    fn cmd(command: &str) -> Value {
        json!({"command": command})
    }

    #[test]
    fn a_prefix_covers_its_words_and_whatever_follows_them() {
        let r = prefix("git status");
        for c in ["git status", "git status --short", "git  status --porcelain", " git status"] {
            assert!(matches(&r, "Bash", &cmd(c)), "{c:?}");
        }
    }

    #[test]
    fn a_prefix_ends_at_a_word_boundary() {
        let r = prefix("git status");
        for c in ["git statusx", "git status-x", "git stat", "git", "git-status", "gitstatus", "xgit status", "git stash", "git log status"] {
            assert!(!matches(&r, "Bash", &cmd(c)), "{c:?}");
        }
    }

    #[test]
    fn shell_operators_and_substitutions_never_ride_on_a_prefix() {
        let r = prefix("npm test");
        for c in [
            "npm test; rm -rf ~",
            "npm test && rm x",
            "npm test || rm x",
            "npm test | sh",
            "npm test & rm x",
            "npm test `rm x`",
            "npm test $(rm x)",
            "npm test ${HOME}",
            "npm test $HOME",
            "npm test > /etc/hosts",
            "npm test < x",
            "npm test <(rm x)",
            "npm test\nrm x",
            "npm test\rrm x",
            "npm test\trm x",
            "npm test \\; rm x",
            "npm test *",
            "npm test ?",
            "npm test [a]",
            "npm test {a,b}",
            "(npm test)",
        ] {
            assert!(!matches(&r, "Bash", &cmd(c)), "{c:?}");
        }
    }

    #[test]
    fn a_command_that_starts_differently_never_matches() {
        let r = prefix("npm test");
        for c in ["FOO=1 npm test", "env npm test", "npm tests", "pnpm test", "npmtest", "./npm test"] {
            assert!(!matches(&r, "Bash", &cmd(c)), "{c:?}");
        }
    }

    #[test]
    fn an_exact_command_matches_only_itself() {
        let r = exact("npm test");
        assert!(matches(&r, "Bash", &cmd("npm test")));
        for c in ["npm test -- x", "npm tests", "npm test ", "npm test;", "npm test\n"] {
            assert!(!matches(&r, "Bash", &cmd(c)), "{c:?}");
        }
    }

    #[test]
    fn bash_input_is_read_only_when_every_key_is_known() {
        let r = prefix("npm test");
        assert!(matches(&r, "Bash", &json!({"command": "npm test", "description": "run", "timeout": 5, "run_in_background": false})));
        assert!(!matches(&r, "Bash", &json!({"command": "npm test", "dangerouslyDisableSandbox": true})));
        assert!(!matches(&r, "Bash", &json!({"cmd": "npm test"})));
        assert!(!matches(&r, "Bash", &json!({"command": 5})));
        assert!(!matches(&r, "Bash", &json!("npm test")));
    }

    #[test]
    fn bash_never_matches_every_call() {
        assert!(!matches(&bash(Matcher::Any), "Bash", &cmd("rm -rf x")));
    }

    #[test]
    fn tools_no_rule_answers_are_never_matched() {
        for tool in ["ExitPlanMode", "AskUserQuestion", "Reproduce", "Approval", "mcp__lantern__approve", "mcp__lantern__reproduce", "mcp__lantern__request_approval"] {
            let r = Rule { tool: tool.into(), matcher: Matcher::Any };
            assert!(!matches(&r, tool, &json!({"x": 1})), "{tool}");
        }
    }

    #[test]
    fn other_tools_match_by_their_full_name() {
        let r = Rule { tool: "mcp__linear__save_issue".into(), matcher: Matcher::Any };
        assert!(matches(&r, "mcp__linear__save_issue", &json!({"title": "x"})));
        assert!(!matches(&r, "mcp__linear__save_issues", &json!({})));
        assert!(!matches(&r, "mcp__linear__save_issue", &json!("not an object")));
    }

    #[test]
    fn a_folder_covers_the_files_under_it_and_nothing_else() {
        let r = Rule { tool: "Edit".into(), matcher: Matcher::Dir { path: "/Users/a/proj".into() } };
        assert!(matches(&r, "Edit", &json!({"file_path": "/Users/a/proj/src/x.ts"})));
        assert!(matches(&r, "Edit", &json!({"file_path": "/Users/a/proj"})));
        for p in ["/Users/a/projx/x.ts", "/Users/a/proj/../secret", "src/x.ts", "/etc/passwd", "/Users/a/pro", ""] {
            assert!(!matches(&r, "Edit", &json!({"file_path": p})), "{p:?}");
        }
        assert!(!matches(&r, "Edit", &json!({"path": "/Users/a/proj/x"})));
        assert!(!matches(&r, "Write", &json!({"file_path": "/Users/a/proj/x"})));
    }

    #[test]
    fn a_file_tool_with_any_file_still_needs_a_plain_path() {
        let r = Rule { tool: "Read".into(), matcher: Matcher::Any };
        assert!(matches(&r, "Read", &json!({"file_path": "/a/b"})));
        assert!(!matches(&r, "Read", &json!({"file_path": "b"})));
        assert!(!matches(&r, "Read", &json!({"file_path": "/a/../b"})));
        assert!(!matches(&r, "Read", &json!({})));
    }

    #[test]
    fn notebooks_use_their_notebook_path() {
        let r = Rule { tool: "NotebookEdit".into(), matcher: Matcher::Dir { path: "/p".into() } };
        assert!(matches(&r, "NotebookEdit", &json!({"notebook_path": "/p/n.ipynb"})));
    }

    #[test]
    fn a_matcher_only_goes_with_the_tools_it_is_for() {
        assert!(!matches(&Rule { tool: "Edit".into(), matcher: Matcher::Exact { text: "npm test".into() } }, "Edit", &json!({"file_path": "/a"})));
        assert!(!matches(&Rule { tool: "Bash".into(), matcher: Matcher::Dir { path: "/a".into() } }, "Bash", &cmd("ls")));
    }

    #[test]
    fn only_rules_that_match_as_intended_are_made() {
        for good in [prefix("npm test"), prefix("ls"), prefix("cargo check"), exact("npm test -- --grep \"a b\""), Rule { tool: "Edit".into(), matcher: Matcher::Any }, Rule { tool: "mcp__linear__x".into(), matcher: Matcher::Any }] {
            assert!(validate(&good).is_ok(), "{good:?}");
        }
        let bad = [
            prefix(""),
            prefix("a"),
            prefix("*"),
            prefix(" npm"),
            prefix("npm test extra words"),
            prefix("npm;rm"),
            prefix("npm$x"),
            prefix("npm -e"),
            prefix("npm"),
            prefix("-x"),
            prefix("sh"),
            prefix("bash -c"),
            prefix("env"),
            prefix("sudo rm"),
            exact(""),
            exact("x"),
            exact("npm test\nrm"),
            bash(Matcher::Any),
            bash(Matcher::Dir { path: "/a".into() }),
            Rule { tool: "Edit".into(), matcher: Matcher::Prefix { text: "npm test".into() } },
            Rule { tool: "Edit".into(), matcher: Matcher::Dir { path: "rel/x".into() } },
            Rule { tool: "Edit".into(), matcher: Matcher::Dir { path: "/a/../b".into() } },
            Rule { tool: "Edit".into(), matcher: Matcher::Dir { path: "/".into() } },
            Rule { tool: "mcp__linear__x".into(), matcher: Matcher::Dir { path: "/a".into() } },
            Rule { tool: "AskUserQuestion".into(), matcher: Matcher::Any },
            Rule { tool: "ExitPlanMode".into(), matcher: Matcher::Any },
            Rule { tool: "mcp__lantern__approve".into(), matcher: Matcher::Any },
            Rule { tool: "".into(), matcher: Matcher::Any },
        ];
        for b in bad {
            assert!(validate(&b).is_err(), "{b:?}");
        }
    }

    #[test]
    fn a_folder_rule_is_kept_by_its_real_path() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, dir.path().join("alias")).unwrap();
        let rule = Rule { tool: "Edit".into(), matcher: Matcher::Dir { path: dir.path().join("alias").display().to_string() } };
        assert_eq!(validate(&rule).unwrap().matcher, Matcher::Dir { path: std::fs::canonicalize(&real).unwrap().display().to_string() });
    }

    #[test]
    fn a_symlink_inside_the_folder_does_not_pass_as_a_file_in_it() {
        let dir = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(dir.path()).unwrap().join("proj");
        let outside = std::fs::canonicalize(dir.path()).unwrap().join("outside");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, folder.join("link")).unwrap();
        let rule = Rule { tool: "Read".into(), matcher: Matcher::Dir { path: folder.display().to_string() } };
        let asked = json!({"file_path": folder.join("link/secret.txt").display().to_string()});
        assert!(!matches(&rule, "Read", &for_matching("Read", &asked)));
        let inside = json!({"file_path": folder.join("src/new.txt").display().to_string()});
        assert!(matches(&rule, "Read", &for_matching("Read", &inside)));
        // Matching resolves the path but the tool still gets its input as Claude sent it.
        assert_eq!(for_matching("Bash", &cmd("ls")), cmd("ls"));
    }

    #[test]
    fn a_link_to_a_file_not_there_yet_is_not_taken_for_a_file_in_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let folder = root.join("proj");
        let other = root.join("other");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        // A dangling link: its target doesn't exist yet, so a Write through it would create the file outside the folder.
        std::os::unix::fs::symlink(other.join("new.txt"), folder.join("link")).unwrap();
        let asked = json!({"file_path": folder.join("link").display().to_string(), "content": "x"});
        let dir_rule = Rule { tool: "Write".into(), matcher: Matcher::Dir { path: folder.display().to_string() } };
        assert!(!matches(&dir_rule, "Write", &for_matching("Write", &asked)));
        let any_rule = Rule { tool: "Write".into(), matcher: Matcher::Any };
        assert!(!matches(&any_rule, "Write", &for_matching("Write", &asked)));
    }

    #[test]
    fn a_file_tool_acts_on_its_own_path_key_and_no_others() {
        let notebook = Rule { tool: "NotebookEdit".into(), matcher: Matcher::Dir { path: "/p".into() } };
        // NotebookEdit acts on notebook_path, so a file_path inside the folder doesn't make an outside notebook pass.
        assert!(!matches(&notebook, "NotebookEdit", &json!({"file_path": "/p/x.ipynb", "notebook_path": "/outside/n.ipynb"})));
        assert!(!matches(&notebook, "NotebookEdit", &json!({"notebook_path": "/p/n.ipynb", "file_path": "/p/n.ipynb"})));
        assert!(matches(&notebook, "NotebookEdit", &json!({"notebook_path": "/p/n.ipynb", "new_source": "x"})));
        let write = Rule { tool: "Write".into(), matcher: Matcher::Dir { path: "/p".into() } };
        assert!(!matches(&write, "Write", &json!({"file_path": "/p/x", "notebook_path": "/outside/n"})));
        // A key a write doesn't take means the call isn't one to allow by rule.
        assert!(!matches(&write, "Write", &json!({"file_path": "/p/x", "content": "a", "extra": 1})));
        assert!(matches(&write, "Write", &json!({"file_path": "/p/x", "content": "a"})));
    }

    #[test]
    fn a_prefix_cannot_start_with_a_program_that_runs_or_destroys_anything() {
        for text in ["python", "python3", "node", "deno", "bun", "ruby", "perl", "php", "awk", "sed", "find", "rm", "rmdir", "mv", "cp", "dd", "chmod", "chown", "curl", "wget", "tee", "make"] {
            assert!(validate(&prefix(text)).is_err(), "{text}");
            assert!(!matches(&prefix(text), "Bash", &cmd(&format!("{text} x"))), "{text}");
        }
        // Exact still allows one command, as written.
        assert!(validate(&exact("find . -delete")).is_ok());
    }

    #[test]
    fn a_subcommand_tool_needs_its_subcommand_and_no_runner_as_one() {
        for text in ["git", "npm", "yarn", "pnpm", "cargo", "docker", "kubectl", "brew", "pip", "go", "gh"] {
            assert!(validate(&prefix(text)).is_err(), "{text}");
            assert!(!matches(&prefix(text), "Bash", &cmd(&format!("{text} status"))), "{text}");
        }
        for good in ["git status", "npm test", "cargo test"] {
            assert!(validate(&prefix(good)).is_ok(), "{good}");
        }
        for text in ["npm exec", "npm dlx", "npm x", "docker exec", "kubectl exec", "git x", "npx", "docker ps", "gh pr"] {
            assert!(validate(&prefix(text)).is_err(), "{text}");
        }
    }

    #[test]
    fn a_program_spelled_another_way_is_still_refused_as_a_prefix() {
        for text in ["/bin/sh", "/usr/bin/env", "/usr/bin/python3", "./script.sh", "~/x", "python3.12", "Python", "nodejs", "bash5", "Rm", "/bin/rm", "node.js", "/opt/homebrew/bin/npm"] {
            assert!(validate(&prefix(text)).is_err(), "{text}");
            assert!(!matches(&prefix(text), "Bash", &cmd(&format!("{text} x"))), "{text}");
        }
        // A path in the first word is an arbitrary program, as Exact it's still just the one command.
        assert!(validate(&exact("./script.sh --fast")).is_ok());
    }

    #[test]
    fn a_script_runner_is_only_ever_an_exact_rule() {
        for text in ["npm run", "npm run-script", "yarn run", "pnpm run", "cargo run", "go run", "docker run", "kubectl exec", "npm exec", "npx"] {
            assert!(validate(&prefix(text)).is_err(), "{text}");
        }
        assert!(validate(&exact("npm run build")).is_ok());
        assert!(matches(&exact("npm run build"), "Bash", &cmd("npm run build")));
        assert!(!matches(&exact("npm run build"), "Bash", &cmd("npm run deploy")));
    }

    #[test]
    fn the_everyday_subcommands_are_still_prefixes() {
        for text in ["npm test", "git status", "git diff", "git log", "cargo test", "cargo build", "cargo check"] {
            assert!(validate(&prefix(text)).is_ok(), "{text}");
            assert!(matches(&prefix(text), "Bash", &cmd(&format!("{text} src"))), "{text}");
        }
    }

    #[test]
    fn the_newly_listed_tools_are_not_prefixes() {
        for text in ["osascript", "open", "ln", "truncate", "shred", "tar", "unzip", "rsync", "scp", "nc", "ncat", "telnet", "kill", "killall", "pkill", "launchctl", "defaults", "security", "networksetup", "diskutil", "hdiutil", "crontab", "at", "tmux", "screen", "script", "expect", "swift", "xcodebuild", "gcc", "clang", "cc"] {
            assert!(validate(&prefix(text)).is_err(), "{text}");
        }
    }

    #[test]
    fn only_vetted_commands_can_be_prefixes() {
        for (program, subs) in VETTED {
            if subs.is_empty() {
                assert!(validate(&prefix(program)).is_ok(), "{program}");
                assert!(matches(&prefix(program), "Bash", &cmd(&format!("{program} src"))), "{program}");
            }
            for sub in subs.iter() {
                let text = format!("{program} {sub}");
                assert!(validate(&prefix(&text)).is_ok(), "{text}");
                // `git branch` takes flags only (a name would create a branch), so it's probed with one.
                let probe = if text == "git branch" { "--oneline" } else { "src" };
                assert!(matches(&prefix(&text), "Bash", &cmd(&format!("{text} {probe}"))), "{text}");
            }
        }
    }

    #[test]
    fn nothing_outside_the_vetted_list_can_be_a_prefix() {
        for text in [
            "npm run", "npm exec", "npm publish", "npm ci", "npm install", "npm audit", "npm outdated", "npm ls", "npx", "yarn run", "yarn dlx", "yarn test", "pnpm test", "cargo run", "cargo install", "cargo doc", "cargo tree", "cargo fmt", "go run", "go list", "go build", "go generate", "make", "make test", "docker ps", "docker run", "kubectl get",
            "cat", "head", "tail", "rg", "grep", "diff", "file", "stat", "du", "df", "echo", "wc", "tsc", "vitest", "jest", "pytest", "eslint", "prettier", "git remote", "git ls-files", "git blame",
            "python x", "python3 x", "node x", "ruby x", "git add", "git commit", "git push", "git checkout", "git reset", "git clean", "git rebase", "git config", "git stash", "git fetch", "git pull",
            "rm", "mv", "sed", "awk", "xargs", "bash", "sh", "env", "sudo", "curl", "open", "git", "npm", "cargo", "prettier", "gh pr", "brew install", "pip install", "unknown-tool",
        ] {
            assert!(validate(&prefix(text)).is_err(), "{text}");
            assert!(!matches(&prefix(text), "Bash", &cmd(text)), "{text}");
        }
    }

    #[test]
    fn a_vetted_program_must_be_spelled_exactly() {
        for text in ["/usr/bin/git status", "./git status", "~/git status", "git3 status", "Git status", "GIT status", "npm@10 test", "ls2", "Ls", "git  status", "git status/x"] {
            assert!(validate(&prefix(text)).is_err(), "{text}");
        }
        // Exact still covers one command, however it's spelled.
        assert!(validate(&exact("/usr/bin/git status")).is_ok());
    }

    #[test]
    fn a_vetted_command_with_an_argument_that_writes_or_runs_code_is_not_matched() {
        for (text, command) in [
            ("git log", "git log --output=/tmp/x"),
            ("git log", "git log --output /tmp/x"),
            ("git log", "git log -o x"),
            ("git diff", "git diff --ext-diff"),
            ("git show", "git show --textconv"),
            ("git log", "git log --exec-path=/x"),
            ("git status", "git status --git-dir=/x"),
            ("git status", "git status --work-tree /x"),
            ("git log", "git log --config=core.pager=sh"),
            ("git log", "git log --pager=sh"),
            ("git log", "git log --editor=x"),
            ("cargo test", "cargo test --config x"),
            ("cargo build", "cargo build -C x"),
            ("cargo build", "cargo build --config=x"),
            ("go test", "go test -C dir"),
            ("npm test", "npm test --ssh-command=x"),
            ("ls", "ls --upload-pack=x"),
            ("rg", "rg --pre=sh foo"),
            ("rg", "rg --pre-glob x foo"),
            ("grep", "grep --pre sh x"),
            ("git log", "git log -c core.pager=sh"),
        ] {
            assert!(!matches(&prefix(text), "Bash", &cmd(command)), "{command}");
        }
        // The arguments a command is normally run with still match.
        for (text, command) in [("git log", "git log --oneline -5"), ("git log", "git log -n 5"), ("git diff", "git diff --cached"), ("git log", "git log --format=oneline"), ("ls", "ls -la src"), ("cargo build", "cargo build --release -q")] {
            assert!(matches(&prefix(text), "Bash", &cmd(command)), "{command}");
        }
    }

    #[test]
    fn only_the_flags_a_vetted_command_is_known_to_read_or_build_with_are_allowed() {
        for (text, command) in [
            // Flags nothing here takes, or that write or run something (a flag with a value, a runner, an output).
            ("git diff", "git diff --output=x"),
            ("git log", "git log --pretty=oneline"),
            ("git log", "git log --format=%h"),
            ("git log", "git log -o x"),
            ("git log", "git log -c core.pager=sh"),
            ("git log", "git log --exec-path=/x"),
            ("git status", "git status --git-dir=/x"),
            ("git show", "git show --textconv"),
            ("cargo build", "cargo build --target-dir=/x"),
            ("cargo build", "cargo build -C x"),
            ("cargo test", "cargo test --config x"),
            ("cargo test", "cargo test -- --nocapture"),
            ("npm test", "npm test -- --coverage"),
            ("npm test", "npm test --ssh-command=x"),
            ("go test", "go test -run X"),
            ("go test", "go test -count=1"),
            ("ls", "ls --upload-pack=x"),
            ("ls", "ls -la /tmp"),
            ("ls", "ls ~"),
            ("ls", "ls ../x"),
            ("git diff", "git diff /etc/passwd"),
            ("git log", "git log ../x"),
            // `git branch` takes no name: a name would create a branch.
            ("git branch", "git branch newname"),
            ("git branch", "git branch -D main"),
            ("npm test", "npm test src/../x"),
        ] {
            assert!(!matches(&prefix(text), "Bash", &cmd(command)), "{command}");
        }
        // Not here at all: a test runner or a reader outside the vetted list, whatever its flags.
        for command in ["pytest --basetemp=/x", "jest --outputFile=x", "vitest --outputFile x", "tsc --outDir x", "eslint --fix src", "cat ~/.ssh/id_rsa", "rg foo", "grep -r x .", "head -5 x", "prettier --write x"] {
            let program = command.split(' ').next().unwrap();
            assert!(validate(&prefix(program)).is_err(), "{command}");
            assert!(!matches(&prefix(program), "Bash", &cmd(command)), "{command}");
        }
    }

    #[test]
    fn a_quote_in_the_command_is_never_a_prefix_match() {
        assert!(!matches(&prefix("git log"), "Bash", &cmd("git log --grep='fix bug'")));
        assert!(!matches(&prefix("git log"), "Bash", &cmd("git log \"--oneline\"")));
        // Exact keeps its quotes, when the text is identical.
        assert!(matches(&exact("git log --grep=\"a b\""), "Bash", &cmd("git log --grep=\"a b\"")));
        assert!(!matches(&exact("git log --grep=\"a b\""), "Bash", &cmd("git log --grep='a b'")));
    }

    #[test]
    fn installs_and_fixes_are_exact_only() {
        for text in ["npm install", "npm ci", "yarn install", "pnpm install", "npm audit", "yarn audit", "pnpm audit"] {
            assert!(validate(&prefix(text)).is_err(), "{text}");
            assert!(validate(&exact(text)).is_ok(), "{text}");
            assert!(matches(&exact(text), "Bash", &cmd(text)), "{text}");
        }
    }

    #[test]
    fn a_file_tool_rule_never_covers_git_or_config_files() {
        let dir = Rule { tool: "Write".into(), matcher: Matcher::Dir { path: "/Users/a/proj".into() } };
        let any = Rule { tool: "Write".into(), matcher: Matcher::Any };
        for p in [
            "/Users/a/proj/.git/config",
            "/Users/a/proj/.git/hooks/pre-commit",
            "/Users/a/proj/.claude/settings.json",
            "/Users/a/proj/.mcp.json",
            "/Users/a/proj/.vscode/tasks.json",
            "/Users/a/proj/.gitconfig",
            "/Users/a/proj/sub/.envrc",
            "/Users/a/proj/.husky/pre-commit",
            "/Users/a/proj/.gitmodules",
            "/Users/a/proj/.idea/workspace.xml",
        ] {
            let input = json!({"file_path": p, "content": "x"});
            assert!(!matches(&dir, "Write", &input), "{p}");
            assert!(!matches(&any, "Write", &input), "{p}");
        }
        let ordinary = json!({"file_path": "/Users/a/proj/src/a.ts", "content": "x"});
        assert!(matches(&dir, "Write", &ordinary));
        assert!(matches(&any, "Write", &ordinary));
    }

    #[test]
    fn a_link_into_git_or_config_is_not_a_file_in_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(dir.path()).unwrap().join("proj");
        std::fs::create_dir_all(folder.join(".git/hooks")).unwrap();
        std::fs::create_dir_all(folder.join("src")).unwrap();
        std::os::unix::fs::symlink(folder.join(".git"), folder.join("link")).unwrap();
        std::os::unix::fs::symlink(folder.join(".git/hooks"), folder.join("src/hooks")).unwrap();
        let dir_rule = Rule { tool: "Write".into(), matcher: Matcher::Dir { path: folder.display().to_string() } };
        let any = Rule { tool: "Write".into(), matcher: Matcher::Any };
        for p in [folder.join("link"), folder.join("link/config"), folder.join("src/hooks/pre-commit")] {
            let asked = json!({"file_path": p.display().to_string(), "content": "x"});
            assert!(!matches(&dir_rule, "Write", &for_matching("Write", &asked)), "{}", p.display());
            assert!(!matches(&any, "Write", &for_matching("Write", &asked)), "{}", p.display());
        }
        let ordinary = json!({"file_path": folder.join("src/new.ts").display().to_string(), "content": "x"});
        assert!(matches(&dir_rule, "Write", &for_matching("Write", &ordinary)));
    }

    #[test]
    fn no_folder_rule_is_made_over_git_or_config_folders() {
        for path in ["/p/.git", "/p/.git/hooks", "/p/.claude", "/p/.vscode/x", "/p/.idea", "/p/.husky"] {
            let rule = Rule { tool: "Edit".into(), matcher: Matcher::Dir { path: path.into() } };
            assert!(validate(&rule).is_err(), "{path}");
        }
        let ok = Rule { tool: "Edit".into(), matcher: Matcher::Dir { path: "/p/src".into() } };
        assert!(validate(&ok).is_ok());
    }

    #[test]
    fn protected_names_match_whatever_their_case() {
        // macOS filesystems are case-insensitive by default, so these are the same files.
        let dir = Rule { tool: "Write".into(), matcher: Matcher::Dir { path: "/Users/a/proj".into() } };
        let any = Rule { tool: "Write".into(), matcher: Matcher::Any };
        for p in ["/Users/a/proj/.GIT/config", "/Users/a/proj/.Claude/settings.json", "/Users/a/proj/.MCP.JSON", "/Users/a/proj/Package.JSON"] {
            let input = json!({"file_path": p, "content": "x"});
            assert!(!matches(&dir, "Write", &input), "{p}");
            assert!(!matches(&any, "Write", &input), "{p}");
        }
        assert!(validate(&Rule { tool: "Edit".into(), matcher: Matcher::Dir { path: "/p/.GIT".into() } }).is_err());
    }

    #[test]
    fn build_and_package_files_are_never_covered() {
        // What the vetted build and test commands run, and the config they read: no rule covers those files.
        let dir = Rule { tool: "Write".into(), matcher: Matcher::Dir { path: "/Users/a/proj".into() } };
        let any = Rule { tool: "Write".into(), matcher: Matcher::Any };
        for p in [
            "/Users/a/proj/.cargo/config.toml",
            "/Users/a/proj/.npmrc",
            "/Users/a/proj/.yarnrc",
            "/Users/a/proj/.yarnrc.yml",
            "/Users/a/proj/.yarn/releases/yarn.cjs",
            "/Users/a/proj/.pnpmfile.cjs",
            "/Users/a/proj/.githooks/pre-push",
            "/Users/a/proj/.pre-commit-config.yaml",
            "/Users/a/proj/.cursor/rules.md",
            "/Users/a/proj/.zed/settings.json",
            "/Users/a/proj/package.json",
            "/Users/a/proj/Cargo.toml",
            "/Users/a/proj/build.rs",
            "/Users/a/proj/Makefile",
            "/Users/a/proj/go.mod",
        ] {
            let input = json!({"file_path": p, "content": "x"});
            assert!(!matches(&dir, "Write", &input), "{p}");
            assert!(!matches(&any, "Write", &input), "{p}");
        }
        let ordinary = json!({"file_path": "/Users/a/proj/src/main.rs", "content": "x"});
        assert!(matches(&dir, "Write", &ordinary));
        assert!(matches(&any, "Write", &ordinary));
    }

    #[test]
    fn a_hard_link_to_a_protected_file_is_not_a_file_in_the_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(tmp.path()).unwrap().join("proj");
        std::fs::create_dir_all(folder.join(".git")).unwrap();
        std::fs::write(folder.join(".git/config"), "[core]\n").unwrap();
        // A second name for the same file, with no protected name in its own path: a write through it changes .git/config.
        std::fs::hard_link(folder.join(".git/config"), folder.join("ok.txt")).unwrap();
        let dir_rule = Rule { tool: "Write".into(), matcher: Matcher::Dir { path: folder.display().to_string() } };
        let any = Rule { tool: "Write".into(), matcher: Matcher::Any };
        let asked = json!({"file_path": folder.join("ok.txt").display().to_string(), "content": "x"});
        assert!(!matches(&dir_rule, "Write", &for_matching("Write", &asked)));
        assert!(!matches(&any, "Write", &for_matching("Write", &asked)));
        // A file with one name is still an ordinary file in the folder.
        std::fs::write(folder.join("src.txt"), "x").unwrap();
        let ordinary = json!({"file_path": folder.join("src.txt").display().to_string(), "content": "x"});
        assert!(matches(&dir_rule, "Write", &for_matching("Write", &ordinary)));
    }

    #[test]
    fn a_rule_made_by_hand_in_settings_behaves_like_one_made_on_a_card() {
        // The shapes Settings' Add a rule form posts: the same ones a card posts.
        let hand: Vec<NewRule> = serde_json::from_value(json!([
            {"scope": "folder", "tool": "Bash", "kind": "prefix", "text": "npm test"},
            {"scope": "chat", "tool": "Bash", "kind": "exact", "text": "npm run build"},
            {"scope": "chat", "tool": "WebFetch", "kind": "any"},
            {"scope": "folder", "tool": "mcp__linear__save_issue", "kind": "any"}
        ]))
        .unwrap();
        for new in &hand {
            assert_eq!(validate(&new.rule).unwrap(), new.rule, "{:?}", new.rule);
        }
        assert!(matches(&hand[0].rule, "Bash", &cmd("npm test --")) == matches(&prefix("npm test"), "Bash", &cmd("npm test --")));
        assert!(matches(&hand[0].rule, "Bash", &cmd("npm test")));
        assert!(!matches(&hand[0].rule, "Bash", &cmd("npm test; rm x")));
        assert!(matches(&hand[1].rule, "Bash", &cmd("npm run build")));
        assert!(!matches(&hand[1].rule, "Bash", &cmd("npm run build x")));
        assert!(matches(&hand[2].rule, "WebFetch", &json!({"url": "https://example.com", "prompt": "x"})));
        assert!(!matches(&hand[2].rule, "WebSearch", &json!({"query": "x"})));
        assert!(matches(&hand[3].rule, "mcp__linear__save_issue", &json!({"title": "x"})));
        // What Settings' form refuses, the backend refuses too: a rule for every Bash command, an interpreter's start, a wrapper.
        for text in ["*", "rm", "sh", "python3", "npm install"] {
            assert!(validate(&prefix(text)).is_err(), "{text}");
        }
        assert!(validate(&bash(Matcher::Any)).is_err());
    }

    #[test]
    fn a_folder_rule_covers_a_folder_whose_path_has_a_space() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(tmp.path()).unwrap().join("my project").join("src");
        std::fs::create_dir_all(&folder).unwrap();
        let rule = validate(&Rule { tool: "Edit".into(), matcher: Matcher::Dir { path: folder.display().to_string() } }).unwrap();
        let inside = json!({"file_path": folder.join("a b.ts").display().to_string()});
        assert!(matches(&rule, "Edit", &for_matching("Edit", &inside)));
        let outside = json!({"file_path": folder.parent().unwrap().join("other.ts").display().to_string()});
        assert!(!matches(&rule, "Edit", &for_matching("Edit", &outside)));
    }

    #[test]
    fn a_saved_folder_rule_comes_back_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub/permission_rules.json");
        let rule = prefix("npm test");
        FolderRules::load(Some(path.clone())).add("/repo", rule.clone());
        let again = FolderRules::load(Some(path.clone()));
        assert_eq!(again.for_folder("/repo"), vec![rule.clone()]);
        assert!(again.for_folder("/other").is_empty());
        assert!(!dir.path().join("sub/permission_rules.json.tmp").exists());
        again.add("/repo", rule.clone());
        assert_eq!(again.for_folder("/repo").len(), 1, "the same rule isn't kept twice");
        again.remove("/repo", &rule);
        assert!(FolderRules::load(Some(path)).for_folder("/repo").is_empty());
    }

    #[test]
    fn a_corrupt_rules_file_is_kept_aside_not_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("permission_rules.json");
        std::fs::write(&path, r#"{"/repo": [{"tool": "Bash"#).unwrap();
        assert!(FolderRules::load(Some(path.clone())).all().is_empty());
        assert_eq!(std::fs::read_to_string(dir.path().join("permission_rules.json.corrupt")).unwrap(), r#"{"/repo": [{"tool": "Bash"#);
        assert!(!path.exists());
    }

    #[test]
    fn rules_are_checked_again_when_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("permission_rules.json");
        let hand_edited = json!({"/repo": [
            {"tool": "Bash", "kind": "any"},
            {"tool": "Bash", "kind": "prefix", "text": "n"},
            {"tool": "ExitPlanMode", "kind": "any"},
            {"tool": "Bash", "kind": "prefix", "text": "npm test"}
        ]});
        std::fs::write(&path, hand_edited.to_string()).unwrap();
        assert_eq!(FolderRules::load(Some(path)).for_folder("/repo"), vec![prefix("npm test")]);
    }

    #[test]
    fn rules_are_written_in_the_shape_the_settings_list_uses() {
        let entry = RuleEntry { scope: Scope::Folder, folder: Some("/repo".into()), rule: prefix("git status") };
        assert_eq!(serde_json::to_value(&entry).unwrap(), json!({"scope": "folder", "folder": "/repo", "tool": "Bash", "kind": "prefix", "text": "git status"}));
        let new: NewRule = serde_json::from_value(json!({"scope": "chat", "tool": "Read", "kind": "dir", "path": "/a"})).unwrap();
        assert_eq!(new, NewRule { scope: Scope::Chat, rule: Rule { tool: "Read".into(), matcher: Matcher::Dir { path: "/a".into() } } });
    }
}
