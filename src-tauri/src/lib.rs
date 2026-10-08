pub mod args;
pub mod changes;
pub mod cli_locator;
pub mod files;
pub mod git;
pub mod history;
pub mod navigation;
pub mod permission;
pub mod pr;
pub mod session;
pub mod shell;
pub mod skills;
pub mod slots;
pub mod outside;
pub mod stream_parser;
pub mod test_runs;
pub mod titles;
pub mod ui_event;
pub mod updates;

use args::{HelperConfig, Mode};
use changes::FileDiff;
use session::{EditHook, Session, SessionConfig};
use slots::{Slot, SlotEvent, Slots};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct AppState {
    slots: Slots,
    login_path: Arc<OnceLock<Option<String>>>,
    titles: Arc<titles::TitleStore>,
    /// PRs looked up for the Changes pane, by folder and number, with when: fetching them takes a moment.
    prs: std::sync::Mutex<std::collections::HashMap<(std::path::PathBuf, u32), (std::time::Instant, pr::PrRange)>>,
}

/// How long a looked-up PR is used before it's fetched again (it may have new commits).
const PR_FRESH: std::time::Duration = std::time::Duration::from_secs(120);

async fn pr_range(state: &AppState, folder: std::path::PathBuf, number: Option<u32>, hints: Vec<String>) -> Result<pr::PrRange, String> {
    let number = number.ok_or("Which pull request? None is being reviewed.")?;
    let key = (folder.clone(), number);
    if let Some((at, range)) = state.prs.lock().unwrap().get(&key) {
        if at.elapsed() < PR_FRESH {
            return Ok(range.clone());
        }
    }
    let path_env = login_path(state).await;
    let range = tauri::async_runtime::spawn_blocking(move || pr::repo_for(&folder, &hints).and_then(|repo| pr::resolve(&repo, number, path_env.as_deref()))).await.map_err(|e| e.to_string())??;
    state.prs.lock().unwrap().insert(key, (std::time::Instant::now(), range.clone()));
    Ok(range)
}

/// The login-shell PATH, computed once off the main thread.
async fn login_path(state: &AppState) -> Option<String> {
    let cell = state.login_path.clone();
    tauri::async_runtime::spawn_blocking(move || cell.get_or_init(cli_locator::login_shell_path).clone()).await.ok().flatten()
}

fn emitter(app: &AppHandle) -> impl Fn(SlotEvent) + Send + Sync + Clone + 'static {
    let app = app.clone();
    move |ev| {
        let _ = app.emit("ui-event", ev);
    }
}

/// The chat's slot, created on first use.
fn slot_for(app: &AppHandle, state: &AppState, slot: &str) -> Result<Arc<Slot>, String> {
    state.slots.get_or_create(slot, &std::env::temp_dir(), emitter(app))
}

fn helper_config(slot: &Slot) -> Result<HelperConfig, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(HelperConfig { exe: exe.display().to_string(), socket: slot.bridge.socket_path.display().to_string() })
}

/// Stops the slot's running session (denying its pending prompts) and starts `cfg` in it.
async fn launch(app: &AppHandle, id: &str, slot: &Slot, cfg: SessionConfig, clear_changes: bool) -> Result<(), String> {
    let mut session = slot.session.lock().await;
    if let Some(old) = session.take() {
        slot.bridge.cancel_all();
        old.stop().await;
    }
    if clear_changes {
        let folder = cfg.folder.clone();
        let baseline = tauri::async_runtime::spawn_blocking(move || outside::Baseline::take(&folder)).await.map_err(|e| e.to_string())?;
        let mut changes = slot.changes.lock().unwrap();
        changes.clear();
        changes.watch(baseline);
    }
    let changes = slot.changes.clone();
    let on_edit: EditHook = Arc::new(move |path: &str, original: Option<String>| changes.lock().unwrap().record(path, original));
    let mut started = Session::spawn(&cfg, slots::tagged(id, emitter(app)), on_edit)?;
    started.initialize().await;
    *session = Some(started);
    *slot.config.lock().unwrap() = Some(cfg);
    Ok(())
}

