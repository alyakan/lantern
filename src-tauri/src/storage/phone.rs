//! What a paired phone may see of Storage and clear from it: the Mac's disk, and the items a scan found safe to clear.
//!
//! The phone never says what is safe, and never sends a path. It sends the ids of the items it was shown, and the Mac keeps only
//! those that are safe in its own last scan *now* (the same items the Storage tab ticks, of the kinds below), then deletes them
//! the way the tab's Delete does (each checked again at that moment: see clean.rs). Whatever a phone sends beyond that, a
//! Review or Blocked item, a project, the Trash, is ignored.

use super::{free_bytes, now_secs, total_bytes, Item, Kind, Removal, Risk, Storage};
use serde::Serialize;
use std::sync::Arc;

/// The kinds of item a phone may clear. What comes back by itself (a cache, build output, a simulator's data) or is in git
/// (a worktree with nothing unsaved). Not a stale project (it goes to the Trash with its ignored files), not the Trash (that is
/// for good) and not a download: those stay for the Storage tab on the Mac.
const KINDS: [Kind; 4] = [Kind::Worktree, Kind::BuildOutput, Kind::Cache, Kind::Simulator];

/// How old the scan may be for a phone to clear from it: a list the user saw an hour ago may not be what is on the disk now.
const FRESH_MS: u64 = 60 * 60 * 1000;

/// How many items a phone is sent (the biggest); the rest are counted and left for the Storage tab.
pub const MAX_ITEMS: usize = 60;

/// How a phone's last clear went.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Report {
    pub ok: usize,
    pub failed: usize,
    /// What the items that went took on disk when they were scanned.
    pub freed: u64,
    /// When it finished (ms since the epoch).
    pub at: u64,
}

/// What a phone is shown.
#[derive(Clone, Debug, Serialize, Default)]
pub struct PhoneView {
    pub free_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub scanned_at: Option<u64>,
    pub scanning: bool,
    pub progress: String,
    /// A clear (the Storage tab's or a phone's) is running.
    pub deleting: bool,
    /// The biggest safe items, at most MAX_ITEMS.
    pub items: Vec<Item>,
    /// How many safe items there are beyond those.
    pub more: usize,
    pub report: Option<Report>,
}

/// The items in `items` a phone may clear: safe and ticked by the scan, of a kind in KINDS, and not inside another such item
/// (a worktree takes what is inside it along, so it would be counted twice).
pub fn clearable(items: &[Item]) -> Vec<Item> {
    let safe: Vec<&Item> = items.iter().filter(|i| i.risk == Risk::Safe && i.ticked && KINDS.contains(&i.kind)).collect();
    let mut out: Vec<Item> = safe.iter().filter(|i| i.within.as_ref().is_none_or(|w| !safe.iter().any(|o| &o.id == w))).map(|i| (*i).clone()).collect();
    out.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.id.cmp(&b.id)));
    out
}

/// The word a phone is told a kind by.
pub fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Worktree => "worktree",
        Kind::Repo => "repo",
        Kind::BuildOutput => "build_output",
        Kind::Cache => "cache",
        Kind::Simulator => "simulator",
        Kind::Download => "download",
        Kind::Trash => "trash",
    }
}

/// Whether removing `item` moves it to the Trash, which takes no space back until the Trash is emptied.
pub fn to_trash(item: &Item) -> bool {
    item.removal == Removal::Trash
}

impl Storage {
    /// What a phone is shown now.
    pub fn phone_view(&self) -> PhoneView {
        let inner = self.lock();
        let all = clearable(&inner.items);
        let more = all.len().saturating_sub(MAX_ITEMS);
        PhoneView {
            free_bytes: free_bytes(&self.home),
            total_bytes: total_bytes(&self.home),
            scanned_at: inner.scanned_at,
            scanning: inner.scanning,
            progress: inner.progress.clone(),
            deleting: inner.deleting,
            items: all.into_iter().take(MAX_ITEMS).collect(),
            more,
            report: inner.report.clone(),
        }
    }

