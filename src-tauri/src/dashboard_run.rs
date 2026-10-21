//! Running a dashboard's form: which dashboards the user has trusted, the command a form's values turn into, the run itself,
//! and the history of runs. The spec side (reading and checking the files) is dashboard.rs.
//!
//! A dashboard file comes from the folder, so nothing in it runs until the user has looked at its commands and trusted it,
//! and trust is the hash of the exact bytes they were shown (`dashboard::Dashboard::hash`). A run reads the file again, and
//! runs the spec of *that* read, only if its hash is trusted: an edit, or a swap between the user's click and the run, is
//! a different dashboard and doesn't run.
//!
//! A command is an argument list that is run directly, never through a shell. A form's values go into single arguments, so a
//! value can't add or split an argument (and dashboard.rs has already refused a free-text value that could start one).
//!
//! Runs are kept per folder in dashboards.json (0600: a run's output can hold logins). They are shown to the user, who can
//! delete any of them.

use crate::dashboard::{self, Form, Kind};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt};

/// The most output kept from a run, for each of stdout and stderr: the end of it, which is where errors and results are.
const KEPT_OUTPUT: usize = 128 << 10;
/// The most output kept in the history for each of stdout and stderr (the run itself returns what was captured).
const KEPT_IN_HISTORY: usize = 64 << 10;
/// The most runs kept for one form.
const MAX_RUNS: usize = 50;
/// The most trusted dashboards remembered for a folder; the oldest is forgotten first.
const MAX_TRUSTED: usize = 50;
/// A run that goes on longer than this is stopped.
const RUN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Longest value of a text field.
const MAX_TEXT: usize = 1024;

/// What a form's fields were set to: field id to a string, number, boolean or list of strings.
pub type Values = BTreeMap<String, Value>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub file: String,
    pub form: String,
    /// Milliseconds since 1970.
    pub started_at: u64,
    pub duration_ms: u64,
    /// None when the command was ended by a signal (stopped or timed out) rather than exiting.
    pub exit_code: Option<i32>,
    pub stopped: bool,
    pub timed_out: bool,
    pub inputs: Values,
    /// The program and arguments that ran, with the values in.
    pub args: Vec<String>,
    pub stdout: String,
    pub stderr: String,
    /// More than the kept amount was printed; the start is missing.
    pub truncated: bool,
    /// For a form whose output is "json": the last line of stdout, when it parsed as an object or a list.
    pub output: Option<Value>,
}

/// A run without its output: what the history list shows. The output comes from `Runner::run_detail` when one is opened,
/// so the state the tab reloads on every change stays small.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunSummary {
    pub id: String,
    pub file: String,
    pub form: String,
    pub started_at: u64,
    pub duration_ms: u64,
    pub exit_code: Option<i32>,
    pub stopped: bool,
    pub timed_out: bool,
    pub inputs: Values,
}

impl From<&Run> for RunSummary {
    fn from(r: &Run) -> Self {
        Self { id: r.id.clone(), file: r.file.clone(), form: r.form.clone(), started_at: r.started_at, duration_ms: r.duration_ms, exit_code: r.exit_code, stopped: r.stopped, timed_out: r.timed_out, inputs: r.inputs.clone() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Running {
    pub file: String,
    pub form: String,
}

/// What the Dashboard tab needs to know about a folder besides its files.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct State {
    /// Hashes of the dashboards the user trusted; a dashboard whose hash isn't here asks first.
    pub trusted: Vec<String>,
    pub running: Vec<Running>,
    /// Newest first.
    pub runs: Vec<RunSummary>,
}

/// What a click on the button will do, worked out by the same code that runs it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Preview {
    pub args: Vec<String>,
    pub confirm: Option<String>,
}

// MARK: - Values to arguments

/// Each field's value as the text that goes into the command. Fails with a sentence for the user when a value is missing, the
/// wrong kind, outside the field's limits, or for a field the form doesn't have.
pub fn resolve(form: &Form, values: &Values) -> Result<BTreeMap<String, String>, String> {
    if let Some(key) = values.keys().find(|k| !form.fields.iter().any(|f| &f.id == *k)) {
        return Err(format!("This form has no field called {key:?}."));
    }
    let mut out = BTreeMap::new();
    for field in &form.fields {
        let name = field.label.as_deref().unwrap_or(&field.id);
        let text = match values.get(&field.id).or(field.default.as_ref()) {
            None | Some(Value::Null) if field.kind == Kind::Toggle => "false".to_string(),
            None | Some(Value::Null) => String::new(),
            Some(value) => render(field, value).map_err(|why| format!("{name} {why}"))?,
        };
        if field.required && text.trim().is_empty() {
            return Err(format!("{name} is required."));
        }
        out.insert(field.id.clone(), text);
    }
    Ok(out)
}

fn render(field: &dashboard::Field, value: &Value) -> Result<String, String> {
    match field.kind {
        Kind::Text => {
            let text = value.as_str().ok_or("must be text.")?;
            if text.chars().count() > MAX_TEXT {
                return Err(format!("is longer than {MAX_TEXT} characters."));
            }
            // A value is shown to the user in the confirm line and on the approval card Claude's runs ask. A new line in it
            // could start a section of its own that looks like the card's ("Command: …"), and a mark that hides or reorders
            // text could disguise what follows, so neither can be in it. A tab is the one control character left.
            if text.chars().any(|c| (c.is_control() && c != '\t') || crate::permission::helper::hides_text(c)) {
                return Err("can't contain a new line, another control character, or a hidden or reordering one.".into());
            }
            Ok(text.to_string())
        }
        Kind::Number => {
            let n = value.as_f64().filter(|n| n.is_finite()).ok_or("must be a number.")?;
            if field.min.is_some_and(|m| n < m) || field.max.is_some_and(|m| n > m) {
                return Err("is outside its allowed range.".into());
            }
            Ok(if n.fract() == 0.0 && n.abs() < 1e15 { format!("{}", n as i64) } else { n.to_string() })
        }
        Kind::Select => {
            let text = value.as_str().ok_or("must be one of its options.")?;
            if field.options_from.is_some() {
                if !text.is_empty() {
                    loaded_option(text)?;
                }
            } else if !text.is_empty() && !field.options.iter().any(|o| o == text) {
                return Err("must be one of its options.".into());
            }
            Ok(text.to_string())
        }
        Kind::Multiselect => {
            let items = value.as_array().ok_or("must be a list of its options.")?;
            let mut chosen = Vec::new();
            for item in items {
                let text = item.as_str().ok_or("must be a list of its options.")?;
                // The options a command printed aren't known here, so the value is held to what any of them could be (the
                // script has its own say on whether it is one); a written list is checked against that list.
                if field.options_from.is_some() {
                    loaded_option(text)?;
                } else if !field.options.iter().any(|o| o == text) {
                    return Err("must be a list of its options.".into());
                }
                if chosen.contains(&text) {
                    return Err(format!("lists {text:?} twice."));
                }
                chosen.push(text);
            }
            if field.options_from.is_some() {
                return Ok(chosen.join(","));
            }
            // In the field's own order, so the same choices always make the same command.
            Ok(field.options.iter().filter(|o| chosen.contains(&o.as_str())).cloned().collect::<Vec<_>>().join(","))
        }
        Kind::Toggle => Ok(value.as_bool().ok_or("must be on or off.")?.to_string()),
    }
}

/// Longest option a command may print.
const MAX_OPTION: usize = 200;
/// The most options a command may print.
const MAX_LOADED_OPTIONS: usize = 200;
/// How long an options command has to print its list.
const OPTIONS_TIMEOUT: Duration = Duration::from_secs(20);

/// Whether `text` could be one of the options a command printed, and so be a chosen value: one line of plain text, no comma (a
/// multiselect's choices are joined with commas), and not starting with `-`, since a value that stands alone as an argument
/// could otherwise be taken for an option of the program. Used for what a command printed and for what is chosen from it.
fn loaded_option(text: &str) -> Result<(), String> {
    if text.is_empty() || text.chars().count() > MAX_OPTION {
        return Err(format!("must be 1 to {MAX_OPTION} characters."));
    }
    if text.contains(',') {
        return Err("can't contain a comma.".into());
    }
    if text.starts_with('-') {
        return Err("can't start with a dash.".into());
    }
    if text.chars().any(|c| c.is_control() || crate::permission::helper::hides_text(c)) {
        return Err("can't contain a control character or a hidden or reordering one.".into());
    }
    Ok(())
}

/// What an options command printed: its last non-empty line, a JSON list of strings, each fit to be an option and none twice.
fn parse_options(stdout: &str) -> Result<Vec<String>, String> {
    let line = stdout.lines().rev().find(|l| !l.trim().is_empty()).ok_or("printed nothing; its last line should be a JSON list of strings like [\"a\", \"b\"].")?;
    let options: Vec<String> = serde_json::from_str(line.trim()).map_err(|_| "its last line isn't a JSON list of strings like [\"a\", \"b\"].".to_string())?;
    if options.len() > MAX_LOADED_OPTIONS {
        return Err(format!("printed {} options; at most {MAX_LOADED_OPTIONS}.", options.len()));
    }
    for (i, option) in options.iter().enumerate() {
        loaded_option(option).map_err(|why| format!("option {} ({}) {why}", i + 1, clip(option, 30)))?;
        if options[..i].contains(option) {
            return Err(format!("lists {option:?} twice."));
        }
    }
    Ok(options)
}

/// Runs an options command and reads what it printed. Like a run it is its own process group, in the project folder, without
/// a shell; unlike one it is given `OPTIONS_TIMEOUT`, and only its list is kept.
async fn read_options(root: &Path, command: &[String], path_env: Option<&str>, timeout: Duration) -> Result<Vec<String>, String> {
    let args = command.iter().map(|t| expand_home(t)).collect::<Result<Vec<_>, _>>()?;
    let program = find_program(&args[0], root, path_env)?;
    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&args[1..]).current_dir(root).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).process_group(0);
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not run {}: {e}", args[0]))?;
    let pgid = child.id().map_or(0, |p| p as i32);
    let stdout = tokio::spawn(read_tail(child.stdout.take().expect("stdout is piped")));
    let stderr = tokio::spawn(read_tail(child.stderr.take().expect("stderr is piped")));
    let status = tokio::select! {
        status = child.wait() => status.ok(),
        _ = tokio::time::sleep(timeout) => {
            if pgid > 1 {
                crate::shell::kill_group(pgid);
            }
            let _ = child.wait().await;
            return Err(format!("{} took longer than {} seconds to print its options.", args[0], timeout.as_secs().max(1)));
        }
    };
    let (stdout, cut) = tokio::time::timeout(Duration::from_secs(2), stdout).await.ok().and_then(Result::ok).unwrap_or_default();
    let (stderr, _) = tokio::time::timeout(Duration::from_secs(2), stderr).await.ok().and_then(Result::ok).unwrap_or_default();
    if !status.is_some_and(|s| s.success()) {
        let why = String::from_utf8_lossy(&stderr);
        let why = why.trim();
        return Err(if why.is_empty() { format!("{} failed.", args[0]) } else { format!("{} failed: {}", args[0], clip(&one_line(why), 300)) });
    }
    if cut {
        return Err(format!("{} printed too much.", args[0]));
    }
    parse_options(&String::from_utf8_lossy(&stdout)).map_err(|why| format!("{}: {why}", args[0]))
}

