//! Your work, for a phone. The window works out where each piece of the user's work stands (lib/yourWork.ts: git, GitHub and Linear are
//! asked on the Mac) and tells the backend; a phone is sent it to show, and may ask for one of its steps, which the window does.
//!
//! The window is trusted for what it says, but what it says is kept small and plain: so many items, each word cut short, only the
//! stages and states the phone draws, and a link only when it is an https page on GitHub or Linear.

use super::protocol::{RemoteWork, RemoteWorkItem, RemoteWorkNext, RemoteWorkStack};
use serde::Deserialize;
use std::sync::Mutex;

/// The most items kept, and the longest key.
const ITEMS_MAX: usize = 150;
const KEY_MAX: usize = 240;
/// The most repositories named as ones whose owner GitHub didn't say.
const BLIND_MAX: usize = 5;

const STAGES: &[&str] = &["issue", "local", "pr", "checks", "review", "merge", "release"];
const TONES: &[&str] = &["bad", "wait", "you", "move", "local", "todo", "ready", "done"];
const FOLDS: &[&str] = &["ready", "done"];

/// What the window says of the user's work: the shape the phone is sent, checked and cut here.
#[derive(Debug, Clone, Deserialize)]
pub struct WindowWork {
    pub issues: bool,
    #[serde(default)]
    pub looked: bool,
    #[serde(default)]
    pub blind: Vec<String>,
    pub items: Vec<RemoteWorkItem>,
}

#[derive(Default)]
struct Held {
    work: RemoteWork,
    /// Counts each change, so a connection sends the work again only when it moved on.
    version: u64,
}

/// What the window last said of the user's work.
#[derive(Default)]
pub struct WorkBoard {
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

fn cut_opt(text: Option<String>, max: usize) -> Option<String> {
    text.map(|t| cut(&t, max)).filter(|t| !t.is_empty())
}

fn key_ok(key: &str) -> bool {
    !key.is_empty() && key.len() <= KEY_MAX && !key.chars().any(char::is_control)
}

/// A link a phone may open: https on GitHub or Linear, a plain URL with nothing a phone could take for something else.
pub fn link_ok(url: &str) -> bool {
    let rest = url.strip_prefix("https://github.com/").or_else(|| url.strip_prefix("https://linear.app/"));
    url.len() <= 300 && rest.is_some_and(|r| !r.is_empty()) && !url.chars().any(|c| c.is_control() || c.is_whitespace() || c == '\\' || c == '@')
}

fn tidy(item: RemoteWorkItem) -> Option<RemoteWorkItem> {
    if !key_ok(&item.key) || !STAGES.contains(&item.stage.as_str()) || !TONES.contains(&item.tone.as_str()) {
        return None;
    }
    Some(RemoteWorkItem {
        key: item.key,
        repo: cut(&item.repo, 60),
        title: cut(&item.title, 160),
        stage: item.stage,
        tone: item.tone,
        word: cut(&item.word, 60),
        meta: cut(&item.meta, 200),
        at: item.at,
        number: item.number,
        feature: cut_opt(item.feature, 80),
        issue: cut_opt(item.issue, 40),
        url: item.url.filter(|u| link_ok(u)),
        sig: cut(&item.sig, 80),
        step_only: item.step_only,
        fold: item.fold.filter(|f| FOLDS.contains(&f.as_str())),
        next: item.next.map(|n| RemoteWorkNext { what: cut(&n.what, 80), yours: n.yours, button: cut(&n.button, 20), warn: n.warn }),
        issue_url: item.issue_url.filter(|u| link_ok(u)),
        branch: cut_opt(item.branch, 120),
        stack: item.stack.filter(|s| s.pos >= 1 && s.pos <= s.of && s.of <= 50).map(|s| RemoteWorkStack { id: s.id, pos: s.pos, of: s.of, on: s.on }),
    })
}

impl WorkBoard {
    /// Takes in what the window says, in place of what it said before. An item with no proper key, stage or state is left out.
    pub fn set(&self, w: WindowWork) {
        let mut seen = std::collections::HashSet::new();
        let items: Vec<RemoteWorkItem> = w.items.into_iter().filter_map(tidy).filter(|i| seen.insert(i.key.clone())).take(ITEMS_MAX).collect();
        let blind: Vec<String> = w.blind.iter().map(|r| cut(r, 60)).filter(|r| !r.is_empty()).take(BLIND_MAX).collect();
        let work = RemoteWork { issues: w.issues, looked: w.looked, blind, items };
        let mut held = self.held.lock().unwrap();
        if held.work != work {
            held.version += 1;
        }
        held.work = work;
    }

