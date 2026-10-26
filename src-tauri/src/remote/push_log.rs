//! A short log of what the Mac did about each push: sent and what Apple answered, or why nothing was sent. Pushes fail
//! quietly otherwise (no push key, a phone that is watching, an Apple error), and nothing else says so.
//!
//! One line per push, never a token, a key, a chat's words or its title. Kept in `push.log` in the app's data folder,
//! cut back to its last half when it passes `MAX_BYTES`.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const MAX_BYTES: u64 = 64 * 1024;

static PATH: OnceLock<PathBuf> = OnceLock::new();
static WRITE: Mutex<()> = Mutex::new(());

/// Where the log is kept (the app sets it once at launch; without it nothing is written, as in tests).
pub fn set_path(path: PathBuf) {
    let _ = PATH.set(path);
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

/// Adds one line. A log that can't be written is not worth failing a push for.
pub fn note(line: &str) {
    let Some(path) = PATH.get() else { return };
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
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

#[cfg(test)]
mod tests {
    use super::stamp;

    #[test]
    fn a_time_is_written_as_a_utc_date_and_clock() {
        assert_eq!(stamp(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(stamp(1_700_000_000), "2023-11-14 22:13:20 UTC");
        assert_eq!(stamp(1_793_007_349), "2026-10-26 09:35:49 UTC");
        // The day after a leap day.
        assert_eq!(stamp(1_709_251_200), "2024-03-01 00:00:00 UTC");
    }
}