/// `text` on one line, its line breaks as spaces.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `template` with each `{field}` replaced by that field's text. The values are put in once and never read again, so a
/// value that itself looks like `{users}` stays as typed.
fn fill(template: &str, resolved: &BTreeMap<String, String>) -> String {
    let mut out = String::new();
    let mut at = 0;
    for (start, id) in dashboard::placeholders(template) {
        out.push_str(&template[at..start]);
        out.push_str(resolved.get(&id).map_or("", String::as_str));
        at = start + id.len() + 2;
    }
    out.push_str(&template[at..]);
    out
}

/// A leading `~/` in the spec's own text is the home folder (there's no shell to do it). Values are never expanded.
fn expand_home(template: &str) -> Result<String, String> {
    match template.strip_prefix("~/").or(if template == "~" { Some("") } else { None }) {
        None => Ok(template.to_string()),
        Some(rest) => {
            let home = std::env::var_os("HOME").ok_or("There is no home folder to expand ~ to.")?;
            Ok(Path::new(&home).join(rest).to_string_lossy().into_owned())
        }
    }
}

/// The program and arguments for `values`, and the confirm text, with nothing run.
pub fn preview(form: &Form, values: &Values) -> Result<Preview, String> {
    let resolved = resolve(form, values)?;
    let args = form.action.command.iter().map(|t| Ok(fill(&expand_home(t)?, &resolved))).collect::<Result<Vec<_>, String>>()?;
    Ok(Preview { args, confirm: form.action.confirm.as_ref().map(|c| fill(c, &resolved)) })
}

/// One form's command as the trust card shows it: what would be run, before any value is in.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CommandInfo {
    pub form: String,
    pub title: Option<String>,
    /// "action" (what the form's button runs) or "options" (what loads a select's options when the form opens).
    pub kind: &'static str,
    /// For "options": the field whose options it loads.
    pub field: Option<String>,
    /// The program and arguments as written, with `~` as the home folder; `{field}` stands for that field's value.
    pub command: Vec<String>,
    /// Where the program is on disk, or None with `error` saying why not.
    pub program: Option<String>,
    pub error: Option<String>,
}

/// Every form's command in a dashboard that checked out, for the user to read before they trust it.
pub fn commands(dashboard: &dashboard::Dashboard, root: &Path, path_env: Option<&str>) -> Vec<CommandInfo> {
    let Some(spec) = &dashboard.spec else { return Vec::new() };
    let info = |form: &Form, kind: &'static str, field: Option<String>, template: &[String]| {
        let command: Vec<String> = template.iter().map(|t| expand_home(t).unwrap_or_else(|_| t.clone())).collect();
        let found = find_program(&command[0], root, path_env);
        CommandInfo { form: form.id.clone(), title: form.title.clone(), kind, field, program: found.as_ref().ok().map(|p| p.display().to_string()), error: found.err(), command }
    };
    let mut out = Vec::new();
    for panel in &spec.panels {
        let dashboard::Panel::Form(form) = panel else { continue };
        out.push(info(form, "action", None, &form.action.command));
        // These run on their own, when the form opens, so the user reads them before trusting just like the button's.
        for field in &form.fields {
            if let Some(from) = &field.options_from {
                out.push(info(form, "options", Some(field.id.clone()), &from.command));
            }
        }
    }
    out
}

