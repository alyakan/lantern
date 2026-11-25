//! Web Claude: a connector claude.ai adds (Settings › Connectors), so web Claude, where the user designs on canvases, can
//! hand work to Lantern's chats and read what they did, and Lantern's chats can leave web Claude questions and notes.
//!
//! - server.rs: HTTP on 127.0.0.1 (sign-in and MCP); funnel.rs puts it on the internet with Tailscale Funnel.
//! - store.rs: connections (token hashes), canvas → project links, requests waiting for the user's Run, the outbox.
//! - mcp.rs: the six tools web Claude gets. Two more, web_ask and web_note, are Lantern's MCP tools in a chat (see
//!   `chat_call`).
//!
//! Nothing web Claude sends runs until the user taps Run on its card; a claude.ai sign-in waits for their Allow.

pub mod funnel;
pub mod mcp;
pub mod server;
pub mod store;

use serde::Serialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use store::{OutKind, Store};

/// The tools a chat is offered on Lantern's MCP server.
pub const CHAT_TOOLS: &[&str] = &["web_ask", "web_note"];

/// The connector's local port; LANTERN_WEBCLAUDE_PORT moves it (a dev run beside the real app).
pub const PORT: u16 = 47124;

pub fn port() -> u16 {
    std::env::var("LANTERN_WEBCLAUDE_PORT").ok().and_then(|v| v.trim().parse::<u16>().ok()).filter(|p| *p > 1023).unwrap_or(PORT)
}

struct Running {
    task: tokio::task::JoinHandle<()>,
    port: u16,
}

pub struct WebClaude {
    pub store: Arc<Store>,
    running: Mutex<Option<Running>>,
    public: Arc<Mutex<Option<String>>>,
    error: Mutex<Option<String>>,
    /// Held while it starts or stops, so two can't race.
    pub lifecycle: tokio::sync::Mutex<()>,
}

/// Settings › Web Claude.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct View {
    pub enabled: bool,
    pub listening: bool,
    /// What to paste in claude.ai: the public address of /mcp, while on.
    pub address: Option<String>,
    pub error: Option<String>,
    pub connections: Vec<store::Connection>,
    pub links: Vec<LinkView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LinkView {
    pub canvas: String,
    pub title: String,
    pub folder: String,
}

impl WebClaude {
    pub fn new(store: Store) -> Self {
        store.after_restart();
        Self { store: Arc::new(store), running: Mutex::default(), public: Arc::default(), error: Mutex::default(), lifecycle: tokio::sync::Mutex::new(()) }
    }

    pub fn view(&self) -> View {
        let listening = self.running.lock().unwrap().is_some();
        let address = if listening { self.public.lock().unwrap().clone().map(|b| format!("{b}/mcp")) } else { None };
        View {
            enabled: self.store.enabled(),
            listening,
            address,
            error: self.error.lock().unwrap().clone(),
            connections: self.store.connections(server::now_ms()),
            links: self.store.links().into_iter().map(|l| LinkView { canvas: l.canvas, title: l.title, folder: l.folder }).collect(),
        }
    }

    /// Starts the server and the Funnel. On any failure nothing is left listening, and why is kept for Settings.
    pub async fn start(&self, mac: Arc<dyn mcp::Mac>, public: bool) -> Result<(), String> {
        let _held = self.lifecycle.lock().await;
        if self.running.lock().unwrap().is_some() {
            return Ok(());
        }
        let port = port();
        let result = async {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| format!("Lantern couldn't listen on port {port} for web Claude: {e}"))?;
            let ctx = Arc::new(server::Ctx { store: self.store.clone(), mac, public: Mutex::new(None) });
            let task = tokio::spawn(server::serve(listener, ctx.clone()));
            let base = if public {
                match funnel::open(port).await {
                    Ok(b) => Some(b),
                    Err(e) => {
                        task.abort();
                        return Err(e);
                    }
                }
            } else {
                Some(format!("http://127.0.0.1:{port}"))
            };
            *ctx.public.lock().unwrap() = base.clone();
            *self.public.lock().unwrap() = base;
            Ok::<_, String>(Running { task, port })
        }
        .await;
        match result {
            Ok(r) => {
                *self.running.lock().unwrap() = Some(r);
                *self.error.lock().unwrap() = None;
                Ok(())
            }
            Err(e) => {
                *self.error.lock().unwrap() = Some(e.clone());
                Err(e)
            }
        }
    }

    /// Takes it off the internet and stops listening.
    pub async fn stop(&self, public: bool) {
        let _held = self.lifecycle.lock().await;
        let running = self.running.lock().unwrap().take();
        if let Some(r) = running {
            if public {
                if let Err(e) = funnel::close(r.port).await {
                    *self.error.lock().unwrap() = Some(e);
                }
            }
            r.task.abort();
        }
        *self.public.lock().unwrap() = None;
    }

    /// web_ask and web_note, from chat `slot`.
    pub fn chat_call(&self, slot: &str, chat_title: Option<String>, tool: &str, input: &Value) -> Result<String, String> {
        let text = input["text"].as_str().or_else(|| input["question"].as_str()).unwrap_or("");
        let now = server::now_ms();
        match tool {
            "web_ask" => {
                let item = self.store.chat_post(slot, chat_title, OutKind::Question, text, None, now)?;
                Ok(format!("Your question is in web Claude's outbox (id {}). Web Claude sees it the next time it checks; its answer comes to this chat as a message, after the user taps Run. Don't wait for it: carry on with what you can.", item.id))
            }
            "web_note" => {
                let item = self.store.chat_post(slot, chat_title, OutKind::Note, text, input["preview_url"].as_str(), now)?;
                Ok(format!("Left for web Claude (id {}). It sees it the next time it checks the outbox.", item.id))
            }
            _ => Err(format!("Lantern has no tool \"{tool}\".")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_chat_not_on_a_canvas_cant_post_and_one_on_a_canvas_can() {
        let w = WebClaude::new(Store::load(None));
        assert!(w.chat_call("s1", None, "web_note", &json!({"text": "hi"})).is_err());
        let r = w.store.propose(store::Kind::Send, "c", "c", "m", Some("/p".into()), "g", 1).unwrap();
        w.store.decide_run(&r.id, true, None).unwrap();
        w.store.started(&r.id, "s1", None);
        assert!(w.chat_call("s1", None, "web_ask", &json!({"text": "16 or 20?"})).unwrap().contains("outbox"));
        assert!(w.chat_call("s1", None, "web_note", &json!({"text": "preview", "preview_url": "https://claude.ai/artifact/x"})).is_ok());
        assert_eq!(w.store.outbox(None, None, 10).len(), 2);
        assert!(w.chat_call("s1", None, "nope", &json!({})).is_err());
    }

    #[tokio::test]
    async fn it_starts_on_this_mac_only_and_stops() {
        struct NoMac;
        impl mcp::Mac for NoMac {
            fn projects(&self) -> mcp::BoxFut<Vec<(String, String)>> {
                Box::pin(async { vec![] })
            }
            fn chats(&self) -> Vec<mcp::ChatLine> {
                vec![]
            }
        }
        std::env::set_var("LANTERN_WEBCLAUDE_PORT", "47999");
        let w = WebClaude::new(Store::load(None));
        w.start(Arc::new(NoMac), false).await.unwrap();
        assert_eq!(w.view().address.as_deref(), Some("http://127.0.0.1:47999/mcp"));
        assert!(tokio::net::TcpStream::connect("127.0.0.1:47999").await.is_ok());
        w.stop(false).await;
        assert!(!w.view().listening);
        std::env::remove_var("LANTERN_WEBCLAUDE_PORT");
    }
}