    /// Takes the items among `ids` that are safe to clear now (see `clearable`) as snapshots, and marks the Storage as deleting, in one
    /// step under the lock: from here until the clear ends no scan, tab delete or other clear can run, so what is removed is
    /// exactly what was found safe here, and not whatever a rescan made of the same ids meanwhile. Refused while a scan or a delete
    /// runs, for a scan older than an hour, and when none of the ids is safe. The caller must remove them (`finish_phone_clear`).
    fn begin_phone_clear(&self, ids: &[String]) -> Result<Vec<Item>, String> {
        let mut inner = self.lock();
        if inner.scanning || inner.deleting {
            return Err("Your Mac is busy with a scan or a clear. Try again in a moment.".into());
        }
        let fresh = inner.scanned_at.is_some_and(|t| (now_secs() as u64 * 1000).saturating_sub(t) <= FRESH_MS);
        if !fresh {
            return Err("The scan is old. Scan again, then clear.".into());
        }
        let safe = clearable(&inner.items);
        let mut picked: Vec<Item> = Vec::new();
        for id in ids {
            if picked.iter().any(|i| &i.id == id) {
                continue;
            }
            if let Some(item) = safe.iter().find(|i| &i.id == id) {
                picked.push(item.clone());
            }
        }
        if picked.is_empty() {
            return Err("Nothing on that list is safe to clear any more. Scan again.".into());
        }
        inner.deleting = true;
        inner.report = None;
        Ok(picked)
    }

    /// Removes what `begin_phone_clear` took, writes down how it went (before `deleting` ends, so a phone that sees it end sees the
    /// report), and ends the clear.
    fn finish_phone_clear(&self, picked: Vec<Item>, path_env: Option<&str>) {
        let _clear = super::Deleting(self);
        let done = self.remove_picked(picked, path_env);
        let report = Report { ok: done.iter().filter(|o| o.ok).count(), failed: done.iter().filter(|o| !o.ok).count(), freed: done.iter().filter(|o| o.ok).map(|o| o.freed).sum(), at: now_secs() as u64 * 1000 };
        self.lock().report = Some(report);
    }