/// Where the program is: a path with a slash is that path (relative to the folder), a bare name is looked up on `path_env`.
fn find_program(program: &str, folder: &Path, path_env: Option<&str>) -> Result<PathBuf, String> {
    if program.contains('/') {
        let path = Path::new(program);
        return Ok(if path.is_absolute() { path.to_path_buf() } else { folder.join(path) });
    }
    let search = path_env.map(str::to_string).or_else(|| std::env::var("PATH").ok()).unwrap_or_default();
    std::env::split_paths(&search)
        // A relative entry (like `.`) would mean Lantern's own working folder, not the project.
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(program))
        .find(|candidate| {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(candidate).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
        .ok_or_else(|| format!("{program:?} isn't on the PATH Lantern runs commands with."))
}

// MARK: - The store

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct FolderData {
    #[serde(default)]
    trusted: Vec<String>,
    #[serde(default)]
    runs: Vec<Run>,
}

type Key = (String, String, String);

pub struct Runner {
    path: Option<PathBuf>,
    data: Mutex<BTreeMap<String, FolderData>>,
    /// Forms being run: the run's id and its process group (so it can be stopped).
    running: Mutex<HashMap<Key, (String, i32)>>,
    timeout: Duration,
    on_change: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    counter: Mutex<u64>,
    /// Runs Claude proposed that the user has been shown and may approve, by ticket (see `prepare`).
    tickets: Mutex<HashMap<String, Ticket>>,
    ticket_life: Duration,
}

/// A run Claude proposed: exactly what the user is asked to approve, for as long as the approval is good.
struct Ticket {
    folder: String,
    file: String,
    /// The dashboard file as it was when the command was worked out.
    hash: String,
    form: String,
    values: Values,
    expires: Instant,
}

/// How long the user has to answer an approval card before the run it was for is forgotten.
const TICKET_LIFE: Duration = Duration::from_secs(10 * 60);
/// The most runs waiting for an approval at once.
const MAX_TICKETS: usize = 20;

/// What the user is asked to approve for a run Claude proposed, and the one-use ticket that runs exactly that.
#[derive(Debug, Clone, PartialEq)]
pub struct Prepared {
    pub ticket: String,
    /// One line for the approval card's title.
    pub action: String,
    /// The card's text: what it does, the command with the values in, where.
    pub details: String,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

impl Runner {
    pub fn load(path: Option<PathBuf>) -> Self {
        let data = path.as_deref().map(read_store).unwrap_or_default();
        Self { path, data: Mutex::new(data), running: Mutex::default(), timeout: RUN_TIMEOUT, on_change: Mutex::default(), counter: Mutex::default(), tickets: Mutex::default(), ticket_life: TICKET_LIFE }
    }

    pub fn set_on_change(&self, f: impl Fn() + Send + Sync + 'static) {
        *self.on_change.lock().unwrap() = Some(Arc::new(f));
    }

    fn changed(&self) {
        let f = self.on_change.lock().unwrap().clone();
        if let Some(f) = f {
            f();
        }
    }

    pub fn state(&self, folder: &str) -> State {
        let data = self.data.lock().unwrap();
        let d = data.get(folder);
        let running = self.running.lock().unwrap().keys().filter(|(f, _, _)| f == folder).map(|(_, file, form)| Running { file: file.clone(), form: form.clone() }).collect();
        State { trusted: d.map(|d| d.trusted.clone()).unwrap_or_default(), running, runs: d.map(|d| d.runs.iter().map(RunSummary::from).collect()).unwrap_or_default() }
    }

    /// One kept run with its output, for the history entry the user opened.
    pub fn run_detail(&self, folder: &str, id: &str) -> Option<Run> {
        self.data.lock().unwrap().get(folder)?.runs.iter().find(|r| r.id == id).cloned()
    }

    pub fn is_trusted(&self, folder: &str, hash: &str) -> bool {
        !hash.is_empty() && self.data.lock().unwrap().get(folder).is_some_and(|d| d.trusted.iter().any(|h| h == hash))
    }

    /// Trusts the dashboard `file` as it is now, if it is still the `hash` the user was shown.
    pub fn trust(&self, folder: &str, root: &Path, file: &str, hash: &str) -> Result<(), String> {
        let now = dashboard::load(root).into_iter().find(|d| d.file == file).ok_or("That dashboard is gone.")?;
        if now.spec.is_none() {
            return Err("That dashboard has problems, so it can't be trusted yet.".into());
        }
        if now.hash != hash {
            return Err("That dashboard changed since you looked at it. Look at it again.".into());
        }
        self.change(folder, |d| {
            d.trusted.retain(|h| h != hash);
            d.trusted.push(hash.to_string());
            if d.trusted.len() > MAX_TRUSTED {
                d.trusted.remove(0);
            }
        });
        Ok(())
    }

    pub fn delete_run(&self, folder: &str, id: &str) -> bool {
        let mut found = false;
        self.change(folder, |d| {
            let before = d.runs.len();
            d.runs.retain(|r| r.id != id);
            found = d.runs.len() != before;
        });
        found
    }

    pub fn clear_runs(&self, folder: &str, file: &str, form: &str) {
        self.change(folder, |d| d.runs.retain(|r| !(r.file == file && r.form == form)));
    }

    fn change(&self, folder: &str, f: impl FnOnce(&mut FolderData)) {
        {
            let mut data = self.data.lock().unwrap();
            f(data.entry(folder.to_string()).or_default());
            if data.get(folder).is_some_and(|d| d.trusted.is_empty() && d.runs.is_empty()) {
                data.remove(folder);
            }
            self.save(&data);
        }
        self.changed();
    }

    fn record(&self, folder: &str, mut run: Run) {
        // The history keeps the end of a long output, not all of it.
        run.truncated |= keep_tail(&mut run.stdout, KEPT_IN_HISTORY);
        run.truncated |= keep_tail(&mut run.stderr, KEPT_IN_HISTORY);
        self.change(folder, |d| {
            let (file, form) = (run.file.clone(), run.form.clone());
            d.runs.insert(0, run);
            let mut seen = 0;
            d.runs.retain(|r| {
                if r.file != file || r.form != form {
                    return true;
                }
                seen += 1;
                seen <= MAX_RUNS
            });
        });
    }

    fn save(&self, data: &BTreeMap<String, FolderData>) {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Written beside the file and renamed over it, so a write cut short can't leave a truncated file; readable by the
        // user only, since a run's output can hold logins.
        let tmp = path.with_extension("json.tmp");
        let Ok(json) = serde_json::to_string_pretty(data) else { return };
        let written = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).and_then(|mut f| f.write_all(json.as_bytes()));
        if written.is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }

    /// Stops a running form's command and everything it started; false when it wasn't running.
    pub fn stop(&self, folder: &str, file: &str, form: &str) -> bool {
        let key = (folder.to_string(), file.to_string(), form.to_string());
        {
            let mut running = self.running.lock().unwrap();
            // A process that hasn't started yet has no group to stop (and group 0 would be Lantern's own).
            if !running.get(&key).is_some_and(|(_, pgid)| *pgid > 1) {
                return false;
            }
            let (_, pgid) = running.remove(&key).expect("checked above");
            crate::shell::kill_group(pgid);
        }
        self.changed();
        true
    }

    // MARK: - Options from a command

    /// The options of a select whose list comes from a command, read by running it now. Only for a dashboard the user trusted
    /// (this runs a command without a button press, so it asks what a run asks), and only the command written in that exact
    /// file, which is read again here.
    pub async fn options(&self, folder: &str, root: &Path, file: &str, form_id: &str, field_id: &str, path_env: Option<String>) -> Result<Vec<String>, String> {
        let found = dashboard::load(root).into_iter().find(|d| d.file == file).ok_or("That dashboard is gone.")?;
        if found.spec.is_none() {
            return Err("That dashboard has problems.".into());
        }
        if !self.is_trusted(folder, &found.hash) {
            return Err("You haven't trusted this version of the dashboard, so its options aren't loaded.".into());
        }
        let field = found.form(form_id).and_then(|f| f.fields.iter().find(|x| x.id == field_id)).ok_or_else(|| format!("That dashboard has no field {field_id:?} in a form {form_id:?}."))?;
        let from = field.options_from.as_ref().ok_or("That field's options are written in the dashboard, not loaded by a command.")?;
        read_options(root, &from.command, path_env.as_deref(), OPTIONS_TIMEOUT).await
    }

    // MARK: - A run Claude proposes

    /// Works out what a run Claude proposed would do, for the user to approve: refused (with what Claude should tell the user)
    /// unless the dashboard is one the user trusted and the values are good. The ticket it returns runs exactly this, once,
    /// if the file is unchanged and the approval comes in time (`run_ticket`).
    pub fn prepare(&self, folder: &str, root: &Path, file: &str, form_id: &str, values: Values, path_env: Option<&str>) -> Result<Prepared, String> {
        let found = dashboard::load(root).into_iter().find(|d| d.file == file).ok_or_else(|| format!("This folder has no dashboard file called {file:?}. dashboard_spec lists them."))?;
        if found.spec.is_none() {
            return Err(format!("{file} has problems, so it can't run. dashboard_spec lists them."));
        }
        if !self.is_trusted(folder, &found.hash) {
            return Err("The user hasn't trusted this version of the dashboard yet, and only they can: ask them to open the Dashboard tab, read its commands and press Trust. Nothing ran.".into());
        }
        let form = found.form(form_id).ok_or_else(|| format!("{file} has no form called {form_id:?}."))?;
        let Preview { args, confirm } = preview(form, &values)?;
        find_program(&args[0], root, path_env)?;
        let title = form.title.as_deref().unwrap_or(&form.id);
        let action = format!("Run “{}” from {}", clip(title, 50), clip(file, 40));
        let mut details = confirm.map(|c| format!("{c}\n\n")).unwrap_or_default();
        details.push_str(&format!("Command:\n{}\n\nFolder: {folder}\n\nLantern checks the dashboard file, not the files the command runs.", display_line(&args)));
        let ticket = self.mint();
        let mut tickets = self.tickets.lock().unwrap();
        tickets.retain(|_, t| t.expires > Instant::now());
        if tickets.len() >= MAX_TICKETS {
            return Err("Too many runs are waiting for the user's approval. Wait for them to answer the cards they have.".into());
        }
        tickets.insert(ticket.clone(), Ticket { folder: folder.to_string(), file: file.to_string(), hash: found.hash, form: form_id.to_string(), values, expires: Instant::now() + self.ticket_life });
        Ok(Prepared { ticket, action, details })
    }

    /// Runs what `prepare` described, after the user approved it. A ticket works once, in the folder it was made for, and only
    /// while the dashboard file is the one whose command the user read.
    pub async fn run_ticket(self: &Arc<Self>, folder: &str, root: &Path, ticket: &str, path_env: Option<String>) -> Result<Run, String> {
        const GONE: &str = "That approval was already used or has expired, so nothing ran.";
        let t = self.tickets.lock().unwrap().remove(ticket).ok_or(GONE)?;
        if t.expires <= Instant::now() || t.folder != folder {
            return Err(GONE.into());
        }
        self.run_pinned(folder, root, &t.file, &t.form, t.values, path_env, Some(&t.hash)).await
    }

    /// A ticket nobody can guess: the process's random hash keys, mixed with the time and a count.
    fn mint(&self) -> String {
        use std::hash::{BuildHasher, Hasher};
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        let mut n = self.counter.lock().unwrap();
        *n += 1;
        hasher.write_u64(*n);
        hasher.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
        format!("{:016x}", hasher.finish())
    }

    // MARK: - Running

    /// Runs a form of the folder's dashboard `file` with `values`, and returns the run (also kept in the history). The file
    /// is read again here, and only a spec whose hash the user trusted runs.
    pub async fn run(self: &Arc<Self>, folder: &str, root: &Path, file: &str, form_id: &str, values: Values, path_env: Option<String>) -> Result<Run, String> {
        self.run_pinned(folder, root, file, form_id, values, path_env, None).await
    }

    /// `run`, but only if the file still is the `expect_hash` one (a run the user approved reading its command).
    #[allow(clippy::too_many_arguments)]
    async fn run_pinned(self: &Arc<Self>, folder: &str, root: &Path, file: &str, form_id: &str, values: Values, path_env: Option<String>, expect_hash: Option<&str>) -> Result<Run, String> {
        let dashboard = dashboard::load(root).into_iter().find(|d| d.file == file).ok_or("That dashboard is gone.")?;
        if dashboard.spec.is_none() {
            return Err("That dashboard has problems, so it doesn't run.".into());
        }
        if expect_hash.is_some_and(|h| h != dashboard.hash) {
            return Err("The dashboard file changed after the user approved this run, so nothing ran.".into());
        }
        if !self.is_trusted(folder, &dashboard.hash) {
            return Err("You haven't trusted this version of the dashboard, so it doesn't run.".into());
        }
        let form = dashboard.form(form_id).ok_or_else(|| format!("That dashboard has no form called {form_id:?}."))?;
        let Preview { args, .. } = preview(form, &values)?;
        let program = find_program(&args[0], root, path_env.as_deref())?;

        let key: Key = (folder.to_string(), file.to_string(), form_id.to_string());
        let id = {
            let mut n = self.counter.lock().unwrap();
            *n += 1;
            format!("{}-{}", now_ms(), *n)
        };
        {
            let mut running = self.running.lock().unwrap();
            if running.contains_key(&key) {
                return Err("That form is already running.".into());
            }
            running.insert(key.clone(), (id.clone(), 0));
        }
        let started = now_ms();
        let mut cmd = tokio::process::Command::new(&program);
        // Its own process group, so stopping it also stops whatever it started.
        cmd.args(&args[1..]).current_dir(root).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).process_group(0);
        if let Some(p) = &path_env {
            cmd.env("PATH", p);
        }
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => {
                self.running.lock().unwrap().remove(&key);
                return Err(format!("Could not run {}: {e}", args[0]));
            }
        };
        let pgid = child.id().map_or(0, |p| p as i32);
        if let Some(entry) = self.running.lock().unwrap().get_mut(&key) {
            entry.1 = pgid;
        }
        self.changed();
        let stdout = tokio::spawn(read_tail(child.stdout.take().expect("stdout is piped")));
        let stderr = tokio::spawn(read_tail(child.stderr.take().expect("stderr is piped")));

        let mut timed_out = false;
        let status = tokio::select! {
            status = child.wait() => status.ok(),
            _ = tokio::time::sleep(self.timeout) => {
                timed_out = true;
                if pgid > 1 {
                    crate::shell::kill_group(pgid);
                }
                child.wait().await.ok()
            }
        };
        // Whatever the command started may still hold its output open; don't wait on that for long.
        let (stdout, out_cut) = tokio::time::timeout(Duration::from_secs(2), stdout).await.ok().and_then(Result::ok).unwrap_or_default();
        let (stderr, err_cut) = tokio::time::timeout(Duration::from_secs(2), stderr).await.ok().and_then(Result::ok).unwrap_or_default();
        // stop() takes the entry out; a run that finds its entry still there ended on its own.
        let stopped = {
            let mut running = self.running.lock().unwrap();
            match running.get(&key) {
                Some((mine, _)) if *mine == id => {
                    running.remove(&key);
                    false
                }
                _ => true,
            }
        };
        let stdout = String::from_utf8_lossy(&stdout).into_owned();
        let output = (form.action.output == dashboard::Output::Json && !out_cut).then(|| last_line_json(&stdout)).flatten();
        let run = Run {
            id,
            file: file.to_string(),
            form: form_id.to_string(),
            started_at: started,
            duration_ms: now_ms().saturating_sub(started),
            exit_code: status.and_then(|s| s.code()),
            stopped,
            timed_out,
            inputs: values,
            args,
            stdout,
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            truncated: out_cut || err_cut,
            output,
        };
        self.record(folder, run.clone());
        Ok(run)
    }
}

