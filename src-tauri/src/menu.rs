//! The menu bar. Most items are actions of the webview's registry (src/lib/actions.ts): choosing one emits its id to the
//! window, which runs the action its shortcut runs. The tests at the bottom keep this list and that file in step.

use std::sync::Mutex;
use tauri::menu::{AboutMetadata, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// Items that aren't registry actions: Lantern ▸ Check for Updates… and the Quit that closes the window first.
pub const CHECK_FOR_UPDATES: &str = "check-for-updates";
pub const QUIT: &str = "quit";

/// How many recent folders File ▸ Open Recent lists.
const RECENT_LIMIT: usize = 8;

/// The folders Open Recent lists, in menu order: the item "recent:N" opens the Nth.
#[derive(Default)]
pub struct RecentMenu(Mutex<Vec<String>>);

/// The menu's actions: the id (an action id in src/lib/actions.ts), the label and the accelerator. An action without an
/// accelerator is run by the webview's keydown; its label carries the shortcut instead, so the menu can't swallow a key
/// Monaco or a text field needs.
pub const ACTIONS: &[(&str, &str, Option<&str>)] = &[
    ("new-session", "New Session", Some("CmdOrCtrl+N")),
    ("open-folder", "Open Folder…", Some("CmdOrCtrl+O")),
    ("session-history", "Session History   ⌘K", None),
    ("find-file", "Find File…", Some("CmdOrCtrl+P")),
    ("search-files", "Search in Files…", Some("Shift+CmdOrCtrl+F")),
    ("find-in-file", "Find in File   ⌘F", None),
    ("toggle-changes", "Toggle Changes Pane", Some("CmdOrCtrl+Backslash")),
    ("command-palette", "Command Palette…", Some("Shift+CmdOrCtrl+P")),
    ("settings", "Settings…", Some("CmdOrCtrl+Comma")),
    ("keyboard-shortcuts", "Keyboard Shortcuts   ⌘/", None),
    ("report-bug", "Report a Bug…", None),
];

fn label_of(id: &str) -> (&'static str, Option<&'static str>) {
    let (_, label, accelerator) = ACTIONS.iter().find(|(action, _, _)| *action == id).unwrap_or_else(|| panic!("no menu action {id}"));
    (label, *accelerator)
}

/// "~/Documents/x" for a path in the home folder, so the menu doesn't show the user name.
fn tilde(path: &str) -> String {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() => match path.strip_prefix(&home) {
            Some(rest) => format!("~{rest}"),
            None => path.to_string(),
        },
        _ => path.to_string(),
    }
}

/// The menu bar, with `recent` as Open Recent's folders.
#[cfg(target_os = "macos")]
fn build(app: &AppHandle, recent: &[String]) -> tauri::Result<Menu<Wry>> {
    let action = |id: &str| {
        let (label, accelerator) = label_of(id);
        MenuItem::with_id(app, id, label, true, accelerator)
    };
    let separator = || PredefinedMenuItem::separator(app);

    let recent_items: Vec<MenuItem<Wry>> = if recent.is_empty() {
        vec![MenuItem::with_id(app, "recent-none", "No Recent Folders", false, None::<&str>)?]
    } else {
        recent
            .iter()
            .enumerate()
            .map(|(i, path)| {
                let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone());
                let parent = std::path::Path::new(path).parent().map(|p| tilde(&p.to_string_lossy())).unwrap_or_default();
                MenuItem::with_id(app, format!("recent:{i}"), format!("{name}   {parent}"), true, None::<&str>)
            })
            .collect::<tauri::Result<_>>()?
    };
    let recent_refs: Vec<&dyn IsMenuItem<Wry>> = recent_items.iter().map(|item| item as &dyn IsMenuItem<Wry>).collect();
    let open_recent = Submenu::with_items(app, "Open Recent", true, &recent_refs)?;

    // The standard app menu, with Check for Updates… under About (Mac users look for it there) and the Quit that closes
    // the window: the standard Quit ends the app without a close request, so the window's guard for unsaved edits
    // never hears of it.
    let pkg = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let check = MenuItem::with_id(app, CHECK_FOR_UPDATES, "Check for Updates…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "Quit Lantern", true, Some("CmdOrCtrl+Q"))?;
    let app_menu = Submenu::with_items(
        app,
        pkg.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &check,
            &separator()?,
            &PredefinedMenuItem::services(app, None)?,
            &separator()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &separator()?,
            &quit,
        ],
    )?;

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[&action("new-session")?, &action("open-folder")?, &open_recent, &separator()?, &PredefinedMenuItem::close_window(app, None)?],
    )?;
    // Copy, paste and the rest of editing stay the standard items: they're what Monaco and the text fields rely on.
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &action("session-history")?,
            &action("find-file")?,
            &action("search-files")?,
            &action("find-in-file")?,
            &separator()?,
            &action("toggle-changes")?,
            &action("command-palette")?,
            &separator()?,
            &action("settings")?,
            &separator()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?, &separator()?, &PredefinedMenuItem::close_window(app, None)?],
    )?;
    let help = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[&action("keyboard-shortcuts")?, &action("report-bug")?])?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

