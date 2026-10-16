pub mod args;
pub mod aside;
pub mod awake;
pub mod changes;
pub mod checks;
pub mod cli_locator;
pub mod diagnostics;
pub mod files;
pub mod git;
pub mod history;
pub mod history_search;
pub mod mcp_config;
pub mod menu;
pub mod merge_tests;
pub mod navigation;
pub mod network;
pub mod orchestra;
pub mod permission;
pub mod pr;
pub mod process;
pub mod provider;
pub mod read_git;
pub mod session;
pub mod setup;
pub mod shell;
pub mod skills;
pub mod slots;
pub mod offstream;
pub mod outside;
pub mod relocate;
pub mod roles;
pub mod stream_parser;
pub mod test_runs;
pub mod titles;
pub mod trash;
pub mod revert;
pub mod checkpoint;
pub mod ui_event;
pub mod updates;

use args::{HelperConfig, Mode, Role};
use changes::FileDiff;
use provider::{ProviderId, ProviderInfo};
use session::{EditHook, Session, SessionConfig};
use slots::{Slot, SlotEvent, Slots};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

pub struct AppState {
    slots: Slots,
    /// The main agents and workers of every orchestra (see orchestra.rs).
    orchestra: Arc<orchestra::Orchestra>,
    login_path: Arc<OnceLock<Option<String>>>,
    titles: Arc<titles::TitleStore>,
    /// Names the user gave sessions in Lantern (Rename in the History menu): they beat every other title.
    renames: Arc<titles::TitleStore>,
    /// "Always allow" rules for folders, saved in app data and shared by every chat.
    folder_rules: Arc<permission::rules::FolderRules>,
    /// Where each folder was before it moved (see relocate): its sessions are read from there too.
    relocations: Arc<relocate::Relocations>,
    /// PRs looked up for the Changes pane, by repository and number, with when: fetching them takes a moment.
    prs: std::sync::Mutex<std::collections::HashMap<(std::path::PathBuf, u32), (std::time::Instant, pr::PrRange)>>,
    /// Network Monitor's captured traffic, as the network_* tools and the Network tab read it (see network.rs).
    network: Arc<network::Monitor>,
    /// How many workers may run at once across all of Lantern (Settings → General; the window sends it).
    agent_limit: std::sync::atomic::AtomicUsize,
    /// What History's full-text search has read of past chats, and the number of its newest search (see history_search.rs).
    chat_search: Arc<history_search::ChatSearch>,
    /// The side chats that are open: quick questions about a chat, in their own read-only claude (see aside.rs).
    asides: aside::Asides,
    /// What the user saved for each project: the setup run in a new worktree, and the Run command (the window sends it).
    setups: setup::SetupStore,
    /// "Keep restore points before each message" (Settings → General; the window sends it). On until the user turns it off.
    restore_points: std::sync::atomic::AtomicBool,
}

/// Where a test makes folders that must not be in the system temp dir (which recent folders leave out): the target dir
/// cargo builds into, wherever that is (a worktree may build into another checkout's). Not an agent's folder either
/// (Lantern's own workers' worktrees, which recent folders leave out too, see history::is_agent_folder): a checkout
/// there builds into its own target dir, so the tests use a cache folder in the home folder instead.
#[cfg(test)]
pub(crate) fn scratch_dir() -> std::path::PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR").map_or_else(|| std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/target")), std::path::PathBuf::from);
    if !history::is_agent_folder(&target.to_string_lossy()) {
        return target;
    }
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from).expect("HOME is set");
    let cache = home.join(".cache").join("lantern-tests");
    std::fs::create_dir_all(&cache).unwrap();
    cache
}

/// The user's limit on agents running at once until the window says otherwise, and the range it may be set in.
const DEFAULT_AGENT_LIMIT: usize = 3;
const AGENT_LIMITS: std::ops::RangeInclusive<usize> = 1..=orchestra::MAX_WORKERS;

/// The sidebar was hidden, shown, collapsed or expanded: View's two sidebar items now say what choosing them does.
#[tauri::command]
fn sidebar_menu(app: tauri::AppHandle, hidden: bool, compact: bool) -> Result<(), String> {
    menu::sidebar_changed(&app, hidden, compact).map_err(|e| e.to_string())
}

/// The window says whether any chat or agent is working, and whether the user wants the Mac kept awake meanwhile.
#[tauri::command]
fn keep_awake(awake: State<'_, awake::Awake>, working: bool, allowed: bool) {
    awake.update(working, allowed);
}

/// The user changed how many agents may run at once (or the window started and says what it was set to).
#[tauri::command]
fn set_agent_limit(state: State<'_, AppState>, limit: usize) -> Result<(), String> {
    if !AGENT_LIMITS.contains(&limit) {
        return Err(format!("The limit is between {} and {}.", AGENT_LIMITS.start(), AGENT_LIMITS.end()));
    }
    state.agent_limit.store(limit, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// The window sends what the user saved for a project (or the window started and says what it was): the lines run in each new
/// worktree, and the command its Run button starts. Lantern's own setting is the only place these come from.
#[tauri::command]
fn set_project_setup(state: State<'_, AppState>, folder: String, commands: Vec<String>, run: Option<String>) -> Result<(), String> {
    state.setups.set(std::path::Path::new(&folder), setup::ProjectSetup { commands, run })
}

/// What the project's files suggest for its setup and Run command: only offered, the user saves them.
#[tauri::command]
async fn suggest_setup(folder: String) -> Result<setup::Suggestion, String> {
    tauri::async_runtime::spawn_blocking(move || setup::detect(std::path::Path::new(&folder))).await.map_err(|e| e.to_string())
}

/// How long a looked-up PR is used before it's fetched again (it may have new commits).
const PR_FRESH: std::time::Duration = std::time::Duration::from_secs(120);

async fn pr_range(state: &AppState, folder: std::path::PathBuf, number: Option<u32>, hints: Vec<String>) -> Result<pr::PrRange, String> {
    let number = number.ok_or("Which pull request? None is being reviewed.")?;
    // Keyed by the repository the hints pick, not the folder: two repositories in one folder can both have a PR #N.
    let repo = tauri::async_runtime::spawn_blocking(move || pr::repo_for(&folder, &hints)).await.map_err(|e| e.to_string())??;
    let key = (repo.clone(), number);
    if let Some((at, range)) = state.prs.lock().unwrap().get(&key) {
        if at.elapsed() < PR_FRESH {
            return Ok(range.clone());
        }
    }
    let path_env = login_path(state).await;
    let range = tauri::async_runtime::spawn_blocking(move || pr::resolve(&repo, number, path_env.as_deref())).await.map_err(|e| e.to_string())??;
    state.prs.lock().unwrap().insert(key, (std::time::Instant::now(), range.clone()));
    Ok(range)
}

/// The login-shell PATH, computed once off the main thread.
async fn login_path(state: &AppState) -> Option<String> {
    let cell = state.login_path.clone();
    tauri::async_runtime::spawn_blocking(move || cell.get_or_init(cli_locator::login_shell_path).clone()).await.ok().flatten()
}

/// Sends a chat's events to the UI, and lets the orchestra see them too (a worker finishing a turn wakes its main agent).
fn emitter(app: &AppHandle) -> impl Fn(SlotEvent) + Send + Sync + Clone + 'static {
    let app = app.clone();
    move |ev| {
        let _ = app.emit("ui-event", &ev);
        if let Some(state) = app.try_state::<AppState>() {
            // Its claude is gone: the pid it had could be given to some other process, which must not pass for it.
            if matches!(ev.event, ui_event::UiEvent::SessionEnded { .. }) {
                if let Ok(slot) = state.slots.get(&ev.slot) {
                    slot.claude_pid.store(0, std::sync::atomic::Ordering::SeqCst);
                }
            }
            // The turn is over (or its claude is gone): files stop changing, so they can be restored.
            if matches!(ev.event, ui_event::UiEvent::TurnDone { .. } | ui_event::UiEvent::SessionEnded { .. }) {
                if let Ok(slot) = state.slots.get(&ev.slot) {
                    slot.checkpoints.turn_ended();
                }
            }
            state.orchestra.observe(&ev.slot, &ev.event);
        }
    }
}

/// What a provider can do (see Capabilities).
fn capabilities_of(provider: ProviderId) -> provider::Capabilities {
    provider.provider().capabilities()
}

/// The providers a main agent on `own` may start workers on: its own, which is running, then every other whose CLI is found.
async fn available_providers(own: ProviderId) -> Vec<ProviderId> {
    let mut available = vec![own];
    for id in ProviderId::all().into_iter().filter(|id| *id != own) {
        if tauri::async_runtime::spawn_blocking(move || id.provider().locate(None)).await.is_ok_and(|found| found.is_ok()) {
            available.push(id);
        }
    }
    available
}

/// The most freedom the workers of main agent `main` may have, from its mode as it is now (Ask when it isn't open).
fn main_ceiling(state: &AppState, main: &str) -> Mode {
    let cfg = state.slots.get(main).ok().and_then(|s| s.config.lock().unwrap().clone());
    ceiling_of(cfg.map(|c| (c.mode, c.auto_approve, c.provider)))
}

/// The most freedom workers may have under a main agent running `(mode, auto_approve, provider)`: Ask when it isn't open.
fn ceiling_of(main: Option<(Mode, bool, ProviderId)>) -> Mode {
    main.map_or(Mode::Ask, |(mode, auto, provider)| args::worker_mode(mode, auto, &capabilities_of(provider)))
}

/// `cfg`'s mode and auto-approve, no freer than `ceiling` allows (None: no ceiling, the chat is no worker). True when that
/// lowered them.
fn cap_mode(cfg: &mut SessionConfig, ceiling: Option<Mode>) -> bool {
    let Some(ceiling) = ceiling else { return false };
    let (mode, auto) = args::capped_mode(cfg.mode, cfg.auto_approve, ceiling, &capabilities_of(cfg.provider));
    let lowered = (mode, auto) != (cfg.mode, cfg.auto_approve);
    cfg.mode = mode;
    cfg.auto_approve = auto;
    lowered
}

/// The ceiling for chat `slot` when it is a worker of an open main agent: what its main agent allows now.
fn worker_ceiling(state: &AppState, slot: &str) -> Option<Mode> {
    state.orchestra.parent_of(slot).map(|main| main_ceiling(state, &main))
}

/// Tells the window a worker runs on Ask: its mode was lowered under it.
fn told_ask(app: &AppHandle, slot: &str) {
    let _ = app.emit("ui-event", SlotEvent { slot: slot.to_string(), event: ui_event::UiEvent::AgentMode { mode: "ask".into() } });
}

/// How the worker `worker` runs once its main agent's mode allows no more than `ceiling`: lowered (its claude restarted on
/// the same conversation, since the mode is a launch flag) when it was running with more freedom than that.
async fn lower_worker(app: &AppHandle, state: &AppState, worker: &str, ceiling: Mode) {
    let Ok(s) = state.slots.get(worker) else { return };
    let Some(mut cfg) = s.config.lock().unwrap().clone() else { return };
    let (mode, auto) = args::capped_mode(cfg.mode, cfg.auto_approve, ceiling, &capabilities_of(cfg.provider));
    if (mode, auto) == (cfg.mode, cfg.auto_approve) {
        return;
    }
    let running = s.session.lock().await.as_ref().and_then(|x| x.session_id());
    cfg.mode = mode;
    cfg.auto_approve = auto;
    cfg.resume = running.or(cfg.resume);
    cfg.path_env = login_path(state).await;
    if let Ok(helper) = helper_config(&s, cfg.helper.role.clone(), cfg.helper.project_notes.clone()) {
        cfg.helper = helper;
    }
    if launch(app, worker, &s, cfg, false).await.is_ok() {
        told_ask(app, worker);
    }
}

/// The app, as the orchestra needs it (see orchestra::Host).
struct AppHost {
    app: AppHandle,
}

impl orchestra::Host for AppHost {
    fn emit(&self, slot: &str, event: ui_event::UiEvent) {
        let _ = self.app.emit("ui-event", SlotEvent { slot: slot.to_string(), event });
    }

    fn main_folder(&self, main: &str) -> Result<std::path::PathBuf, String> {
        self.app.state::<AppState>().slots.get(main)?.folder()
    }

    fn main_provider(&self, main: &str) -> ProviderId {
        let state = self.app.state::<AppState>();
        let cfg = state.slots.get(main).ok().and_then(|s| s.config.lock().unwrap().as_ref().map(|c| c.provider));
        cfg.unwrap_or_default()
    }

    fn available_providers(&self, main: &str) -> orchestra::Fut<'_, Vec<ProviderId>> {
        let own = self.main_provider(main);
        Box::pin(available_providers(own))
    }

    fn worker_mode(&self, main: &str, provider: ProviderId) -> Mode {
        let ceiling = main_ceiling(&self.app.state::<AppState>(), main);
        args::capped_mode(ceiling, false, ceiling, &capabilities_of(provider)).0
    }

    fn agent_limit(&self) -> usize {
        self.app.state::<AppState>().agent_limit.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn project_setup(&self, folder: &std::path::Path) -> setup::ProjectSetup {
        self.app.state::<AppState>().setups.get(folder)
    }

    fn worktree_root(&self) -> std::path::PathBuf {
        self.app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("worktrees")
    }

    fn path_env(&self) -> orchestra::Fut<'_, Option<String>> {
        Box::pin(async move { login_path(&self.app.state::<AppState>()).await })
    }

    fn spawn_worker(&self, req: orchestra::SpawnRequest) -> orchestra::Fut<'_, Result<(), String>> {
        Box::pin(async move {
            let state = self.app.state::<AppState>();
            let parent_slot = req.parent.clone();
            let parent = state.slots.get(&req.parent)?;
            // The worker runs on its main agent's provider unless another was asked for: it is cloned with the rest of the config.
            let mut cfg = parent.config.lock().unwrap().clone().ok_or("The Lead has no folder open.")?;
            if req.provider != cfg.provider {
                // Another provider's CLI is a program, models and settings of its own: none of the main agent's carry over.
                let id = req.provider;
                cfg.binary = tauri::async_runtime::spawn_blocking(move || id.provider().locate(None)).await.map_err(|e| e.to_string())??;
                cfg.provider = id;
                cfg.model = None;
                cfg.effort = None;
                cfg.advisor = None;
                cfg.subagent_model = None;
            }
            let s = slot_for(&self.app, &state, &req.slot)?;
            // On Auto a prompt only reaches the user when Claude Code's own classifier can't decide, which is what makes a
            // team of workers workable: but only when the main agent is on Auto too. Otherwise an Ask-mode main agent
            // (the user approves each of its actions) could start workers that don't ask.
            cfg.folder = req.folder;
            cfg.mode = req.mode;
            cfg.auto_approve = false;
            cfg.resume = None;
            if req.model.is_some() {
                cfg.model = req.model;
            }
            // The worker's folder is a worktree, but it belongs to its Lead's project: it gets the notes the Lead started with.
            let notes = cfg.helper.project_notes.clone();
            cfg.helper = helper_config(&s, Role::Worker { name: req.name, read_only: req.read_only }, notes)?;
            cfg.path_env = login_path(&state).await;
            launch(&self.app, &req.slot, &s, cfg, true).await?;
            // The main agent's mode may have been lowered while this one started (the mode it was given was read before):
            // checked again now that it runs, so a restart that missed it can't leave it freer than its main agent.
            lower_worker(&self.app, &state, &req.slot, main_ceiling(&state, &parent_slot)).await;
            send_text(&self.app, &req.slot, &s, &req.brief).await.map(|_| ())
        })
    }

    fn send_to<'a>(&'a self, slot: &'a str, text: String) -> orchestra::Fut<'a, Result<(), String>> {
        Box::pin(async move {
            let s = self.app.state::<AppState>().slots.get(slot)?;
            send_text(&self.app, slot, &s, &text).await.map(|_| ())
        })
    }

    fn stop<'a>(&'a self, slot: &'a str) -> orchestra::Fut<'a, ()> {
        Box::pin(async move {
            let Ok(s) = self.app.state::<AppState>().slots.get(slot) else { return };
            s.bridge.cancel_all();
            s.shells.stop_all();
            // Taken out before stopping: the lock would otherwise be held while claude stops. A write to a claude that isn't
            // reading can hold it, so after a moment claude is signalled directly rather than waited for.
            let session = match tokio::time::timeout(std::time::Duration::from_secs(2), s.session.lock()).await {
                Ok(mut guard) => guard.take(),
                Err(_) => {
                    let pid = s.claude_pid.swap(0, std::sync::atomic::Ordering::SeqCst);
                    // Only if that pid is still a process this app started: one that has exited may have had its number
                    // given to something else, and a group signal would reach that.
                    if pid > 1 && process::is_child_of(pid, std::process::id()) {
                        // Its own session and group (the pid is the group id), as Session::stop signals it.
                        unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
                    }
                    return;
                }
            };
            s.claude_pid.store(0, std::sync::atomic::Ordering::SeqCst);
            if let Some(session) = session {
                // Remembered, so restarting the chat carries on the same conversation rather than starting another.
                if let (Some(id), Some(cfg)) = (session.session_id(), s.config.lock().unwrap().as_mut()) {
                    cfg.resume = Some(id);
                }
                session.stop().await;
            }
        })
    }

    fn transcript(&self, folder: &std::path::Path, session_id: &str) -> Result<Vec<ui_event::UiEvent>, String> {
        let path = history::transcript_path(&projects_root()?, folder, session_id)?;
        Ok(history::replay(&path).events)
    }
}