/// How a chat's claude runs: permission mode, model and effort (None = Claude Code's default for either).
#[derive(serde::Deserialize)]
struct Settings {
    mode: Mode,
    model: Option<String>,
    effort: Option<String>,
    /// In Step by step: auto-approve actions (Claude Code's auto mode) instead of asking in the app.
    #[serde(default)]
    auto_approve: bool,
    /// The harness: the advisor model and the subagents' model (None = Claude Code's own settings).
    #[serde(default)]
    advisor: Option<String>,
    #[serde(default)]
    subagent_model: Option<String>,
}

fn checked_effort(effort: Option<String>) -> Result<Option<String>, String> {
    match effort {
        Some(e) if !args::valid_effort(&e) => Err(format!("{e:?} is not an effort level.")),
        e => Ok(e),
    }
}

async fn new_config(state: &AppState, slot: &Slot, claude_path: String, folder: String, settings: Settings, resume: Option<String>) -> Result<SessionConfig, String> {
    if !std::path::Path::new(&folder).is_dir() {
        return Err(format!("{folder} no longer exists."));
    }
    Ok(SessionConfig {
        claude: claude_path.into(),
        folder: folder.into(),
        mode: settings.mode,
        auto_approve: settings.auto_approve,
        resume,
        model: checked_model(settings.model)?,
        effort: checked_effort(settings.effort)?,
        advisor: checked_model(settings.advisor)?,
        subagent_model: checked_model(settings.subagent_model)?,
        helper: helper_config(slot)?,
        path_env: login_path(state).await,
    })
}

