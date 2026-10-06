//! Lantern updating itself from its published GitHub releases. A newer version is downloaded and verified in the
//! background, then waits: the user restarts onto it from the chat box, or it installs when Lantern quits. Nothing here
//! ever restarts the app on its own, since that would stop every chat's claude.

use std::sync::Mutex;

/// Installs a downloaded update over the running app (it takes effect on the next launch).
pub type Install = Box<dyn FnOnce() -> Result<(), String> + Send>;

/// What the UI is told about a ready update.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct UpdateInfo {
    pub version: String,
}

struct Ready {
    version: String,
    install: Install,
}

/// The update waiting to be installed, if any.
#[derive(Default)]
pub struct Updates {
    ready: Mutex<Option<Ready>>,
}

impl Updates {
    /// A downloaded, verified update and how to install it. A newer one found later replaces it.
    pub fn offer(&self, version: String, install: Install) {
        *self.ready.lock().unwrap() = Some(Ready { version, install });
    }

    pub fn ready(&self) -> Option<UpdateInfo> {
        self.ready.lock().unwrap().as_ref().map(|r| UpdateInfo { version: r.version.clone() })
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

/// Looks for a newer release a little after launch, then every few hours, until one is downloaded.
pub async fn watch(app: tauri::AppHandle) {
    use tauri::Manager;
    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    loop {
        if app.state::<Updates>().ready().is_none() {
            // Offline, GitHub down, a bad signature: nothing to tell the user; the next check tries again.
            if let Err(e) = check(&app).await {
                eprintln!("Lantern update check failed: {e}");
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(4 * 60 * 60)).await;
    }
}

/// Downloads a newer release if there is one (the plugin checks its signature against the app's public key), keeps
/// it ready, and tells the window.
async fn check(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    use tauri_plugin_updater::UpdaterExt;
    let Some(update) = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())? else { return Ok(()) };
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    let version = update.version.clone();
    app.state::<Updates>().offer(version.clone(), Box::new(move || update.install(bytes).map_err(|e| e.to_string())));
    let _ = app.emit("update-ready", UpdateInfo { version });
    Ok(())
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
        updates.offer("0.1.2".into(), counting(&installs));
        assert_eq!(updates.ready(), Some(UpdateInfo { version: "0.1.2".into() }));
        assert_eq!(updates.install(), Ok("0.1.2".into()));
        assert_eq!(installs.load(Ordering::SeqCst), 1);
        // Restarting to update ends in a quit, which mustn't install it a second time.
        assert!(updates.install().is_err());
        assert_eq!(installs.load(Ordering::SeqCst), 1);
        assert_eq!(updates.ready(), None);
    }

    #[test]
    fn a_newer_download_replaces_the_one_waiting() {
        let updates = Updates::default();
        let first = Arc::new(AtomicUsize::new(0));
        let second = Arc::new(AtomicUsize::new(0));
        updates.offer("0.1.2".into(), counting(&first));
        updates.offer("0.1.3".into(), counting(&second));
        assert_eq!(updates.install(), Ok("0.1.3".into()));
        assert_eq!((first.load(Ordering::SeqCst), second.load(Ordering::SeqCst)), (0, 1));
    }

    #[test]
    fn a_failed_install_says_why() {
        let updates = Updates::default();
        updates.offer("0.1.2".into(), Box::new(|| Err("disk full".into())));
        assert_eq!(updates.install(), Err("Couldn't install Lantern 0.1.2: disk full".into()));
    }

    #[test]
    #[cfg(debug_assertions)]
    fn development_builds_never_check() {
        assert!(!checks_enabled());
    }
}