    /// Starts clearing the items with these ids that are safe to clear now, in the background: it can take minutes (a worktree, a
    /// simulator's runtime), so this returns at once with how many and about how many bytes, and the phone watches `phone_view`.
    pub fn phone_clear(self: &Arc<Self>, ids: &[String], path_env: Option<String>) -> Result<(usize, u64), String> {
        let picked = self.begin_phone_clear(ids)?;
        (self.changed)();
        let (count, bytes) = (picked.len(), picked.iter().map(|i| i.bytes).sum());
        let me = self.clone();
        std::thread::spawn(move || me.finish_phone_clear(picked, path_env.as_deref()));
        Ok((count, bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn item(id: &str, kind: Kind, bytes: u64) -> Item {
        let mut i = Item::new(kind, Path::new(&format!("/x/{id}")), id.to_string(), bytes, Removal::Permanent, "note");
        i.id = id.to_string();
        i.ticked = true;
        i
    }

    #[test]
    fn only_safe_ticked_items_of_the_phone_kinds_are_offered_biggest_first() {
        let mut review = item("review", Kind::Cache, 900);
        review.risk = Risk::Review;
        let mut blocked = item("blocked", Kind::Worktree, 900);
        blocked.risk = Risk::Blocked;
        let mut unticked = item("unticked", Kind::Cache, 900);
        unticked.ticked = false;
        let items = vec![item("small", Kind::Cache, 10), item("big", Kind::BuildOutput, 500), review, blocked, unticked, item("sim", Kind::Simulator, 50), item("tree", Kind::Worktree, 70)];
        assert_eq!(clearable(&items).iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["big", "tree", "sim", "small"]);
    }

    #[test]
    fn a_stale_project_the_trash_and_a_download_are_left_for_the_mac() {
        let items = vec![item("repo", Kind::Repo, 9000), item("trash", Kind::Trash, 8000), item("dl", Kind::Download, 7000), item("cache", Kind::Cache, 1)];
        assert_eq!(clearable(&items).iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["cache"]);
    }

    #[test]
    fn what_is_inside_an_offered_worktree_is_not_offered_again() {
        let tree = item("tree", Kind::Worktree, 1000);
        let mut inside = item("inside", Kind::BuildOutput, 400);
        inside.within = Some("tree".into());
        // Inside something that is not offered (a Review worktree), it is offered on its own.
        let mut review = item("review", Kind::Worktree, 100);
        review.risk = Risk::Review;
        let mut inside_review = item("inside-review", Kind::BuildOutput, 300);
        inside_review.within = Some("review".into());
        let ids: Vec<String> = clearable(&[tree, inside, review, inside_review]).into_iter().map(|i| i.id).collect();
        assert_eq!(ids, ["tree", "inside-review"]);
    }

    fn storage_with(items: Vec<Item>, scanned_at: Option<u64>) -> Arc<Storage> {
        let s = Arc::new(Storage::new(std::env::temp_dir(), || {}, Vec::new));
        let mut inner = s.lock();
        inner.items = items;
        inner.scanned_at = scanned_at;
        drop(inner);
        s
    }

    fn now_ms() -> u64 {
        now_secs() as u64 * 1000
    }

    #[test]
    fn a_clear_refuses_an_old_scan_and_a_list_with_nothing_safe_on_it() {
        let old = storage_with(vec![item("a", Kind::Cache, 5)], Some(now_ms() - 2 * 60 * 60 * 1000));
        assert!(old.phone_clear(&["a".into()], None).unwrap_err().contains("old"));
        let never = storage_with(vec![item("a", Kind::Cache, 5)], None);
        assert!(never.phone_clear(&["a".into()], None).is_err());
        let fresh = storage_with(vec![item("a", Kind::Cache, 5)], Some(now_ms()));
        let err = fresh.phone_clear(&["not-there".into()], None).unwrap_err();
        assert!(err.contains("safe to clear"), "{err}");
        assert!(!fresh.phone_view().deleting, "a refusal starts nothing");
    }

    #[test]
    fn a_clear_takes_only_what_is_safe_now_of_what_the_phone_sent() {
        let mut review = item("review", Kind::Cache, 800);
        review.risk = Risk::Review;
        let s = storage_with(vec![item("a", Kind::Cache, 5), review, item("repo", Kind::Repo, 700)], Some(now_ms()));
        // The phone names a Review item and a project too: neither is touched, and the count and bytes say so.
        let (count, bytes) = s.phone_clear(&["a".into(), "review".into(), "repo".into(), "a".into()], None).unwrap();
        assert_eq!((count, bytes), (1, 5));
    }

    #[test]
    fn once_a_clear_has_taken_its_items_no_scan_other_clear_or_tab_delete_can_start_until_it_ends() {
        let s = storage_with(vec![item("a", Kind::Cache, 5), item("b", Kind::Cache, 6)], Some(now_ms()));
        let picked = s.begin_phone_clear(&["a".into()]).unwrap();
        assert_eq!(picked.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["a"]);
        assert!(s.phone_view().deleting);
        // A rescan (the tab's, Claude's, another phone's), another clear and the tab's Delete are all refused meanwhile.
        assert!(!s.start_scan(None), "a scan started in the middle of a clear");
        assert!(s.begin_phone_clear(&["b".into()]).is_err());
        assert!(s.delete(&["b".into()], None).is_err());
    }

    #[test]
    fn what_is_removed_is_what_was_safe_when_the_clear_began_not_what_the_ids_mean_afterwards() {
        let s = storage_with(vec![item("a", Kind::Cache, 5)], Some(now_ms()));
        let picked = s.begin_phone_clear(&["a".into()]).unwrap();
        // The item turns into one that needs a look, as a rescan would show it (the same id, now Review).
        {
            let mut inner = s.lock();
            inner.items[0].risk = Risk::Review;
        }
        assert_eq!((picked[0].risk, picked[0].ticked), (Risk::Safe, true), "the clear holds what it found, a snapshot");
        // And a clear started now, by the same id, refuses it.
        s.lock().deleting = false;
        assert!(s.begin_phone_clear(&["a".into()]).unwrap_err().contains("safe to clear"));
    }

    #[test]
    fn the_report_is_there_by_the_time_the_clear_is_over() {
        let s = storage_with(vec![item("gone", Kind::Cache, 5)], Some(now_ms()));
        let picked = s.begin_phone_clear(&["gone".into()]).unwrap();
        s.finish_phone_clear(picked, None);
        let v = s.phone_view();
        assert!(!v.deleting);
        let report = v.report.expect("a report");
        // The path is made up, so there was nothing there to remove: it counts as cleared, as for the tab, and frees nothing.
        assert_eq!((report.ok, report.failed, report.freed), (1, 0, 0));
    }

    #[test]
    fn the_view_gives_the_biggest_and_counts_the_rest() {
        let items: Vec<Item> = (0..MAX_ITEMS + 7).map(|n| item(&format!("i{n:03}"), Kind::Cache, 1000 + n as u64)).collect();
        let s = storage_with(items, Some(now_ms()));
        let v = s.phone_view();
        assert_eq!((v.items.len(), v.more), (MAX_ITEMS, 7));
        assert!(v.items[0].bytes > v.items[MAX_ITEMS - 1].bytes);
        assert!(v.total_bytes.unwrap() >= v.free_bytes.unwrap());
    }

    #[test]
    fn a_trashed_item_says_so() {
        let mut i = item("a", Kind::Worktree, 5);
        i.removal = Removal::Trash;
        assert!(to_trash(&i));
        assert!(!to_trash(&item("b", Kind::Cache, 5)));
    }
}