/// How a run went, in words for Claude: "exit code 0", "failed with exit code 3", "stopped by the user", "timed out".
pub fn status_of(exit_code: Option<i32>, stopped: bool, timed_out: bool) -> String {
    match (timed_out, stopped, exit_code) {
        (true, _, _) => "it timed out and was stopped".to_string(),
        (_, true, _) => "it was stopped by the user".to_string(),
        (_, _, Some(0)) => "exit code 0, so it worked".to_string(),
        (_, _, Some(code)) => format!("it failed with exit code {code}"),
        (_, _, None) => "it ended without an exit code".to_string(),
    }
}

/// `text` cut to `max` characters, with an ellipsis when it was longer.
fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max { text.to_string() } else { format!("{}…", text.chars().take(max - 1).collect::<String>()) }
}

/// A command as one line to read, an argument with a space, a quote or such in it quoted.
pub fn display_line(args: &[String]) -> String {
    args.iter()
        .map(|a| if a.is_empty() || a.chars().any(|c| !(c.is_ascii_alphanumeric() || "@%+=:,./~{}-_".contains(c))) { format!("{a:?}") } else { a.clone() })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Cuts `text` down to its last `max` bytes (from a character boundary); true when something was dropped.
fn keep_tail(text: &mut String, max: usize) -> bool {
    if text.len() <= max {
        return false;
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text.drain(..start);
    true
}

/// Reads to the end, keeping the last `KEPT_OUTPUT` bytes; true when something was dropped.
async fn read_tail(mut reader: impl AsyncRead + Unpin) -> (Vec<u8>, bool) {
    let (mut kept, mut cut, mut buf) = (Vec::new(), false, [0u8; 8192]);
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                kept.extend_from_slice(&buf[..n]);
                if kept.len() > KEPT_OUTPUT {
                    kept.drain(..kept.len() - KEPT_OUTPUT);
                    cut = true;
                }
            }
        }
    }
    (kept, cut)
}

/// The last non-empty line of `text`, if it is a JSON object or list.
fn last_line_json(text: &str) -> Option<Value> {
    let line = text.lines().rev().find(|l| !l.trim().is_empty())?;
    serde_json::from_str::<Value>(line.trim()).ok().filter(|v| v.is_object() || v.is_array())
}

