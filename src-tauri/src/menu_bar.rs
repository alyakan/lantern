//! The menu bar item: a lantern in the Mac's top bar with a live readout (memory used, disk free), which opens a small panel
//! with the same numbers, the open chats and a box to start a new one. The user picks what shows (Settings ▸ General ▸ Menu
//! bar): nothing, the lantern alone, or the lantern with its readout.
//!
//! The panel is a second window of this app (label `menubar`) that loads the same page as the main window and draws itself
//! in the user's theme. It only reads: what it asks of the main window (open a chat, start one, open Storage) goes through
//! `menubar_act`, which checks it and tells the main window, and the main window is the one that acts.
//!
//! The icon is a template image (macOS tints it for a light or dark bar). When memory or the disk runs low it swaps to an
//! amber or red lantern instead, which is the one thing a title's text can't do.

use crate::storage::{self, memory};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::tray::{MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const TRAY_ID: &str = "lantern";
/// The panel window's label (the page tells it from the main window by it).
pub const PANEL: &str = "menubar";
const MAIN: &str = "main";

/// How often the readout is read while the item is on.
const POLL: Duration = Duration::from_secs(5);
/// Free disk below this is amber, below the next red.
pub const WARN_FREE_BYTES: u64 = 15_000_000_000;
pub const CRITICAL_FREE_BYTES: u64 = 5_000_000_000;
/// A click on the item that arrives this soon after the panel closed itself on losing focus is the click that did it, not a
/// new one: the panel stays closed.
const BLUR_GRACE: Duration = Duration::from_millis(250);

const PANEL_WIDTH: f64 = 380.0;
const PANEL_MIN: f64 = 160.0;
const PANEL_MAX: f64 = 720.0;

const ICON_NORMAL: &[u8] = include_bytes!("../icons/tray.png");
const ICON_WARN: &[u8] = include_bytes!("../icons/tray-warn.png");
const ICON_CRITICAL: &[u8] = include_bytes!("../icons/tray-crit.png");

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// No menu bar item at all.
    Off,
    /// The lantern alone.
    Icon,
    /// The lantern and its readout.
    Full,
}

/// What the user chose. `ram` and `disk` say what the readout shows, and also what the lantern watches when it tints.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub struct Config {
    pub mode: Mode,
    pub ram: bool,
    pub disk: bool,
    /// Tint the lantern amber or red when what it watches runs low.
    pub alerts: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self { mode: Mode::Full, ram: true, disk: true, alerts: true }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Ok,
    Warn,
    Critical,
}

/// How worried the lantern looks: the worse of memory pressure and free disk, counting only what the user has it watch.
pub fn level(cfg: &Config, pressure: Option<memory::Pressure>, free_disk: Option<u64>) -> Level {
    let ram = if cfg.ram {
        match pressure {
            Some(memory::Pressure::Critical) => Level::Critical,
            Some(memory::Pressure::Warning) => Level::Warn,
            _ => Level::Ok,
        }
    } else {
        Level::Ok
    };
    let disk = match free_disk {
        Some(f) if cfg.disk && f < CRITICAL_FREE_BYTES => Level::Critical,
        Some(f) if cfg.disk && f < WARN_FREE_BYTES => Level::Warn,
        _ => Level::Ok,
    };
    // Critical beats Warn beats Ok.
    [ram, disk].into_iter().max_by_key(|l| *l as u8).unwrap_or(Level::Ok)
}

/// The text beside the lantern: "62% · 8.3 GB" (memory used, disk free), whichever of them the user shows.
pub fn readout(cfg: &Config, ram: Option<&memory::Light>, free_disk: Option<u64>) -> String {
    let mut parts = Vec::new();
    if let (true, Some(r)) = (cfg.ram, ram) {
        if r.total_bytes > 0 {
            parts.push(format!("{}%", ((r.used_bytes as f64 / r.total_bytes as f64) * 100.0).round().min(100.0) as u64));
        }
    }
    if let (true, Some(free)) = (cfg.disk, free_disk) {
        parts.push(storage::size_text(free));
    }
    parts.join(" · ")
}

/// What the lantern says when hovered: the same numbers in words.
fn tooltip(ram: Option<&memory::Light>, free: Option<u64>, total: Option<u64>) -> String {
    let mut lines = vec!["Lantern".to_string()];
    if let Some(r) = ram {
        let pressure = match r.pressure {
            memory::Pressure::Normal => "normal",
            memory::Pressure::Warning => "warning",
            memory::Pressure::Critical => "critical",
        };
        lines.push(format!("Memory: {} of {} used, pressure {pressure}", storage::size_text(r.used_bytes), storage::size_text(r.total_bytes)));
    }
    if let Some(f) = free {
        lines.push(match total {
            Some(t) => format!("Disk: {} free of {}", storage::size_text(f), storage::size_text(t)),
            None => format!("Disk: {} free", storage::size_text(f)),
        });
    }
    lines.join("\n")
}

