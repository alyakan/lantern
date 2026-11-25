//! Antigravity's limits, as a usage reading like Codex's. ACP itself says nothing of them (its `usage_update` is the context
//! window), but `agy acp` runs a language server on localhost, and that server's `RetrieveUserQuotaSummary` answers with each
//! group of models' 5-hour and weekly buckets: how much is left, and when it refreshes. Its port is random; `agy` writes it in
//! its own log, `~/.gemini/antigravity-cli/log/acp-server-<time>-<pid>.log`.
//!
//! What `agy` 1.5.15 answered (trimmed):
//! `{"response":{"groups":[{"displayName":"Gemini Models","buckets":[{"bucketId":"gemini-weekly","window":"weekly",
//! "remainingFraction":0.604,"resetTime":"2026-12-01T09:32:47Z"},{"bucketId":"gemini-5h","window":"5h","remainingFraction":1,
//! "resetTime":"2026-11-25T15:00:50Z"}]},{"displayName":"Claude and GPT models","buckets":[...]}]}}`

use crate::ui_event::{ProviderUsage, UsageWindow};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The provider id the reading is kept under (the Mac's and the phone's usage lists name it "Antigravity").
pub const PROVIDER: &str = "antigravity";

/// A reading is a nicety: asked once, briefly, and given up on quietly.
const WAIT: Duration = Duration::from_secs(3);

/// Where `agy` keeps its logs.
fn log_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".gemini/antigravity-cli/log")
}

/// The port of the plain-HTTP language server the `agy` process `pid` started, as its log says. None until it has said it.
pub fn port_of(pid: u32) -> Option<u16> {
    port_in_dir(&log_dir(), pid)
}

fn port_in_dir(dir: &Path, pid: u32) -> Option<u16> {
    let suffix = format!("-{pid}.log");
    // The newest, should an older run have had the same process id (its name starts with when it started).
    let file = std::fs::read_dir(dir).ok()?.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("acp-server-") && n.ends_with(&suffix))).max()?;
    port_in(&std::fs::read_to_string(file).ok()?)
}

/// "Language server listening on random port at 59961 for HTTP" (not the "for HTTPS (gRPC)" line beside it).
fn port_in(log: &str) -> Option<u16> {
    log.lines().find_map(|line| {
        let rest = line.split("listening on random port at ").nth(1)?;
        let (port, what) = rest.split_once(' ')?;
        (what.trim_end() == "for HTTP").then(|| port.parse().ok()).flatten()
    })
}

/// Asks the language server on `port` for the limits; None if it doesn't answer, or answers with nothing that reads as one.
pub async fn read(port: u16) -> Option<ProviderUsage> {
    // reqwest won't build a client without one, even for plain HTTP (as linear.rs and endpoints.rs do).
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    // Only ever this machine's own server, never through a proxy.
    let client =reqwest::Client::builder().timeout(WAIT).no_proxy().redirect(reqwest::redirect::Policy::none()).build().ok()?;
    let reply = client
        .post(format!("http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary"))
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", "1")
        .body("{}")
        .send()
        .await
        .ok()?;
    if !reply.status().is_success() {
        return None;
    }
    let body: Value = reply.json().await.ok()?;
    usage_of(&body, now())
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
}

/// The summary as a reading: each group's windows, named by the group ("Gemini · 5 hours", "Claude & GPT · Week") since the
/// groups' limits are separate, each group's shortest first (its session, then its week, as Claude's are). Used is what isn't
/// left. None when no bucket says how much is left.
pub fn usage_of(summary: &Value, now: u64) -> Option<ProviderUsage> {
    let groups = summary["response"]["groups"].as_array()?;
    let windows: Vec<UsageWindow> = groups
        .iter()
        .flat_map(|g| {
            let group = group_name(g["displayName"].as_str().unwrap_or(""));
            let mut own: Vec<UsageWindow> = g["buckets"].as_array().into_iter().flatten().filter_map(|b| {
                let left = b["remainingFraction"].as_f64().filter(|f| f.is_finite())?;
                let (minutes, span) = match b["window"].as_str() {
                    Some("5h") => (Some(300), "5 hours".to_string()),
                    Some("weekly") => (Some(10080), "Week".to_string()),
                    Some(other) if !other.is_empty() => (None, other.to_string()),
                    _ => (None, b["displayName"].as_str().unwrap_or("Limit").to_string()),
                };
                let label = if group.is_empty() { span } else { format!("{group} · {span}") };
                Some(UsageWindow { label, used: (1.0 - left).clamp(0.0, 1.0), resets_at: b["resetTime"].as_str().and_then(epoch_of), minutes })
            }).collect();
            own.sort_by_key(|w| w.minutes.unwrap_or(u32::MAX));
            own
        })
        .collect();
    (!windows.is_empty()).then(|| ProviderUsage { provider: PROVIDER.into(), windows, updated_at: now })
}

