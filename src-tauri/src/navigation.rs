//! Keeps the window on Lantern's own pages. A link that would load somewhere else opens in the browser instead,
//! so no click (whatever button, whatever element) can replace the app with a web page.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, PartialEq)]
pub enum Navigation {
    /// One of Lantern's own pages: load it.
    Stay,
    /// A web page or mail link: hand it to the browser or mail app.
    OpenOutside,
    /// Anything else: ignore it.
    Block,
}

/// `dev_url` is where the frontend is served from while developing; it counts as Lantern's own.
pub fn decide(url: &Url, dev_url: Option<&Url>) -> Navigation {
    let ours = match url.scheme() {
        // macOS and Linux serve the app from tauri://localhost.
        "tauri" | "about" => true,
        // Windows serves it from http(s)://tauri.localhost.
        "http" | "https" => url.host_str() == Some("tauri.localhost") || dev_url.is_some_and(|dev| dev.origin() == url.origin()),
        _ => false,
    };
    if ours {
        Navigation::Stay
    } else if matches!(url.scheme(), "http" | "https" | "mailto") {
        Navigation::OpenOutside
    } else {
        Navigation::Block
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navigation")
        .on_navigation(|webview, url| {
            let app = webview.app_handle();
            let dev_url = if cfg!(debug_assertions) { app.config().build.dev_url.clone() } else { None };
            match decide(url, dev_url.as_ref()) {
                Navigation::Stay => true,
                Navigation::OpenOutside => {
                    let _ = app.opener().open_url(url.as_str(), None::<&str>);
                    false
                }
                Navigation::Block => false,
            }
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
    fn web_pages_open_outside() {
        assert_eq!(decide(&url("https://github.com/alyakan/lantern"), None), Navigation::OpenOutside);
        assert_eq!(decide(&url("mailto:someone@example.com"), None), Navigation::OpenOutside);
        // Another local server is not the app, even while developing.
        let dev = url("http://localhost:1420");
        assert_eq!(decide(&url("http://localhost:3000/"), Some(&dev)), Navigation::OpenOutside);
        assert_eq!(decide(&url("http://localhost:1420/"), None), Navigation::OpenOutside);
    }

    #[test]
    fn other_schemes_are_ignored() {
        assert_eq!(decide(&url("file:///etc/passwd"), None), Navigation::Block);
        assert_eq!(decide(&url("javascript:alert(1)"), None), Navigation::Block);
    }
}