/// The user's name for their messages: the macOS account's full name, else git's user.name, else the login name.
#[tauri::command]
async fn user_name() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = |cmd: &str, args: &[&str]| {
            std::process::Command::new(cmd).args(args).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty())
        };
        out("id", &["-F"]).or_else(|| out("git", &["config", "--global", "user.name"])).or_else(|| std::env::var("USER").ok())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn locate_claude(path_override: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || cli_locator::locate(path_override.as_deref()).map(|p| p.display().to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn start_session(app: AppHandle, state: State<'_, AppState>, slot: String, claude_path: String, folder: String, settings: Settings) -> Result<(), String> {
    let s = slot_for(&app, &state, &slot)?;
    let cfg = new_config(&state, &s, claude_path, folder, settings, None).await?;
    launch(&app, &slot, &s, cfg, true).await
}

/// Restarts a chat's claude on the same session (`--resume`), e.g. with a new permission mode or effort.
#[tauri::command]
async fn restart_session(app: AppHandle, state: State<'_, AppState>, slot: String, mode: Mode, effort: Option<String>, auto_approve: Option<bool>) -> Result<(), String> {
    let s = state.slots.get(&slot)?;
    let running_id = s.session.lock().await.as_ref().and_then(|x| x.session_id());
    let mut cfg = s.config.lock().unwrap().clone().ok_or("No folder is open")?;
    cfg.mode = mode;
    cfg.effort = checked_effort(effort)?;
    if let Some(auto) = auto_approve {
        cfg.auto_approve = auto;
    }
    cfg.resume = running_id.or(cfg.resume);
    cfg.helper = helper_config(&s)?;
    cfg.path_env = login_path(&state).await;
    launch(&app, &slot, &s, cfg, false).await
}

/// Restarts a chat's claude on the same session with another harness: main model and effort, advisor, subagents' model.
#[tauri::command]
async fn apply_harness(app: AppHandle, state: State<'_, AppState>, slot: String, model: Option<String>, effort: Option<String>, advisor: Option<String>, subagent_model: Option<String>) -> Result<(), String> {
    let s = state.slots.get(&slot)?;
    let running_id = s.session.lock().await.as_ref().and_then(|x| x.session_id());
    let mut cfg = s.config.lock().unwrap().clone().ok_or("No folder is open")?;
    cfg.model = checked_model(model)?;
    cfg.effort = checked_effort(effort)?;
    cfg.advisor = checked_model(advisor)?;
    cfg.subagent_model = checked_model(subagent_model)?;
    cfg.resume = running_id.or(cfg.resume);
    cfg.helper = helper_config(&s)?;
    cfg.path_env = login_path(&state).await;
    launch(&app, &slot, &s, cfg, false).await
}

/// Stops a chat and forgets it. Closing one that doesn't exist is fine.
#[tauri::command]
async fn close_session(state: State<'_, AppState>, slot: String) -> Result<(), String> {
    if let Some(s) = state.slots.remove(&slot) {
        s.shut_down().await;
    }
    Ok(())
}

fn checked_model(model: Option<String>) -> Result<Option<String>, String> {
    match model {
        Some(m) if !args::valid_model(&m) => Err(format!("{m:?} is not a model name.")),
        m => Ok(m),
    }
}

/// Switches the chat's model in-band from its next turn on, and remembers it for restarts. None = Claude Code's default.
#[tauri::command]
async fn set_model(state: State<'_, AppState>, slot: String, model: Option<String>) -> Result<(), String> {
    let model = checked_model(model)?;
    let Ok(s) = state.slots.get(&slot) else { return Ok(()) };
    if let Some(cfg) = s.config.lock().unwrap().as_mut() {
        cfg.model = model.clone();
    }
    let mut session = s.session.lock().await;
    match session.as_mut() {
        Some(x) if x.is_running() => x.set_model(model.as_deref()).await,
        _ => Ok(()),
    }
}

#[tauri::command]
/// Returns the turn's number, which the Changes pane can ask about later (a Step-by-step page's changes).
async fn send_message(state: State<'_, AppState>, slot: String, text: String) -> Result<usize, String> {
    let s = state.slots.get(&slot)?;
    // What "Last turn" in the Changes pane compares against.
    let changes = s.changes.clone();
    let turn = tauri::async_runtime::spawn_blocking(move || changes.lock().unwrap().start_turn()).await.map_err(|e| e.to_string())?;
    let mut session = s.session.lock().await;
    session.as_mut().ok_or("No Claude session is running")?.send(&text).await?;
    Ok(turn)
}

/// The control requests Settings may send to a chat's claude: MCP servers' status and actions, and reloading
/// skills and plugins. Anything else is refused.
const SETTINGS_REQUESTS: &[&str] = &["mcp_status", "mcp_reconnect", "mcp_toggle", "mcp_authenticate", "mcp_oauth_callback_url", "mcp_clear_auth", "reload_skills", "reload_plugins"];

/// Sends one of SETTINGS_REQUESTS to the chat's claude and returns its reply.
#[tauri::command]
async fn claude_request(state: State<'_, AppState>, slot: String, request: serde_json::Value) -> Result<serde_json::Value, String> {
    let subtype = request["subtype"].as_str().unwrap_or("").to_string();
    if !SETTINGS_REQUESTS.contains(&subtype.as_str()) {
        return Err(format!("{subtype:?} can't be sent from Settings."));
    }
    let s = state.slots.get(&slot)?;
    let reply = {
        let mut session = s.session.lock().await;
        session.as_mut().ok_or("Claude isn't running in this chat.")?.request(request).await?
    };
    // Logging in waits for the browser; the rest answer quickly.
    let wait = if subtype == "mcp_authenticate" { 120 } else { 30 };
    match tokio::time::timeout(std::time::Duration::from_secs(wait), reply).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("Claude stopped before it answered.".into()),
        Err(_) => Err("Claude didn't answer in time.".into()),
    }
}

/// The skills and custom commands on disk: yours, the chat folder's, and plugins'.
#[tauri::command]
async fn skill_index(state: State<'_, AppState>, slot: Option<String>) -> Result<Vec<skills::Entry>, String> {
    let folder = slot.and_then(|id| state.slots.get(&id).ok()).and_then(|s| s.folder().ok());
    let config = skills::config_dir().ok_or("HOME is not set")?;
    tauri::async_runtime::spawn_blocking(move || skills::index(&config, folder.as_deref())).await.map_err(|e| e.to_string())
}

/// A skill or command file's text (only markdown under Claude Code's folders).
#[tauri::command]
async fn read_skill(state: State<'_, AppState>, slot: Option<String>, path: String) -> Result<String, String> {
    let folder = slot.and_then(|id| state.slots.get(&id).ok()).and_then(|s| s.folder().ok());
    let config = skills::config_dir().ok_or("HOME is not set")?;
    tauri::async_runtime::spawn_blocking(move || skills::read(&config, folder.as_deref(), std::path::Path::new(&path))).await.map_err(|e| e.to_string())?
}

/// A server to add with `claude mcp add`.
#[derive(serde::Deserialize)]
struct McpServerSpec {
    name: String,
    /// "stdio", "http" or "sse".
    transport: String,
    /// The command line (stdio) or the URL.
    target: String,
    /// "local" (you, this project), "user" (you, everywhere) or "project" (shared in .mcp.json).
    scope: String,
    /// KEY=value, for stdio.
    #[serde(default)]
    env: Vec<String>,
    /// "Name: value", for http and sse.
    #[serde(default)]
    headers: Vec<String>,
}

const MCP_SCOPES: &[&str] = &["local", "user", "project"];

/// Runs `claude mcp …` in the chat's folder (scopes are per project), as the user would in a terminal.
async fn claude_mcp(state: &AppState, slot: &str, args: Vec<String>) -> Result<String, String> {
    let s = state.slots.get(slot)?;
    let (claude, folder) = {
        let cfg = s.config.lock().unwrap();
        let cfg = cfg.as_ref().ok_or("No folder is open")?;
        (cfg.claude.clone(), cfg.folder.clone())
    };
    let mut cmd = tokio::process::Command::new(claude);
    cmd.args(&args).current_dir(folder).stdin(std::process::Stdio::null());
    if let Some(p) = login_path(state).await {
        cmd.env("PATH", p);
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(60), cmd.output()).await.map_err(|_| "claude mcp didn't finish in time.".to_string())?.map_err(|e| e.to_string())?;
    let text = |b: &[u8]| String::from_utf8_lossy(b).trim().to_string();
    if out.status.success() {
        Ok(text(&out.stdout))
    } else {
        let err = text(&out.stderr);
        Err(if err.is_empty() { text(&out.stdout) } else { err })
    }
}

#[tauri::command]
async fn mcp_add(state: State<'_, AppState>, slot: String, spec: McpServerSpec) -> Result<String, String> {
    let name = spec.name.trim();
    if name.is_empty() || name.starts_with('-') || !MCP_SCOPES.contains(&spec.scope.as_str()) || !["stdio", "http", "sse"].contains(&spec.transport.as_str()) {
        return Err("Give the server a name, a type and where it applies.".into());
    }
    let mut args: Vec<String> = ["mcp", "add", "-s", &spec.scope, "-t", &spec.transport].map(String::from).to_vec();
    if spec.transport == "stdio" {
        for e in spec.env.iter().filter(|e| !e.trim().is_empty()) {
            args.extend(["-e".into(), e.trim().into()]);
        }
        let words = shell::split_words(&spec.target)?;
        if words.is_empty() {
            return Err("Which command starts the server?".into());
        }
        args.extend(["--".into(), name.into()]);
        args.extend(words);
    } else {
        for h in spec.headers.iter().filter(|h| !h.trim().is_empty()) {
            args.extend(["-H".into(), h.trim().into()]);
        }
        let url = spec.target.trim();
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err("The server's address starts with https://.".into());
        }
        args.extend(["--".into(), name.into(), url.into()]);
    }
    claude_mcp(&state, &slot, args).await
}

