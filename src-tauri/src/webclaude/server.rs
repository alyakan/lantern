//! The connector's HTTP server, on 127.0.0.1 only (Tailscale Funnel carries claude.ai's calls to it). It answers OAuth
//! sign-in (metadata, client registration, the page that waits for the user's Allow, tokens) and MCP at /mcp, which needs a
//! token. Requests are routed by `route`, which the tests call directly.

use super::mcp::{self, Mac};
use super::store::{AuthStatus, Store};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// The largest request body read.
const BODY_MAX: usize = 1 << 20;

pub struct Ctx {
    pub store: Arc<Store>,
    pub mac: Arc<dyn Mac>,
    /// The address claude.ai reaches this at (the Funnel's https://…ts.net), when known.
    pub public: Mutex<Option<String>>,
}

#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    fn json(status: u16, v: Value) -> Self {
        Self { status, headers: vec![("content-type", "application/json".into()), ("cache-control", "no-store".into())], body: serde_json::to_vec(&v).unwrap_or_default() }
    }
    fn html(status: u16, body: String) -> Self {
        Self {
            status,
            headers: vec![
                ("content-type", "text/html; charset=utf-8".into()),
                ("cache-control", "no-store".into()),
                // No script: the sign-in page moves on by reloading itself.
                ("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'".into()),
                ("x-frame-options", "DENY".into()),
                ("referrer-policy", "no-referrer".into()),
            ],
            body: body.into_bytes(),
        }
    }
    fn empty(status: u16) -> Self {
        Self { status, headers: vec![], body: vec![] }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `a=b&c=d`, decoded (+ is a space, as forms send it).
pub fn parse_query(q: &str) -> HashMap<String, String> {
    fn dec(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            match b[i] {
                b'+' => out.push(b' '),
                b'%' if i + 2 < b.len() => match u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                },
                c => out.push(c),
            }
            i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }
    q.split('&').filter(|p| !p.is_empty()).map(|p| {
        let (k, v) = p.split_once('=').unwrap_or((p, ""));
        (dec(k), dec(v))
    }).collect()
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// The address claude.ai uses: the Funnel's when Lantern knows it, else the one this request came to (https on a
/// tailnet name, which only Tailscale serves).
fn base(ctx: &Ctx, host: Option<&str>) -> String {
    if let Some(p) = ctx.public.lock().unwrap().clone() {
        return p;
    }
    let host = host.filter(|h| !h.is_empty() && h.chars().all(|c| c.is_ascii_alphanumeric() || ".-:[]".contains(c))).unwrap_or("127.0.0.1");
    let scheme = if host.split(':').next().is_some_and(|h| h.ends_with(".ts.net")) { "https" } else { "http" };
    format!("{scheme}://{host}")
}

fn page(title: &str, body: &str) -> String {
    page_with(title, "", body)
}

/// `head`: more of the page's head, as HTML (already escaped).
fn page_with(title: &str, head: &str, body: &str) -> String {
    format!(r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">{head}<title>{title}</title><style>
:root{{color-scheme:light dark;--bg:#f7f6f3;--fg:#1d1c1a;--muted:#6b6862;--card:#fff;--line:#e4e1da;--accent:#c2410c}}
@media (prefers-color-scheme:dark){{:root{{--bg:#191817;--fg:#ecebe7;--muted:#a29f98;--card:#232220;--line:#363431;--accent:#fb923c}}}}
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
main{{max-width:420px;margin:16px;padding:28px;background:var(--card);border:1px solid var(--line);border-radius:14px}}
h1{{font-size:20px;margin:0 0 8px}}p{{margin:8px 0;color:var(--muted)}}.code{{font:600 32px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.2em;color:var(--fg);text-align:center;margin:16px 0}}.dot{{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);margin-right:8px;animation:p 1.4s infinite}}@keyframes p{{50%{{opacity:.3}}}}
</style></head><body><main>{body}</main></body></html>"#)
}

/// The sign-in page. It moves on with no script, which a browser or an extension may block: it reloads itself from
/// /authorize/wait, which shows it again until the user answers, then sends the browser back to claude.ai.
fn waiting_page(id: &str, client: &str, code: &str) -> String {
    let refresh = format!(r#"<meta http-equiv="refresh" content="2;url=/authorize/wait?id={}">"#, esc(id));
    page_with("Connect to Lantern", &refresh, &format!(r#"<h1>Allow {client} in Lantern</h1>
<p id="say"><span class="dot"></span>Lantern on your Mac shows a card asking whether {client} may connect. Type this code on that card, then Allow:</p>
<p class="code">{code}</p>
<p>This page moves on by itself once you answer.</p>"#, client = esc(client), code = esc(code)))
}

fn error_page(why: &str) -> Reply {
    Reply::html(400, page("Lantern", &format!("<h1>Lantern can't connect this</h1><p>{}</p>", esc(why))))
}

fn oauth_error(status: u16, code: &str) -> Reply {
    Reply::json(status, json!({"error": code}))
}

/// One request. `path` has no query; `query` is what came after `?`.
pub async fn route(ctx: &Ctx, method: &str, path: &str, query: &str, headers: &HashMap<String, String>, body: &[u8]) -> Reply {
    let base = base(ctx, headers.get("host").map(String::as_str));
    let now = now_ms();
    // A page in a browser may not call this (only claude.ai's servers, and the sign-in page itself).
    if let Some(origin) = headers.get("origin") {
        let ok = origin == &base || ["https://claude.ai", "https://claude.com"].contains(&origin.as_str());
        if !ok {
            return Reply::json(403, json!({"error": "origin not allowed"}));
        }
    }
    match (method, path) {
        ("GET", "/") => Reply { status: 200, headers: vec![("content-type", "text/plain; charset=utf-8".into())], body: b"Lantern's connector for web Claude. Add this address with /mcp in claude.ai's Connectors.".to_vec() },
        ("GET", "/.well-known/oauth-protected-resource") | ("GET", "/.well-known/oauth-protected-resource/mcp") => Reply::json(200, json!({
            "resource": format!("{base}/mcp"),
            "authorization_servers": [base],
            "bearer_methods_supported": ["header"],
            "resource_name": "Lantern",
        })),
        ("GET", "/.well-known/oauth-authorization-server") | ("GET", "/.well-known/oauth-authorization-server/mcp") => Reply::json(200, json!({
            "issuer": base,
            "authorization_endpoint": format!("{base}/authorize"),
            "token_endpoint": format!("{base}/token"),
            "registration_endpoint": format!("{base}/register"),
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
            "scopes_supported": ["lantern"],
        })),
        ("POST", "/register") => {
            let Ok(v) = serde_json::from_slice::<Value>(body) else { return oauth_error(400, "invalid_client_metadata") };
            let uris: Vec<String> = v["redirect_uris"].as_array().map(|a| a.iter().filter_map(|u| u.as_str().map(String::from)).collect()).unwrap_or_default();
            match ctx.store.register(v["client_name"].as_str(), &uris, now) {
                Ok(c) => Reply::json(201, json!({
                    "client_id": c.id,
                    "client_name": c.name,
                    "redirect_uris": c.redirect_uris,
                    "client_id_issued_at": c.created_at / 1000,
                    "token_endpoint_auth_method": "none",
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                })),
                Err(e) => Reply::json(400, json!({"error": "invalid_redirect_uri", "error_description": e})),
            }
        }
        ("GET", "/authorize") => {
            let q = parse_query(query);
            let get = |k: &str| q.get(k).map(String::as_str).unwrap_or("");
            if get("response_type") != "code" {
                return error_page("Only response_type=code is supported.");
            }
            match ctx.store.begin_auth(get("client_id"), get("redirect_uri"), q.get("state").map(String::as_str), get("code_challenge"), get("code_challenge_method"), now) {
                Ok(id) => match ctx.store.auth_code(&id) {
                    Some((code, client)) => Reply::html(200, waiting_page(&id, &client, &code)),
                    None => error_page("That sign-in has ended. Start again from claude.ai."),
                },
                Err(e) => error_page(&e),
            }
        }
        ("GET", "/authorize/wait") => {
            let q = parse_query(query);
            let id = q.get("id").map(String::as_str).unwrap_or("");
            match ctx.store.auth_status(id, now) {
                AuthStatus::Waiting => match ctx.store.auth_code(id) {
                    Some((code, client)) => Reply::html(200, waiting_page(id, &client, &code)),
                    None => error_page("This sign-in ended. Start again from claude.ai."),
                },
                AuthStatus::Redirect(url) => Reply { status: 302, headers: vec![("location", url), ("cache-control", "no-store".into()), ("referrer-policy", "no-referrer".into())], body: vec![] },
                AuthStatus::Gone => error_page("This sign-in ended. Start again from claude.ai."),
            }
        }
        ("POST", "/token") => {
            let f = parse_query(std::str::from_utf8(body).unwrap_or(""));
            let get = |k: &str| f.get(k).map(String::as_str).unwrap_or("");
            let result = match get("grant_type") {
                "authorization_code" => ctx.store.exchange_code(get("code"), get("client_id"), get("redirect_uri"), get("code_verifier"), now),
                "refresh_token" => ctx.store.refresh(get("refresh_token"), get("client_id"), now),
                _ => return oauth_error(400, "unsupported_grant_type"),
            };
            match result {
                Ok(t) => Reply::json(200, json!({"access_token": t.access, "token_type": "Bearer", "expires_in": t.expires_in, "refresh_token": t.refresh, "scope": "lantern"})),
                Err(e) => oauth_error(400, if e == "invalid_client" { "invalid_client" } else { "invalid_grant" }),
            }
        }
        (_, "/mcp") => {
            let unauthorized = || {
                let mut r = Reply::json(401, json!({"error": "invalid_token"}));
                r.headers.push(("www-authenticate", format!("Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource\"")));
                r
            };
            let token = headers.get("authorization").and_then(|a| a.strip_prefix("Bearer ").or_else(|| a.strip_prefix("bearer "))).map(str::trim);
            let Some(grant) = token.and_then(|t| ctx.store.bearer(t, now)) else { return unauthorized() };
            if method != "POST" {
                let mut r = Reply::empty(405);
                r.headers.push(("allow", "POST".into()));
                return r;
            }
            let Ok(msg) = serde_json::from_slice::<Value>(body) else { return Reply::json(400, json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "Not JSON."}})) };
            let replies: Vec<Value> = match &msg {
                Value::Array(batch) if batch.len() <= 20 => {
                    let mut out = Vec::new();
                    for m in batch {
                        out.extend(mcp::handle(&ctx.store, ctx.mac.as_ref(), &grant, m, now).await);
                    }
                    out
                }
                Value::Array(_) => return Reply::json(400, json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32600, "message": "Batch too large."}})),
                m => mcp::handle(&ctx.store, ctx.mac.as_ref(), &grant, m, now).await.into_iter().collect(),
            };
            match (msg.is_array(), replies.len()) {
                (_, 0) => Reply::empty(202),
                (false, _) => Reply::json(200, replies.into_iter().next().unwrap()),
                (true, _) => Reply::json(200, Value::Array(replies)),
            }
        }
        _ => Reply::json(404, json!({"error": "not found"})),
    }
}

/// Serves `ctx` on `listener` until the task is aborted.
pub async fn serve(listener: tokio::net::TcpListener, ctx: Arc<Ctx>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                let ctx = ctx.clone();
                async move {
                    let method = req.method().as_str().to_string();
                    let path = req.uri().path().to_string();
                    let query = req.uri().query().unwrap_or("").to_string();
                    let headers: HashMap<String, String> = req.headers().iter().filter_map(|(k, v)| Some((k.as_str().to_lowercase(), v.to_str().ok()?.to_string()))).collect();
                    let body = match Limited::new(req.into_body(), BODY_MAX).collect().await {
                        Ok(b) => b.to_bytes().to_vec(),
                        Err(_) => return Ok::<_, std::convert::Infallible>(to_hyper(Reply::json(413, json!({"error": "too large"})))),
                    };
                    let reply = route(&ctx, &method, &path, &query, &headers, &body).await;
                    Ok(to_hyper(reply))
                }
            });
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
        });
    }
}

