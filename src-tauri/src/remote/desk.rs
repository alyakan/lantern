//! The Desk, for a phone. The window works out its Desks (lib/desk.ts, lib/desks.ts) and tells the backend what they hold: each
//! Desk's projects and open chats (as the router is shown them, see crate::desk), and the cards of the answers that finished. A
//! phone is sent the Desks and the cards; the chats' lines stay here, for routing a message the phone typed on a Desk.
//!
//! The window is trusted for what it says, but what it says is kept small: so many Desks, cards and chats, each line cut short.

use super::protocol::{RemoteDesk, RemoteDeskCard, RemoteDeskInfo, RemoteProject};
use crate::desk::Candidate;
use serde::Deserialize;
use std::sync::Mutex;

/// The most Desks, cards, projects a Desk lists, and the longest id a Desk or card has.
const DESKS_MAX: usize = 8;
const CARDS_MAX: usize = 60;
const PROJECTS_MAX: usize = 100;
const ID_MAX: usize = 120;

/// What the window says of its Desks.
#[derive(Debug, Clone, Deserialize)]
pub struct WindowDesk {
    pub desks: Vec<WindowDeskInfo>,
    pub cards: Vec<WindowCard>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WindowDeskInfo {
    pub id: String,
    pub name: String,
    pub projects: Vec<WindowProject>,
    /// Its open chats, the last active first.
    pub chats: Vec<Candidate>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WindowProject {
    pub folder: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WindowCard {
    pub key: String,
    pub desk: String,
    pub slot: String,
    pub title: String,
    #[serde(rename = "where")]
    pub project: String,
    pub at: Option<u64>,
    pub asked: String,
    pub auto: bool,
    pub said: String,
    pub outcome: String,
}

/// A Desk's projects (folder, label) and chats, for routing a message typed on it.
pub struct Routing {
    pub chats: Vec<Candidate>,
    pub projects: Vec<(String, String)>,
    /// The first Desk (home) has every project no other Desk has, open or not: `elsewhere` are the other Desks' folders.
    pub home: bool,
    pub elsewhere: Vec<String>,
}

impl Routing {
    /// Whether a past chat in `folder` is one of this Desk's (a search finds only those).
    pub fn has_folder(&self, folder: &str) -> bool {
        if self.home {
            !self.elsewhere.iter().any(|f| f == folder)
        } else {
            self.projects.iter().any(|(f, _)| f == folder)
        }
    }
}

#[derive(Default)]
struct Held {
    phone: RemoteDesk,
    routing: Vec<(String, Routing)>,
    /// Counts each change, so a connection sends the Desk again only when it moved on.
    version: u64,
}

/// What the window last said of its Desks.
#[derive(Default)]
pub struct Board {
    held: Mutex<Held>,
}

/// `text` on one line, at most `max` characters.
fn cut(text: &str, max: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        format!("{}…", flat.chars().take(max.saturating_sub(1)).collect::<String>())
    }
}

fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= ID_MAX && !id.chars().any(char::is_control)
}

impl Board {
    /// Takes in what the window says, in place of what it said before. Nothing is kept of a Desk with no proper id, or a card of a
    /// Desk it didn't list.
    pub fn set(&self, w: WindowDesk) {
        let mut desks: Vec<RemoteDeskInfo> = Vec::new();
        let mut routing = Vec::new();
        for d in w.desks.into_iter().filter(|d| id_ok(&d.id)) {
            if desks.len() >= DESKS_MAX || desks.iter().any(|x| x.id == d.id) {
                continue;
            }
            let chats: Vec<Candidate> = d.chats.into_iter().filter(|c| id_ok(&c.id)).take(crate::desk::CHATS_MAX).collect();
            let projects: Vec<(String, String)> = d.projects.into_iter().filter(|p| p.folder.starts_with('/')).take(PROJECTS_MAX).map(|p| (p.folder, cut(&p.label, 80))).collect();
            desks.push(RemoteDeskInfo {
                id: d.id.clone(),
                name: cut(&d.name, 40),
                slots: chats.iter().map(|c| c.id.clone()).collect(),
                projects: projects.iter().map(|(folder, label)| RemoteProject { id: folder.clone(), name: label.clone() }).collect(),
            });
            routing.push((d.id, Routing { chats, projects, home: false, elsewhere: Vec::new() }));
        }
        // The first is home; what the others have is not home's.
        let all: Vec<(String, Vec<String>)> = routing.iter().map(|(id, r): &(String, Routing)| (id.clone(), r.projects.iter().map(|(f, _)| f.clone()).collect())).collect();
        for (i, (id, r)) in routing.iter_mut().enumerate() {
            r.home = i == 0;
            r.elsewhere = all.iter().filter(|(other, _)| other != id).flat_map(|(_, folders)| folders.clone()).collect();
        }
        let mut cards: Vec<RemoteDeskCard> = w
            .cards
            .into_iter()
            .filter(|c| id_ok(&c.key) && id_ok(&c.slot) && desks.iter().any(|d| d.id == c.desk))
            .map(|c| RemoteDeskCard {
                key: c.key,
                desk: c.desk,
                slot: c.slot,
                title: cut(&c.title, 120),
                project: cut(&c.project, 80),
                at: c.at,
                asked: cut(&c.asked, 160),
                auto: c.auto,
                said: cut(&c.said, 300),
                outcome: if matches!(c.outcome.as_str(), "done" | "failed" | "stopped") { c.outcome } else { "done".into() },
            })
            .collect();
        // The newest: the window lists them oldest first.
        let extra = cards.len().saturating_sub(CARDS_MAX);
        cards.drain(..extra);
        let phone = RemoteDesk { desks, cards };
        let mut held = self.held.lock().unwrap();
        if held.phone != phone {
            held.version += 1;
        }
        held.phone = phone;
        held.routing = routing;
    }