#[tauri::command]
async fn mcp_remove(state: State<'_, AppState>, slot: String, name: String, scope: Option<String>) -> Result<String, String> {
    let mut args: Vec<String> = vec!["mcp".into(), "remove".into()];
    if let Some(sc) = scope.filter(|s| MCP_SCOPES.contains(&s.as_str())) {
        args.extend(["-s".into(), sc]);
    }
    args.extend(["--".into(), name]);
    claude_mcp(&state, &slot, args).await
}

/// Runs a command the user typed after "!" in the chat's folder; its output arrives as ui-events.
#[tauri::command]
async fn run_shell(app: AppHandle, state: State<'_, AppState>, slot: String, id: String, command: String) -> Result<(), String> {
    let s = state.slots.get(&slot)?;
    let folder = s.folder()?;
    let path_env = login_path(&state).await;
    s.shells.run(&id, &command, &folder, path_env.as_deref(), slots::tagged(&slot, emitter(&app)))
}

/// Types into a running command: the user's reply to what it asked.
#[tauri::command]
fn shell_input(state: State<'_, AppState>, slot: String, id: String, text: String) -> Result<(), String> {
    state.slots.get(&slot)?.shells.input(&id, &text)
}

#[tauri::command]
fn stop_shell(state: State<'_, AppState>, slot: String, id: String) -> Result<(), String> {
    state.slots.get(&slot)?.shells.stop(&id);
    Ok(())
}