/// A rectangle in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Where the panel's top-left goes: centred under the lantern, a little below the bar, and kept on the screen the lantern is on.
pub fn place(icon: Area, panel: (f64, f64), screen: Area, scale: f64) -> (f64, f64) {
    let (gap, margin) = (6.0 * scale, 8.0 * scale);
    let x = icon.x + icon.w / 2.0 - panel.0 / 2.0;
    let x = x.min(screen.x + screen.w - panel.0 - margin).max(screen.x + margin);
    let y = (icon.y + icon.h + gap).min(screen.y + screen.h - panel.1 - margin).max(screen.y);
    (x, y)
}

/// What the panel may ask the main window to do. Each is checked here and again by the main window, which holds the chats.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    /// Bring Lantern's window forward.
    Open,
    /// Show one of the open chats.
    Chat { slot: String },
    /// Start a chat in a project, with a first message.
    NewChat { folder: String, text: String },
    /// Open the Storage panel.
    Storage,
    /// Open Settings on the Menu bar group.
    Settings,
}

const MAX_TEXT: usize = 20_000;
const MAX_PATH: usize = 4096;

impl Action {
    pub fn check(&self) -> Result<(), String> {
        match self {
            Action::Chat { slot } if !crate::slots::valid_slot(slot) => Err("That isn't a chat.".into()),
            Action::NewChat { folder, text } => {
                if !folder.starts_with('/') || folder.len() > MAX_PATH || folder.contains('\0') {
                    Err("That isn't a project folder.".into())
                } else if text.trim().is_empty() {
                    Err("Write what the chat should start with.".into())
                } else if text.chars().count() > MAX_TEXT {
                    Err("That message is too long.".into())
                } else {
                    Ok(())
                }
            }
            _ => Ok(()),
        }
    }
}

/// The menu bar item's state, managed by the app.
#[derive(Default)]
pub struct MenuBar {
    config: Mutex<Config>,
    /// When the panel last closed because it lost focus.
    hidden_at: Mutex<Option<Instant>>,
    /// The tint the icon has now (None: not set yet).
    shown: Mutex<Option<Level>>,
    polling: AtomicBool,
}

fn state(app: &AppHandle) -> tauri::State<'_, MenuBar> {
    app.state::<MenuBar>()
}

fn image(bytes: &'static [u8]) -> Option<Image<'static>> {
    Image::from_bytes(bytes).ok()
}

fn icon_for(level: Level) -> &'static [u8] {
    match level {
        Level::Ok => ICON_NORMAL,
        Level::Warn => ICON_WARN,
        Level::Critical => ICON_CRITICAL,
    }
}

fn home() -> std::path::PathBuf {
    std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_default()
}

/// The disk's whole size, as the free space is counted (the volume the home folder is on).
pub fn disk_total(home: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let path = CString::new(home.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(path.as_ptr(), &mut st) } != 0 {
        return None;
    }
    Some(st.f_blocks as u64 * st.f_frsize as u64)
}

/// Reads the numbers and draws them on the lantern: its title, its tooltip and its tint. Done every few seconds and whenever
/// the choice changes.
pub fn refresh(app: &AppHandle) {
    let st = state(app);
    let cfg = *st.config.lock().unwrap_or_else(|e| e.into_inner());
    if cfg.mode == Mode::Off {
        return;
    }
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let ram = memory::light().ok();
    let home = home();
    let (free, total) = (storage::free_bytes(&home), disk_total(&home));
    let title = (cfg.mode == Mode::Full).then(|| readout(&cfg, ram.as_ref(), free)).filter(|t| !t.is_empty());
    let _ = tray.set_title(title.as_deref());
    let _ = tray.set_tooltip(Some(tooltip(ram.as_ref(), free, total)));
    let lvl = if cfg.alerts { level(&cfg, ram.map(|r| r.pressure), free) } else { Level::Ok };
    let mut shown = st.shown.lock().unwrap_or_else(|e| e.into_inner());
    if *shown != Some(lvl) {
        *shown = Some(lvl);
        if let Some(img) = image(icon_for(lvl)) {
            let _ = tray.set_icon(Some(img));
            // Only the plain lantern is a template (tinted by macOS); the amber and red ones keep their colour.
            let _ = tray.set_icon_as_template(lvl == Level::Ok);
        }
    }
}

