use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::ErrorKind;

/// Remembers each edited file's content from before Claude's first edit to it, for the whole session and for the
/// latest turn.
#[derive(Default)]
pub struct ChangeTracker {
    originals: HashMap<String, Option<String>>,
    /// How files stood when each turn began (every file tracked by then, plus files first edited during it), oldest
    /// first. The last is the latest turn's.
    turns: Vec<HashMap<String, Option<String>>>,
    /// How the folder was when the chat started, to catch files changed outside Claude's edits (a `cp`, a download).
    outside: Option<std::sync::Arc<crate::outside::Baseline>>,
}

/// Which baseline the Changes pane compares against.
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// Since the chat started (or the session was opened).
    #[default]
    Session,
    /// Since the last message was sent.
    Turn,
    /// Everything uncommitted in git, whoever changed it (read from git, not this tracker).
    Git,
    /// A GitHub pull request's files against its base (read from git, see pr.rs).
    Pr,
    /// The checked-out branch's commits against where it left the default branch (read from git, see pr.rs).
    Branch,
}

fn read_text(path: &str) -> Option<String> {
    std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// A changed file as it stands on disk now, compared with its original.
#[derive(Debug, PartialEq, Serialize)]
pub struct ChangeSummary {
    pub path: String,
    pub created: bool,
    pub deleted: bool,
    pub added: usize,
    pub removed: usize,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct FileDiff {
    pub path: String,
    pub original: String,
    pub current: String,
    pub created: bool,
    pub deleted: bool,
}

impl ChangeTracker {
    /// `original` is None when the edit created the file. Only the first call per path counts.
    pub fn record(&mut self, path: &str, original: Option<String>) {
        if let Some(turn) = self.turns.last_mut() {
            turn.entry(path.to_string()).or_insert_with(|| original.clone());
        }
        self.originals.entry(path.to_string()).or_insert(original);
    }

    pub fn clear(&mut self) {
        self.originals.clear();
        self.turns.clear();
    }

    /// From now on, compare the folder with `baseline` too (see `scan`).
    pub fn watch(&mut self, baseline: crate::outside::Baseline) {
        self.outside = Some(std::sync::Arc::new(baseline));
    }

    /// What a scan needs, so it can run (git, a folder walk) without holding the tracker: the baseline and the paths
    /// already tracked.
    pub fn scan_inputs(&self) -> Option<(std::sync::Arc<crate::outside::Baseline>, std::collections::HashSet<String>)> {
        Some((self.outside.clone()?, self.originals.keys().cloned().collect()))
    }

    /// Adds what a scan found: files that changed on disk without a tool edit, new ones as created, edited or deleted
    /// ones with their content from before. A file Claude edited meanwhile keeps the original it recorded.
    pub fn add_found(&mut self, found: Vec<(String, Option<String>)>) {
        for (path, original) in found {
            if !self.originals.contains_key(&path) {
                self.record(&path, original);
            }
        }
    }

    #[cfg(test)]
    fn scan(&mut self) {
        if let Some((baseline, known)) = self.scan_inputs() {
            self.add_found(baseline.changes(|p| known.contains(p)));
        }
    }

    /// Refills the tracker from a replayed session: `edits` in order, the last `edits.len() - last_turn_from` of them
    /// made in its last turn, whose baseline is each file as it stood before that turn's first edit to it.
    /// The replayed last turn becomes turn 0.
    pub fn restore(&mut self, edits: Vec<(String, Option<String>)>, last_turn_from: usize) {
        self.clear();
        let mut last = HashMap::new();
        for (i, (path, original)) in edits.into_iter().enumerate() {
            if i >= last_turn_from {
                last.entry(path.clone()).or_insert_with(|| original.clone());
            }
            self.originals.entry(path).or_insert(original);
        }
        self.turns.push(last);
    }

    /// A turn is starting: its baseline is every tracked file as it is on disk now. Returns the turn's number.
    pub fn start_turn(&mut self) -> usize {
        self.turns.push(self.originals.keys().map(|p| (p.clone(), read_text(p))).collect());
        self.turns.len() - 1
    }

    /// For a range of turns, each file as it was at the first of them that knew it.
    fn baseline(&self, scope: Scope, turn: Option<usize>, to_turn: Option<usize>) -> Option<std::borrow::Cow<'_, HashMap<String, Option<String>>>> {
        use std::borrow::Cow;
        match (scope, turn) {
            (Scope::Git | Scope::Pr | Scope::Branch, _) => None,
            (Scope::Session, _) => Some(Cow::Borrowed(&self.originals)),
            (Scope::Turn, None) => self.turns.last().map(Cow::Borrowed),
            (Scope::Turn, Some(n)) => {
                let first = self.turns.get(n)?;
                let end = to_turn.unwrap_or(n).min(self.turns.len() - 1);
                if end <= n {
                    return Some(Cow::Borrowed(first));
                }
                let mut merged = first.clone();
                for later in &self.turns[n + 1..=end] {
                    for (path, original) in later {
                        merged.entry(path.clone()).or_insert_with(|| original.clone());
                    }
                }
                Some(Cow::Owned(merged))
            }
        }
    }

    /// A file as it was when `turn` ended: at the next turn's start, or on disk now if `turn` is the latest.
    fn after(&self, path: &str, turn: Option<usize>) -> Option<String> {
        match turn.and_then(|n| self.turns.get(n + 1)) {
            Some(next) => next.get(path).cloned().flatten(),
            None => read_text(path),
        }
    }

    /// Every tracked file that still differs from its original, with line counts from a real diff. Files that are back
    /// to their original (reverted, or created and then deleted) are left out, whoever changed them since:
    /// a shell command, git, or the user.
    /// `turn`: with Scope::Turn, which turn (the latest when None); `to_turn`, the last turn of a range starting there
    /// (a Step-by-step page can span several). An earlier turn ends where the next one began.
    pub fn summary(&self, scope: Scope, turn: Option<usize>, to_turn: Option<usize>) -> Vec<ChangeSummary> {
        let Some(baseline) = self.baseline(scope, turn, to_turn) else { return vec![] };
        let turn = turn.filter(|_| scope == Scope::Turn).map(|t| to_turn.unwrap_or(t).max(t));
        let mut out: Vec<ChangeSummary> = baseline
            .iter()
            .filter_map(|(path, original)| {
                let current = self.after(path, turn);
                if &current == original {
                    return None;
                }
                let (old, new) = (original.as_deref().unwrap_or(""), current.as_deref().unwrap_or(""));
                let (mut added, mut removed) = (0, 0);
                for change in similar::TextDiff::from_lines(old, new).iter_all_changes() {
                    match change.tag() {
                        similar::ChangeTag::Insert => added += 1,
                        similar::ChangeTag::Delete => removed += 1,
                        similar::ChangeTag::Equal => {}
                    }
                }
                Some(ChangeSummary { path: path.clone(), created: original.is_none(), deleted: current.is_none(), added, removed })
            })
            .collect();
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out
    }

    pub fn diff(&self, path: &str, scope: Scope, turn: Option<usize>, to_turn: Option<usize>) -> Result<FileDiff, String> {
        let baseline = self.baseline(scope, turn, to_turn);
        let original = baseline.as_ref().and_then(|b| b.get(path)).ok_or_else(|| format!("{path} has no recorded changes"))?;
        let end = turn.map(|t| to_turn.unwrap_or(t).max(t));
        let earlier_turn = end.filter(|n| scope == Scope::Turn && n + 1 < self.turns.len());
        let current = match earlier_turn {
            Some(_) => self.after(path, earlier_turn),
            None => match std::fs::read(path) {
                Ok(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
                Err(e) if e.kind() == ErrorKind::NotFound => None,
                Err(e) => return Err(format!("Could not read {path}: {e}")),
            },
        };
        Ok(FileDiff {
            path: path.to_string(),
            original: original.clone().unwrap_or_default(),
            created: original.is_none(),
            deleted: current.is_none(),
            current: current.unwrap_or_default(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_original_wins() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        std::fs::write(&path, "v3").unwrap();
        let p = path.to_str().unwrap();
        let mut t = ChangeTracker::default();
        t.record(p, Some("v1".into()));
        t.record(p, Some("v2".into()));
        assert_eq!(t.diff(p, Scope::Session, None, None).unwrap(), FileDiff { path: p.into(), original: "v1".into(), current: "v3".into(), created: false, deleted: false });
    }

    #[test]
    fn created_file_has_empty_original() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.txt");
        std::fs::write(&path, "fresh").unwrap();
        let p = path.to_str().unwrap();
        let mut t = ChangeTracker::default();
        t.record(p, None);
        t.record(p, Some("fresh".into()));
        let d = t.diff(p, Scope::Session, None, None).unwrap();
        assert!(d.created);
        assert_eq!(d.original, "");
        assert_eq!(d.current, "fresh");
    }

    #[test]
    fn deleted_file_reports_deleted() {
        let mut t = ChangeTracker::default();
        t.record("/definitely/not/here.txt", Some("old".into()));
        let d = t.diff("/definitely/not/here.txt", Scope::Session, None, None).unwrap();
        assert!(d.deleted);
        assert_eq!(d.current, "");
    }

    #[test]
    fn summary_counts_from_disk_and_drops_files_back_to_their_original() {
        let dir = tempfile::tempdir().unwrap();
        let p = |name: &str| dir.path().join(name).to_str().unwrap().to_string();
        std::fs::write(p("edited.txt"), "a\nB\nc\nd\n").unwrap();
        std::fs::write(p("reverted.txt"), "same\n").unwrap();
        let mut t = ChangeTracker::default();
        t.record(&p("edited.txt"), Some("a\nb\nc\n".into()));
        t.record(&p("reverted.txt"), Some("same\n".into()));
        t.record(&p("created-then-deleted.txt"), None);
        t.record(&p("deleted.txt"), Some("gone\n".into()));
        let s = t.summary(Scope::Session, None, None);
        assert_eq!(s.iter().map(|c| c.path.rsplit('/').next().unwrap()).collect::<Vec<_>>(), vec!["deleted.txt", "edited.txt"]);
        assert_eq!(s[1], ChangeSummary { path: p("edited.txt"), created: false, deleted: false, added: 2, removed: 1 });
        assert!(s[0].deleted && s[0].removed == 1);
    }

    #[test]
    fn unknown_path_is_an_error_and_clear_forgets() {
        let mut t = ChangeTracker::default();
        assert!(t.diff("/x", Scope::Session, None, None).is_err());
        t.record("/x", None);
        t.clear();
        assert!(t.diff("/x", Scope::Session, None, None).is_err());
        assert!(t.diff("/x", Scope::Turn, None, None).is_err());
    }

    #[test]
    fn a_restored_session_s_last_turn_holds_only_that_turn_s_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = |name: &str| dir.path().join(name).to_str().unwrap().to_string();
        std::fs::write(p("a.txt"), "a2\n").unwrap();
        std::fs::write(p("b.txt"), "b2\n").unwrap();
        let mut t = ChangeTracker::default();
        // Earlier turn: a.txt edited. Last turn: b.txt edited twice, a.txt edited again.
        t.restore(vec![(p("a.txt"), Some("a0\n".into())), (p("b.txt"), Some("b0\n".into())), (p("b.txt"), Some("b1\n".into())), (p("a.txt"), Some("a1\n".into()))], 1);
        let names = |s: Vec<ChangeSummary>| s.into_iter().map(|c| c.path.rsplit('/').next().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(names(t.summary(Scope::Session, None, None)), vec!["a.txt", "b.txt"]);
        assert_eq!(names(t.summary(Scope::Turn, None, None)), vec!["a.txt", "b.txt"]);
        assert_eq!(t.diff(&p("a.txt"), Scope::Turn, None, None).unwrap().original, "a1\n");
        assert_eq!(t.diff(&p("a.txt"), Scope::Session, None, None).unwrap().original, "a0\n");
        assert_eq!(t.diff(&p("b.txt"), Scope::Turn, None, None).unwrap().original, "b0\n");
        // Nothing edited in the last turn: it's empty, while the session still has everything.
        t.restore(vec![(p("a.txt"), Some("a0\n".into()))], 1);
        assert!(t.summary(Scope::Turn, None, None).is_empty());
        assert_eq!(names(t.summary(Scope::Session, None, None)), vec!["a.txt"]);
    }

    #[test]
    fn an_earlier_turn_shows_what_it_changed_up_to_where_the_next_turn_began() {
        let dir = tempfile::tempdir().unwrap();
        let p = |name: &str| dir.path().join(name).to_str().unwrap().to_string();
        let mut t = ChangeTracker::default();
        let names = |s: Vec<ChangeSummary>| s.into_iter().map(|c| c.path.rsplit('/').next().unwrap().to_string()).collect::<Vec<_>>();
        // Turn 0 creates a.txt; turn 1 edits it and creates b.txt; turn 2 changes nothing.
        assert_eq!(t.start_turn(), 0);
        t.record(&p("a.txt"), None);
        std::fs::write(p("a.txt"), "v1\n").unwrap();
        assert_eq!(t.start_turn(), 1);
        t.record(&p("a.txt"), Some("v1\n".into()));
        std::fs::write(p("a.txt"), "v2\n").unwrap();
        t.record(&p("b.txt"), None);
        std::fs::write(p("b.txt"), "b\n").unwrap();
        assert_eq!(t.start_turn(), 2);
        assert_eq!(names(t.summary(Scope::Turn, Some(0), None)), vec!["a.txt"]);
        let d = t.diff(&p("a.txt"), Scope::Turn, Some(0), None).unwrap();
        assert_eq!((d.original.as_str(), d.current.as_str(), d.created), ("", "v1\n", true));
        assert_eq!(names(t.summary(Scope::Turn, Some(1), None)), vec!["a.txt", "b.txt"]);
        let d = t.diff(&p("a.txt"), Scope::Turn, Some(1), None).unwrap();
        assert_eq!((d.original.as_str(), d.current.as_str()), ("v1\n", "v2\n"));
        assert!(t.summary(Scope::Turn, Some(2), None).is_empty());
        // Turns 0 to 1 as one range: a.txt from nothing to v2, and b.txt.
        assert_eq!(names(t.summary(Scope::Turn, Some(0), Some(1))), vec!["a.txt", "b.txt"]);
        let d = t.diff(&p("a.txt"), Scope::Turn, Some(0), Some(1)).unwrap();
        assert_eq!((d.original.as_str(), d.current.as_str()), ("", "v2\n"));
        assert!(t.summary(Scope::Turn, Some(9), None).is_empty());
    }

    #[test]
    fn a_file_copied_in_outside_claudes_edits_shows_as_new() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("old.txt"), "old\n").unwrap();
        let mut t = ChangeTracker::default();
        t.watch(crate::outside::Baseline::take(dir.path()));
        t.start_turn();
        std::fs::write(dir.path().join("copied.txt"), "copied\n").unwrap();
        t.scan();
        let s = t.summary(Scope::Session, None, None);
        assert_eq!(s.len(), 1);
        assert!(s[0].path.ends_with("copied.txt") && s[0].created && s[0].added == 1);
        assert_eq!(t.summary(Scope::Turn, None, None).len(), 1);
        // Scanning again doesn't add it twice.
        t.scan();
        assert_eq!(t.summary(Scope::Session, None, None).len(), 1);
    }

    #[test]
    fn turn_scope_compares_with_how_files_stood_when_the_turn_began() {
        let dir = tempfile::tempdir().unwrap();
        let p = |name: &str| dir.path().join(name).to_str().unwrap().to_string();
        let mut t = ChangeTracker::default();
        // Turn 1 edits a.txt.
        t.start_turn();
        t.record(&p("a.txt"), Some("one\n".into()));
        std::fs::write(p("a.txt"), "one\ntwo\n").unwrap();
        // Turn 2 leaves a.txt alone and creates b.txt.
        t.start_turn();
        t.record(&p("b.txt"), None);
        std::fs::write(p("b.txt"), "new\n").unwrap();
        let names = |s: Vec<ChangeSummary>| s.into_iter().map(|c| c.path.rsplit('/').next().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(names(t.summary(Scope::Session, None, None)), vec!["a.txt", "b.txt"]);
        assert_eq!(names(t.summary(Scope::Turn, None, None)), vec!["b.txt"]);
        // A shell command in the turn changes a.txt too: it shows, compared with how it stood when the turn began.
        std::fs::write(p("a.txt"), "one\ntwo\nthree\n").unwrap();
        assert_eq!(names(t.summary(Scope::Turn, None, None)), vec!["a.txt", "b.txt"]);
        assert_eq!(t.diff(&p("a.txt"), Scope::Turn, None, None).unwrap().original, "one\ntwo\n");
        assert_eq!(t.diff(&p("a.txt"), Scope::Session, None, None).unwrap().original, "one\n");
    }
}