/// The checked-out branch's commits since it left the default branch, for reviewing a local branch.
#[tauri::command]
async fn branch_review(state: State<'_, AppState>, slot: String, hints: Option<Vec<String>>) -> Result<pr::BranchReview, String> {
    let folder = state.slots.get(&slot)?.folder()?;
    let hints = hints.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || pr::branch(&folder, &hints).map(|(_, review)| review)).await.map_err(|e| e.to_string())?
}

/// Stops one of the chat's background tasks; claude then lists what's left.
#[tauri::command]
async fn stop_task(state: State<'_, AppState>, slot: String, task_id: String) -> Result<(), String> {
    let s = state.slots.get(&slot)?;
    let mut session = s.session.lock().await;
    session.as_mut().ok_or("Claude isn't running.")?.stop_task(&task_id).await
}

#[tauri::command]
async fn interrupt(state: State<'_, AppState>, slot: String) -> Result<(), String> {
    let Ok(s) = state.slots.get(&slot) else { return Ok(()) };
    if let Some(x) = s.session.lock().await.as_mut() {
        x.interrupt().await;
    }
    s.bridge.cancel_all();
    Ok(())
}

/// `pr`: with the "pr" scope, the pull request's number.
#[tauri::command]
async fn get_file_diff(state: State<'_, AppState>, slot: String, path: String, scope: Option<changes::Scope>, turn: Option<usize>, to_turn: Option<usize>, pr: Option<u32>) -> Result<FileDiff, String> {
    let s = state.slots.get(&slot)?;
    if scope == Some(changes::Scope::Pr) {
        let range = pr_range(&state, s.folder()?, pr, vec![]).await?;
        return tauri::async_runtime::spawn_blocking(move || pr::file(&range, &path)).await.map_err(|e| e.to_string())?;
    }
    if scope == Some(changes::Scope::Branch) {
        // The file's own repository: in a workspace of several, that's the one under review.
        let dir = std::path::Path::new(&path).parent().map(|p| p.to_path_buf()).unwrap_or(s.folder()?);
        return tauri::async_runtime::spawn_blocking(move || pr::branch(&dir, &[]).and_then(|(range, _)| pr::file(&range, &path))).await.map_err(|e| e.to_string())?;
    }
    if scope == Some(changes::Scope::Git) {
        let folder = s.folder()?;
        let original = outside::committed(&folder, std::path::Path::new(&path))?;
        let current = std::fs::read(&path).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
        return Ok(FileDiff { path, created: original.is_none(), deleted: current.is_none(), original: original.unwrap_or_default(), current: current.unwrap_or_default() });
    }
    let diff = s.changes.lock().unwrap().diff(&path, scope.unwrap_or_default(), turn, to_turn);
    diff
}