    /// The Desk as a phone is sent it, and its version.
    pub fn phone(&self) -> (RemoteDesk, u64) {
        let held = self.held.lock().unwrap();
        (held.phone.clone(), held.version)
    }

    pub fn version(&self) -> u64 {
        self.held.lock().unwrap().version
    }

    /// The chats and projects of Desk `id`, or None when the window has no such Desk.
    pub fn routing(&self, id: &str) -> Option<Routing> {
        let held = self.held.lock().unwrap();
        held.routing.iter().find(|(d, _)| d == id).map(|(_, r)| Routing { chats: r.chats.clone(), projects: r.projects.clone(), home: r.home, elsewhere: r.elsewhere.clone() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(id: &str) -> Candidate {
        Candidate { id: id.into(), title: "t".into(), project: "lantern".into(), workflow: "chat".into(), status: "idle".into(), last: "x".into() }
    }
    fn desk(id: &str, chats: &[&str]) -> WindowDeskInfo {
        WindowDeskInfo { id: id.into(), name: format!("{id} desk"), projects: vec![WindowProject { folder: format!("/w/{id}"), label: id.into() }, WindowProject { folder: "relative".into(), label: "no".into() }], chats: chats.iter().map(|c| chat(c)).collect() }
    }
    fn card(key: &str, desk: &str) -> WindowCard {
        WindowCard { key: key.into(), desk: desk.into(), slot: "s1".into(), title: "T".into(), project: "lantern".into(), at: Some(1), asked: "a\nb".into(), auto: false, said: "x".repeat(400), outcome: "weird".into() }
    }

    #[test]
    fn keeps_what_the_window_says_small_and_only_of_desks_it_listed() {
        let b = Board::default();
        let mut desks = vec![desk("home", &["s1", "s2"]), desk("", &["s3"]), desk("home", &["s4"])];
        desks.extend((0..10).map(|i| desk(&format!("d{i}"), &[])));
        let mut cards = vec![card("k-gone", "nowhere")];
        cards.extend((0..70).map(|i| card(&format!("k{i}"), "home")));
        b.set(WindowDesk { desks, cards });
        let (phone, version) = b.phone();
        assert_eq!(version, 1);
        assert_eq!(phone.desks.len(), DESKS_MAX);
        assert_eq!(phone.desks[0].slots, vec!["s1", "s2"]);
        // A project that isn't a folder's whole path is left out.
        assert_eq!(phone.desks[0].projects, vec![RemoteProject { id: "/w/home".into(), name: "home".into() }]);
        assert_eq!(phone.cards.len(), CARDS_MAX);
        assert_eq!(phone.cards[0].key, "k10", "the newest");
        assert_eq!(phone.cards[0].asked, "a b");
        assert_eq!(phone.cards[0].said.chars().count(), 300);
        assert_eq!(phone.cards[0].outcome, "done");
        let r = b.routing("home").unwrap();
        assert_eq!(r.chats.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["s1", "s2"]);
        assert_eq!(r.projects, vec![("/w/home".to_string(), "home".to_string())]);
        assert!(b.routing("nowhere").is_none());
        // Home has every folder no other Desk has, open or not; another Desk only its own.
        assert!(r.has_folder("/w/home") && r.has_folder("/w/closed-project") && !r.has_folder("/w/d0"));
        let d0 = b.routing("d0").unwrap();
        assert!(d0.has_folder("/w/d0") && !d0.has_folder("/w/closed-project"));
    }

    #[test]
    fn moves_on_only_when_what_a_phone_sees_changed() {
        let b = Board::default();
        let say = |cards: Vec<WindowCard>| WindowDesk { desks: vec![desk("home", &["s1"])], cards };
        b.set(say(vec![card("k1", "home")]));
        b.set(say(vec![card("k1", "home")]));
        assert_eq!(b.version(), 1);
        b.set(say(vec![card("k1", "home"), card("k2", "home")]));
        assert_eq!(b.version(), 2);
    }
}
