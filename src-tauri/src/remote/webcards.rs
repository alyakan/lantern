//! The work web Claude sent that waits for the user's Run, for a phone (see webclaude/). The app tells the backend each time the
//! cards change; a phone that shows them is sent them, and may Run or Decline one, which the app does as the Mac's card would.

use super::protocol::RemoteWebCard;
use std::sync::Mutex;

/// The most cards kept (the connector lets no more than ten wait), and the longest message a phone is sent.
const CARDS_MAX: usize = 20;
const MESSAGE_MAX: usize = 4_000;

#[derive(Default)]
struct Held {
    cards: Vec<RemoteWebCard>,
    /// Counts each change, so a connection sends the cards again only when they moved on.
    version: u64,
}

/// The cards as the app last said them.
#[derive(Default)]
pub struct WebBoard {
    held: Mutex<Held>,
}

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(max.saturating_sub(1)).collect::<String>())
    }
}

impl WebBoard {
    /// Takes in the cards waiting now, in place of those before.
    pub fn set(&self, cards: Vec<RemoteWebCard>) {
        let cards: Vec<RemoteWebCard> = cards.into_iter().take(CARDS_MAX).map(|c| RemoteWebCard { message: cut(&c.message, MESSAGE_MAX), ..c }).collect();
        let mut held = self.held.lock().unwrap();
        if held.cards != cards {
            held.version += 1;
        }
        held.cards = cards;
    }

    /// The cards as a phone is sent them, and their version (0: none said yet).
    pub fn phone(&self) -> (Vec<RemoteWebCard>, u64) {
        let held = self.held.lock().unwrap();
        (held.cards.clone(), held.version)
    }

    /// Whether `id` is a card waiting now.
    pub fn waits(&self, id: &str) -> bool {
        self.held.lock().unwrap().cards.iter().any(|c| c.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: &str, message: &str) -> RemoteWebCard {
        RemoteWebCard { id: id.into(), title: "Rayak".into(), canvas: String::new(), message: message.into(), project: None, project_name: None, answer: false, chat: None, at: 1 }
    }

    #[test]
    fn the_version_moves_only_when_the_cards_change_and_long_messages_are_cut() {
        let b = WebBoard::default();
        assert_eq!(b.phone().1, 0);
        b.set(vec![card("a", "m")]);
        b.set(vec![card("a", "m")]);
        assert_eq!(b.phone().1, 1);
        assert!(b.waits("a") && !b.waits("b"));
        b.set(vec![card("b", &"x".repeat(MESSAGE_MAX + 5))]);
        let (cards, version) = b.phone();
        assert_eq!((version, cards[0].message.chars().count()), (2, MESSAGE_MAX));
    }
}