/// A chat's changed files as they stand on disk, so the Changes list catches what happened outside Claude's edits.
#[tauri::command]
/// `hints`: with the "pr" and "branch" scopes, the reviewed files' paths, which pick the repository when the folder
/// holds several.
async fn change_summary(
    state: State<'_, AppState>,
    slot: String,
    scope: Option<changes::Scope>,
    turn: Option<usize>,
    to_turn: Option<usize>,
    pr: Option<u32>,
    hints: Option<Vec<String>>,
) -> Result<Vec<changes::ChangeSummary>, String> {
    let s = state.slots.get(&slot)?;
    if scope == Some(changes::Scope::Pr) {
        let range = pr_range(&state, s.folder()?, pr, hints.unwrap_or_default()).await?;
        return tauri::async_runtime::spawn_blocking(move || pr::summary(&range)).await.map_err(|e| e.to_string())?;
    }
    if scope == Some(changes::Scope::Branch) {
        let folder = s.folder()?;
        let hints = hints.unwrap_or_default();
        return tauri::async_runtime::spawn_blocking(move || pr::branch(&folder, &hints).and_then(|(range, _)| pr::summary(&range))).await.map_err(|e| e.to_string())?;
    }
    if scope == Some(changes::Scope::Git) {
        let folder = s.folder()?;
        return tauri::async_runtime::spawn_blocking(move || {
            let rows = outside::uncommitted(&folder).ok_or("This folder isn't in a git repository.")?;
            let mut out: Vec<changes::ChangeSummary> = rows.into_iter().map(|(path, created, deleted, added, removed)| changes::ChangeSummary { path, created, deleted, added, removed }).collect();
            out.sort_by(|a, b| a.path.cmp(&b.path));
            Ok(out)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    let changes = s.changes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Files changed outside Claude's edits; git runs without holding the tracker, which edits need meanwhile.
        let inputs = changes.lock().unwrap().scan_inputs();
        if let Some((baseline, known)) = inputs {
            let found = baseline.changes(|p| known.contains(p));
            changes.lock().unwrap().add_found(found);
        }
        changes.lock().unwrap().summary(scope.unwrap_or_default(), turn, to_turn)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn respond_permission(state: State<'_, AppState>, slot: String, request_id: String, allow: bool, message: Option<String>) -> Result<(), String> {
    if state.slots.get(&slot)?.bridge.respond(&request_id, allow, message) {
        Ok(())
    } else {
        Err("That permission request is no longer pending.".into())
    }
}

#[tauri::command]
fn git_branch(folder: String) -> Option<String> {
    git::current_branch(std::path::Path::new(&folder))
}

/// File browsing is confined to the folder the chat was started in.
#[tauri::command]
async fn list_dir(state: State<'_, AppState>, slot: String, path: String) -> Result<Vec<files::Entry>, String> {
    let root = state.slots.get(&slot)?.folder()?;
    tauri::async_runtime::spawn_blocking(move || files::list_dir(&root, std::path::Path::new(&path))).await.map_err(|e| e.to_string())?
}

/// The chat's folder and its files for search and file mentions, listed at most every 15 seconds.
async fn file_index(state: &State<'_, AppState>, slot: &str) -> Result<(std::path::PathBuf, Arc<Vec<String>>), String> {
    const FRESH_FOR: std::time::Duration = std::time::Duration::from_secs(15);
    let s = state.slots.get(slot)?;
    let root = s.folder()?;
    let cached = s.file_index.lock().unwrap().as_ref().filter(|(r, at, _)| *r == root && at.elapsed() < FRESH_FOR).map(|(_, _, paths)| paths.clone());
    if let Some(paths) = cached {
        return Ok((root, paths));
    }
    let walk_root = root.clone();
    let paths = Arc::new(tauri::async_runtime::spawn_blocking(move || files::all_files(&walk_root)).await.map_err(|e| e.to_string())?);
    *s.file_index.lock().unwrap() = Some((root.clone(), std::time::Instant::now(), paths.clone()));
    Ok((root, paths))
}

/// Files in the chat's folder whose paths fuzzy-match `query`, best first.
#[tauri::command]
async fn find_files(state: State<'_, AppState>, slot: String, query: String) -> Result<Vec<files::Found>, String> {
    let (root, paths) = file_index(&state, &slot).await?;
    tauri::async_runtime::spawn_blocking(move || files::find(&root, &paths, &query, 60)).await.map_err(|e| e.to_string())
}

/// Lines in the chat's folder's files that match `query`, by file. A newer search cancels this one.
#[tauri::command]
async fn search_text(state: State<'_, AppState>, slot: String, query: files::TextQuery) -> Result<files::TextResults, String> {
    use std::sync::atomic::Ordering;
    let s = state.slots.get(&slot)?;
    let root = s.folder()?;
    let this = s.text_search.fetch_add(1, Ordering::SeqCst) + 1;
    let slot_ref = s.clone();
    tauri::async_runtime::spawn_blocking(move || files::search_text(&root, &query, &|| slot_ref.text_search.load(Ordering::Relaxed) != this))
        .await
        .map_err(|e| e.to_string())?
}

/// For each file mention in Claude's text, the file in the chat's folder it means, if any.
#[tauri::command]
async fn resolve_files(state: State<'_, AppState>, slot: String, mentions: Vec<String>) -> Result<Vec<Option<String>>, String> {
    let (root, paths) = file_index(&state, &slot).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let set: std::collections::HashSet<&str> = paths.iter().map(String::as_str).collect();
        mentions.iter().map(|m| files::resolve(&root, &set, m)).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_file(state: State<'_, AppState>, slot: String, path: String) -> Result<String, String> {
    let root = state.slots.get(&slot)?.folder()?;
    tauri::async_runtime::spawn_blocking(move || files::read_file(&root, std::path::Path::new(&path))).await.map_err(|e| e.to_string())?
}

/// Where Claude Code keeps transcripts (it honours CLAUDE_CONFIG_DIR, so we do too).
fn projects_root() -> Result<std::path::PathBuf, String> {
    let base = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) => std::path::PathBuf::from(dir),
        None => std::path::PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?).join(".claude"),
    };
    Ok(base.join("projects"))
}

#[tauri::command]
async fn list_sessions(state: State<'_, AppState>, folder: String) -> Result<Vec<history::SessionSummary>, String> {
    let root = projects_root()?;
    let titles = state.titles.all();
    tauri::async_runtime::spawn_blocking(move || history::list_sessions(&root, std::path::Path::new(&folder), &titles)).await.map_err(|e| e.to_string())
}

/// A short title for a session: Claude Code's own if it made one, else one Lantern made earlier, else a new one from
/// `prompt` (its first message). None when none could be made; the chat keeps its first prompt as its name then.
#[tauri::command]
async fn title_session(state: State<'_, AppState>, claude_path: String, folder: String, session_id: String, prompt: String) -> Result<Option<String>, String> {
    if !history::valid_id(&session_id) {
        return Err("Not a session id.".into());
    }
    let root = projects_root()?;
    let id = session_id.clone();
    let own = tauri::async_runtime::spawn_blocking(move || history::transcript_path(&root, std::path::Path::new(&folder), &id).ok().and_then(|p| history::transcript_title(&p)))
        .await
        .map_err(|e| e.to_string())?;
    if let Some(title) = own.or_else(|| state.titles.get(&session_id)) {
        return Ok(Some(title));
    }
    let path_env = login_path(&state).await;
    let title = titles::generate(std::path::Path::new(&claude_path), path_env.as_deref(), &prompt).await;
    if let Some(t) = &title {
        state.titles.set(&session_id, t);
    }
    Ok(title)
}

/// Folders the user has used Claude Code in lately, for the folder menu.
#[tauri::command]
async fn recent_folders() -> Result<Vec<history::RecentFolder>, String> {
    let root = projects_root()?;
    tauri::async_runtime::spawn_blocking(move || history::recent_folders(&root, 8)).await.map_err(|e| e.to_string())
}

/// Replays a past session into a chat, refills its change tracker from the session's edits, and continues it with `--resume`.
#[tauri::command]
async fn open_session(
    app: AppHandle,
    state: State<'_, AppState>,
    slot: String,
    claude_path: String,
    folder: String,
    settings: Settings,
    session_id: String,
) -> Result<Vec<ui_event::UiEvent>, String> {
    let s = slot_for(&app, &state, &slot)?;
    let cfg = new_config(&state, &s, claude_path, folder, settings, Some(session_id.clone())).await?;
    let root = projects_root()?;
    let folder = cfg.folder.clone();
    let replayed = tauri::async_runtime::spawn_blocking(move || history::transcript_path(&root, &folder, &session_id).map(|p| history::replay(&p)))
        .await
        .map_err(|e| e.to_string())??;
    launch(&app, &slot, &s, cfg, true).await?;
    s.changes.lock().unwrap().restore(replayed.edits, replayed.edits_before_last_turn);
    Ok(replayed.events)
}

/// A newer Lantern already downloaded and verified, for a window that started listening after it was found.
#[tauri::command]
fn update_status(updates: State<'_, updates::Updates>) -> Option<updates::UpdateInfo> {
    updates.ready()
}

/// Installs the downloaded update, stops every chat's claude, and relaunches into the new version. A failed install
/// leaves the chats running.
#[tauri::command]
async fn restart_to_update(app: AppHandle, state: State<'_, AppState>, updates: State<'_, updates::Updates>) -> Result<(), String> {
    updates.install()?;
    for s in state.slots.drain() {
        s.shut_down().await;
    }
    app.restart()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(navigation::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let titles = titles::TitleStore::load(app.path().app_data_dir().ok().map(|d| d.join("titles.json")));
            app.manage(AppState { slots: Slots::default(), login_path: Arc::new(OnceLock::new()), titles: Arc::new(titles), prs: Default::default() });
            app.manage(updates::Updates::default());
            if updates::checks_enabled() {
                tauri::async_runtime::spawn(updates::watch(app.handle().clone()));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            locate_claude,
            user_name,
            start_session,
            restart_session,
            apply_harness,
            close_session,
            send_message,
            run_shell,
            claude_request,
            skill_index,
            read_skill,
            mcp_add,
            mcp_remove,
            shell_input,
            stop_shell,
            interrupt,
            stop_task,
            branch_review,
            set_model,
            recent_folders,
            get_file_diff,
            change_summary,
            respond_permission,
            git_branch,
            list_dir,
            read_file,
            find_files,
            resolve_files,
            search_text,
            list_sessions,
            title_session,
            open_session,
            update_status,
            restart_to_update
        ])
        .build(tauri::generate_context!())
        .expect("error while building Lantern")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AppState>() {
                    tauri::async_runtime::block_on(async {
                        for s in state.slots.drain() {
                            s.shut_down().await;
                        }
                    });
                }
                // An update the user didn't restart for goes in now, for the next launch.
                if let Some(updates) = app.try_state::<updates::Updates>() {
                    if updates.ready().is_some() {
                        if let Err(e) = updates.install() {
                            eprintln!("{e}");
                        }
                    }
                }
            }
        });
}
