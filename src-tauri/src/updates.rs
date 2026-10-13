//! Lantern updating itself from its published GitHub releases. A newer version is downloaded and verified in the
//! background, then waits: the user restarts onto it from the chat box, or it installs when Lantern quits. Nothing here
//! ever restarts the app on its own, since that would stop every chat's claude.

use std::sync::Mutex;

/// Installs a downloaded update over the running app (it takes effect on the next launch).
pub type Install = Box<dyn FnOnce() -> Result<(), String> + Send>;

/// What the UI is told about a ready update. `notes` is the release's body (its "What's new"), as the release published
/// it; the update's manifest carries it, so it's known before the update is installed.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct UpdateInfo {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Where updating has got to, told to the window as it happens (the `update-state` event) so it can show it.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateState {
    /// Nothing has been looked for yet, or a background look found nothing worth mentioning.
    #[default]
    Idle,
    Checking,
    UpToDate,
    /// `total` is None when the server doesn't say how big it is.
    Downloading { version: String, downloaded: u64, total: Option<u64> },
    Ready {
        version: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        notes: Option<String>,
    },
    Installing { version: String },
    Restarting,
    Failed { error: String },
}

struct Ready {
    version: String,
    notes: Option<String>,
    install: Install,
}

/// The update waiting to be installed, if any, and how updating is going.
#[derive(Default)]
pub struct Updates {
    ready: Mutex<Option<Ready>>,
    state: Mutex<UpdateState>,
    /// Held for as long as a check, and the download it leads to, takes: only one at a time.
    checking: tokio::sync::Mutex<()>,
}

impl Updates {
    pub fn state(&self) -> UpdateState {
        self.state.lock().unwrap().clone()
    }

    fn remember(&self, state: UpdateState) {
        *self.state.lock().unwrap() = state;
    }

    /// Starts a check, unless one is already under way (the background one, partway through a download): then it's
    /// the state that check has reached, so a second ask shows its progress instead of waiting for it.
    fn begin_check(&self) -> Result<tokio::sync::MutexGuard<'_, ()>, UpdateState> {
        self.checking.try_lock().map_err(|_| self.state())
    }

    /// A downloaded, verified update and how to install it. A newer one found later replaces it.
    pub fn offer(&self, version: String, notes: Option<String>, install: Install) {
        *self.ready.lock().unwrap() = Some(Ready { version, notes, install });
    }

    pub fn ready(&self) -> Option<UpdateInfo> {
        self.ready.lock().unwrap().as_ref().map(|r| UpdateInfo { version: r.version.clone(), notes: r.notes.clone() })
    }

    /// Installs the waiting update, once, and returns its version.
    pub fn install(&self) -> Result<String, String> {
        let ready = self.ready.lock().unwrap().take().ok_or("No update has been downloaded.")?;
        (ready.install)().map_err(|e| format!("Couldn't install Lantern {}: {e}", ready.version))?;
        Ok(ready.version)
    }
}

/// Development builds never look for updates: they'd offer to replace the build being worked on.
pub fn checks_enabled() -> bool {
    !cfg!(debug_assertions)
}

/// Tells the window where updating has got to, and remembers it for a window that asks later.
pub fn publish(app: &tauri::AppHandle, state: UpdateState) {
    use tauri::{Emitter, Manager};
    app.state::<Updates>().remember(state.clone());
    let _ = app.emit("update-state", state);
}

