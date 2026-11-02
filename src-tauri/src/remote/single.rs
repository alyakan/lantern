//! One project, for a phone. The window's sidebar can show one project on its own (Sidebar's One project); the window says which,
//! and a phone that follows it (protocol::PHONE_SINGLE) is sent it, to show only that project's chats under the same banner. A
//! phone that picks one asks the window (Request::SetSingle), and shows what the window says back: the window is where it lives.
//!
//! The window is trusted for what it says, but what it says is checked: a folder's whole path, a colour as "#rrggbb", and the
//! name a phone matches its chats on is worked out here from the folder, as RemoteChat's `project` is.

use super::protocol::RemoteSingle;
use serde::Deserialize;
use std::sync::Mutex;

/// The longest folder path taken.
pub const FOLDER_MAX: usize = 4096;

/// What the window says of its One project: the folder, and the colour the sidebar gives it.
#[derive(Debug, Clone, Deserialize)]
pub struct WindowSingle {
    pub folder: String,
    pub color: Option<String>,
}

/// Whether `folder` is a folder's whole path, of one line and not too long: what a window or a phone may name.
pub fn folder_ok(folder: &str) -> bool {
    folder.starts_with('/') && folder.len() <= FOLDER_MAX && !folder.chars().any(char::is_control)
}

fn color_ok(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

#[derive(Default)]
struct Held {
    single: Option<RemoteSingle>,
    /// Counts each change, so a connection sends it again only when it moved on.
    version: u64,
}

/// What the window last said of its One project.
#[derive(Default)]
pub struct Board {
    held: Mutex<Held>,
}

impl Board {
    /// Takes in what the window says, in place of what it said before. A folder that isn't a whole path is taken as none.
    pub fn set(&self, w: Option<WindowSingle>) {
        let single = w.filter(|w| folder_ok(&w.folder)).map(|w| {
            let name = std::path::Path::new(&w.folder).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| w.folder.clone());
            RemoteSingle { project: w.folder, name, color: w.color.filter(|c| color_ok(c)) }
        });
        let mut held = self.held.lock().unwrap();
        if held.single != single {
            held.version += 1;
            held.single = single;
        }
    }

    /// The One project as a phone is sent it, and its version (0: the window hasn't said one yet).
    pub fn phone(&self) -> (Option<RemoteSingle>, u64) {
        let held = self.held.lock().unwrap();
        (held.single.clone(), held.version)
    }

    pub fn version(&self) -> u64 {
        self.held.lock().unwrap().version
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(folder: &str, color: Option<&str>) -> Option<WindowSingle> {
        Some(WindowSingle { folder: folder.into(), color: color.map(String::from) })
    }

    #[test]
    fn keeps_a_whole_path_names_it_as_a_chat_is_and_drops_a_colour_that_isnt_one() {
        let b = Board::default();
        assert_eq!(b.phone(), (None, 0));
        b.set(said("/w/lumiform-ios", Some("#0f8a7e")));
        assert_eq!(b.phone(), (Some(RemoteSingle { project: "/w/lumiform-ios".into(), name: "lumiform-ios".into(), color: Some("#0f8a7e".into()) }), 1));
        b.set(said("/w/lumiform-ios", Some("red; background:url(x)")));
        assert_eq!(b.phone().0.unwrap().color, None);
        // Not a folder's whole path, or more than one line: none.
        for bad in ["relative", "/w/a\nb", &format!("/{}", "a".repeat(FOLDER_MAX))] {
            b.set(said(bad, None));
            assert_eq!(b.phone().0, None, "{bad:?}");
        }
    }

    #[test]
    fn moves_on_only_when_it_changed() {
        let b = Board::default();
        b.set(None);
        assert_eq!(b.version(), 0, "none, as before: nothing to send");
        b.set(said("/w/a", None));
        b.set(said("/w/a", None));
        assert_eq!(b.version(), 1);
        b.set(None);
        assert_eq!(b.phone(), (None, 2));
    }
}
