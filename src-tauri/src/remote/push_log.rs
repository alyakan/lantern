//! A short log of what the Mac did about each push: sent and what Apple answered, or why nothing was sent. Pushes fail
//! quietly otherwise (no push key, a phone that is watching, an Apple error), and nothing else says so.
//!
//! One line per push, never a token, a key, a chat's words or its title. Kept in `push.log` in the app's data folder,
//! cut back to its last half when it passes `MAX_BYTES`.
//!
//! `SLEEP` is the same kind of log for chats put to sleep (`sleep.log`): which chat, what it looked like to the window and
//! to the hub when it was, so that a chat that slept while it worked can be told from one that was only idle.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const MAX_BYTES: u64 = 64 * 1024;

/// A log file: where it lives is set once at launch, and a line is added with the time.
pub struct Log {
    path: OnceLock<PathBuf>,
    write: Mutex<()>,
}

static PUSH: Log = Log::new();
pub static SLEEP: Log = Log::new();

/// Where the push log is kept (the app sets it once at launch; without it nothing is written, as in tests).
pub fn set_path(path: PathBuf) {
    PUSH.set_path(path);
}

/// `YYYY-MM-DD HH:MM:SS` in UTC, from seconds since 1970.
fn stamp(secs: u64) -> String {
    let (days, rest) = (secs / 86_400, secs % 86_400);
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02} UTC", rest / 3_600, rest % 3_600 / 60, rest % 60)
}

impl Log {
    const fn new() -> Self {
        Self { path: OnceLock::new(), write: Mutex::new(()) }
    }

    pub fn set_path(&self, path: PathBuf) {
        let _ = self.path.set(path);
    }

    /// Adds one line. A log that can't be written is not worth failing what it describes for.
    pub fn note(&self, line: &str) {
        let Some(path) = self.path.get() else { return };
        let _guard = self.write.lock().unwrap_or_else(|e| e.into_inner());
        if std::fs::metadata(path).is_ok_and(|m| m.len() > MAX_BYTES) {
            if let Ok(text) = std::fs::read_to_string(path) {
                let keep = text.len() / 2;
                let from = text[keep..].find('\n').map_or(text.len(), |i| keep + i + 1);
                let _ = std::fs::write(path, &text[from..]);
            }
        }
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{} {line}", stamp(super::now_ms() / 1000));
        }
    }
}

/// Adds one line to the push log.
pub fn note(line: &str) {
    PUSH.note(line);
}

#[cfg(test)]
mod tests {
    use super::{stamp, Log};

    #[test]
    fn a_log_keeps_its_lines_and_writes_nothing_until_it_has_a_place() {
        let log = Log::new();
        log.note("before a path is set");
        let path = std::env::temp_dir().join(format!("lantern-sleep-log-test-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&path);
        log.set_path(path.clone());
        log.note("hub slot=s1 asleep while working=true");
        log.note("window slot=s1 why=idle");
        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with(" UTC hub slot=s1 asleep while working=true"));
        assert!(lines[1].ends_with(" UTC window slot=s1 why=idle"));
    }

    #[test]
    fn a_time_is_written_as_a_utc_date_and_clock() {
        assert_eq!(stamp(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(stamp(1_700_000_000), "2023-11-14 22:13:20 UTC");
        assert_eq!(stamp(1_793_007_349), "2026-10-26 09:35:49 UTC");
        // The day after a leap day.
        assert_eq!(stamp(1_709_251_200), "2024-03-01 00:00:00 UTC");
    }
}