fn hide_panel(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window(PANEL) {
        let _ = panel.hide();
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Opens the panel under the lantern, or closes it if it's open.
fn toggle(app: &AppHandle, rect: &tauri::Rect) {
    let Some(panel) = app.get_webview_window(PANEL) else { return };
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }
    let recently_closed = state(app).hidden_at.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|t| t.elapsed() < BLUR_GRACE);
    if recently_closed {
        return;
    }
    let (pos, size) = (rect.position.to_physical::<f64>(1.0), rect.size.to_physical::<f64>(1.0));
    let icon = Area { x: pos.x, y: pos.y, w: size.width, h: size.height };
    let monitor = app.monitor_from_point(pos.x, pos.y).ok().flatten().or_else(|| app.primary_monitor().ok().flatten());
    let (screen, scale) = match &monitor {
        Some(m) => (Area { x: m.position().x as f64, y: m.position().y as f64, w: m.size().width as f64, h: m.size().height as f64 }, m.scale_factor()),
        None => (Area { x: 0.0, y: 0.0, w: f64::MAX / 4.0, h: f64::MAX / 4.0 }, 1.0),
    };
    let panel_size = panel.outer_size().map(|s| (s.width as f64, s.height as f64)).unwrap_or((PANEL_WIDTH * scale, 400.0 * scale));
    let (x, y) = place(icon, panel_size, screen, scale);
    let _ = panel.set_position(PhysicalPosition::new(x, y));
    let _ = panel.show();
    let _ = panel.set_focus();
    let _ = app.emit_to(PANEL, "menubar-shown", ());
}

/// The panel window, hidden, once. It closes itself when it loses focus, as a menu does.
fn ensure_panel(app: &AppHandle) {
    if app.get_webview_window(PANEL).is_some() {
        return;
    }
    let built = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("index.html".into()))
        .title("Lantern")
        .inner_size(PANEL_WIDTH, 420.0)
        .decorations(false)
        .transparent(true)
        // The panel draws its own shadow inside the window: a system one would be a square box around its rounded corners.
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .visible_on_all_workspaces(true)
        .accept_first_mouse(true)
        .build();
    let panel = match built {
        Ok(panel) => panel,
        Err(e) => return eprintln!("menu bar: couldn't make the panel: {e}"),
    };
    let handle = app.clone();
    panel.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            *state(&handle).hidden_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
            hide_panel(&handle);
        }
    });
}

fn ensure_tray(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(true);
        return;
    }
    let Some(img) = image(ICON_NORMAL) else { return };
    let built = TrayIconBuilder::with_id(TRAY_ID)
        .icon(img)
        .icon_as_template(true)
        .tooltip("Lantern")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button_state: MouseButtonState::Up, rect, .. } = event {
                toggle(tray.app_handle(), &rect);
            }
        })
        .build(app);
    match built {
        Ok(_) => {
            eprintln!("menu bar: the lantern is in the menu bar");
            *state(app).shown.lock().unwrap_or_else(|e| e.into_inner()) = Some(Level::Ok);
        }
        Err(e) => eprintln!("menu bar: couldn't put the lantern in the menu bar: {e}"),
    }
}

/// Puts the menu bar item as the user chose: on the main thread, where the Mac wants it built.
fn apply(app: &AppHandle, cfg: Config) {
    *state(app).config.lock().unwrap_or_else(|e| e.into_inner()) = cfg;
    if cfg.mode == Mode::Off {
        hide_panel(app);
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            let _ = tray.set_visible(false);
        }
        return;
    }
    ensure_tray(app);
    ensure_panel(app);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if cfg.mode == Mode::Icon {
            let _ = tray.set_title(None::<&str>);
        }
    }
    if !state(app).polling.swap(true, Ordering::SeqCst) {
        let handle = app.clone();
        std::thread::spawn(move || loop {
            refresh(&handle);
            std::thread::sleep(POLL);
        });
    } else {
        let handle = app.clone();
        std::thread::spawn(move || refresh(&handle));
    }
}