/// Sets the menu bar with `recent` as Open Recent's folders, and remembers them for the items that open them.
#[cfg(target_os = "macos")]
pub fn refresh(app: &AppHandle, recent: Vec<String>) -> tauri::Result<()> {
    let menu = build(app, &recent)?;
    *app.state::<RecentMenu>().0.lock().unwrap() = recent;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn refresh(_app: &AppHandle, _recent: Vec<String>) -> tauri::Result<()> {
    Ok(())
}

/// Rebuilds Open Recent from Claude Code's history. Called when a session starts and when a message goes out, since a
/// folder's history is first written then, so it can't be listed before.
pub async fn refresh_recent(app: &AppHandle) {
    let Ok(root) = crate::projects_root() else { return };
    let folders = tauri::async_runtime::spawn_blocking(move || crate::history::recent_folders(&root, RECENT_LIMIT).into_iter().map(|r| r.path).collect::<Vec<_>>())
        .await
        .unwrap_or_default();
    let _ = refresh(app, folders);
}

/// Whether Open Recent already lists `folder`.
pub fn lists(app: &AppHandle, folder: &str) -> bool {
    app.state::<RecentMenu>().0.lock().unwrap().iter().any(|f| f == folder)
}

/// The window hears of a menu item it runs: an action's id, or the folder an Open Recent item names.
pub fn chosen(app: &AppHandle, id: &str) {
    if let Some(index) = id.strip_prefix("recent:") {
        let folder = index.parse::<usize>().ok().and_then(|i| app.state::<RecentMenu>().0.lock().unwrap().get(i).cloned());
        if let Some(folder) = folder {
            let _ = app.emit("open-recent", folder);
        }
    } else if ACTIONS.iter().any(|(action, _, _)| *action == id) {
        let _ = app.emit("menu-action", id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REGISTRY: &str = include_str!("../../src/lib/actions.ts");

    /// One action of the registry: its id, key, whether it's shift, in the menu, and whether the menu owns its key.
    #[derive(Debug, PartialEq)]
    struct Def {
        id: String,
        key: Option<String>,
        shift: bool,
        menu: bool,
        native: bool,
    }

    /// The entries of ACTIONS in actions.ts. Each one is on a line of its own, with `id: "…"`.
    fn registry() -> Vec<Def> {
        REGISTRY
            .lines()
            .filter_map(|line| {
                let id = between(line, "id: \"")?;
                let key = between(line, "key: \"").map(|k| if k == "\\\\" { "\\".to_string() } else { k });
                Some(Def { id, key, shift: line.contains("shift: true"), menu: line.contains("menu: true"), native: line.contains("native: true") })
            })
            .collect()
    }

    fn between(line: &str, start: &str) -> Option<String> {
        let rest = &line[line.find(start)? + start.len()..];
        // A key is one character, or a backslash written as two.
        let end = if rest.starts_with("\\\\") { 2 } else { rest.find('"')? };
        Some(rest[..end].to_string())
    }

    /// The accelerator the menu should use for a registry key, in muda's spelling.
    fn accelerator_for(def: &Def) -> String {
        let key = def.key.as_deref().unwrap_or_default();
        let name = match key {
            "\\" => "Backslash".to_string(),
            "," => "Comma".to_string(),
            "/" => "Slash".to_string(),
            other => other.to_uppercase(),
        };
        format!("{}CmdOrCtrl+{name}", if def.shift { "Shift+" } else { "" })
    }

    #[test]
    fn every_menu_action_is_a_registry_action_and_every_menu_registry_action_is_in_the_menu() {
        let mut menu_ids: Vec<String> = ACTIONS.iter().map(|(id, _, _)| id.to_string()).collect();
        let mut registry_menu: Vec<String> = registry().into_iter().filter(|d| d.menu).map(|d| d.id).collect();
        menu_ids.sort();
        registry_menu.sort();
        assert!(!menu_ids.is_empty());
        assert_eq!(menu_ids, registry_menu);
        let mut unique = menu_ids.clone();
        unique.dedup();
        assert_eq!(unique, menu_ids, "menu ids must be unique");
    }

    #[test]
    fn a_menu_accelerator_is_exactly_the_native_registry_key() {
        for def in registry().into_iter().filter(|d| d.menu) {
            let (_, accelerator) = label_of(&def.id);
            if def.native {
                assert_eq!(accelerator, Some(accelerator_for(&def).as_str()), "{}", def.id);
            } else {
                assert_eq!(accelerator, None, "{} is run by the webview, so the menu must not take its key", def.id);
            }
        }
    }

    #[test]
    fn every_accelerator_parses_so_the_menu_builds_at_launch() {
        for (id, _, accelerator) in ACTIONS {
            if let Some(text) = accelerator {
                text.parse::<muda::accelerator::Accelerator>().unwrap_or_else(|e| panic!("{id}: {text}: {e}"));
            }
        }
    }

    #[test]
    fn a_registry_line_is_read_back_with_its_key_and_flags() {
        let line = r#"  { id: "toggle-changes", title: "Toggle Changes Pane", group: "View", key: "\\", menu: true, native: true },"#;
        assert_eq!(between(line, "id: \""), Some("toggle-changes".into()));
        assert_eq!(between(line, "key: \""), Some("\\\\".into()));
        assert_eq!(accelerator_for(&Def { id: "x".into(), key: Some("\\".into()), shift: false, menu: true, native: true }), "CmdOrCtrl+Backslash");
        assert_eq!(accelerator_for(&Def { id: "x".into(), key: Some("p".into()), shift: true, menu: true, native: true }), "Shift+CmdOrCtrl+P");
    }

    #[test]
    fn a_path_in_the_home_folder_shows_with_a_tilde() {
        std::env::set_var("HOME", "/Users/someone");
        assert_eq!(tilde("/Users/someone/Documents/app"), "~/Documents/app");
        assert_eq!(tilde("/elsewhere/app"), "/elsewhere/app");
    }
}