    /// The work as a phone is sent it, and its version.
    pub fn phone(&self) -> (RemoteWork, u64) {
        let held = self.held.lock().unwrap();
        (held.work.clone(), held.version)
    }

    pub fn version(&self) -> u64 {
        self.held.lock().unwrap().version
    }

    /// The item `key`, as the window last said it.
    pub fn find(&self, key: &str) -> Option<RemoteWorkItem> {
        self.held.lock().unwrap().work.items.iter().find(|i| i.key == key).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(key: &str) -> RemoteWorkItem {
        RemoteWorkItem {
            key: key.into(),
            repo: "lantern".into(),
            title: "Fix\nit".into(),
            stage: "checks".into(),
            tone: "bad".into(),
            word: "Checks failing".into(),
            meta: "lantern · {ago}".into(),
            at: Some(5),
            number: Some(7),
            feature: Some("Sync".into()),
            issue: Some("ENG-1".into()),
            url: Some("https://github.com/aly/lantern/pull/7".into()),
            sig: "checks:Checks failing".into(),
            step_only: false,
            fold: None,
            next: Some(RemoteWorkNext { what: "Fix failing checks on".into(), yours: false, button: "Do it".into(), warn: false }),
            issue_url: Some("https://linear.app/a/issue/ENG-1".into()),
            branch: Some("aly/eng-1".into()),
            stack: None,
        }
    }

    #[test]
    fn keeps_a_stack_place_that_makes_sense_and_only_a_linear_or_github_issue_link() {
        let b = WorkBoard::default();
        let mut on = item("k-on");
        on.stack = Some(RemoteWorkStack { id: 4, pos: 2, of: 3, on: Some(4) });
        let mut odd = item("k-odd");
        odd.stack = Some(RemoteWorkStack { id: 4, pos: 5, of: 3, on: None });
        odd.issue_url = Some("javascript:alert(1)".into());
        b.set(WindowWork { issues: true, looked: true, blind: vec![], items: vec![on, odd] });
        let items = b.phone().0.items;
        assert_eq!(items[0].stack, Some(RemoteWorkStack { id: 4, pos: 2, of: 3, on: Some(4) }));
        assert_eq!((items[0].issue_url.as_deref(), items[0].branch.as_deref()), (Some("https://linear.app/a/issue/ENG-1"), Some("aly/eng-1")));
        assert_eq!((items[1].stack.as_ref(), items[1].issue_url.as_ref()), (None, None));
    }

    #[test]
    fn keeps_only_the_folds_a_phone_draws_and_reads_a_window_that_does_not_say_them() {
        let b = WorkBoard::default();
        let mut ready = item("k-ready");
        ready.fold = Some("ready".into());
        let mut odd = item("k-odd");
        odd.fold = Some("loud".into());
        b.set(WindowWork { issues: true, looked: true, blind: vec![], items: vec![ready, odd] });
        let items = b.phone().0.items;
        assert_eq!(items[0].fold.as_deref(), Some("ready"));
        assert_eq!(items[1].fold, None, "a kind of fold this phone doesn't know is left plain");
        // An older window says neither a fold nor whether a step goes around a rule.
        let older: WindowWork = serde_json::from_str(r#"{"issues":true,"items":[{"key":"k","repo":"r","title":"t","stage":"merge","tone":"you","word":"w","meta":"m","at":null,"number":null,"feature":null,"issue":null,"url":null,"sig":"s","step_only":false,"next":{"what":"Merge","yours":true,"button":"Merge…"}}]}"#).unwrap();
        b.set(older);
        let item = &b.phone().0.items[0];
        assert_eq!(item.fold, None);
        assert!(!item.next.as_ref().unwrap().warn);
    }

    #[test]
    fn keeps_what_the_window_says_small_and_drops_what_the_phone_cannot_draw() {
        let b = WorkBoard::default();
        let mut bad_stage = item("k-stage");
        bad_stage.stage = "elsewhere".into();
        let mut bad_tone = item("k-tone");
        bad_tone.tone = "loud".into();
        let mut long = item("k-long");
        long.title = "x".repeat(400);
        let mut items = vec![item("k1"), item("k1"), item(""), bad_stage, bad_tone, long];
        items.extend((0..200).map(|i| item(&format!("n{i}"))));
        b.set(WindowWork { issues: true, looked: true, blind: vec![], items });
        let (work, version) = b.phone();
        assert_eq!(version, 1);
        assert!(work.issues);
        assert_eq!(work.items.len(), ITEMS_MAX);
        assert_eq!(work.items[0].key, "k1");
        assert_eq!(work.items[0].title, "Fix it", "one line");
        assert_eq!(work.items.iter().filter(|i| i.key == "k1").count(), 1, "a key is listed once");
        assert!(work.items.iter().all(|i| i.stage != "elsewhere" && i.tone != "loud" && !i.key.is_empty()));
        assert_eq!(work.items[1].key, "k-long");
        assert_eq!(work.items[1].title.chars().count(), 160);
        assert!(b.find("k1").is_some() && b.find("nowhere").is_none());
    }

    #[test]
    fn a_link_is_an_https_page_on_github_or_linear_and_nothing_else() {
        for ok in ["https://github.com/aly/lantern/pull/7", "https://linear.app/team/issue/ENG-1/title"] {
            assert!(link_ok(ok), "{ok}");
        }
        for bad in [
            "http://github.com/aly/lantern",
            "https://github.com.evil.example/x",
            "https://github.com@evil.example/x",
            "https://evil.example/https://github.com/",
            "javascript:alert(1)",
            "https://github.com/",
            "https://github.com/a b",
            "https://github.com/a\\b",
            "https://linear.app/\u{0}x",
            "ssh://github.com/x",
        ] {
            assert!(!link_ok(bad), "{bad}");
        }
        let mut i = item("k");
        i.url = Some("https://evil.example/x".into());
        let b = WorkBoard::default();
        b.set(WindowWork { issues: false, looked: true, blind: vec![], items: vec![i] });
        assert_eq!(b.phone().0.items[0].url, None);
    }

    #[test]
    fn says_whether_the_window_looked_and_which_repositories_it_could_not_tell_the_owner_of_cut_small() {
        let b = WorkBoard::default();
        assert!(!b.phone().0.looked, "nothing is known before the window says");
        b.set(WindowWork { issues: false, looked: true, blind: (0..9).map(|i| format!("repo-{i}\n{}", "x".repeat(100))).collect(), items: vec![] });
        let (work, _) = b.phone();
        assert!(work.looked);
        assert_eq!(work.blind.len(), BLIND_MAX);
        assert!(work.blind.iter().all(|r| r.chars().count() <= 60 && !r.contains('\n')));
        let from_an_older_window: WindowWork = serde_json::from_str(r#"{"issues":false,"items":[]}"#).unwrap();
        b.set(from_an_older_window);
        assert!(!b.phone().0.looked, "a window that doesn't say hasn't looked");
    }

    #[test]
    fn moves_on_only_when_what_a_phone_sees_changed() {
        let b = WorkBoard::default();
        b.set(WindowWork { issues: false, looked: true, blind: vec![], items: vec![item("k1")] });
        b.set(WindowWork { issues: false, looked: true, blind: vec![], items: vec![item("k1")] });
        assert_eq!(b.version(), 1);
        b.set(WindowWork { issues: false, looked: true, blind: vec![], items: vec![item("k1"), item("k2")] });
        assert_eq!(b.version(), 2);
        b.set(WindowWork { issues: true, looked: true, blind: vec![], items: vec![item("k1"), item("k2")] });
        assert_eq!(b.version(), 3);
    }
}