/// "Gemini Models" is "Gemini", "Claude and GPT models" is "Claude & GPT".
fn group_name(display: &str) -> String {
    let trimmed = display.trim();
    let name = if trimmed.to_lowercase().ends_with(" models") { &trimmed[..trimmed.len() - " models".len()] } else { trimmed };
    name.replace(" and ", " & ")
}

/// "2026-12-01T09:32:47Z" (fractions of a second allowed) as seconds since 1970; anything else, None.
fn epoch_of(text: &str) -> Option<u64> {
    let t = text.strip_suffix('Z')?;
    let (date, time) = t.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let time = time.split('.').next()?;
    let mut c = time.split(':').map(|p| p.parse::<i64>().ok());
    let (h, min, s) = (c.next()??, c.next()??, c.next()??);
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) || h > 23 || min > 59 || s > 60 {
        return None;
    }
    // Days from 1970-01-01 to the date (Howard Hinnant's days_from_civil).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    u64::try_from(days * 86400 + h * 3600 + min * 60 + s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn summary() -> Value {
        json!({"response": {"groups": [
            {"displayName": "Gemini Models", "buckets": [
                {"bucketId": "gemini-weekly", "displayName": "Weekly Limit Remaining", "window": "weekly", "remainingFraction": 0.60421795, "resetTime": "2026-12-01T09:32:47Z"},
                {"bucketId": "gemini-5h", "displayName": "Five Hour Limit Remaining", "window": "5h", "remainingFraction": 1, "resetTime": "2026-11-25T15:00:50Z"}
            ]},
            {"displayName": "Claude and GPT models", "buckets": [
                {"bucketId": "3p-weekly", "window": "weekly", "remainingFraction": 1},
                {"bucketId": "3p-5h", "window": "5h", "remainingFraction": 0.25}
            ]}
        ]}})
    }

    #[test]
    fn each_group_s_session_then_week_are_windows_named_by_the_group_with_what_is_used() {
        let u = usage_of(&summary(), 42).unwrap();
        assert_eq!(u.provider, "antigravity");
        assert_eq!(u.updated_at, 42);
        let got: Vec<_> = u.windows.iter().map(|w| (w.label.as_str(), (w.used * 100.0).round() as u32, w.minutes, w.resets_at)).collect();
        assert_eq!(got, [("Gemini · 5 hours", 0, Some(300), Some(1_795_618_850)), ("Gemini · Week", 40, Some(10080), Some(1_796_117_567)), ("Claude & GPT · 5 hours", 75, Some(300), None), ("Claude & GPT · Week", 0, Some(10080), None)]);
    }

    #[test]
    fn a_summary_with_nothing_left_to_read_is_no_reading() {
        assert!(usage_of(&json!({}), 1).is_none());
        assert!(usage_of(&json!({"response": {"groups": []}}), 1).is_none());
        assert!(usage_of(&json!({"response": {"groups": [{"displayName": "Gemini Models", "buckets": [{"window": "5h", "remainingFraction": "lots"}]}]}}), 1).is_none());
    }

    #[test]
    fn reset_times_are_read_as_utc_seconds_and_anything_else_is_unknown() {
        assert_eq!(epoch_of("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(epoch_of("2000-03-01T00:00:00Z"), Some(951_868_800));
        assert_eq!(epoch_of("2026-11-25T15:00:50.123Z"), Some(1_795_618_850));
        assert_eq!(epoch_of("2026-11-25T15:00:50+01:00"), None);
        assert_eq!(epoch_of("soon"), None);
        assert_eq!(epoch_of("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn the_port_is_the_plain_http_one_agy_logs_for_its_own_process() {
        let log = "I1125 12:00:10.827801 10 server.go:1290] Language server will attempt to listen on host localhost\n\
                   I1125 12:00:10.830165 10 server.go:1305] Language server listening on random port at 59960 for HTTPS (gRPC)\n\
                   I1125 12:00:10.830361 10 server.go:1313] Language server listening on random port at 59961 for HTTP\n";
        assert_eq!(port_in(log), Some(59961));
        assert_eq!(port_in("nothing yet"), None);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("acp-server-20261125_120010-73428.log"), log).unwrap();
        std::fs::write(dir.path().join("acp-server-20261125_115945-7342.log"), "Language server listening on random port at 1 for HTTP").unwrap();
        // An older run with the same process id: the newest log is the one.
        std::fs::write(dir.path().join("acp-server-20260101_090000-73428.log"), "Language server listening on random port at 2 for HTTP").unwrap();
        assert_eq!(port_in_dir(dir.path(), 73428), Some(59961));
        assert_eq!(port_in_dir(dir.path(), 999), None);
    }
}
