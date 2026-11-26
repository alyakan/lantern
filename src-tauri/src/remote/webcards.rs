//! The work web Claude sent that waits for the user's Run, for a phone (see webclaude/). The app tells the backend each time the
//! cards change; a phone that shows them is sent them, and may Run or Decline one, which the app does as the Mac's card would.

use super::protocol::RemoteWebCard;
use std::sync::Mutex;

/// The most cards kept (the connector lets no more than ten wait). Each message goes whole (the connector takes no more than 20,000
/// characters): a Run on the phone runs exactly what the phone showed.
const CARDS_MAX: usize = 20;

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

impl WebBoard {
    /// Takes in the cards waiting now, in place of those before.
    pub fn set(&self, cards: Vec<RemoteWebCard>) {
        let cards: Vec<RemoteWebCard> = cards.into_iter().take(CARDS_MAX).collect();
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
    fn the_version_moves_only_when_the_cards_change_and_messages_go_whole() {
        let b = WebBoard::default();
        assert_eq!(b.phone().1, 0);
        b.set(vec![card("a", "m")]);
        b.set(vec![card("a", "m")]);
        assert_eq!(b.phone().1, 1);
        assert!(b.waits("a") && !b.waits("b"));
        // What a Run runs is what the phone was shown: never a cut message.
        b.set(vec![card("b", &"x".repeat(crate::webclaude::store::MESSAGE_MAX))]);
        let (cards, version) = b.phone();
        assert_eq!((version, cards[0].message.chars().count()), (2, crate::webclaude::store::MESSAGE_MAX));
    }
}