/// Makes `slot` the main agent of an orchestra (when its role says so): its bridge serves the orchestra tools.
fn enroll(state: &AppState, id: &str, slot: &Slot, role: &Role) {
    if *role == Role::Main {
        state.orchestra.register_main(id);
        // Only this chat's own helper reaches the handler (see slot_for): a process this chat's claude started itself that
        // runs Lantern's executable. That keeps out workers, their commands, other chats and anything else of the user's.
        // It doesn't keep out the main agent itself: a command it runs that starts Lantern's executable directly (a shell
        // runs a single command in its own place) is the same kind of process as the helper, and is let in. That gives
        // the main agent nothing it can't already do with its own orchestra tools.
        slot.bridge.set_orchestra(state.orchestra.handler(id.to_string()));
    } else {
        state.orchestra.forget(id);
    }
}

/// The chat's slot, created on first use.
fn slot_for(app: &AppHandle, state: &AppState, slot: &str) -> Result<Arc<Slot>, String> {
    // Every request to the chat's bridge must come from its own claude's helper: a direct child of that claude running
    // Lantern's own executable (see bridge::helper_of).
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let slot = state.slots.get_or_create(slot, &std::env::temp_dir(), emitter(app), state.folder_rules.clone(), move |claude| permission::bridge::helper_of(claude, exe))?;
    // Every chat's helper offers the network_* tools; they're answered here, for the chat's folder.
    let monitor = state.network.clone();
    slot.bridge.set_network(Arc::new(move |folder, tool, input| {
        let monitor = monitor.clone();
        Box::pin(async move {
            let result = tauri::async_runtime::spawn_blocking(move || monitor.call(folder.as_deref(), &tool, &input)).await.unwrap_or_else(|e| Err(e.to_string()));
            let (allow, text) = match result {
                Ok(text) => (true, text),
                Err(text) => (false, text),
            };
            permission::protocol::BridgeResponse { allow, message: Some(text), updated_input: None, failed: false }
        })
    }));
    Ok(slot)
}

/// The Network tab's rows for a folder, with its watches and whether Network Monitor is running.
#[tauri::command]
async fn network_state(state: State<'_, AppState>, folder: String) -> Result<network::View, String> {
    let monitor = state.network.clone();
    tauri::async_runtime::spawn_blocking(move || monitor.view(&permission::rules::folder_key(std::path::Path::new(&folder)))).await.map_err(|e| e.to_string())
}

/// One request's headers and bodies, for the Network tab: the copy Lantern kept, else Network Monitor's.
#[tauri::command]
async fn network_response(state: State<'_, AppState>, folder: String, id: String) -> Result<network::Detail, String> {
    let monitor = state.network.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let key = permission::rules::folder_key(std::path::Path::new(&folder));
        monitor.detail(Some(&key), &id).map(|d| (*d).clone()).map_err(|f| f.explain())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Puts back a watch the user just removed from the Network tab (its Undo).
#[tauri::command]
fn network_rewatch(state: State<'_, AppState>, folder: String, label: String, method: Option<String>, url: String) {
    state.network.watch(&permission::rules::folder_key(std::path::Path::new(&folder)), network::Watch { label, method, url });
}

#[tauri::command]
fn network_unwatch(state: State<'_, AppState>, folder: String, label: String) -> bool {
    state.network.unwatch(&permission::rules::folder_key(std::path::Path::new(&folder)), &label)
}

/// `project_notes`: what the chat was started with (a restart passes its own on, a new chat the user's notes as they are now).
fn helper_config(slot: &Slot, role: Role, project_notes: Option<String>) -> Result<HelperConfig, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(HelperConfig { exe: exe.display().to_string(), socket: slot.bridge.socket_path.display().to_string(), role, providers: vec![], project_notes })
}

/// Stops the slot's running session (denying its pending prompts) and starts `cfg` in it.
async fn launch(app: &AppHandle, id: &str, slot: &Slot, mut cfg: SessionConfig, clear_changes: bool) -> Result<(), String> {
    // Told to the main agent as it starts (and again whenever it restarts, which is when a CLI installed since shows up).
    if cfg.helper.role == Role::Main {
        cfg.helper.providers = available_providers(cfg.provider).await;
    }
    let mut session = slot.session.lock().await;
    if let Some(old) = session.take() {
        slot.claude_pid.store(0, std::sync::atomic::Ordering::SeqCst);
        slot.bridge.cancel_all();
        old.stop().await;
    }
    slot.bridge.set_folder(&cfg.folder);
    // Only a chat started as a read-only agent has the git tool answered (see PermissionBridge); the helper's word is not taken.
    let reader = matches!(cfg.helper.role, Role::Worker { read_only: true, .. });
    slot.bridge.set_read_git(reader.then(|| read_git::Scope { folder: cfg.folder.clone(), path_env: cfg.path_env.clone() }));
    if clear_changes {
        // A new conversation in this chat: the rules it made for its old one go. (A restart keeps them.)
        slot.bridge.clear_chat_rules();
        let folder = cfg.folder.clone();
        let baseline = tauri::async_runtime::spawn_blocking(move || outside::Baseline::take(&folder)).await.map_err(|e| e.to_string())?;
        let mut changes = slot.changes.lock().unwrap();
        changes.clear();
        changes.watch(baseline);
        slot.checkpoints.forget();
    }
    slot.checkpoints.turn_ended();
    let changes = slot.changes.clone();
    let on_edit: EditHook = Arc::new(move |path: &str, original: Option<String>| changes.lock().unwrap().record(path, original));
    let mut started = Session::spawn(&cfg, slots::tagged(id, emitter(app)), on_edit)?;
    slot.claude_pid.store(started.pid(), std::sync::atomic::Ordering::SeqCst);
    started.initialize().await;
    *session = Some(started);
    *slot.config.lock().unwrap() = Some(cfg);
    Ok(())
}

/// How a chat's claude runs: permission mode, model and effort (None = Claude Code's default for either).
#[derive(serde::Deserialize)]
struct Settings {
    /// Which agent CLI runs the chat. Chats saved before there was a choice don't say, and are Claude's.
    #[serde(default)]
    provider: ProviderId,
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
    /// Start the chat as the main agent of an orchestra: it can spawn workers (see orchestra.rs).
    #[serde(default)]
    orchestrator: bool,
    /// Reopen the chat as a worker of an open main agent (a team restored after Lantern was closed).
    #[serde(default)]
    worker: Option<WorkerSettings>,
    /// The user's notes for the project (see args::clean_project_notes). A worker's are its Lead's, whatever it sends.
    #[serde(default)]
    project_notes: Option<String>,
}