/// Looks for a newer release a little after launch, then every few hours, until one is downloaded.
pub async fn watch(app: tauri::AppHandle) {
    use tauri::Manager;
    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    loop {
        if app.state::<Updates>().ready().is_none() {
            // Offline, GitHub down, a bad signature: nothing to tell the user; the next check tries again.
            if let Err(e) = check(&app, false).await {
                eprintln!("Lantern update check failed: {e}");
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(4 * 60 * 60)).await;
    }
}

/// Downloads a newer release if there is one (the plugin checks its signature against the app's public key), keeps
/// it ready, and tells the window each step. `manual`: the user asked, so a failure stays on screen; otherwise it's
/// forgotten, since nobody was waiting. If a check is already under way, this returns where it has got to.
pub async fn check(app: &tauri::AppHandle, manual: bool) -> Result<UpdateState, String> {
    use tauri::Manager;
    let updates = app.state::<Updates>();
    let _running = match updates.begin_check() {
        Ok(guard) => guard,
        Err(state) => return Ok(state),
    };
    if let Some(info) = updates.ready() {
        return Ok(UpdateState::Ready { version: info.version, notes: info.notes });
    }
    publish(app, UpdateState::Checking);
    match download_newer(app).await {
        Ok(state) => {
            publish(app, state.clone());
            Ok(state)
        }
        Err(error) => {
            publish(app, if manual { UpdateState::Failed { error: error.clone() } } else { UpdateState::Idle });
            Err(error)
        }
    }
}

async fn download_newer(app: &tauri::AppHandle) -> Result<UpdateState, String> {
    use tauri::{Emitter, Manager};
    use tauri_plugin_updater::UpdaterExt;
    let Some(update) = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())? else { return Ok(UpdateState::UpToDate) };
    let version = update.version.clone();
    let notes = update.body.clone();
    publish(app, UpdateState::Downloading { version: version.clone(), downloaded: 0, total: None });
    let mut progress = Progress::default();
    let bytes = update
        .download(
            |chunk, total| {
                if let Some((downloaded, total)) = progress.advance(chunk, total) {
                    publish(app, UpdateState::Downloading { version: version.clone(), downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    app.state::<Updates>().offer(version.clone(), notes.clone(), Box::new(move || update.install(bytes).map_err(|e| e.to_string())));
    let _ = app.emit("update-ready", UpdateInfo { version: version.clone(), notes: notes.clone() });
    Ok(UpdateState::Ready { version, notes })
}

/// Turns the downloader's call per chunk into a few updates for the window: one per percent when the size is known,
/// otherwise one per 256 KiB, and always one when the download is complete.
#[derive(Default)]
pub struct Progress {
    downloaded: u64,
    reported: u64,
}

impl Progress {
    /// What to tell the window after another `chunk` bytes, if it's worth a message: the bytes so far and the total.
    pub fn advance(&mut self, chunk: usize, total: Option<u64>) -> Option<(u64, Option<u64>)> {
        self.downloaded += chunk as u64;
        let step = match total {
            Some(t) if t >= 100 => t / 100,
            _ => 256 * 1024,
        };
        let finished = total.is_some_and(|t| self.downloaded >= t);
        if self.downloaded - self.reported >= step || (finished && self.downloaded > self.reported) {
            self.reported = self.downloaded;
            return Some((self.downloaded, total));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn counting(count: &Arc<AtomicUsize>) -> Install {
        let count = count.clone();
        Box::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }

    #[test]
    fn with_nothing_downloaded_there_is_nothing_to_install() {
        let updates = Updates::default();
        assert_eq!(updates.ready(), None);
        assert_eq!(updates.install(), Err("No update has been downloaded.".into()));
    }

    #[test]
    fn a_downloaded_update_is_reported_then_installed_once() {
        let updates = Updates::default();
        let installs = Arc::new(AtomicUsize::new(0));
        updates.offer("0.1.2".into(), None, counting(&installs));
        assert_eq!(updates.ready(), Some(UpdateInfo { version: "0.1.2".into(), notes: None }));
        assert_eq!(updates.install(), Ok("0.1.2".into()));
        assert_eq!(installs.load(Ordering::SeqCst), 1);
        // Restarting to update ends in a quit, which mustn't install it a second time.
        assert!(updates.install().is_err());
        assert_eq!(installs.load(Ordering::SeqCst), 1);
        assert_eq!(updates.ready(), None);
    }

    #[test]
    fn the_release_notes_of_a_waiting_update_are_kept_until_it_is_installed() {
        let updates = Updates::default();
        let installs = Arc::new(AtomicUsize::new(0));
        updates.offer("0.1.3".into(), Some("## What's new\n\n- Faster search".into()), counting(&installs));
        assert_eq!(updates.ready().and_then(|u| u.notes), Some("## What's new\n\n- Faster search".into()));
        assert_eq!(updates.install(), Ok("0.1.3".into()));
        assert_eq!(updates.ready(), None);
    }

    #[test]
    fn a_newer_download_replaces_the_one_waiting() {
        let updates = Updates::default();
        let first = Arc::new(AtomicUsize::new(0));
        let second = Arc::new(AtomicUsize::new(0));
        updates.offer("0.1.2".into(), None, counting(&first));
        updates.offer("0.1.3".into(), None, counting(&second));
        assert_eq!(updates.install(), Ok("0.1.3".into()));
        assert_eq!((first.load(Ordering::SeqCst), second.load(Ordering::SeqCst)), (0, 1));
    }

    #[test]
    fn a_failed_install_says_why() {
        let updates = Updates::default();
        updates.offer("0.1.2".into(), None, Box::new(|| Err("disk full".into())));
        assert_eq!(updates.install(), Err("Couldn't install Lantern 0.1.2: disk full".into()));
    }

    #[test]
    #[cfg(debug_assertions)]
    fn development_builds_never_check() {
        assert!(!checks_enabled());
    }

    #[test]
    fn the_state_reaches_the_window_tagged_by_kind() {
        let json = |s: UpdateState| serde_json::to_string(&s).unwrap();
        assert_eq!(json(UpdateState::Checking), r#"{"kind":"checking"}"#);
        assert_eq!(json(UpdateState::UpToDate), r#"{"kind":"up_to_date"}"#);
        assert_eq!(json(UpdateState::Downloading { version: "0.1.3".into(), downloaded: 5, total: Some(10) }), r#"{"kind":"downloading","version":"0.1.3","downloaded":5,"total":10}"#);
        assert_eq!(json(UpdateState::Downloading { version: "0.1.3".into(), downloaded: 5, total: None }), r#"{"kind":"downloading","version":"0.1.3","downloaded":5,"total":null}"#);
        assert_eq!(json(UpdateState::Ready { version: "0.1.3".into(), notes: None }), r#"{"kind":"ready","version":"0.1.3"}"#);
        assert_eq!(json(UpdateState::Ready { version: "0.1.3".into(), notes: Some("- Faster".into()) }), r#"{"kind":"ready","version":"0.1.3","notes":"- Faster"}"#);
        assert_eq!(serde_json::to_string(&UpdateInfo { version: "0.1.3".into(), notes: None }).unwrap(), r#"{"version":"0.1.3"}"#);
        assert_eq!(json(UpdateState::Installing { version: "0.1.3".into() }), r#"{"kind":"installing","version":"0.1.3"}"#);
        assert_eq!(json(UpdateState::Failed { error: "offline".into() }), r#"{"kind":"failed","error":"offline"}"#);
        assert_eq!(UpdateState::default(), UpdateState::Idle);
    }

    #[test]
    fn a_second_check_while_one_runs_gets_where_it_has_got_to() {
        let updates = Updates::default();
        let first = updates.begin_check();
        assert!(first.is_ok());
        updates.remember(UpdateState::Downloading { version: "0.1.3".into(), downloaded: 40, total: Some(100) });
        assert_eq!(updates.begin_check().err(), Some(UpdateState::Downloading { version: "0.1.3".into(), downloaded: 40, total: Some(100) }));
        // Once the first is over, the next one starts.
        drop(first);
        assert!(updates.begin_check().is_ok());
    }

    #[test]
    fn progress_is_reported_about_once_per_percent_and_when_it_completes() {
        let mut progress = Progress::default();
        let total = Some(10_000u64);
        let mut told = vec![];
        for _ in 0..1000 {
            if let Some((downloaded, _)) = progress.advance(10, total) {
                told.push(downloaded);
            }
        }
        // 100 bytes is a percent of 10 000: a hundred messages for a thousand chunks, ending at the total.
        assert_eq!(told.len(), 100);
        assert_eq!(told.first(), Some(&100));
        assert_eq!(told.last(), Some(&10_000));
    }

    #[test]
    fn progress_without_a_known_size_is_reported_every_256_kib_and_a_short_download_still_finishes() {
        let mut progress = Progress::default();
        assert_eq!(progress.advance(100 * 1024, None), None);
        assert_eq!(progress.advance(100 * 1024, None), None);
        assert_eq!(progress.advance(100 * 1024, None), Some((300 * 1024, None)));
        // A tiny file: a total below a hundred bytes isn't split into percents, and still ends with a message.
        let mut small = Progress::default();
        assert_eq!(small.advance(10, Some(40)), None);
        assert_eq!(small.advance(30, Some(40)), Some((40, Some(40))));
        assert_eq!(small.advance(0, Some(40)), None);
    }
}
