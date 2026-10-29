//! Keeps the window on Lantern's own pages: nothing (whatever button, whatever element) can replace the app with a
//! web page. The app opens links in the browser itself (ExternalLink, with the opener plugin), so a navigation to a
//! web page is refused, not handed to the browser: it may come from an artifact's frame (WebKit asks about every
//! frame's navigations, and doesn't say which frame), and a page that could open URLs could send what it holds out in
//! one.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url};

#[derive(Debug, PartialEq)]
pub enum Navigation {
    /// One of Lantern's own pages, or an artifact in its frame: load it.
    Stay,
    /// Anything else: ignore it.
    Block,
}

/// `dev_url` is where the frontend is served from while developing; it counts as Lantern's own.
pub fn decide(url: &Url, dev_url: Option<&Url>) -> Navigation {
    let ours = match url.scheme() {
        // macOS and Linux serve the app from tauri://localhost.
        "tauri" | "about" => true,
        // The Artifacts tab's frame (see artifacts.rs).
        crate::artifacts::SCHEME => true,
        // Windows serves it from http(s)://tauri.localhost.
        "http" | "https" => url.host_str() == Some("tauri.localhost") || dev_url.is_some_and(|dev| dev.origin() == url.origin()),
        _ => false,
    };
    if ours {
        Navigation::Stay
    } else {
        Navigation::Block
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navigation")
        .on_navigation(|webview, url| {
            let app = webview.app_handle();
            let dev_url = if cfg!(debug_assertions) { app.config().build.dev_url.clone() } else { None };
            decide(url, dev_url.as_ref()) == Navigation::Stay
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn the_app_stays_in_the_window() {
        assert_eq!(decide(&url("tauri://localhost/index.html"), None), Navigation::Stay);
        assert_eq!(decide(&url("http://tauri.localhost/"), None), Navigation::Stay);
        assert_eq!(decide(&url("about:blank"), None), Navigation::Stay);
        let dev = url("http://localhost:1420");
        assert_eq!(decide(&url("http://localhost:1420/src/main.tsx"), Some(&dev)), Navigation::Stay);
    }

    #[test]
    fn artifacts_load_in_their_frame() {
        assert_eq!(decide(&url("lantern-artifact://localhost/0a1b/map.html"), None), Navigation::Stay);
    }

    #[test]
    fn web_pages_are_refused_not_opened() {
        // An artifact's frame could otherwise send its data out in a URL the browser opens.
        assert_eq!(decide(&url("https://github.com/alyakan/lantern"), None), Navigation::Block);
        assert_eq!(decide(&url("mailto:someone@example.com"), None), Navigation::Block);
        // Another local server is not the app, even while developing.
        let dev = url("http://localhost:1420");
        assert_eq!(decide(&url("http://localhost:3000/"), Some(&dev)), Navigation::Block);
        assert_eq!(decide(&url("http://localhost:1420/"), None), Navigation::Block);
    }

    #[test]
    fn other_schemes_are_ignored() {
        assert_eq!(decide(&url("file:///etc/passwd"), None), Navigation::Block);
        assert_eq!(decide(&url("javascript:alert(1)"), None), Navigation::Block);
    }
}