/// Whose worker a restored chat is.
#[derive(serde::Deserialize, Clone)]
struct WorkerSettings {
    name: String,
    /// The main agent's slot, which has to be open already.
    parent: String,
    /// The branch Lantern made for it, as the canvas saved it (None: a shared folder, or a save from before it was kept).
    /// Its worktree's HEAD is the worker's to switch, so this is what says which branch is the worker's.
    #[serde(default)]
    branch: Option<String>,
    /// It works in its main agent's folder, so it reads and doesn't edit (see Role::Worker).
    #[serde(default)]
    shared: bool,
    /// Its role is a read-only one (see roles.rs): the same as `shared` for what it may do, but it has a folder of its own.
    #[serde(default)]
    read_only: bool,
    /// The role it was started in, which decides whether a finished turn of its starts a review (see orchestra/review.rs).
    #[serde(default)]
    role: Option<roles::RoleTag>,
}

fn checked_effort(effort: Option<String>) -> Result<Option<String>, String> {
    match effort {
        Some(e) if !args::valid_effort(&e) => Err(format!("{e:?} is not an effort level.")),
        e => Ok(e),
    }
}

/// A chat's config from what the window sent. A worker's mode is no freer than its main agent allows now, whatever the
/// window asked for (see `cap_mode`).
async fn new_config(state: &AppState, slot: &Slot, claude_path: String, folder: String, settings: Settings, resume: Option<String>) -> Result<SessionConfig, String> {
    if !std::path::Path::new(&folder).is_dir() {
        return Err(format!("{folder} no longer exists."));
    }
    let ceiling = settings.worker.as_ref().map(|w| main_ceiling(state, &w.parent));
    // A worker's folder is a worktree of its Lead's project, so it gets the notes its Lead started with.
    let notes = match &settings.worker {
        Some(w) => state.slots.get(&w.parent).ok().and_then(|s| s.config.lock().unwrap().as_ref().and_then(|c| c.helper.project_notes.clone())),
        None => settings.project_notes.as_deref().and_then(args::clean_project_notes),
    };
    let mut cfg = SessionConfig {
        provider: settings.provider,
        binary: claude_path.into(),
        folder: folder.into(),
        mode: settings.mode,
        auto_approve: settings.auto_approve,
        resume,
        model: checked_model(settings.model)?,
        effort: checked_effort(settings.effort)?,
        advisor: checked_model(settings.advisor)?,
        subagent_model: checked_model(settings.subagent_model)?,
        helper: helper_config(
            slot,
            match (settings.orchestrator, settings.worker) {
                (true, _) => Role::Main,
                (false, Some(w)) => Role::Worker { name: w.name, read_only: w.shared || w.read_only },
                (false, None) => Role::Normal,
            },
            notes,
        )?,
        path_env: login_path(state).await,
    };
    cap_mode(&mut cfg, ceiling);
    Ok(cfg)
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
    // The window only knows Claude Code for now: which provider's binary is wanted will come with its choice.
    tauri::async_runtime::spawn_blocking(move || ProviderId::Claude.provider().locate(path_override.as_deref()).map(|p| p.display().to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether claude is logged in, and as whom (`claude auth status`).
#[derive(serde::Serialize)]
struct Login {
    logged_in: bool,
    account: Option<String>,
}

/// Asks the claude at `claude_path` whether it is logged in, for the first-launch screen. An error means claude couldn't
/// say (too old to have `auth status`, or it didn't answer): the screen then leaves it to the first chat to find out.
#[tauri::command]
async fn claude_login(state: State<'_, AppState>, claude_path: String) -> Result<Login, String> {
    let path_env = login_path(&state).await;
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&claude_path);
        cmd.args(["auth", "status"]).stdin(std::process::Stdio::null());
        if let Some(path) = path_env {
            cmd.env("PATH", path);
        }
        let out = cmd.output().map_err(|e| e.to_string())?;
        // A claude that isn't logged in may exit with an error and still say so, in the same JSON.
        let status: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|_| "claude didn't say whether it is logged in.".to_string())?;
        Ok(Login { logged_in: status["loggedIn"].as_bool().unwrap_or(false), account: status["email"].as_str().map(str::to_string) })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn start_session(app: AppHandle, state: State<'_, AppState>, slot: String, claude_path: String, folder: String, settings: Settings) -> Result<ProviderInfo, String> {
    let s = slot_for(&app, &state, &slot)?;
    let asked = settings.mode;
    let cfg = new_config(&state, &s, claude_path, folder, settings, None).await?;
    enroll(&state, &slot, &s, &cfg.helper.role);
    let provider = cfg.provider.info();
    let lowered = cfg.mode != asked;
    launch(&app, &slot, &s, cfg, true).await?;
    if lowered {
        told_ask(&app, &slot);
    }
    menu::refresh_recent(&app).await;
    Ok(provider)
}

/// The role a chat has after its Workflow is set to Team (`team` true) or to another (false): a chat becomes the Lead of a
/// team, or stops being one. A worker keeps its role (its Workflow is its Lead's to set), and `team` None leaves it as it is.
/// Stopping being a Lead is refused while it has agents, which would be left with nobody to report to.
fn role_after(role: &Role, team: Option<bool>, agents: usize) -> Result<Role, String> {
    match (role, team) {
        (Role::Worker { .. }, _) | (_, None) => Ok(role.clone()),
        (_, Some(true)) => Ok(Role::Main),
        (Role::Main, Some(false)) if agents > 0 => Err("This team still has agents. Close them first, then switch its Workflow.".into()),
        (_, Some(false)) => Ok(Role::Normal),
    }
}

/// Restarts a chat's claude on the same session (`--resume`), e.g. with new Permissions, Workflow or effort. `mode` and
/// `auto_approve` are the launch flags those make (Auto is `Auto`, or `Steps` with `auto_approve`); `team` is Workflow Team:
/// true makes the chat the Lead of a team (its claude restarts with the Lead's tools and instructions, on the same
/// conversation), false makes a Lead an ordinary chat again, and None leaves its role alone.
#[tauri::command]
async fn restart_session(app: AppHandle, state: State<'_, AppState>, slot: String, mode: Mode, effort: Option<String>, auto_approve: Option<bool>, team: Option<bool>) -> Result<(), String> {
    let s = state.slots.get(&slot)?;
    let running_id = s.session.lock().await.as_ref().and_then(|x| x.session_id());
    let mut cfg = s.config.lock().unwrap().clone().ok_or("No folder is open")?;
    let role = role_after(&cfg.helper.role, team, state.orchestra.workers_of(&slot).len())?;
    cfg.mode = mode;
    cfg.effort = checked_effort(effort)?;
    if let Some(auto) = auto_approve {
        cfg.auto_approve = auto;
    }
    cfg.resume = running_id.or(cfg.resume);
    cfg.helper = helper_config(&s, role.clone(), cfg.helper.project_notes.clone())?;
    cfg.path_env = login_path(&state).await;
    // A worker asked for more freedom than its main agent allows gets what it allows (the window is told).
    let lowered = cap_mode(&mut cfg, worker_ceiling(&state, &slot));
    let (new_mode, new_auto, provider) = (cfg.mode, cfg.auto_approve, cfg.provider);
    launch(&app, &slot, &s, cfg, false).await?;
    // Registered as the Lead (or taken out of the team registry) once it runs as one; a worker's role never changes here.
    if team.is_some() && !matches!(role, Role::Worker { .. }) {
        enroll(&state, &slot, &s, &role);
    }
    if lowered {
        told_ask(&app, &slot);
    }
    // A worker never has more freedom than its main agent: when the main agent's mode is lowered, so are its workers'.
    if state.orchestra.is_main(&slot) {
        let ceiling = args::worker_mode(new_mode, new_auto, &capabilities_of(provider));
        for worker in state.orchestra.workers_of(&slot) {
            lower_worker(&app, &state, &worker, ceiling).await;
        }
    }
    Ok(())
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
    cfg.helper = helper_config(&s, cfg.helper.role.clone(), cfg.helper.project_notes.clone())?;
    cfg.path_env = login_path(&state).await;
    let lowered = cap_mode(&mut cfg, worker_ceiling(&state, &slot));
    launch(&app, &slot, &s, cfg, false).await?;
    if lowered {
        told_ask(&app, &slot);
    }
    Ok(())
}

/// Stops a chat and forgets it. Closing one that doesn't exist is fine.
#[tauri::command]
async fn close_session(state: State<'_, AppState>, slot: String) -> Result<(), String> {
    state.orchestra.forget(&slot);
    state.asides.stop_slot(&slot).await;
    if let Some(s) = state.slots.remove(&slot) {
        s.shut_down().await;
    }
    Ok(())
}

/// Asks a side question about a chat (see aside.rs): the first question of side chat `aside` starts a read-only copy of the
/// chat's conversation, the rest follow up in it. The answer comes as `aside-event`s, never as the chat's own events.
/// `model`: what the side chat runs on; None is the chat's. Resolves to whether it has the chat's conversation to start from.
#[tauri::command]
async fn aside_ask(app: AppHandle, state: State<'_, AppState>, slot: String, aside: String, text: String, model: Option<String>) -> Result<bool, String> {
    let model = checked_model(model)?;
    let s = state.slots.get(&slot)?;
    let (provider, binary, folder, path_env, chat_model) = {
        let cfg = s.config.lock().unwrap();
        let cfg = cfg.as_ref().ok_or("No folder is open")?;
        (cfg.provider, cfg.binary.clone(), cfg.folder.clone(), cfg.path_env.clone(), cfg.model.clone())
    };
    if provider != ProviderId::Claude {
        return Err("Side chats need Claude Code.".into());
    }
    let session_id = s.session.lock().await.as_ref().and_then(|x| x.session_id());
    // From the folder's own transcripts only: that is where the claude it starts looks.
    let resume = aside::forkable(&projects_root()?, &folder, &[], session_id.as_deref());
    let launch = aside::Launch { binary, folder, path_env, resume, model: model.or(chat_model) };
    let emit: Arc<dyn Fn(aside::AsideEvent) + Send + Sync> = Arc::new(move |ev| {
        let _ = app.emit("aside-event", &ev);
    });
    state.asides.ask(&aside, &slot, &launch, &text, emit).await
}

/// The side chat's popover closed: its claude is stopped and nothing of it is kept.
#[tauri::command]
async fn aside_stop(state: State<'_, AppState>, aside: String) -> Result<(), String> {
    state.asides.stop(&aside).await;
    Ok(())
}

/// Stops the answer being written, keeping the side chat for another question.
#[tauri::command]
async fn aside_stop_answering(app: AppHandle, state: State<'_, AppState>, aside: String) -> Result<(), String> {
    state.asides.stop_answering(&aside, Arc::new(move |ev| {
        let _ = app.emit("aside-event", &ev);
    })).await;
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
    let mut live = true;
    if let Some(cfg) = s.config.lock().unwrap().as_mut() {
        cfg.model = model.clone();
        // A provider whose model is fixed for the session takes it at the next start, which reads it from the config.
        live = cfg.provider.provider().capabilities().model_switchable;
    }
    let mut session = s.session.lock().await;
    match session.as_mut() {
        Some(x) if live && x.is_running() => x.set_model(model.as_deref()).await,
        _ => Ok(()),
    }
}

#[tauri::command]
/// Returns the turn's number, which the Changes pane can ask about later (a Step-by-step page's changes).
async fn send_message(app: AppHandle, state: State<'_, AppState>, slot: String, text: String) -> Result<usize, String> {
    let s = state.slots.get(&slot)?;
    let turn = send_text(&app, &slot, &s, &text).await?;
    // Said to a worker by the user themselves: its main agent hears of it with its next wake-up.
    state.orchestra.note_user_message(&slot, &text);
    Ok(turn)
}

/// Runs `f` (blocking) with the chat's restore points and the git checkout of its folder: an error says why there is none
/// (the folder isn't in a repository). A worker's worktree is checked against its Lead's repository first.
async fn at_checkpoints<T, F>(app: &AppHandle, id: &str, s: &Arc<Slot>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Slot, &checkpoint::Place, Option<&str>) -> Result<T, String> + Send + 'static,
{
    let (folder, path_env) = {
        let cfg = s.config.lock().unwrap();
        let cfg = cfg.as_ref().ok_or("No folder is open")?;
        (cfg.folder.clone(), cfg.path_env.clone())
    };
    let state = app.state::<AppState>();
    let main = state.orchestra.parent_of(id).and_then(|p| state.slots.get(&p).ok()).and_then(|p| p.folder().ok());
    let s = s.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let place = checkpoint::Place::find(&folder, main.as_deref(), path_env.as_deref()).ok_or("This folder isn't in a git repository, so it has no restore points.")?;
        f(&s, &place, path_env.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Sends `text` into the chat's claude as a new message and returns the turn's number.
async fn send_text(app: &AppHandle, id: &str, s: &Arc<Slot>, text: &str) -> Result<usize, String> {
    let mut session = s.session.lock().await;
    let claude = session.as_mut().ok_or("No Claude session is running")?;
    // What "Last turn" in the Changes pane compares against. It's taken before the send, so Claude's edits come after it.
    let changes = s.changes.clone();
    let turn = tauri::async_runtime::spawn_blocking(move || changes.lock().unwrap().start_turn()).await.map_err(|e| e.to_string())?;
    // How the folder stands before the message, which "Restore files to here" puts back. Before the send, so Claude's edits
    // come after it; a folder that isn't a repository, or git failing, only means there is no restore point for it. It is
    // given a few seconds at most, and a late one is never kept (it would hold edits of the turn).
    let (late, slot_id) = (Arc::new(std::sync::atomic::AtomicBool::new(false)), id.to_string());
    let given_up = late.clone();
    // Not at all when the user has turned restore points off.
    if app.state::<AppState>().restore_points.load(std::sync::atomic::Ordering::SeqCst) {
        let taken = at_checkpoints(app, id, s, move |s, place, path_env| s.checkpoints.take_unless(place, &slot_id, turn, path_env, &given_up));
        if tokio::time::timeout(std::time::Duration::from_secs(8), taken).await.is_err() {
            late.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    s.checkpoints.turn_started();
    if let Err(e) = claude.send(text).await {
        s.checkpoints.turn_ended();
        s.changes.lock().unwrap().cancel_turn(turn);
        return Err(e);
    }
    // The folder's history is first written with its first message: Open Recent lists it from then on.
    let folder = s.config.lock().unwrap().as_ref().map(|c| c.folder.display().to_string());
    drop(session);
    if folder.is_some_and(|f| !menu::lists(app, &f)) {
        menu::refresh_recent(app).await;
    }
    Ok(turn)
}

/// The user approved a worker's merge (the card's button): its branch goes into the main checkout.
#[tauri::command]
async fn orchestra_approve_merge(state: State<'_, AppState>, worker: String) -> Result<(), String> {
    state.orchestra.approve_merge(&worker).await
}

#[tauri::command]
fn orchestra_decline_merge(state: State<'_, AppState>, worker: String) -> Result<(), String> {
    state.orchestra.decline_merge(&worker)
}

/// The merge card's test run for a worker: how it can be run, what is going, and the last result.
#[tauri::command]
async fn orchestra_merge_tests_info(state: State<'_, AppState>, worker: String) -> Result<orchestra::TestsInfo, String> {
    state.orchestra.merge_tests_info(&worker).await
}

/// Runs the tests in a worker's worktree, when the user asks: `command` is the words of what they typed (null: what the
/// worktree says). Resolves when they end; null when the user cancelled them.
#[tauri::command]
async fn orchestra_run_merge_tests(state: State<'_, AppState>, worker: String, command: Option<Vec<String>>) -> Result<Option<orchestra::LastInfo>, String> {
    state.orchestra.run_merge_tests(&worker, command).await
}

#[tauri::command]
fn orchestra_cancel_merge_tests(state: State<'_, AppState>, worker: String) {
    state.orchestra.cancel_merge_tests(&worker)
}

/// What a command the user typed would run as: its words, or why it can't be run. Nothing is run.
#[tauri::command]
fn merge_tests_split_command(text: String) -> Result<Vec<String>, String> {
    merge_tests::split_command(&text)
}

/// "Keep restore points before each message" (Settings → General). Off, no file is copied before a message; restore points
/// already made can still be used.
#[tauri::command]
fn set_restore_points(state: State<'_, AppState>, on: bool) {
    state.restore_points.store(on, std::sync::atomic::Ordering::SeqCst);
}

/// "Run tests when a merge is proposed" (Settings → General).
#[tauri::command]
fn set_auto_merge_tests(state: State<'_, AppState>, on: bool) {
    state.orchestra.set_auto_tests(on)
}

/// Removes a worker's worktree. Without `force`, a worktree with loose work is kept (an error says so) and a branch
/// that isn't merged is kept either way.
#[tauri::command]
async fn orchestra_discard(state: State<'_, AppState>, worker: String, force: bool) -> Result<(), String> {
    state.orchestra.discard(&worker, force).await
}

/// What closing a worker from its card would throw away: asked before anything is stopped or removed.
#[tauri::command]
async fn orchestra_close_check(state: State<'_, AppState>, worker: String) -> Result<orchestra::CloseCheck, String> {
    state.orchestra.close_check(&worker).await
}

/// Closes a worker from its card: stops it, removes its worktree and branch, and tells its main agent. Work that would be
/// thrown away needs `agreed`: what the user was asked about, which the worker must not have outgrown since.
#[tauri::command]
async fn orchestra_close_worker(state: State<'_, AppState>, worker: String, agreed: Option<orchestra::Agreed>) -> Result<(), String> {
    state.orchestra.close_worker(&worker, agreed).await
}

/// The user's answer on a worker whose setup failed: "start" it anyway, or run setup "again".
#[tauri::command]
async fn orchestra_setup_answer(state: State<'_, AppState>, worker: String, answer: String) -> Result<(), String> {
    state.orchestra.setup_answer(&worker, &answer).await
}

/// Starts a worker the user asked for from the canvas (the main agent `main` is told). Returns the worker's id.
#[tauri::command]
async fn orchestra_spawn(state: State<'_, AppState>, main: String, task: String, name: Option<String>, isolation: String, model: Option<String>, role: Option<roles::RoleTag>) -> Result<String, String> {
    state.orchestra.spawn_for_user(&main, &task, name.as_deref(), &isolation, model.as_deref(), role).await
}

/// Tells a Lead's team the project's own roles (the built-in ones need no telling), so the Lead may ask for one by id.
/// A team's "Review and test what an agent builds" setting (see orchestra/review.rs).
#[tauri::command]
fn orchestra_set_review(state: State<'_, AppState>, main: String, setting: orchestra::ReviewSetting) -> Result<(), String> {
    state.orchestra.set_review(&main, setting)
}

#[tauri::command]
fn orchestra_set_roles(state: State<'_, AppState>, main: String, roles: Vec<roles::RoleDef>) -> Result<(), String> {
    state.orchestra.set_roles(&main, roles)
}

/// The control requests Settings may send to a chat's claude: MCP servers' status and actions, and reloading plugins
/// (which is how claude picks up skills, commands and agents too). Anything else is refused.
const SETTINGS_REQUESTS: &[&str] = &["mcp_status", "mcp_reconnect", "mcp_toggle", "mcp_authenticate", "mcp_oauth_callback_url", "mcp_clear_auth", "reload_plugins"];

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

/// Makes a skill or command in yours or the chat folder's project (see skills::create). Returns its file.
#[tauri::command]
async fn skill_create(state: State<'_, AppState>, slot: Option<String>, kind: String, scope: String, name: String, description: String) -> Result<String, String> {
    let folder = slot.and_then(|id| state.slots.get(&id).ok()).and_then(|s| s.folder().ok());
    let config = skills::config_dir().ok_or("HOME is not set")?;
    tauri::async_runtime::spawn_blocking(move || skills::create(&config, folder.as_deref(), &kind, &scope, &name, &description).map(|p| p.display().to_string())).await.map_err(|e| e.to_string())?
}

/// Moves a skill's folder or a command's file to the Trash (see skills::delete). Returns where it went.
#[tauri::command]
async fn skill_delete(state: State<'_, AppState>, slot: Option<String>, path: String) -> Result<String, String> {
    let folder = slot.and_then(|id| state.slots.get(&id).ok()).and_then(|s| s.folder().ok());
    let config = skills::config_dir().ok_or("HOME is not set")?;
    tauri::async_runtime::spawn_blocking(move || skills::delete(&config, folder.as_deref(), std::path::Path::new(&path)).map(|p| p.display().to_string())).await.map_err(|e| e.to_string())?
}

/// Saves a skill or command file's text, if it's still what Settings read (see skills::save).
#[tauri::command]
async fn skill_save(state: State<'_, AppState>, slot: Option<String>, path: String, text: String, expected: String) -> Result<files::Written, String> {
    let folder = slot.and_then(|id| state.slots.get(&id).ok()).and_then(|s| s.folder().ok());
    let config = skills::config_dir().ok_or("HOME is not set")?;
    tauri::async_runtime::spawn_blocking(move || skills::save(&config, folder.as_deref(), std::path::Path::new(&path), &text, &expected)).await.map_err(|e| e.to_string())?
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
        // Claude Code's own command: another provider has no `mcp`, so adding one means saying what happens here.
        let binary = match cfg.provider {
            ProviderId::Claude => cfg.binary.clone(),
            #[cfg(test)]
            ProviderId::Fake => return Err("The fake CLI has no mcp command.".into()),
        };
        (binary, cfg.folder.clone())
    };
    let mut cmd = tokio::process::Command::new(claude);
    // A timeout drops the wait below; kill_on_drop stops the process rather than leaving it running.
    cmd.args(&args).current_dir(folder).stdin(std::process::Stdio::null()).kill_on_drop(true);
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

/// The arguments for `claude mcp add`, after checking the spec. `--` before the name and URL keeps a value that starts
/// with `-` from being read as an option.
fn mcp_add_args(spec: &McpServerSpec) -> Result<Vec<String>, String> {
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
    Ok(args)
}

#[cfg(test)]
mod mcp_add_tests {
    use super::*;

    fn spec(name: &str, transport: &str, target: &str, scope: &str) -> McpServerSpec {
        McpServerSpec { name: name.into(), transport: transport.into(), target: target.into(), scope: scope.into(), env: vec![], headers: vec![] }
    }

    #[test]
    fn stdio_puts_env_first_then_the_name_and_the_command_words() {
        let mut s = spec(" fs ", "stdio", "npx -y server /tmp/a", "local");
        s.env = vec!["A=1".into(), "  ".into(), " B=2 ".into()];
        s.headers = vec!["X: ignored".into()];
        assert_eq!(
            mcp_add_args(&s).unwrap(),
            ["mcp", "add", "-s", "local", "-t", "stdio", "-e", "A=1", "-e", "B=2", "--", "fs", "npx", "-y", "server", "/tmp/a"]
        );
    }

    #[test]
    fn http_takes_the_trimmed_url_and_non_empty_headers() {
        let mut s = spec("api", "http", " https://x.dev/mcp ", "user");
        s.headers = vec!["Authorization: Bearer t".into(), " ".into()];
        s.env = vec!["A=1".into()];
        assert_eq!(mcp_add_args(&s).unwrap(), ["mcp", "add", "-s", "user", "-t", "http", "-H", "Authorization: Bearer t", "--", "api", "https://x.dev/mcp"]);
    }

    #[test]
    fn a_name_or_url_that_looks_like_an_option_stays_a_value() {
        assert!(mcp_add_args(&spec("-rf", "stdio", "server", "local")).is_err());
        let args = mcp_add_args(&spec("api", "sse", "https://x.dev/sse", "project")).unwrap();
        assert_eq!(&args[args.len() - 3..], ["--", "api", "https://x.dev/sse"]);
    }

    #[test]
    fn refuses_a_missing_name_scope_or_type() {
        assert!(mcp_add_args(&spec("  ", "stdio", "server", "local")).is_err());
        assert!(mcp_add_args(&spec("api", "stdio", "server", "global")).is_err());
        assert!(mcp_add_args(&spec("api", "ws", "wss://x", "local")).is_err());
    }

    #[test]
    fn refuses_an_empty_command_or_a_non_web_address() {
        assert_eq!(mcp_add_args(&spec("fs", "stdio", "   ", "local")).unwrap_err(), "Which command starts the server?");
        assert!(mcp_add_args(&spec("api", "http", "ftp://x.dev", "local")).is_err());
    }
}

#[tauri::command]
async fn mcp_add(state: State<'_, AppState>, slot: String, spec: McpServerSpec) -> Result<String, String> {
    let args = mcp_add_args(&spec)?;
    // The project's .mcp.json is committed: a literal secret stays out of it (only ${NAME} references go in).
    if spec.scope == "project" {
        mcp_config::check_committed(&mcp_config::to_config(&spec, &serde_json::Value::Null)?, "project", None)?;
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

/// Claude Code's own settings file: ~/.claude.json, or inside CLAUDE_CONFIG_DIR when that's set.
fn claude_json_file() -> Result<std::path::PathBuf, String> {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) => Ok(std::path::PathBuf::from(dir).join(".claude.json")),
        None => Ok(std::path::PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?).join(".claude.json")),
    }
}

/// A server's stored settings for the edit form, with its secret values masked (see mcp_config).
#[tauri::command]
async fn mcp_form(state: State<'_, AppState>, slot: String, name: String, scope: String) -> Result<mcp_config::Form, String> {
    let folder = state.slots.get(&slot)?.folder()?;
    let stored = mcp_config::read_entry(&claude_json_file()?, &folder, &name, &scope)?.ok_or_else(|| format!("{name} isn't there any more. Reload the list."))?;
    mcp_config::to_form(&name, &scope, &stored)
}

fn add_json_args(scope: &str, name: &str, json: &str) -> Vec<String> {
    ["mcp", "add-json", "-s", scope, "--", name, json].map(String::from).to_vec()
}

fn remove_args(scope: &str, name: &str) -> Vec<String> {
    ["mcp", "remove", "-s", scope, "--", name].map(String::from).to_vec()
}

/// Runs one step of an edit with `claude mcp`.
async fn run_step(state: &AppState, slot: &str, step: mcp_config::Step) -> Result<String, String> {
    let args = match step {
        mcp_config::Step::Add { scope, name, json } => add_json_args(&scope, &name, &json),
        mcp_config::Step::Remove { scope, name } => remove_args(&scope, &name),
    };
    claude_mcp(state, slot, args).await
}

/// Saves an edited server: `from_name` and `from_scope` are where it is now, `spec` where it should be. The new entry is
/// added before the old one is removed, so a failure never loses the server. The exception is a server that keeps its
/// name in its scope: that name can't be added twice, so the old entry is removed and put back if the new one fails.
#[tauri::command]
async fn mcp_edit(state: State<'_, AppState>, slot: String, from_name: String, from_scope: String, spec: McpServerSpec) -> Result<String, String> {
    // The same checks as adding, on the new name, scope, type and address.
    mcp_add_args(&spec)?;
    let folder = state.slots.get(&slot)?.folder()?;
    let stored = mcp_config::read_entry(&claude_json_file()?, &folder, &from_name, &from_scope)?.ok_or_else(|| format!("{from_name} isn't there any more. Reload the list."))?;
    let config = mcp_config::to_config(&spec, &stored)?;
    let name = spec.name.trim().to_string();
    // Only an entry already in the project's file may keep its secret values as they are there.
    let kept = (from_scope == "project" && spec.scope == "project").then_some(&stored);
    mcp_config::check_committed(&config, &spec.scope, kept)?;
    let plan = mcp_config::edit_plan((&from_name, &from_scope), (&name, &spec.scope), config.to_string(), stored.to_string());
    let mcp_config::Plan { steps: [first, second], undo } = plan;
    // Nothing has changed yet when the first step fails.
    run_step(&state, &slot, first).await?;
    if let Err(e) = run_step(&state, &slot, second).await {
        return Err(match run_step(&state, &slot, undo).await {
            Ok(_) => format!("{e} Nothing changed."),
            Err(again) => format!("{e} Taking the change back failed too ({again}): check the list of servers."),
        });
    }
    Ok(format!("Saved {name}."))
}

/// Runs a command the user typed after "!" in the chat's folder; its output arrives as ui-events.
#[tauri::command]
async fn run_shell(app: AppHandle, state: State<'_, AppState>, slot: String, id: String, command: String) -> Result<(), String> {
    let s = state.slots.get(&slot)?;
    let folder = s.folder()?;
    let path_env = login_path(&state).await;
    s.shells.run(&id, &command, &folder, path_env.as_deref(), slots::tagged(&slot, emitter(&app)))
}

/// Types into a running command: the user's reply to what it asked. Async and off the main thread: a write can wait for
/// the command to read what's already in its terminal.
#[tauri::command]
async fn shell_input(state: State<'_, AppState>, slot: String, id: String, text: String) -> Result<(), String> {
    let shells = state.slots.get(&slot)?.shells.clone();
    tauri::async_runtime::spawn_blocking(move || shells.input(&id, &text)).await.map_err(|e| e.to_string())?
}

/// Starts the project's Run command (from its saved setting, never from the window's say-so) in the chat's folder, as a
/// command like any other of the chat's (see shell.rs): stopped with `stop_shell`, and when the chat closes. `id` is "run-…".
#[tauri::command]
async fn run_project(app: AppHandle, state: State<'_, AppState>, slot: String, id: String) -> Result<(), String> {
    if !id.starts_with("run-") {
        return Err(format!("{id:?} is not a run id."));
    }
    let s = state.slots.get(&slot)?;
    let folder = s.folder()?;
    // An agent in a worktree runs what its project's Run command says: the project is its main agent's folder.
    let project = match state.orchestra.parent_of(&slot) {
        Some(main) => state.slots.get(&main)?.folder()?,
        None => folder.clone(),
    };
    let command = state.setups.get(&project).run.ok_or("This project has no Run command: set one in its Project setup.")?;
    let path_env = login_path(&state).await;
    s.shells.run(&id, &command, &folder, path_env.as_deref(), slots::tagged(&slot, emitter(&app)))
}

#[tauri::command]
fn stop_shell(state: State<'_, AppState>, slot: String, id: String) -> Result<(), String> {
    state.slots.get(&slot)?.shells.stop(&id);
    Ok(())
}

/// The checked-out branch's commits since it left its base, for reviewing a local branch. `base`: the branch the review
/// says it is stacked on (see pr::branch for what is used when it doesn't say, or names one that isn't there).
#[tauri::command]
async fn branch_review(state: State<'_, AppState>, slot: String, hints: Option<Vec<String>>, base: Option<String>) -> Result<pr::BranchReview, String> {
    let folder = state.slots.get(&slot)?.folder()?;
    let hints = hints.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || pr::branch(&folder, &hints, base.as_deref()).map(|(_, review)| review)).await.map_err(|e| e.to_string())?
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

/// `pr`: with the "pr" scope, the pull request's number. `base`: with the "branch" scope, the branch it is compared with.
#[tauri::command]
// A command's arguments are what the window names in its call, so they stay separate rather than bundled.
#[allow(clippy::too_many_arguments)]
async fn get_file_diff(state: State<'_, AppState>, slot: String, path: String, scope: Option<changes::Scope>, turn: Option<usize>, to_turn: Option<usize>, pr: Option<u32>, base: Option<String>) -> Result<FileDiff, String> {
    let s = state.slots.get(&slot)?;
    if scope == Some(changes::Scope::Pr) {
        // The file's path picks its repository, as it did for change_summary's list.
        let range = pr_range(&state, s.folder()?, pr, vec![path.clone()]).await?;
        return tauri::async_runtime::spawn_blocking(move || pr::file(&range, &path)).await.map_err(|e| e.to_string())?;
    }
    if scope == Some(changes::Scope::Branch) {
        // The file's own repository: in a workspace of several, that's the one under review.
        let dir = std::path::Path::new(&path).parent().map(|p| p.to_path_buf()).unwrap_or(s.folder()?);
        return tauri::async_runtime::spawn_blocking(move || pr::branch(&dir, &[], base.as_deref()).and_then(|(range, _)| pr::file(&range, &path))).await.map_err(|e| e.to_string())?;
    }
    if scope == Some(changes::Scope::Git) {
        let folder = s.folder()?;
        let read = path.clone();
        let (original, current) = tauri::async_runtime::spawn_blocking(move || outside::diff_sides(&folder, std::path::Path::new(&read))).await.map_err(|e| e.to_string())??;
        return Ok(FileDiff { path, created: original.is_none(), deleted: current.is_none(), original: original.unwrap_or_default(), current: current.unwrap_or_default() });
    }
    let diff = s.changes.lock().unwrap().diff(&path, scope.unwrap_or_default(), turn, to_turn);
    diff
}

/// A chat's changed files as they stand on disk, so the Changes list catches what happened outside Claude's edits.
#[tauri::command]
/// `hints`: with the "pr" and "branch" scopes, the reviewed files' paths, which pick the repository when the folder
/// holds several. `base`: with the "branch" scope, the branch it is compared with.
#[allow(clippy::too_many_arguments)]
async fn change_summary(
    state: State<'_, AppState>,
    slot: String,
    scope: Option<changes::Scope>,
    turn: Option<usize>,
    to_turn: Option<usize>,
    pr: Option<u32>,
    hints: Option<Vec<String>>,
    base: Option<String>,
) -> Result<Vec<changes::ChangeSummary>, String> {
    let s = state.slots.get(&slot)?;
    if scope == Some(changes::Scope::Pr) {
        let range = pr_range(&state, s.folder()?, pr, hints.unwrap_or_default()).await?;
        return tauri::async_runtime::spawn_blocking(move || pr::summary(&range)).await.map_err(|e| e.to_string())?;
    }
    if scope == Some(changes::Scope::Branch) {
        let folder = s.folder()?;
        let hints = hints.unwrap_or_default();
        return tauri::async_runtime::spawn_blocking(move || pr::branch(&folder, &hints, base.as_deref()).and_then(|(range, _)| pr::summary(&range))).await.map_err(|e| e.to_string())?;
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
fn respond_permission(state: State<'_, AppState>, slot: String, request_id: String, allow: bool, message: Option<String>, updated_input: Option<serde_json::Value>) -> Result<(), String> {
    if state.slots.get(&slot)?.bridge.respond(&request_id, allow, message, updated_input) {
        Ok(())
    } else {
        Err("That permission request is no longer pending.".into())
    }
}

/// The "Always allow" rules Settings lists: this chat's (when it's open), then every folder's.
#[tauri::command]
fn list_permission_rules(state: State<'_, AppState>, slot: Option<String>) -> Vec<permission::rules::RuleEntry> {
    use permission::rules::{RuleEntry, Scope};
    let chat = slot.and_then(|id| state.slots.get(&id).ok()).map(|s| s.bridge.chat_rules()).unwrap_or_default();
    let chat = chat.into_iter().map(|rule| RuleEntry { scope: Scope::Chat, folder: None, rule });
    let folders = state.folder_rules.all().into_iter().flat_map(|(folder, rules)| rules.into_iter().map(move |rule| RuleEntry { scope: Scope::Folder, folder: Some(folder.clone()), rule }));
    chat.chain(folders).collect()
}

/// The team's Subagents setting: where the Lead's built-in helpers run from now on, on the canvas or inline. Only a
/// Lead's calls are ever answered by it (ordinary chats run their subagents inline).
#[tauri::command]
fn set_subagents(state: State<'_, AppState>, slot: String, subagents: permission::bridge::Subagents) -> Result<(), String> {
    state.slots.get(&slot)?.bridge.set_subagents(subagents);
    Ok(())
}

/// The open pull requests of the folder's repository, for the start screen's "Review a PR" picker. An error is a message
/// for the user: gh missing, not logged in, or not a GitHub repository.
#[tauri::command]
async fn list_open_prs(state: State<'_, AppState>, folder: String) -> Result<Vec<pr::OpenPr>, String> {
    let path_env = login_path(&state).await;
    let folder = std::path::PathBuf::from(folder);
    tauri::async_runtime::spawn_blocking(move || pr::open_prs(&folder, path_env.as_deref())).await.map_err(|e| e.to_string())?
}

/// The pull request on the folder's branch and how its checks stand (read-only: see `checks::watch`). An error is a call
/// that failed for a reason that may pass; the window keeps what it knew.
#[tauri::command]
async fn pr_watch(state: State<'_, AppState>, folder: String) -> Result<checks::PrWatch, String> {
    let path_env = login_path(&state).await;
    let folder = std::path::PathBuf::from(folder);
    tauri::async_runtime::spawn_blocking(move || checks::watch(&folder, path_env.as_deref())).await.map_err(|e| e.to_string())?
}

/// The end of the log of a failed check's run (read-only). `run_id` must be digits.
#[tauri::command]
async fn pr_failure_log(state: State<'_, AppState>, folder: String, run_id: String) -> Result<String, String> {
    let path_env = login_path(&state).await;
    let folder = std::path::PathBuf::from(folder);
    tauri::async_runtime::spawn_blocking(move || checks::failure_log(&folder, &run_id, path_env.as_deref())).await.map_err(|e| e.to_string())?
}

/// Whether the GitHub CLI is installed and logged in, for the "Pull request checks" dialog.
#[tauri::command]
async fn gh_access(state: State<'_, AppState>) -> Result<checks::GhAccess, String> {
    let path_env = login_path(&state).await;
    tauri::async_runtime::spawn_blocking(move || checks::gh_access(path_env.as_deref())).await.map_err(|e| e.to_string())
}

/// Step by step's flavours as the prompt Claude runs with has them: each one's section and its headings. The window
/// repeats them in its notes (switching flavour, a page it couldn't read), so they're never a copy that has drifted.
#[tauri::command]
fn steps_guide() -> Vec<args::FlavourGuide> {
    args::FLAVOURS.iter().chain([&args::EXPLAIN]).filter_map(|f| args::flavour_guide(f)).collect()
}

/// Makes an "Always allow" rule from a card (the request itself is answered by respond_permission).
#[tauri::command]
fn add_permission_rule(state: State<'_, AppState>, slot: String, rule: permission::rules::NewRule) -> Result<(), String> {
    state.slots.get(&slot)?.bridge.add_rule(rule.scope, rule.rule)
}

/// Removes a rule Settings lists. A chat rule goes with its chat, so that chat has to be open.
#[tauri::command]
fn remove_permission_rule(state: State<'_, AppState>, slot: Option<String>, entry: permission::rules::RuleEntry) -> Result<(), String> {
    use permission::rules::Scope;
    match entry.scope {
        Scope::Chat => slot.and_then(|id| state.slots.get(&id).ok()).ok_or("That chat is no longer open.")?.bridge.remove_chat_rule(&entry.rule),
        Scope::Folder => state.folder_rules.remove(&entry.folder.ok_or("A folder rule needs its folder.")?, &entry.rule),
    }
    Ok(())
}

/// What the Ship it dialog shows about the folder's repository (read-only: see `git::ship_info`).
#[tauri::command]
async fn ship_info(state: State<'_, AppState>, folder: String) -> Result<git::ShipInfo, String> {
    let path_env = login_path(&state).await;
    let folder = std::path::PathBuf::from(folder);
    tauri::async_runtime::spawn_blocking(move || git::ship_info(&folder, path_env.as_deref())).await.map_err(|e| e.to_string())
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

/// Saves a file the user edited, and tells the chat's change tracker about it as Claude's own edits are: under the path
/// as the UI has it (not the resolved one, which can differ for a symlinked folder), with the text from before, so it
/// shows in Changes with a diff. A file already tracked keeps its first original.
fn save_tracked(root: &std::path::Path, tracker: &std::sync::Mutex<changes::ChangeTracker>, path: &str, text: &str, expected: Option<&str>) -> Result<files::Written, String> {
    let written = files::write_file(root, std::path::Path::new(path), text, expected)?;
    if let files::Written::Saved { previous, changed: true } = &written {
        tracker.lock().unwrap().record(path, previous.clone());
    }
    Ok(written)
}

/// Saves the user's edit of a file in the chat's folder, unless it changed on disk since the editor opened it.
#[tauri::command]
async fn write_file(state: State<'_, AppState>, slot: String, path: String, text: String, expected: Option<String>) -> Result<files::Written, String> {
    let s = state.slots.get(&slot)?;
    let root = s.folder()?;
    let changes = s.changes.clone();
    tauri::async_runtime::spawn_blocking(move || save_tracked(&root, &changes, &path, &text, expected.as_deref())).await.map_err(|e| e.to_string())?
}

/// Puts the chosen files back to how they stood before a turn, a range of turns, or the chat (see revert.rs). Each comes
/// with the text the user was shown, so a newer edit is reported as a conflict rather than overwritten.
#[tauri::command]
async fn revert_files(state: State<'_, AppState>, slot: String, scope: changes::Scope, turn: Option<usize>, to_turn: Option<usize>, files: Vec<revert::Shown>) -> Result<Vec<revert::Outcome>, String> {
    let s = state.slots.get(&slot)?;
    let root = s.folder()?;
    let changes = s.changes.clone();
    tauri::async_runtime::spawn_blocking(move || revert::revert_files(&root, &changes, scope, turn, to_turn, &files, &trash::move_to_trash))
        .await
        .map_err(|e| e.to_string())?
}

/// Undoes a revert: each file goes back to the text it had before, or is taken away if the revert brought it back.
#[tauri::command]
async fn undo_revert(state: State<'_, AppState>, slot: String, files: Vec<revert::Undo>) -> Result<Vec<revert::Outcome>, String> {
    let root = state.slots.get(&slot)?.folder()?;
    tauri::async_runtime::spawn_blocking(move || revert::undo(&root, &files, &trash::move_to_trash)).await.map_err(|e| e.to_string())
}

/// The messages of the chat that have a restore point: a folder that isn't a repository has none.
#[tauri::command]
async fn restore_points(state: State<'_, AppState>, slot: String) -> Result<Vec<usize>, String> {
    let s = state.slots.get(&slot)?;
    tauri::async_runtime::spawn_blocking(move || s.checkpoints.turns()).await.map_err(|e| e.to_string())
}

/// What putting the chat's folder back to before message `turn` would change: for the dialog that asks first.
#[tauri::command]
async fn restore_preview(app: AppHandle, state: State<'_, AppState>, slot: String, turn: usize) -> Result<checkpoint::Plan, String> {
    let s = state.slots.get(&slot)?;
    let id = slot.clone();
    at_checkpoints(&app, &slot, &s, move |s, place, path_env| s.checkpoints.plan(place, &id, turn, path_env)).await
}

/// Puts the chat's folder back to before message `turn` (see checkpoint.rs). Refused while a turn runs.
#[tauri::command]
async fn restore_files(app: AppHandle, state: State<'_, AppState>, slot: String, turn: usize) -> Result<checkpoint::Restored, String> {
    let s = state.slots.get(&slot)?;
    let id = slot.clone();
    at_checkpoints(&app, &slot, &s, move |s, place, path_env| s.checkpoints.restore(place, &id, turn, &trash::move_to_trash, path_env)).await
}

/// Takes the last restore back (`id` is what it returned). Files edited since are left as they are.
#[tauri::command]
async fn undo_restore(app: AppHandle, state: State<'_, AppState>, slot: String, id: u64) -> Result<checkpoint::Restored, String> {
    let s = state.slots.get(&slot)?;
    let chat = slot.clone();
    at_checkpoints(&app, &slot, &s, move |s, place, path_env| s.checkpoints.undo(place, &chat, id, &trash::move_to_trash, path_env)).await
}

/// Saves an exported document (a plan as markdown). The save dialog is opened here rather than by the webview, and only
/// the path it returns is written, so a file can't be written anywhere the user didn't pick. None: the dialog was cancelled.
#[tauri::command]
async fn export_text(app: AppHandle, file_name: String, text: String) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().add_filter("Markdown", &["md"]).set_file_name(file_name).blocking_save_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || files::write_export(&path, &text).map(|()| Some(path.display().to_string()))).await.map_err(|e| e.to_string())?
}

/// Where Claude Code keeps transcripts (it honours CLAUDE_CONFIG_DIR, so we do too).
fn projects_root() -> Result<std::path::PathBuf, String> {
    let base = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) => std::path::PathBuf::from(dir),
        None => std::path::PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?).join(".claude"),
    };
    Ok(base.join("projects"))
}

/// The paths a folder was at before it moved (see relocate), as the store has them. The folder is looked up by its real
/// path, as it's recorded, then as it was given.
fn aliases_for(state: &AppState, folder: &str) -> Vec<std::path::PathBuf> {
    let real = std::fs::canonicalize(folder).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| folder.to_string());
    let found = state.relocations.aliases_of(&real);
    let found = if found.is_empty() { state.relocations.aliases_of(folder) } else { found };
    found.into_iter().map(std::path::PathBuf::from).collect()
}

#[tauri::command]
async fn list_sessions(state: State<'_, AppState>, folder: String) -> Result<Vec<history::SessionSummary>, String> {
    let root = projects_root()?;
    let titles = state.titles.all();
    let renamed = state.renames.all();
    let aliases = aliases_for(&state, &folder);
    tauri::async_runtime::spawn_blocking(move || history::list_sessions_with_aliases(&root, std::path::Path::new(&folder), &aliases, &titles, &renamed)).await.map_err(|e| e.to_string())
}

/// Past chats of every project whose text has `query` (what was said, not tool output), newest first. A newer search cancels
/// this one. The query is plain text: it is compared, never run or used as a path.
#[tauri::command]
async fn search_history(state: State<'_, AppState>, query: String) -> Result<history_search::Results, String> {
    use std::sync::atomic::Ordering;
    let root = projects_root()?;
    let titles = state.titles.all();
    let renamed = state.renames.all();
    let moved: std::collections::HashMap<String, String> = state.relocations.list().into_iter().flat_map(|e| e.aliases.into_iter().map(move |old| (old, e.folder.clone()))).collect();
    let search = state.chat_search.clone();
    let this = search.generation.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        let scope = history_search::Scope { titles: &titles, renamed: &renamed, moved: &moved };
        history_search::search(&root, &query, &scope, &history_search::Options::default(), &search.index, &|| search.generation.load(Ordering::Relaxed) != this)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Names a past session in Lantern (the History menu's Rename). The name is kept apart from Claude Code's transcripts,
/// and beats every title the session has.
#[tauri::command]
fn rename_session(state: State<'_, AppState>, session_id: String, title: String) -> Result<(), String> {
    if !history::valid_id(&session_id) {
        return Err("Not a session id.".into());
    }
    let name = titles::name(&title).ok_or("A session needs a name.")?;
    state.renames.set(&session_id, &name);
    Ok(())
}

/// A past session's events, read from its transcript without starting claude (for Export as Markdown).
#[tauri::command]
async fn session_events(state: State<'_, AppState>, folder: String, session_id: String) -> Result<Vec<ui_event::UiEvent>, String> {
    if !history::valid_id(&session_id) {
        return Err("Not a session id.".into());
    }
    let root = projects_root()?;
    let aliases = aliases_for(&state, &folder);
    tauri::async_runtime::spawn_blocking(move || history::transcript_path_with_aliases(&root, std::path::Path::new(&folder), &aliases, &session_id).map(|p| history::replay(&p).events))
        .await
        .map_err(|e| e.to_string())?
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
    let aliases = aliases_for(&state, &folder);
    let own = tauri::async_runtime::spawn_blocking(move || history::transcript_path_with_aliases(&root, std::path::Path::new(&folder), &aliases, &id).ok().and_then(|p| history::transcript_title(&p)))
        .await
        .map_err(|e| e.to_string())?;
    if let Some(title) = state.renames.get(&session_id).or(own).or_else(|| state.titles.get(&session_id)) {
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

/// What opening a past session brings back: its events; the folder it was started in, when that was a place this folder
/// moved from (the chat tells Claude once); and why it isn't resumed, when it could only be read (its copy failed). `provider`
/// is the CLI the chat runs on, and what that can do.
#[derive(serde::Serialize)]
pub struct OpenedSession {
    events: Vec<ui_event::UiEvent>,
    moved_from: Option<String>,
    read_only: Option<String>,
    provider: ProviderInfo,
}

/// Replays a past session into a chat, refills its change tracker from the session's edits, and continues it with `--resume`.
/// A session that's only in a place the folder moved from is copied into the folder first (see relocate::ready_session).
#[tauri::command]
async fn open_session(
    app: AppHandle,
    state: State<'_, AppState>,
    slot: String,
    claude_path: String,
    folder: String,
    mut settings: Settings,
    session_id: String,
) -> Result<OpenedSession, String> {
    let s = slot_for(&app, &state, &slot)?;
    // A worker of a main agent that isn't open (it was closed, or restored on its own) reopens as an ordinary chat.
    if settings.worker.as_ref().is_some_and(|w| !state.orchestra.is_main(&w.parent)) {
        settings.worker = None;
    }
    // Whatever it was saved with, a worker comes back no freer than its main agent is now (a main agent reopened on Ask must
    // not get workers on Auto).
    let parent_slot = settings.worker.as_ref().map(|w| w.parent.clone());
    let mut lowered = false;
    if let Some(parent) = &parent_slot {
        let ceiling = main_ceiling(&state, parent);
        let (mode, auto) = args::capped_mode(settings.mode, settings.auto_approve, ceiling, &capabilities_of(settings.provider));
        lowered = (mode, auto) != (settings.mode, settings.auto_approve);
        settings.mode = mode;
        settings.auto_approve = auto;
    }
    let worker = settings.worker.clone();
    let cfg = new_config(&state, &s, claude_path, folder, settings, Some(session_id.clone())).await?;
    enroll(&state, &slot, &s, &cfg.helper.role);
    let provider = cfg.provider.info();
    let root = projects_root()?;
    let folder = cfg.folder.clone();
    let aliases = aliases_for(&state, &folder.to_string_lossy());
    let (ready, moved_from) = tauri::async_runtime::spawn_blocking(move || {
        let ready = relocate::ready_session(&root, &folder, &aliases, &session_id)?;
        let moved_from = match ready {
            relocate::Ready::Resumable(_) => relocate::moved_from(&root, &folder, &aliases, &session_id),
            relocate::Ready::ReadOnly { .. } => None,
        };
        Ok::<_, String>((ready, moved_from))
    })
    .await
    .map_err(|e| e.to_string())??;
    match ready {
        relocate::Ready::ReadOnly { source, reason } => {
            let events = tauri::async_runtime::spawn_blocking(move || history::replay(&source).events).await.map_err(|e| e.to_string())?;
            Ok(OpenedSession { events, moved_from: None, read_only: Some(reason), provider })
        }
        relocate::Ready::Resumable(path) => {
            let replayed = tauri::async_runtime::spawn_blocking(move || history::replay(&path)).await.map_err(|e| e.to_string())?;
            // Registered before it starts, so its first events are seen, and unregistered if it never does.
            if let Some(w) = worker {
                state.orchestra.adopt(&slot, &w.parent, &w.name, &cfg.folder, w.branch.as_deref(), w.role.clone()).await?;
            }
            if let Err(e) = launch(&app, &slot, &s, cfg, true).await {
                state.orchestra.forget(&slot);
                return Err(e);
            }
            // The window put the chat up with the mode it was saved in: told the one it runs in, when that is lower.
            if lowered {
                told_ask(&app, &slot);
            }
            // Its main agent may have been lowered while this one was opening.
            if let Some(parent) = &parent_slot {
                lower_worker(&app, &state, &slot, main_ceiling(&state, parent)).await;
            }
            menu::refresh_recent(&app).await;
            s.changes.lock().unwrap().restore(replayed.edits, replayed.edits_before_last_turn);
            // Its messages are numbered afresh from here, so an earlier numbering's restore points can't be asked for.
            s.checkpoints.forget();
            Ok(OpenedSession { events: replayed.events, moved_from, read_only: None, provider })
        }
    }
}

/// Which of these folders are gone (an agent's worktree is removed once its branch is merged), for leaving out the chats
/// that were open in them when Lantern last closed.
#[tauri::command]
fn folders_gone(folders: Vec<String>) -> Vec<String> {
    folders.into_iter().filter(|f| !std::path::Path::new(f).is_dir()).collect()
}

/// Where each folder was before it moved, as Lantern recorded it.
#[tauri::command]
fn relocations_list(state: State<'_, AppState>) -> Vec<relocate::Entry> {
    state.relocations.list()
}

/// The folders the user has used that are gone, each with the place it probably moved to (see relocate::moved_candidates).
#[tauri::command]
async fn moved_folder_candidates(state: State<'_, AppState>) -> Result<Vec<relocate::Moved>, String> {
    let root = projects_root()?;
    let aliases: Vec<String> = state.relocations.list().into_iter().flat_map(|e| e.aliases).collect();
    tauri::async_runtime::spawn_blocking(move || relocate::moved_candidates(&history::recent_user_folders(&root), &aliases, &history::session_folders(&root))).await.map_err(|e| e.to_string())
}

/// The places `folder` was before, whose sessions Lantern can bring over (see relocate::old_locations). Read only.
#[tauri::command]
async fn old_locations(state: State<'_, AppState>, folder: String) -> Result<Vec<relocate::OldLocation>, String> {
    let root = projects_root()?;
    let aliases: Vec<String> = aliases_for(&state, &folder).iter().map(|p| p.to_string_lossy().into_owned()).collect();
    tauri::async_runtime::spawn_blocking(move || relocate::old_locations(&history::session_folders(&root), &folder, &aliases)).await.map_err(|e| e.to_string())
}

/// Every folder with sessions, gone ones included, for choosing where a folder was when nothing was found under its name.
#[tauri::command]
async fn known_folders() -> Result<Vec<history::FolderSessions>, String> {
    let root = projects_root()?;
    tauri::async_runtime::spawn_blocking(move || history::session_folders(&root)).await.map_err(|e| e.to_string())
}

/// What moving `old` to `new` would bring over. Nothing is changed.
#[tauri::command]
async fn relocation_preview(state: State<'_, AppState>, old: String, new: String) -> Result<relocate::Preview, String> {
    let (old, _) = relocate::validate_pair(&old, &new)?;
    let root = projects_root()?;
    let claude = claude_json_file()?;
    let rules = state.folder_rules.clone();
    tauri::async_runtime::spawn_blocking(move || relocate::preview(&root, &claude, &rules, &old)).await.map_err(|e| e.to_string())
}

/// Records that the folder at `old` is now at `new`, carrying over what `options` chooses (see relocate::relocate).
#[tauri::command]
async fn relocate_folder(state: State<'_, AppState>, old: String, new: String, options: relocate::Options) -> Result<relocate::Outcome, String> {
    let (old, new) = relocate::validate_pair(&old, &new)?;
    let root = projects_root()?;
    let claude = claude_json_file()?;
    let (rules, relocations) = (state.folder_rules.clone(), state.relocations.clone());
    tauri::async_runtime::spawn_blocking(move || relocate::relocate(&root, &claude, &rules, &relocations, &old, &new, options)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn update_status(updates: State<'_, updates::Updates>) -> Option<updates::UpdateInfo> {
    updates.ready()
}

/// Where updating has got to, for a window that opens after it started (the rest arrive as `update-state` events).
#[tauri::command]
fn update_state(updates: State<'_, updates::Updates>) -> updates::UpdateState {
    updates.state()
}

/// Looks for a newer Lantern now and downloads it, telling the window as it goes. If a check is already running (the
/// background one), this returns where that one has got to. Development builds don't check.
#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<updates::UpdateState, String> {
    if !updates::checks_enabled() {
        return Err("This is a development build: updates are only checked in the released app.".into());
    }
    updates::check(&app, true).await
}

/// The version of Lantern that's running.
#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Help ▸ Report a Bug…: copies the diagnostics block (versions, model, last error) to the clipboard and returns it.
/// The window then opens the new-issue page.
#[tauri::command]
async fn copy_diagnostics(app: AppHandle, state: State<'_, AppState>, claude_path: Option<String>, model: Option<String>, last_error: Option<String>) -> Result<String, String> {
    let path_env = login_path(&state).await;
    let (macos, claude) = tauri::async_runtime::spawn_blocking(move || {
        (diagnostics::macos_version(), claude_path.and_then(|path| ProviderId::Claude.provider().version(&path, path_env.as_deref())))
    })
    .await
    .map_err(|e| e.to_string())?;
    let home = std::env::var("HOME").ok();
    let block = diagnostics::report(&app.package_info().version.to_string(), macos.as_deref(), claude.as_deref(), model.as_deref(), last_error.as_deref(), home.as_deref());
    let to_copy = block.clone();
    tauri::async_runtime::spawn_blocking(move || diagnostics::copy(&to_copy)).await.map_err(|e| e.to_string())??;
    Ok(block)
}

/// Installs the downloaded update, stops every chat's claude, and relaunches into the new version, telling the window
/// each step so it can show them. A failed install leaves the chats running.
#[tauri::command]
async fn restart_to_update(app: AppHandle, state: State<'_, AppState>, updates: State<'_, updates::Updates>) -> Result<(), String> {
    let version = updates.ready().map(|u| u.version).ok_or("No update has been downloaded.")?;
    updates::publish(&app, updates::UpdateState::Installing { version });
    // Unpacking and replacing the app takes a moment: off this thread, so the window gets to show it.
    let installer = app.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || installer.state::<updates::Updates>().install()).await.map_err(|e| e.to_string())?;
    if let Err(e) = installed {
        // The download was used up by the attempt: another check fetches it again.
        let error = format!("{e} Check for updates to try again.");
        updates::publish(&app, updates::UpdateState::Failed { error: error.clone() });
        return Err(error);
    }
    updates::publish(&app, updates::UpdateState::Restarting);
    for s in state.slots.drain() {
        s.shut_down().await;
    }
    app.restart()
}

/// What the window keeps across launches: where it was, how big, and whether it was full screen. Not whether it was
/// visible (the plugin would then show it only when it was, and a window saved hidden would never appear again) and
/// not its decorations (the title bar is an overlay Lantern sets itself).
fn window_state_flags() -> tauri_plugin_window_state::StateFlags {
    use tauri_plugin_window_state::StateFlags;
    StateFlags::POSITION | StateFlags::SIZE | StateFlags::FULLSCREEN
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().with_state_flags(window_state_flags()).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(navigation::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let titles = titles::TitleStore::load(app.path().app_data_dir().ok().map(|d| d.join("titles.json")));
            let renames = titles::TitleStore::load(app.path().app_data_dir().ok().map(|d| d.join("renames.json")));
            let folder_rules = permission::rules::FolderRules::load(app.path().app_data_dir().ok().map(|d| d.join("permission_rules.json")));
            let relocations = relocate::Relocations::load(app.path().app_data_dir().ok().map(|d| d.join("relocations.json")));
            let orchestra = orchestra::Orchestra::new(Arc::new(AppHost { app: app.handle().clone() }));
            let network = Arc::new(network::Monitor::new(
                network::Store::load(app.path().app_data_dir().ok().map(|d| d.join("network.json"))),
                Box::new(network::Api::new(network::Api::default_info().unwrap_or_default())),
            ));
            let handle = app.handle().clone();
            network.set_on_change(move || {
                let _ = handle.emit("network-changed", ());
            });
            // Follows Network Monitor while any folder has a watch (a poll with none reads nothing).
            let following = network.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                following.tick();
            });
            app.manage(AppState { slots: Slots::default(), orchestra, login_path: Arc::new(OnceLock::new()), titles: Arc::new(titles), renames: Arc::new(renames), folder_rules: Arc::new(folder_rules), relocations: Arc::new(relocations), prs: Default::default(), network, agent_limit: DEFAULT_AGENT_LIMIT.into(), chat_search: Default::default(), asides: Default::default(), setups: Default::default(), restore_points: true.into() });
            app.manage(updates::Updates::default());
            app.manage(awake::Awake::default());
            if updates::checks_enabled() {
                tauri::async_runtime::spawn(updates::watch(app.handle().clone()));
            }
            // The menu bar (menu.rs), then its Open Recent list filled in from the history.
            app.manage(menu::RecentMenu::default());
            app.manage(menu::SidebarMenu::default());
            menu::refresh(app.handle(), Vec::new())?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { menu::refresh_recent(&handle).await });
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if id == menu::CHECK_FOR_UPDATES {
                // The window opens Settings on its Updates page and starts a check.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = app.emit("check-for-updates", ());
            } else if id == menu::QUIT {
                // The standard Quit ends the app without a close request, so the window's guard for unsaved edits never
                // hears of it. This closes the window instead, which does.
                match app.get_webview_window("main") {
                    Some(window) => {
                        let _ = window.close();
                    }
                    None => app.exit(0),
                }
            } else {
                menu::chosen(app, id);
            }
        })
        .invoke_handler(tauri::generate_handler![
            locate_claude,
            claude_login,
            sidebar_menu,
            keep_awake,
            user_name,
            start_session,
            restart_session,
            apply_harness,
            close_session,
            send_message,
            aside_ask,
            aside_stop,
            aside_stop_answering,
            orchestra_approve_merge,
            network_state,
            network_response,
            network_unwatch,
            network_rewatch,
            orchestra_decline_merge,
            orchestra_merge_tests_info,
            orchestra_run_merge_tests,
            orchestra_cancel_merge_tests,
            merge_tests_split_command,
            set_auto_merge_tests,
            set_restore_points,
            orchestra_discard,
            run_shell,
            claude_request,
            skill_index,
            read_skill,
            skill_create,
            skill_delete,
            skill_save,
            mcp_add,
            mcp_remove,
            mcp_form,
            mcp_edit,
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
            steps_guide,
            list_open_prs,
            pr_watch,
            pr_failure_log,
            gh_access,
            set_subagents,
            list_permission_rules,
            add_permission_rule,
            remove_permission_rule,
            git_branch,
            ship_info,
            list_dir,
            read_file,
            write_file,
            revert_files,
            restore_points,
            restore_preview,
            restore_files,
            undo_restore,
            undo_revert,
            export_text,
            find_files,
            resolve_files,
            search_text,
            list_sessions,
            search_history,
            rename_session,
            session_events,
            title_session,
            open_session,
            relocations_list,
            folders_gone,
            moved_folder_candidates,
            old_locations,
            known_folders,
            relocation_preview,
            relocate_folder,
            update_status,
            update_state,
            check_for_updates,
            app_version,
            restart_to_update,
            copy_diagnostics,
            orchestra_close_check,
            orchestra_close_worker,
            orchestra_spawn,
            orchestra_set_roles,
            orchestra_set_review,
            set_agent_limit,
            set_project_setup,
            suggest_setup,
            orchestra_setup_answer,
            run_project
        ])
        .build(tauri::generate_context!())
        .expect("error while building Lantern")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // The Mac may sleep again (caffeinate also ends by itself once Lantern's process is gone).
                if let Some(awake) = app.try_state::<awake::Awake>() {
                    awake.stop();
                }
                // A setup still running in a worktree ends with Lantern.
                setup::stop_all();
                if let Some(state) = app.try_state::<AppState>() {
                    tauri::async_runtime::block_on(state.asides.stop_all());
                    tauri::async_runtime::block_on(slots::shut_down_all(state.slots.drain()));
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

#[cfg(test)]
mod tests {
    use super::*;

    /// What the window sends comes from what it saved, and a chat saved before there was a choice of provider has none.
    #[test]
    fn settings_saved_without_a_provider_are_claudes() {
        let old: Settings = serde_json::from_str(r#"{"mode":"ask","model":null,"effort":"high"}"#).unwrap();
        assert_eq!(old.provider, ProviderId::Claude);
        let named: Settings = serde_json::from_str(r#"{"provider":"claude","mode":"auto","model":"opus","effort":null}"#).unwrap();
        assert_eq!(named.provider, ProviderId::Claude);
        assert!(serde_json::from_str::<Settings>(r#"{"provider":"nope","mode":"ask","model":null,"effort":null}"#).is_err());
    }

    /// A worker reopened from a saved chat: the mode it was saved in, no freer than its main agent's workers may be.
    #[test]
    fn a_restored_worker_keeps_its_mode_under_an_auto_main_agent_and_is_lowered_under_one_that_asks() {
        let claude = ProviderId::Claude;
        let caps = capabilities_of(claude);
        let reopened = |main: Option<(Mode, bool, ProviderId)>, saved: Mode| args::capped_mode(saved, false, ceiling_of(main), &caps);
        assert_eq!(reopened(Some((Mode::Auto, false, claude)), Mode::Auto), (Mode::Auto, false));
        assert_eq!(reopened(Some((Mode::Steps, true, claude)), Mode::Auto), (Mode::Auto, false));
        assert_eq!(reopened(Some((Mode::Auto, false, claude)), Mode::Ask), (Mode::Ask, false));
        assert_eq!(reopened(Some((Mode::Ask, false, claude)), Mode::Auto), (Mode::Ask, false));
        assert_eq!(reopened(Some((Mode::Steps, false, claude)), Mode::Auto), (Mode::Ask, false));
    }

    /// Opened before its main agent has a config (it is still opening, or was closed): nothing allows Auto yet.
    #[test]
    fn a_worker_restored_before_its_main_agent_has_a_config_comes_back_on_ask() {
        assert_eq!(ceiling_of(None), Mode::Ask);
        assert_eq!(args::capped_mode(Mode::Auto, false, ceiling_of(None), &capabilities_of(ProviderId::Claude)), (Mode::Ask, false));
    }

    fn config(mode: Mode, auto_approve: bool) -> SessionConfig {
        SessionConfig {
            provider: ProviderId::Claude,
            binary: "/bin/claude".into(),
            folder: "/tmp".into(),
            mode,
            auto_approve,
            resume: None,
            model: None,
            effort: None,
            advisor: None,
            subagent_model: None,
            helper: HelperConfig { exe: "/Apps/lantern".into(), socket: "/tmp/a.sock".into(), role: Role::Worker { name: "w".into(), read_only: false }, providers: vec![], project_notes: None },
            path_env: None,
        }
    }

    /// Restarting a worker, changing its harness or starting it from the window: whatever mode is asked for, it runs no
    /// freer than its main agent allows, and a chat that is no worker is left as asked.
    #[test]
    fn a_worker_restarted_with_more_freedom_than_its_main_agent_allows_is_capped() {
        let mut cfg = config(Mode::Auto, false);
        assert!(cap_mode(&mut cfg, Some(Mode::Ask)));
        assert_eq!((cfg.mode, cfg.auto_approve), (Mode::Ask, false));
        let mut steps = config(Mode::Steps, true);
        assert!(cap_mode(&mut steps, Some(Mode::Ask)));
        assert_eq!((steps.mode, steps.auto_approve), (Mode::Ask, false));
        let mut allowed = config(Mode::Auto, false);
        assert!(!cap_mode(&mut allowed, Some(Mode::Auto)));
        assert_eq!(allowed.mode, Mode::Auto);
        let mut no_worker = config(Mode::Auto, false);
        assert!(!cap_mode(&mut no_worker, None));
        assert_eq!(no_worker.mode, Mode::Auto);
    }

    /// Workflow Team on a running chat: it becomes the Lead (restart with the Lead's role), and goes back to an ordinary chat
    /// only once its agents are gone. A worker's role is its Lead's, whatever is asked.
    #[test]
    fn choosing_team_in_a_chat_makes_it_the_lead_and_leaving_needs_no_agents() {
        assert_eq!(role_after(&Role::Normal, Some(true), 0), Ok(Role::Main));
        assert_eq!(role_after(&Role::Normal, None, 0), Ok(Role::Normal));
        assert_eq!(role_after(&Role::Main, Some(true), 3), Ok(Role::Main));
        assert_eq!(role_after(&Role::Main, None, 3), Ok(Role::Main));
        assert_eq!(role_after(&Role::Main, Some(false), 0), Ok(Role::Normal));
        assert!(role_after(&Role::Main, Some(false), 2).unwrap_err().contains("still has agents"));
        let worker = Role::Worker { name: "w".into(), read_only: false };
        for team in [Some(true), Some(false), None] {
            assert_eq!(role_after(&worker, team, 0), Ok(worker.clone()), "{team:?}");
        }
    }

    /// Permissions mean the same in every workflow: a team whose Lead is on Auto (in Chat or Step by step terms) lets its
    /// agents run on Auto, and one on Ask never does.
    #[test]
    fn a_leads_permissions_cap_its_agents_the_same_in_every_workflow() {
        let claude = ProviderId::Claude;
        for (mode, auto, agents) in [(Mode::Auto, false, Mode::Auto), (Mode::Steps, true, Mode::Auto), (Mode::Ask, false, Mode::Ask), (Mode::Steps, false, Mode::Ask)] {
            assert_eq!(ceiling_of(Some((mode, auto, claude))), agents, "{mode:?} {auto}");
        }
    }

    /// A restored worker's settings carry the branch the canvas saved, and older saves (without one) still read.
    #[test]
    fn a_restored_workers_settings_carry_its_saved_branch() {
        let saved: Settings = serde_json::from_str(r#"{"mode":"auto","model":null,"effort":null,"worker":{"name":"w","parent":"s1","branch":"lantern/w"}}"#).unwrap();
        assert_eq!(saved.worker.unwrap().branch.as_deref(), Some("lantern/w"));
        let older: Settings = serde_json::from_str(r#"{"mode":"auto","model":null,"effort":null,"worker":{"name":"w","parent":"s1"}}"#).unwrap();
        assert_eq!(older.worker.unwrap().branch, None);
    }

    #[test]
    fn the_window_keeps_where_it_was_how_big_and_full_screen_but_not_whether_it_was_hidden() {
        let flags = window_state_flags();
        assert!(flags.contains(tauri_plugin_window_state::StateFlags::POSITION | tauri_plugin_window_state::StateFlags::SIZE | tauri_plugin_window_state::StateFlags::FULLSCREEN));
        assert!(!flags.intersects(tauri_plugin_window_state::StateFlags::VISIBLE | tauri_plugin_window_state::StateFlags::DECORATIONS));
    }

    #[test]
    fn the_window_state_plugin_is_granted_to_the_main_window() {
        let capability: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let granted = capability["permissions"].as_array().unwrap();
        assert!(granted.iter().any(|p| p == "window-state:default"));
    }

    #[test]
    fn the_window_keeps_the_minimum_size_it_is_built_with_so_a_restored_size_cannot_go_below_it() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window = &config["app"]["windows"][0];
        assert_eq!(window["minWidth"], 1040);
        assert_eq!(window["minHeight"], 600);
    }

    #[test]
    fn a_saved_edit_is_tracked_under_the_ui_path_with_its_original_even_in_a_symlinked_folder() {
        let real = tempfile::tempdir().unwrap();
        let link = real.path().join("via-link");
        std::os::unix::fs::symlink(real.path(), &link).unwrap();
        std::fs::write(real.path().join("a.txt"), "before\n").unwrap();
        let tracker = std::sync::Mutex::new(changes::ChangeTracker::default());
        // The UI knows the folder by the symlink's path.
        let ui_path = link.join("a.txt").display().to_string();
        let r = save_tracked(&link, &tracker, &ui_path, "after\n", Some("before\n")).unwrap();
        assert!(matches!(r, files::Written::Saved { changed: true, .. }));
        let diff = tracker.lock().unwrap().diff(&ui_path, changes::Scope::Session, None, None).unwrap();
        assert_eq!((diff.original.as_str(), diff.current.as_str()), ("before\n", "after\n"));
        // A second save keeps the first original; an unchanged one and a conflict track nothing new.
        save_tracked(&link, &tracker, &ui_path, "again\n", Some("after\n")).unwrap();
        let diff = tracker.lock().unwrap().diff(&ui_path, changes::Scope::Session, None, None).unwrap();
        assert_eq!(diff.original, "before\n");
        let other = link.join("b.txt").display().to_string();
        std::fs::write(real.path().join("b.txt"), "x\n").unwrap();
        assert!(matches!(save_tracked(&link, &tracker, &other, "y\n", Some("stale\n")).unwrap(), files::Written::Conflict { .. }));
        assert!(matches!(save_tracked(&link, &tracker, &other, "x\n", Some("x\n")).unwrap(), files::Written::Saved { changed: false, .. }));
        let tracked: Vec<String> = tracker.lock().unwrap().summary(changes::Scope::Session, None, None).into_iter().map(|c| c.path).collect();
        assert_eq!(tracked, vec![ui_path]);
    }
}