fn to_hyper(r: Reply) -> hyper::Response<Full<Bytes>> {
    let mut b = hyper::Response::builder().status(r.status);
    for (k, v) in &r.headers {
        b = b.header(*k, v);
    }
    b.body(Full::new(Bytes::from(r.body))).unwrap_or_else(|_| hyper::Response::new(Full::new(Bytes::new())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::webclaude::mcp::{BoxFut, ChatLine};
    use crate::webclaude::store::challenge_of;

    struct FakeMac;
    impl Mac for FakeMac {
        fn projects(&self) -> BoxFut<Vec<(String, String)>> {
            Box::pin(async { vec![("/dev/rayak".into(), "rayak".into())] })
        }
        fn chats(&self) -> Vec<ChatLine> {
            vec![]
        }
    }

    fn ctx() -> Ctx {
        Ctx { store: Arc::new(Store::load(None)), mac: Arc::new(FakeMac), public: Mutex::new(Some("https://mac.tail0.ts.net".into())) }
    }

    fn h(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn body(r: &Reply) -> Value {
        serde_json::from_slice(&r.body).unwrap()
    }

    #[test]
    fn queries_decode_percent_and_plus() {
        let q = parse_query("a=1%202&b=x+y&c=%E2%80%94&d&e=%zz");
        assert_eq!((q["a"].as_str(), q["b"].as_str(), q["c"].as_str(), q["d"].as_str(), q["e"].as_str()), ("1 2", "x y", "—", "", "%zz"));
    }

    #[tokio::test]
    async fn mcp_without_a_token_points_claude_at_sign_in() {
        let c = ctx();
        let r = route(&c, "POST", "/mcp", "", &h(&[]), b"{}").await;
        assert_eq!(r.status, 401);
        let www = r.headers.iter().find(|(k, _)| *k == "www-authenticate").unwrap();
        assert!(www.1.contains("https://mac.tail0.ts.net/.well-known/oauth-protected-resource"));
        let meta = route(&c, "GET", "/.well-known/oauth-protected-resource", "", &h(&[]), b"").await;
        assert_eq!(body(&meta)["authorization_servers"][0], "https://mac.tail0.ts.net");
        let auth = route(&c, "GET", "/.well-known/oauth-authorization-server", "", &h(&[]), b"").await;
        assert_eq!(body(&auth)["code_challenge_methods_supported"][0], "S256");
    }

    #[tokio::test]
    async fn the_whole_sign_in_then_a_tool_call_over_http() {
        let c = ctx();
        let cb = "https://claude.ai/api/mcp/auth_callback";
        let reg = route(&c, "POST", "/register", "", &h(&[]), json!({"client_name": "Claude", "redirect_uris": [cb]}).to_string().as_bytes()).await;
        assert_eq!(reg.status, 201);
        let client = body(&reg)["client_id"].as_str().unwrap().to_string();
        let verifier = "x".repeat(60);
        let q = format!("response_type=code&client_id={client}&redirect_uri={}&code_challenge={}&code_challenge_method=S256&state=s1", cb.replace(':', "%3A").replace('/', "%2F"), challenge_of(&verifier));
        let page = route(&c, "GET", "/authorize", &q, &h(&[]), b"").await;
        assert_eq!(page.status, 200);
        let html = String::from_utf8(page.body.clone()).unwrap();
        assert!(html.contains("Allow Claude in Lantern"));
        let id = match &c.store.cards(now_ms())[0] {
            crate::webclaude::store::Card::Connect { id, .. } => id.clone(),
            _ => panic!(),
        };
        // The page moves on with no script (a browser or extension that blocks scripts would leave it stuck): it reloads
        // itself from /authorize/wait, and its policy lets no script run at all.
        assert!(html.contains(&format!(r#"<meta http-equiv="refresh" content="2;url=/authorize/wait?id={id}">"#)), "{html}");
        assert!(!html.contains("<script"));
        let csp = &page.headers.iter().find(|(k, _)| *k == "content-security-policy").unwrap().1;
        assert!(csp.starts_with("default-src 'none'") && !csp.contains("script-src"), "{csp}");
        let wait = route(&c, "GET", "/authorize/wait", &format!("id={id}"), &h(&[]), b"").await;
        assert_eq!(wait.status, 200);
        // The code is on the page only (the card doesn't carry it): the user types what the page shows.
        let code = c.store.auth_code(&id).unwrap().0;
        assert!(html.contains(&format!("<p class=\"code\">{code}</p>")), "{html}");
        assert!(String::from_utf8_lossy(&wait.body).contains(&format!("<p class=\"code\">{code}</p>")));
        assert!(!serde_json::to_string(&c.store.cards(now_ms())).unwrap().contains(&code));
        c.store.decide_auth(&id, true, Some(&code), now_ms()).unwrap();
        let done = route(&c, "GET", "/authorize/wait", &format!("id={id}"), &h(&[]), b"").await;
        assert_eq!(done.status, 302);
        let redirect = done.headers.iter().find(|(k, _)| *k == "location").unwrap().1.clone();
        assert!(redirect.starts_with(cb) && redirect.contains("state=s1"), "{redirect}");
        // The redirect is handed out once: a reload after it says to start again.
        let again = route(&c, "GET", "/authorize/wait", &format!("id={id}"), &h(&[]), b"").await;
        assert_eq!(again.status, 400);
        assert!(String::from_utf8_lossy(&again.body).contains("Start again from claude.ai"));
        let code = redirect.split("code=").nth(1).unwrap().split('&').next().unwrap();
        let form = format!("grant_type=authorization_code&code={code}&client_id={client}&redirect_uri={}&code_verifier={verifier}", cb.replace(':', "%3A").replace('/', "%2F"));
        let tok = route(&c, "POST", "/token", "", &h(&[]), form.as_bytes()).await;
        assert_eq!(tok.status, 200, "{}", String::from_utf8_lossy(&tok.body));
        let access = body(&tok)["access_token"].as_str().unwrap().to_string();
        let auth = format!("Bearer {access}");
        let call = json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "list_projects", "arguments": {}}});
        let r = route(&c, "POST", "/mcp", "", &h(&[("authorization", &auth)]), call.to_string().as_bytes()).await;
        assert_eq!(r.status, 200);
        assert_eq!(body(&r)["result"]["structuredContent"]["projects"][0]["name"], "rayak");
        let note = route(&c, "POST", "/mcp", "", &h(&[("authorization", &auth)]), br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).await;
        assert_eq!(note.status, 202);
        assert_eq!(route(&c, "GET", "/mcp", "", &h(&[("authorization", &auth)]), b"").await.status, 405);
        // The same code can't be used twice.
        assert_eq!(route(&c, "POST", "/token", "", &h(&[]), form.as_bytes()).await.status, 400);
    }

    #[tokio::test]
    async fn a_page_on_another_site_is_turned_away_and_bad_sign_ins_get_an_error_page() {
        let c = ctx();
        assert_eq!(route(&c, "POST", "/register", "", &h(&[("origin", "https://evil.example")]), b"{}").await.status, 403);
        assert_eq!(route(&c, "GET", "/authorize", "response_type=code&client_id=nope", &h(&[]), b"").await.status, 400);
        assert_eq!(route(&c, "POST", "/token", "", &h(&[]), b"grant_type=password").await.status, 400);
        let reg = route(&c, "POST", "/register", "", &h(&[]), json!({"redirect_uris": ["https://evil.example/cb"]}).to_string().as_bytes()).await;
        assert_eq!(reg.status, 400);
    }

    #[test]
    fn without_a_funnel_the_base_is_the_address_asked_for() {
        let c = Ctx { store: Arc::new(Store::load(None)), mac: Arc::new(FakeMac), public: Mutex::new(None) };
        assert_eq!(base(&c, Some("127.0.0.1:47124")), "http://127.0.0.1:47124");
        assert_eq!(base(&c, Some("mac.tail0.ts.net")), "https://mac.tail0.ts.net");
        assert_eq!(base(&c, Some("evil\"host")), "http://127.0.0.1");
    }

    #[tokio::test]
    async fn it_serves_over_a_real_socket() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(serve(listener, Arc::new(ctx())));
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        s.write_all(b"GET /.well-known/oauth-authorization-server HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        assert!(out.starts_with("HTTP/1.1 200") && out.contains("registration_endpoint"), "{out}");
        task.abort();
    }
}