/// The user's choice, pushed by the window when it starts and on every change (like the agent limit).
#[tauri::command]
pub fn set_menu_bar(app: AppHandle, config: Config) -> Result<(), String> {
    let on_main = app.clone();
    app.run_on_main_thread(move || apply(&on_main, config)).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct Stats {
    pub ram: Option<memory::Light>,
    pub disk_free: Option<u64>,
    pub disk_total: Option<u64>,
}

/// The panel's numbers (a few milliseconds: no process list).
#[tauri::command]
pub async fn menubar_stats() -> Stats {
    tauri::async_runtime::spawn_blocking(|| {
        let home = home();
        Stats { ram: memory::light().ok(), disk_free: storage::free_bytes(&home), disk_total: disk_total(&home) }
    })
    .await
    .unwrap_or(Stats { ram: None, disk_free: None, disk_total: None })
}

/// The panel is as tall as what it shows.
#[tauri::command]
pub fn menubar_fit(app: AppHandle, height: f64) {
    if let (Some(panel), true) = (app.get_webview_window(PANEL), height.is_finite()) {
        let _ = panel.set_size(LogicalSize::new(PANEL_WIDTH, height.clamp(PANEL_MIN, PANEL_MAX)));
    }
}

#[tauri::command]
pub fn menubar_hide(app: AppHandle) {
    hide_panel(&app);
}

/// Something the panel wants the main window to do: checked here, then the window is brought forward and told.
#[tauri::command]
pub fn menubar_act(app: AppHandle, action: Action) -> Result<(), String> {
    action.check()?;
    hide_panel(&app);
    show_main(&app);
    app.emit_to(MAIN, "menubar-action", &action).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use memory::Pressure;

    fn cfg(mode: Mode, ram: bool, disk: bool, alerts: bool) -> Config {
        Config { mode, ram, disk, alerts }
    }

    fn light(used_gb: u64, total_gb: u64, pressure: Pressure) -> memory::Light {
        memory::Light { total_bytes: total_gb * 1_000_000_000, used_bytes: used_gb * 1_000_000_000, pressure }
    }

    #[test]
    fn the_readout_shows_memory_used_and_disk_free_as_chosen() {
        let ram = light(10, 16, Pressure::Normal);
        let all = cfg(Mode::Full, true, true, true);
        assert_eq!(readout(&all, Some(&ram), Some(8_300_000_000)), "63% · 8.3 GB");
        assert_eq!(readout(&cfg(Mode::Full, true, false, true), Some(&ram), Some(8_300_000_000)), "63%");
        assert_eq!(readout(&cfg(Mode::Full, false, true, true), Some(&ram), Some(8_300_000_000)), "8.3 GB");
        assert_eq!(readout(&cfg(Mode::Full, false, false, true), Some(&ram), Some(8_300_000_000)), "");
        // What couldn't be read is left out, not shown as zero.
        assert_eq!(readout(&all, None, Some(8_300_000_000)), "8.3 GB");
        assert_eq!(readout(&all, Some(&ram), None), "63%");
        assert_eq!(readout(&all, Some(&light(20, 16, Pressure::Normal)), None), "100%");
    }

    #[test]
    fn the_lantern_worsens_with_memory_pressure_or_low_disk_and_only_for_what_it_watches() {
        let all = cfg(Mode::Full, true, true, true);
        let (gb15, gb14, gb5, gb4) = (15_000_000_000, 14_999_999_999, 5_000_000_000, 4_999_999_999);
        assert_eq!(level(&all, Some(Pressure::Normal), Some(gb15)), Level::Ok);
        assert_eq!(level(&all, Some(Pressure::Normal), Some(gb14)), Level::Warn);
        assert_eq!(level(&all, Some(Pressure::Normal), Some(gb5)), Level::Warn);
        assert_eq!(level(&all, Some(Pressure::Normal), Some(gb4)), Level::Critical);
        assert_eq!(level(&all, Some(Pressure::Warning), Some(gb15)), Level::Warn);
        assert_eq!(level(&all, Some(Pressure::Critical), Some(gb15)), Level::Critical);
        // The worse of the two wins.
        assert_eq!(level(&all, Some(Pressure::Warning), Some(gb4)), Level::Critical);
        assert_eq!(level(&all, Some(Pressure::Critical), Some(gb14)), Level::Critical);
        // Unknown is not alarming.
        assert_eq!(level(&all, None, None), Level::Ok);
        // A reading the user turned off doesn't tint it.
        assert_eq!(level(&cfg(Mode::Full, false, true, true), Some(Pressure::Critical), Some(gb15)), Level::Ok);
        assert_eq!(level(&cfg(Mode::Full, true, false, true), Some(Pressure::Normal), Some(gb4)), Level::Ok);
    }

    #[test]
    fn the_panel_opens_centred_under_the_lantern_and_stays_on_the_screen() {
        let screen = Area { x: 0.0, y: 0.0, w: 3024.0, h: 1964.0 };
        let panel = (760.0, 900.0);
        // Under an icon in the middle: centred, below the bar.
        let (x, y) = place(Area { x: 1500.0, y: 0.0, w: 44.0, h: 50.0 }, panel, screen, 2.0);
        assert_eq!((x, y), (1522.0 - 380.0, 62.0));
        // An icon at the far right edge pulls the panel in, a margin from the edge.
        let (x, _) = place(Area { x: 3000.0, y: 0.0, w: 44.0, h: 50.0 }, panel, screen, 2.0);
        assert_eq!(x, 3024.0 - 760.0 - 16.0);
        // At the far left too.
        let (x, _) = place(Area { x: 0.0, y: 0.0, w: 44.0, h: 50.0 }, panel, screen, 2.0);
        assert_eq!(x, 16.0);
        // A second screen to the right keeps the panel on that one.
        let second = Area { x: 3024.0, y: 0.0, w: 2560.0, h: 1440.0 };
        let (x, _) = place(Area { x: 5560.0, y: 0.0, w: 44.0, h: 50.0 }, panel, second, 2.0);
        assert_eq!(x, 3024.0 + 2560.0 - 760.0 - 16.0);
        // A panel taller than the room is pulled up, not off the bottom.
        let (_, y) = place(Area { x: 100.0, y: 0.0, w: 44.0, h: 50.0 }, (760.0, 1900.0), screen, 2.0);
        assert_eq!(y, 1964.0 - 1900.0 - 16.0);
    }

    #[test]
    fn the_choice_is_read_as_the_window_sends_it_and_the_default_is_the_whole_thing() {
        let c: Config = serde_json::from_str(r#"{"mode":"icon","ram":false,"disk":true,"alerts":false}"#).unwrap();
        assert_eq!(c, cfg(Mode::Icon, false, true, false));
        let c: Config = serde_json::from_str(r#"{"mode":"off","ram":true,"disk":true,"alerts":true}"#).unwrap();
        assert_eq!(c.mode, Mode::Off);
        assert!(serde_json::from_str::<Config>(r#"{"mode":"sideways","ram":true,"disk":true,"alerts":true}"#).is_err());
        assert_eq!(Config::default(), cfg(Mode::Full, true, true, true));
    }

    #[test]
    fn what_the_panel_may_ask_is_checked_before_the_main_window_hears_of_it() {
        let ok = |a: Action| a.check().is_ok();
        assert!(ok(Action::Open) && ok(Action::Storage) && ok(Action::Settings));
        assert!(ok(Action::Chat { slot: "s12".into() }));
        assert!(!ok(Action::Chat { slot: "../../etc".into() }));
        assert!(!ok(Action::Chat { slot: String::new() }));
        assert!(ok(Action::NewChat { folder: "/Users/me/app".into(), text: "fix the bug".into() }));
        // A folder that isn't an absolute path, an empty message, and an enormous one are refused.
        assert!(!ok(Action::NewChat { folder: "app".into(), text: "x".into() }));
        assert!(!ok(Action::NewChat { folder: "/a\0b".into(), text: "x".into() }));
        assert!(!ok(Action::NewChat { folder: "/a".into(), text: "  \n".into() }));
        assert!(!ok(Action::NewChat { folder: "/a".into(), text: "x".repeat(MAX_TEXT + 1) }));
        // And it arrives the way the page sends it, and goes out the way the main window reads it.
        let a: Action = serde_json::from_str(r#"{"kind":"new_chat","folder":"/a","text":"hi"}"#).unwrap();
        assert_eq!(a, Action::NewChat { folder: "/a".into(), text: "hi".into() });
        assert_eq!(serde_json::to_string(&Action::Chat { slot: "s1".into() }).unwrap(), r#"{"kind":"chat","slot":"s1"}"#);
        assert!(serde_json::from_str::<Action>(r#"{"kind":"delete_everything"}"#).is_err());
    }

    #[test]
    fn the_tooltip_says_the_numbers_in_words_and_leaves_out_what_is_unknown() {
        let ram = light(10, 16, Pressure::Warning);
        assert_eq!(tooltip(Some(&ram), Some(8_300_000_000), Some(494_000_000_000)), "Lantern\nMemory: 10.0 GB of 16.0 GB used, pressure warning\nDisk: 8.3 GB free of 494.0 GB");
        assert_eq!(tooltip(None, None, None), "Lantern");
    }

    #[test]
    fn the_three_icons_are_real_images() {
        for bytes in [ICON_NORMAL, ICON_WARN, ICON_CRITICAL] {
            assert!(image(bytes).is_some());
        }
    }
}