fn read_store(path: &Path) -> BTreeMap<String, FolderData> {
    let Ok(bytes) = std::fs::read(path) else { return BTreeMap::new() };
    serde_json::from_slice(&bytes).unwrap_or_else(|_| {
        let _ = std::fs::rename(path, path.with_extension("json.corrupt"));
        BTreeMap::new()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A form whose command prints how many arguments it got, then each one on a line, then a JSON line.
    fn spec(extra_fields: Value, command: Value) -> String {
        // The confirm text names field `n`, so only a form that has one gets it.
        let confirm = if extra_fields.as_array().is_some_and(|f| f.is_empty()) { Value::Null } else { json!("Do it for {n}") };
        let mut action = json!({ "command": command, "output": "json" });
        if !confirm.is_null() {
            action["confirm"] = confirm;
        }
        json!({ "title": "t", "panels": [ { "type": "form", "id": "f", "fields": extra_fields, "action": action } ] }).to_string()
    }

    fn fields() -> Value {
        json!([
            { "id": "n", "type": "number", "label": "Count", "min": 1, "max": 10, "default": 2 },
            { "id": "who", "type": "select", "options": ["a", "b"], "required": true },
            { "id": "tags", "type": "multiselect", "options": ["x", "y", "z"] },
            { "id": "note", "type": "text" },
            { "id": "on", "type": "toggle" }
        ])
    }

    fn form_of(text: &str) -> Form {
        match dashboard::parse(text).unwrap().panels.remove(0) {
            dashboard::Panel::Form(f) => f,
            _ => unreachable!(),
        }
    }

    fn values(pairs: Value) -> Values {
        pairs.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    const ECHO: &str = r#"printf '%s\n' "$#" "$@"; printf '{"count":%s}\n' "$#""#;

    fn sh(args: Value) -> Value {
        let mut command = vec![json!("/bin/sh"), json!("-c"), json!(ECHO), json!("sh")];
        command.extend(args.as_array().unwrap().iter().cloned());
        Value::Array(command)
    }

    // MARK: Values

    #[test]
    fn values_become_text_in_the_fields_own_terms() {
        let form = form_of(&spec(fields(), sh(json!([]))));
        let got = resolve(&form, &values(json!({ "who": "b", "tags": ["z", "x"], "note": "hi there", "on": true }))).unwrap();
        assert_eq!(got["n"], "2"); // the default
        assert_eq!(got["who"], "b");
        assert_eq!(got["tags"], "x,z"); // the field's own order
        assert_eq!(got["note"], "hi there");
        assert_eq!(got["on"], "true");
        let unset = resolve(&form, &values(json!({ "who": "a", "n": 2.5 }))).unwrap();
        assert_eq!((unset["tags"].as_str(), unset["note"].as_str(), unset["on"].as_str(), unset["n"].as_str()), ("", "", "false", "2.5"));
    }

    #[test]
    fn bad_values_say_which_field_and_why() {
        let form = form_of(&spec(fields(), sh(json!([]))));
        let bad = |v: Value| resolve(&form, &values(v)).unwrap_err();
        assert_eq!(bad(json!({})), "who is required.");
        assert_eq!(bad(json!({ "who": "" })), "who is required.");
        assert!(bad(json!({ "who": "c" })).starts_with("who must be one of its options"));
        assert!(bad(json!({ "who": "a", "n": 0 })).starts_with("Count is outside"));
        assert!(bad(json!({ "who": "a", "n": 11 })).starts_with("Count is outside"));
        assert!(bad(json!({ "who": "a", "n": "3" })).starts_with("Count must be a number"));
        assert!(bad(json!({ "who": "a", "tags": ["x", "x"] })).contains("twice"));
        assert!(bad(json!({ "who": "a", "tags": ["q"] })).starts_with("tags must be a list"));
        assert!(bad(json!({ "who": "a", "tags": "x" })).starts_with("tags must be a list"));
        assert!(bad(json!({ "who": "a", "note": 5 })).starts_with("note must be text"));
        assert!(bad(json!({ "who": "a", "note": "x".repeat(MAX_TEXT + 1) })).contains("longer than"));
        // No control character but a tab (a new line could fake a section of the card the user approves from), and no mark
        // that hides or reorders text.
        for evil in ["a\0b", "a\nb", "a\r\nb", "a\u{1b}[2Jb", "a\u{202e}b", "a\u{2028}b"] {
            assert!(bad(json!({ "who": "a", "note": evil })).contains("can't contain a new line"), "{evil:?}");
        }
        assert!(resolve(&form, &values(json!({ "who": "a", "note": "tab\there" }))).is_ok());
        assert!(bad(json!({ "who": "a", "on": "yes" })).starts_with("on must be on or off"));
        assert!(bad(json!({ "who": "a", "extra": 1 })).contains("no field called"));
    }

    #[test]
    fn a_value_is_one_argument_and_is_never_read_again() {
        let form = form_of(&spec(fields(), sh(json!(["--who={who}", "--note={note}", "{n}"]))));
        let nasty = "x y; rm -rf ~ $(whoami) {n} --admins=99";
        let got = preview(&form, &values(json!({ "who": "a", "note": nasty }))).unwrap();
        assert_eq!(&got.args[4..], ["--who=a", &format!("--note={nasty}"), "2"]);
        assert_eq!(got.args.len(), 7);
        assert_eq!(got.confirm.as_deref(), Some("Do it for 2"));
    }

    #[test]
    fn a_home_folder_is_expanded_in_the_spec_but_not_in_values() {
        let form = form_of(&spec(fields(), sh(json!(["~/tool.py", "--note={note}"]))));
        let got = preview(&form, &values(json!({ "who": "a", "note": "~/x" }))).unwrap();
        let home = std::env::var("HOME").unwrap();
        assert_eq!(got.args[4], format!("{home}/tool.py"));
        assert_eq!(got.args[5], "--note=~/x");
    }

    // MARK: Running

    struct Setup {
        folder: tempfile::TempDir,
        data: tempfile::TempDir,
        runner: Arc<Runner>,
    }

    fn setup(text: &str) -> Setup {
        let folder = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(folder.path().join(".lantern/dashboards")).unwrap();
        std::fs::write(folder.path().join(".lantern/dashboards/d.json"), text).unwrap();
        let data = tempfile::tempdir().unwrap();
        let runner = Arc::new(Runner::load(Some(data.path().join("dashboards.json"))));
        Setup { folder, data, runner }
    }

    fn hash_of(s: &Setup) -> String {
        dashboard::load(s.folder.path())[0].hash.clone()
    }

    fn trust(s: &Setup) {
        s.runner.trust("k", s.folder.path(), "d.json", &hash_of(s)).unwrap();
    }

    async fn run(s: &Setup, v: Value) -> Result<Run, String> {
        s.runner.run("k", s.folder.path(), "d.json", "f", values(v), None).await
    }

    #[tokio::test]
    async fn nothing_runs_until_it_is_trusted() {
        let s = setup(&spec(fields(), sh(json!(["{who}"]))));
        let err = run(&s, json!({ "who": "a" })).await.unwrap_err();
        assert!(err.contains("haven't trusted"), "{err}");
        assert!(s.runner.state("k").runs.is_empty());
    }

    #[tokio::test]
    async fn trust_is_the_exact_bytes_that_were_shown() {
        let s = setup(&spec(fields(), sh(json!(["{who}"]))));
        let shown = hash_of(&s);
        // Edited after the user looked, before they trusted: refused.
        std::fs::write(s.folder.path().join(".lantern/dashboards/d.json"), spec(fields(), sh(json!(["{who}", "extra"])))).unwrap();
        assert!(s.runner.trust("k", s.folder.path(), "d.json", &shown).unwrap_err().contains("changed"));
        // Trusted, then edited: no longer trusted, so it doesn't run.
        std::fs::write(s.folder.path().join(".lantern/dashboards/d.json"), spec(fields(), sh(json!(["{who}"])))).unwrap();
        trust(&s);
        assert!(run(&s, json!({ "who": "a" })).await.is_ok());
        std::fs::write(s.folder.path().join(".lantern/dashboards/d.json"), spec(fields(), sh(json!(["{who}", "extra"])))).unwrap();
        assert!(run(&s, json!({ "who": "a" })).await.unwrap_err().contains("haven't trusted"));
        // A file that has problems can't be trusted or run.
        std::fs::write(s.folder.path().join(".lantern/dashboards/d.json"), "{").unwrap();
        assert!(s.runner.trust("k", s.folder.path(), "d.json", &hash_of(&s)).unwrap_err().contains("problems"));
        assert!(run(&s, json!({ "who": "a" })).await.unwrap_err().contains("problems"));
        // Trust belongs to the folder it was given in.
        assert!(!s.runner.is_trusted("other", &shown));
        assert!(!s.runner.is_trusted("k", ""));
    }

    #[tokio::test]
    async fn a_run_gets_exactly_the_arguments_and_reports_its_output() {
        let s = setup(&spec(fields(), sh(json!(["--who={who}", "--note={note}", "{tags}"]))));
        trust(&s);
        let nasty = "a b; echo pwned --admins=99";
        let run = run(&s, json!({ "who": "b", "note": nasty, "tags": ["y", "x"] })).await.unwrap();
        assert_eq!(run.exit_code, Some(0));
        assert!(!run.stopped && !run.timed_out && !run.truncated);
        // $# is 3: the value with spaces and a semicolon stayed one argument.
        assert_eq!(run.stdout.lines().take(4).collect::<Vec<_>>(), ["3", "--who=b", &format!("--note={nasty}"), "x,y"]);
        assert_eq!(run.output, Some(json!({ "count": 3 })));
        assert_eq!(run.inputs["who"], "b");
        assert_eq!(run.args.last().unwrap(), "x,y");
        // The state lists runs without their output; the output is fetched for the one opened.
        assert_eq!(s.runner.state("k").runs, vec![RunSummary::from(&run)]);
        assert_eq!(s.runner.run_detail("k", &run.id), Some(run));
        assert_eq!(s.runner.run_detail("k", "nope"), None);
        assert_eq!(s.runner.run_detail("other", "nope"), None);
    }

    #[tokio::test]
    async fn the_history_keeps_less_output_than_a_run_returns() {
        let s = setup(&spec(json!([]), json!(["/bin/sh", "-c", "yes 0123456789 | head -c 100000; echo; echo end"])));
        trust(&s);
        let run = run(&s, json!({})).await.unwrap();
        // Returned in full (what was captured) …
        assert!(run.stdout.len() > KEPT_IN_HISTORY && !run.truncated);
        // … and kept as its end, marked cut.
        let kept = s.runner.run_detail("k", &run.id).unwrap();
        assert!(kept.stdout.len() <= KEPT_IN_HISTORY && kept.truncated);
        assert!(kept.stdout.ends_with("end\n") && run.stdout.ends_with(&kept.stdout));
    }

    #[test]
    fn the_trust_card_lists_each_forms_command_and_where_its_program_is() {
        let text = json!({ "title": "t", "panels": [
            { "type": "form", "id": "a", "title": "First", "action": { "command": ["echo", "~/x", "{none}"] }, "fields": [{ "id": "none", "type": "toggle" }] },
            { "type": "form", "id": "b", "action": { "command": ["no-such-program-here"] } },
            { "type": "result", "of": "a" }
        ] })
        .to_string();
        let s = setup(&text);
        let found = &dashboard::load(s.folder.path())[0];
        let got = commands(found, s.folder.path(), Some("/bin:/usr/bin:relative/dir"));
        let home = std::env::var("HOME").unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].form.as_str(), got[0].title.as_deref()), ("a", Some("First")));
        assert_eq!(got[0].command, ["echo".to_string(), format!("{home}/x"), "{none}".to_string()]);
        assert!(got[0].program.as_deref().is_some_and(|p| p.ends_with("/echo")) && got[0].error.is_none());
        assert!(got[1].program.is_none() && got[1].error.as_deref().is_some_and(|e| e.contains("isn't on the PATH")));
        // A dashboard with problems has nothing to list.
        let broken = dashboard::Dashboard { spec: None, ..found.clone() };
        assert!(commands(&broken, s.folder.path(), None).is_empty());
    }

    // MARK: Options from a command

    /// A form whose addons and staging lists come from commands; the action echoes what was chosen.
    fn dyn_spec(addons_command: Value) -> String {
        json!({ "title": "t", "panels": [ { "type": "form", "id": "f", "fields": [
            { "id": "addons", "type": "multiselect", "optionsFrom": { "command": addons_command } },
            { "id": "staging", "type": "select", "optionsFrom": { "command": ["/bin/echo", "[\"7\", \"9\"]"] } }
        ], "action": { "command": ["/bin/echo", "--enable", "{addons}", "{staging}"] } } ] })
        .to_string()
    }

    fn printing(list: &str) -> Value {
        // printf, not echo: this sh's echo reads backslash sequences, which would change the JSON before the checker sees it.
        json!(["/bin/sh", "-c", format!("echo some log line; printf '%s\\n' '{list}'")])
    }

    async fn options_of(s: &Setup, field: &str) -> Result<Vec<String>, String> {
        s.runner.options("k", s.folder.path(), "d.json", "f", field, None).await
    }

    #[tokio::test]
    async fn a_selects_options_are_what_its_command_prints_on_its_last_line() {
        let s = setup(&dyn_spec(printing(r#"["approvals", "testo_sensors"]"#)));
        trust(&s);
        assert_eq!(options_of(&s, "addons").await.unwrap(), ["approvals", "testo_sensors"]);
        assert_eq!(options_of(&s, "staging").await.unwrap(), ["7", "9"]);
        // An empty list is a list.
        let none = setup(&dyn_spec(printing("[]")));
        trust(&none);
        assert!(options_of(&none, "addons").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn options_are_not_loaded_for_a_dashboard_that_is_not_trusted_or_a_field_that_has_none_to_load() {
        let s = setup(&dyn_spec(printing(r#"["a"]"#)));
        assert!(options_of(&s, "addons").await.unwrap_err().contains("haven't trusted"));
        trust(&s);
        assert!(options_of(&s, "nope").await.unwrap_err().contains("no field"));
        assert!(s.runner.options("k", s.folder.path(), "d.json", "zz", "addons", None).await.unwrap_err().contains("no field"));
        assert!(s.runner.options("k", s.folder.path(), "gone.json", "f", "addons", None).await.unwrap_err().contains("gone"));
        assert!(s.runner.options("other", s.folder.path(), "d.json", "f", "addons", None).await.unwrap_err().contains("haven't trusted"));
        let written = setup(&spec(fields(), sh(json!([]))));
        trust(&written);
        assert!(options_of(&written, "who").await.unwrap_err().contains("written in the dashboard"));
        // Edited after it was trusted: not run until trusted again.
        std::fs::write(s.folder.path().join(".lantern/dashboards/d.json"), dyn_spec(printing(r#"["b"]"#))).unwrap();
        assert!(options_of(&s, "addons").await.unwrap_err().contains("haven't trusted"));
    }

    #[tokio::test]
    async fn an_options_command_that_prints_the_wrong_thing_says_what_was_wrong() {
        let cases = [
            (json!(["/bin/sh", "-c", "true"]), "printed nothing"),
            (printing("not json"), "isn't a JSON list of strings"),
            (printing(r#"{"a": 1}"#), "isn't a JSON list of strings"),
            (printing("[1, 2]"), "isn't a JSON list of strings"),
            (printing(r#"["a,b"]"#), "can't contain a comma"),
            (printing(r#"["-x"]"#), "can't start with a dash"),
            (printing(r#"[""]"#), "must be 1 to"),
            (printing(r#"["a", "a"]"#), "lists \"a\" twice"),
            (printing(r#"["a\u202eb"]"#), "hidden or reordering"),
            (printing(r#"["a\nb"]"#), "control character"),
            (json!(["/bin/sh", "-c", "echo 'broken thing' >&2; exit 3"]), "failed: broken thing"),
            (json!(["no-such-program-here"]), "isn't on the PATH"),
        ];
        for (command, says) in cases {
            let s = setup(&dyn_spec(command.clone()));
            trust(&s);
            let err = options_of(&s, "addons").await.unwrap_err();
            assert!(err.contains(says), "{command}: {err}");
        }
        // One more than the most there may be, printed by a loop (written out, the list would be longer than a command argument may be).
        let loop_script = format!("i=0; printf '['; while [ $i -lt {MAX_LOADED_OPTIONS} ]; do printf '\"o%s\",' $i; i=$((i+1)); done; printf '\"last\"]\\n'");
        let s = setup(&dyn_spec(json!(["/bin/sh", "-c", loop_script])));
        trust(&s);
        assert!(options_of(&s, "addons").await.unwrap_err().contains("at most"));
    }

    #[tokio::test]
    async fn an_options_command_that_hangs_or_floods_is_stopped_and_reported() {
        let dir = tempfile::tempdir().unwrap();
        let slow = read_options(dir.path(), &["/bin/sh".into(), "-c".into(), "sleep 30".into()], None, Duration::from_millis(300)).await.unwrap_err();
        assert!(slow.contains("took longer than"), "{slow}");
        let flood = read_options(dir.path(), &["/bin/sh".into(), "-c".into(), "yes 0123456789 | head -c 400000".into()], None, Duration::from_secs(10)).await.unwrap_err();
        assert!(flood.contains("printed too much"), "{flood}");
    }

    #[test]
    fn what_is_chosen_from_a_commands_options_is_held_to_what_any_option_could_be() {
        let form = form_of(&dyn_spec(json!(["x"])));
        let ok = |v: Value| resolve(&form, &values(v));
        // Not looked up against a list, in the order chosen, a select left empty is empty.
        let got = ok(json!({ "addons": ["testo_sensors", "approvals"], "staging": "7" })).unwrap();
        assert_eq!((got["addons"].as_str(), got["staging"].as_str()), ("testo_sensors,approvals", "7"));
        assert_eq!(ok(json!({ "addons": [] })).unwrap()["staging"], "");
        // A value the script gets as a whole argument can't be taken for one of its options, or smuggle in a second value.
        for bad in ["-x", "--admins=99", "a,b", "a\nb", "", "a\u{202e}b", &"x".repeat(MAX_OPTION + 1)] {
            let err = ok(json!({ "addons": [bad] })).unwrap_err();
            assert!(err.starts_with("addons "), "{bad:?}: {err}");
            if !bad.is_empty() {
                assert!(ok(json!({ "staging": bad })).is_err(), "{bad:?}");
            }
        }
        assert!(ok(json!({ "addons": ["a", "a"] })).unwrap_err().contains("twice"));
        assert!(ok(json!({ "addons": "a" })).is_err() && ok(json!({ "addons": [1] })).is_err());
    }

    #[test]
    fn the_trust_card_lists_a_forms_options_commands_too() {
        let s = setup(&dyn_spec(json!(["python3", "~/tools/run.py", "addons", "--json"])));
        let found = &dashboard::load(s.folder.path())[0];
        let got = commands(found, s.folder.path(), Some("/bin:/usr/bin"));
        let home = std::env::var("HOME").unwrap();
        assert_eq!(got.iter().map(|c| (c.kind, c.field.as_deref())).collect::<Vec<_>>(), [("action", None), ("options", Some("addons")), ("options", Some("staging"))]);
        assert_eq!(got[1].command, ["python3".to_string(), format!("{home}/tools/run.py"), "addons".into(), "--json".into()]);
        assert!(got[2].program.as_deref().is_some_and(|p| p.ends_with("/echo")));
    }

    #[tokio::test]
    async fn a_run_proposed_for_a_command_fed_select_carries_the_chosen_values_into_the_card() {
        let s = setup(&dyn_spec(printing(r#"["approvals", "testo_sensors"]"#)));
        trust(&s);
        let p = s.runner.prepare("k", s.folder.path(), "d.json", "f", values(json!({ "addons": ["testo_sensors"], "staging": "7" })), None).unwrap();
        assert!(p.details.contains("/bin/echo --enable testo_sensors 7"), "{}", p.details);
        let refused = s.runner.prepare("k", s.folder.path(), "d.json", "f", values(json!({ "addons": ["--admins=99"] })), None).unwrap_err();
        assert!(refused.contains("can't start with a dash"), "{refused}");
    }

    // MARK: A run Claude proposes

    fn proposal(s: &Setup, values: Value) -> Result<Prepared, String> {
        s.runner.prepare("k", s.folder.path(), "d.json", "f", values_of(values), None)
    }

    fn values_of(v: Value) -> Values {
        values(v)
    }

    #[test]
    fn a_proposed_run_is_refused_unless_the_user_trusted_the_dashboard_and_the_values_are_good() {
        let s = setup(&spec(fields(), sh(json!(["--who={who}"]))));
        let untrusted = proposal(&s, json!({ "who": "a" })).unwrap_err();
        assert!(untrusted.contains("hasn't trusted") && untrusted.contains("only they can"), "{untrusted}");
        trust(&s);
        assert!(proposal(&s, json!({})).unwrap_err().contains("required"));
        assert!(proposal(&s, json!({ "who": "z" })).unwrap_err().contains("must be one of"));
        assert!(s.runner.prepare("k", s.folder.path(), "nope.json", "f", Values::new(), None).unwrap_err().contains("no dashboard file called"));
        assert!(s.runner.prepare("k", s.folder.path(), "d.json", "zz", Values::new(), None).unwrap_err().contains("no form called"));
        assert!(proposal(&s, json!({ "who": "a", "note": "a\u{202e}b" })).unwrap_err().contains("hidden or reordering"));
        // Another folder's trust doesn't count here.
        assert!(s.runner.prepare("other", s.folder.path(), "d.json", "f", values_of(json!({ "who": "a" })), None).unwrap_err().contains("hasn't trusted"));
        let missing = setup(&spec(json!([]), json!(["no-such-program-here"])));
        missing.runner.trust("k", missing.folder.path(), "d.json", &hash_of(&missing)).unwrap();
        assert!(missing.runner.prepare("k", missing.folder.path(), "d.json", "f", Values::new(), None).unwrap_err().contains("isn't on the PATH"));
        // Nothing waits for an approval after any refusal.
        assert!(s.runner.tickets.lock().unwrap().is_empty());
    }

    #[test]
    fn the_card_says_what_runs_with_the_values_in_and_where() {
        let s = setup(&spec(fields(), sh(json!(["--who={who}", "--note={note}"]))));
        trust(&s);
        let p = proposal(&s, json!({ "who": "b", "note": "two words" })).unwrap();
        assert_eq!(p.action, "Run “f” from d.json");
        assert!(p.details.starts_with("Do it for 2\n\nCommand:\n/bin/sh -c "), "{}", p.details);
        assert!(p.details.contains(r#""--note=two words""#) && p.details.contains("--who=b"), "{}", p.details);
        assert!(p.details.contains("Folder: k") && p.details.contains("not the files the command runs"), "{}", p.details);
        // The card's own limits (one line, plain text) are the helper's to enforce; this is within them.
        assert!(p.action.chars().count() <= 120 && p.details.chars().count() <= 2000);
        assert_eq!(p.ticket.len(), 16);
    }

    #[tokio::test]
    async fn an_approved_ticket_runs_exactly_once() {
        let s = setup(&spec(fields(), sh(json!(["--who={who}"]))));
        trust(&s);
        let p = proposal(&s, json!({ "who": "a" })).unwrap();
        let run = s.runner.run_ticket("k", s.folder.path(), &p.ticket, None).await.unwrap();
        assert_eq!(run.exit_code, Some(0));
        assert_eq!(run.args.last().unwrap(), "--who=a");
        assert_eq!(s.runner.state("k").runs.len(), 1);
        let again = s.runner.run_ticket("k", s.folder.path(), &p.ticket, None).await.unwrap_err();
        assert!(again.contains("already used or has expired"), "{again}");
        assert!(s.runner.run_ticket("k", s.folder.path(), "not-a-ticket", None).await.is_err());
        assert_eq!(s.runner.state("k").runs.len(), 1);
    }

    #[tokio::test]
    async fn a_ticket_does_not_run_after_the_file_changed_expired_or_in_another_folder() {
        let s = setup(&spec(fields(), sh(json!(["--who={who}"]))));
        trust(&s);
        // The file is edited between the user reading the command and the run (and the new version is trusted too).
        let p = proposal(&s, json!({ "who": "a" })).unwrap();
        std::fs::write(s.folder.path().join(".lantern/dashboards/d.json"), spec(fields(), sh(json!(["--who={who}", "--extra"])))).unwrap();
        trust(&s);
        let err = s.runner.run_ticket("k", s.folder.path(), &p.ticket, None).await.unwrap_err();
        assert!(err.contains("changed after the user approved"), "{err}");
        assert!(s.runner.state("k").runs.is_empty());
        // Too late.
        let mut slow = Runner::load(None);
        slow.ticket_life = Duration::from_millis(0);
        let slow = Arc::new(slow);
        slow.trust("k", s.folder.path(), "d.json", &hash_of(&s)).unwrap();
        let p = slow.prepare("k", s.folder.path(), "d.json", "f", values_of(json!({ "who": "a" })), None).unwrap();
        assert!(slow.run_ticket("k", s.folder.path(), &p.ticket, None).await.unwrap_err().contains("expired"));
        // Another folder's approval.
        let p = proposal(&s, json!({ "who": "a" })).unwrap();
        assert!(s.runner.run_ticket("other", s.folder.path(), &p.ticket, None).await.unwrap_err().contains("expired"));
    }

    #[test]
    fn only_so_many_runs_wait_for_an_approval_and_old_ones_are_forgotten() {
        let s = setup(&spec(fields(), sh(json!(["--who={who}"]))));
        trust(&s);
        for _ in 0..MAX_TICKETS {
            proposal(&s, json!({ "who": "a" })).unwrap();
        }
        assert!(proposal(&s, json!({ "who": "a" })).unwrap_err().contains("Too many runs"));
        for t in s.runner.tickets.lock().unwrap().values_mut() {
            t.expires = Instant::now();
        }
        assert!(proposal(&s, json!({ "who": "a" })).is_ok());
        assert_eq!(s.runner.tickets.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_command_is_shown_as_one_line_with_what_needs_it_quoted() {
        let args: Vec<String> = ["python3", "~/x.py", "--name=QA org", "", "a\"b", "{n}", "tab\there"].iter().map(|s| s.to_string()).collect();
        assert_eq!(display_line(&args), r#"python3 ~/x.py "--name=QA org" "" "a\"b" {n} "tab\there""#);
        assert_eq!(clip("abcdef", 4), "abc…");
        assert_eq!(clip("abc", 4), "abc");
    }

    #[test]
    fn a_cut_is_made_on_a_character_boundary() {
        let mut text = "é".repeat(10);
        assert!(keep_tail(&mut text, 5));
        assert_eq!(text, "éé");
        let mut short = "abc".to_string();
        assert!(!keep_tail(&mut short, 3));
        assert_eq!(short, "abc");
    }

    #[tokio::test]
    async fn exit_codes_stderr_and_unparsable_output_are_kept() {
        let command = json!(["/bin/sh", "-c", "echo oops >&2; echo 'not json'; exit 3"]);
        let s = setup(&spec(json!([]), command));
        trust(&s);
        let run = run(&s, json!({})).await.unwrap();
        assert_eq!(run.exit_code, Some(3));
        assert_eq!(run.stderr, "oops\n");
        assert_eq!(run.stdout, "not json\n");
        assert_eq!(run.output, None);
    }

    #[tokio::test]
    async fn bad_values_and_unknown_forms_do_not_start_anything() {
        let s = setup(&spec(fields(), sh(json!([]))));
        trust(&s);
        assert!(run(&s, json!({})).await.unwrap_err().contains("required"));
        assert!(s.runner.run("k", s.folder.path(), "d.json", "nope", values(json!({})), None).await.unwrap_err().contains("no form"));
        assert!(s.runner.run("k", s.folder.path(), "gone.json", "f", values(json!({})), None).await.unwrap_err().contains("gone"));
        assert!(s.runner.state("k").runs.is_empty() && s.runner.state("k").running.is_empty());
    }

    #[tokio::test]
    async fn a_missing_program_is_explained() {
        let s = setup(&spec(json!([]), json!(["no-such-program-here"])));
        trust(&s);
        let err = run(&s, json!({})).await.unwrap_err();
        assert!(err.contains("isn't on the PATH"), "{err}");
        let s = setup(&spec(json!([]), json!(["./nope.sh"])));
        trust(&s);
        assert!(run(&s, json!({})).await.unwrap_err().contains("Could not run ./nope.sh"));
        assert!(s.runner.state("k").running.is_empty());
    }

    #[tokio::test]
    async fn a_relative_program_runs_from_the_folder_and_a_bare_one_from_the_path() {
        use std::os::unix::fs::PermissionsExt;
        let s = setup(&spec(json!([]), json!(["scripts/hi.sh"])));
        std::fs::create_dir_all(s.folder.path().join("scripts")).unwrap();
        let script = s.folder.path().join("scripts/hi.sh");
        std::fs::write(&script, "#!/bin/sh\npwd\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        trust(&s);
        let run = run(&s, json!({})).await.unwrap();
        // The working folder is the project folder (compared by name: macOS temp folders are behind a symlink).
        assert!(run.stdout.trim().ends_with(s.folder.path().file_name().unwrap().to_str().unwrap()), "{}", run.stdout);
        let s = setup(&spec(json!([]), json!(["echo", "hello"])));
        trust(&s);
        let run = s.runner.run("k", s.folder.path(), "d.json", "f", Values::new(), Some("/bin:/usr/bin".into())).await.unwrap();
        assert_eq!(run.stdout, "hello\n");
    }

    #[tokio::test]
    async fn a_form_that_is_running_is_not_started_twice_and_can_be_stopped() {
        let s = setup(&spec(json!([]), json!(["/bin/sh", "-c", "sleep 30 & wait"])));
        trust(&s);
        let (runner, root) = (s.runner.clone(), s.folder.path().to_path_buf());
        let first = tokio::spawn(async move { runner.run("k", &root, "d.json", "f", Values::new(), None).await });
        for _ in 0..100 {
            if !s.runner.state("k").running.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(s.runner.state("k").running, vec![Running { file: "d.json".into(), form: "f".into() }]);
        assert!(run(&s, json!({})).await.unwrap_err().contains("already running"));
        // The pid is recorded once the process has started.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(s.runner.stop("k", "d.json", "f"));
        let run = first.await.unwrap().unwrap();
        assert!(run.stopped && !run.timed_out);
        assert_eq!(run.exit_code, None);
        assert!(s.runner.state("k").running.is_empty());
        assert!(!s.runner.stop("k", "d.json", "f"));
    }

    #[tokio::test]
    async fn a_run_that_goes_on_too_long_is_stopped() {
        let s = setup(&spec(json!([]), json!(["/bin/sh", "-c", "sleep 30"])));
        trust(&s);
        let mut runner = Runner::load(None);
        runner.timeout = Duration::from_millis(300);
        let runner = Arc::new(runner);
        runner.trust("k", s.folder.path(), "d.json", &hash_of(&s)).unwrap();
        let run = runner.run("k", s.folder.path(), "d.json", "f", Values::new(), None).await.unwrap();
        assert!(run.timed_out && !run.stopped);
        assert_eq!(run.exit_code, None);
        assert!(run.duration_ms < 10_000);
    }

    #[tokio::test]
    async fn long_output_keeps_its_end() {
        let s = setup(&spec(json!([]), json!(["/bin/sh", "-c", "yes 0123456789 | head -c 400000; echo; echo '{\"done\":true}'"])));
        trust(&s);
        let run = run(&s, json!({})).await.unwrap();
        assert!(run.truncated);
        assert!(run.stdout.len() <= KEPT_OUTPUT + 8);
        assert!(run.stdout.trim_end().ends_with(r#"{"done":true}"#));
        // The start is missing, so the end is not taken for the whole.
        assert_eq!(run.output, None);
    }

    // MARK: History and the store

    #[tokio::test]
    async fn history_is_kept_newest_first_capped_per_form_and_deletable() {
        let s = setup(&spec(fields(), json!(["/bin/echo", "{who}"])));
        trust(&s);
        let first = run(&s, json!({ "who": "a" })).await.unwrap();
        let second = run(&s, json!({ "who": "b" })).await.unwrap();
        let runs = s.runner.state("k").runs;
        assert_eq!(runs.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), [second.id.clone(), first.id.clone()]);
        assert!(s.runner.delete_run("k", &first.id));
        assert!(!s.runner.delete_run("k", &first.id));
        assert_eq!(s.runner.state("k").runs.len(), 1);
        for _ in 0..MAX_RUNS + 5 {
            run(&s, json!({ "who": "a" })).await.unwrap();
        }
        assert_eq!(s.runner.state("k").runs.len(), MAX_RUNS);
        s.runner.clear_runs("k", "d.json", "f");
        assert!(s.runner.state("k").runs.is_empty());
        // Clearing the runs keeps the trust.
        assert_eq!(s.runner.state("k").trusted.len(), 1);
    }

    #[tokio::test]
    async fn the_store_survives_a_restart_and_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let s = setup(&spec(json!([]), json!(["/bin/echo", "secret-login"])));
        trust(&s);
        let run = run(&s, json!({})).await.unwrap();
        let path = s.data.path().join("dashboards.json");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let again = Runner::load(Some(path.clone()));
        assert_eq!(again.run_detail("k", &run.id), Some(run));
        assert!(again.is_trusted("k", &hash_of(&s)));
        // A damaged file is set aside, not trusted and not fatal.
        std::fs::write(&path, "{ nope").unwrap();
        let broken = Runner::load(Some(path.clone()));
        assert!(broken.state("k").runs.is_empty() && !broken.is_trusted("k", &hash_of(&s)));
        assert!(path.with_extension("json.corrupt").exists());
    }

    #[tokio::test]
    async fn changes_are_announced() {
        let s = setup(&spec(json!([]), json!(["/bin/echo", "x"])));
        let seen = Arc::new(Mutex::new(0));
        let counter = seen.clone();
        s.runner.set_on_change(move || *counter.lock().unwrap() += 1);
        trust(&s);
        assert_eq!(*seen.lock().unwrap(), 1);
        run(&s, json!({})).await.unwrap();
        // Started, and recorded.
        assert_eq!(*seen.lock().unwrap(), 3);
    }

    #[test]
    fn the_last_json_line_is_found() {
        assert_eq!(last_line_json("log\n{\"a\":1}\n\n"), Some(json!({ "a": 1 })));
        assert_eq!(last_line_json("[1,2]"), Some(json!([1, 2])));
        assert_eq!(last_line_json("{\"a\":1}\nlater"), None);
        assert_eq!(last_line_json("5"), None);
        assert_eq!(last_line_json(""), None);
    }
}
