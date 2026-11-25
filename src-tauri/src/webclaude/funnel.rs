//! Tailscale Funnel, through the `tailscale` command: what puts the connector (on 127.0.0.1) on the internet at
//! https://<this Mac's tailnet name>, port 443, for claude.ai's servers to call. Lantern only ever touches port 443's
//! entry, and only when it points at the connector or is free: anything else the user serves (another port, or 443 for
//! something of theirs) is left alone.

use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

pub const FUNNEL_PORT: u16 = 443;

/// Where the `tailscale` command is: the Mac app's own, else one on PATH.
pub fn cli() -> Option<PathBuf> {
    let app = PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    if app.exists() {
        return Some(app);
    }
    ["/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"].iter().map(PathBuf::from).find(|p| p.exists())
}

/// What `tailscale status --json` says of this Mac: its tailnet name, and whether Funnel is allowed for it.
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub dns_name: String,
    pub funnel_allowed: bool,
    pub running: bool,
}

pub fn parse_status(v: &Value) -> Option<Node> {
    let me = v.get("Self")?;
    let dns_name = me["DNSName"].as_str()?.trim_end_matches('.').to_string();
    if dns_name.is_empty() {
        return None;
    }
    let caps: Vec<&str> = me["Capabilities"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let in_map = me["CapMap"].as_object().is_some_and(|m| m.contains_key("funnel"));
    Some(Node { dns_name, funnel_allowed: caps.contains(&"funnel") || in_map, running: v["BackendState"] == "Running" })
}

/// What port 443 of `funnel status --json` serves now.
#[derive(Debug, Clone, PartialEq)]
pub enum Port443 {
    Free,
    /// Proxied to the connector, and on the internet (AllowFunnel) or only on the tailnet.
    Ours { public: bool },
    /// Something else of the user's: Lantern leaves it.
    Taken(String),
}

pub fn parse_funnel(v: &Value, dns_name: &str, local: &str) -> Port443 {
    let key = format!("{dns_name}:{FUNNEL_PORT}");
    let Some(web) = v["Web"].get(&key) else {
        return if v["TCP"].get(FUNNEL_PORT.to_string()).is_some() { Port443::Taken("a TCP forward".into()) } else { Port443::Free };
    };
    let handlers = web["Handlers"].as_object();
    let ours = handlers.is_some_and(|h| h.len() == 1 && h.get("/").and_then(|r| r["Proxy"].as_str()) == Some(local));
    if ours {
        return Port443::Ours { public: v["AllowFunnel"][&key].as_bool().unwrap_or(false) };
    }
    let what = handlers.and_then(|h| h.values().next()).map(|r| r.to_string()).unwrap_or_else(|| "something".into());
    Port443::Taken(what)
}

/// The address Tailscale says to open, from what it printed (turning Funnel on for the tailnet).
pub fn url_in(text: &str) -> Option<String> {
    text.split_whitespace().find(|w| w.starts_with("https://login.tailscale.com/")).map(|w| w.trim_end_matches(['.', ',', ')']).to_string())
}

async fn run(cli: &PathBuf, args: &[&str], secs: u64) -> Result<(bool, String), String> {
    let mut cmd = tokio::process::Command::new(cli);
    cmd.args(args).kill_on_drop(true).stdin(std::process::Stdio::null());
    match tokio::time::timeout(Duration::from_secs(secs), cmd.output()).await {
        Ok(Ok(out)) => Ok((out.status.success(), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))),
        Ok(Err(e)) => Err(format!("Couldn't run tailscale: {e}")),
        Err(_) => Err("timeout".into()),
    }
}

pub async fn node() -> Result<Node, String> {
    let cli = cli().ok_or("Tailscale isn't installed. Install it from tailscale.com and sign in, then try again.")?;
    let (ok, out) = run(&cli, &["status", "--json", "--peers=false"], 10).await?;
    let v: Value = serde_json::from_str(&out).map_err(|_| if ok { "Tailscale's status couldn't be read.".to_string() } else { format!("Tailscale says: {}", out.trim()) })?;
    let node = parse_status(&v).ok_or("Tailscale isn't signed in on this Mac.")?;
    if !node.running {
        return Err("Tailscale is off. Turn it on, then try again.".into());
    }
    Ok(node)
}

async fn port_443(cli: &PathBuf, node: &Node, local: &str) -> Result<Port443, String> {
    let (_, out) = run(cli, &["funnel", "status", "--json"], 10).await?;
    let v: Value = serde_json::from_str(&out).unwrap_or(Value::Null);
    Ok(parse_funnel(&v, &node.dns_name, local))
}

/// Puts the connector on the internet. Returns its public base address (https://<name>).
pub async fn open(local_port: u16) -> Result<String, String> {
    let cli = cli().ok_or("Tailscale isn't installed. Install it from tailscale.com and sign in, then try again.")?;
    let node = node().await?;
    let local = format!("http://127.0.0.1:{local_port}");
    let base = format!("https://{}", node.dns_name);
    match port_443(&cli, &node, &local).await? {
        Port443::Ours { public: true } => return Ok(base),
        Port443::Taken(what) => return Err(format!("Tailscale already serves {what} on port 443 of this Mac. Lantern won't replace it: turn that off (tailscale funnel --https=443 off) and try again.")),
        _ => {}
    }
    if !node.funnel_allowed {
        return Err("Funnel isn't allowed for this Mac in your tailnet. Turn it on in the Tailscale admin console (Access controls → Funnel), then try again.".into());
    }
    let port = format!("--https={FUNNEL_PORT}");
    match run(&cli, &["funnel", "--bg", &port, &local], 20).await {
        Ok((true, _)) => Ok(base),
        Ok((false, out)) => Err(match url_in(&out) {
            Some(url) => format!("Tailscale needs Funnel turned on for your tailnet first: open {url}, then try again."),
            None => format!("Tailscale couldn't start Funnel: {}", out.trim()),
        }),
        Err(e) if e == "timeout" => Err("Tailscale didn't answer in time. It may be waiting for Funnel to be turned on for your tailnet: run `tailscale funnel 443` in Terminal to see what it asks.".into()),
        Err(e) => Err(e),
    }
}

/// Takes the connector off the internet, if port 443 is still the connector's.
pub async fn close(local_port: u16) -> Result<(), String> {
    let Some(cli) = cli() else { return Ok(()) };
    let node = node().await?;
    let local = format!("http://127.0.0.1:{local_port}");
    if matches!(port_443(&cli, &node, &local).await?, Port443::Ours { .. }) {
        let port = format!("--https={FUNNEL_PORT}");
        let (ok, out) = run(&cli, &["funnel", &port, "off"], 15).await?;
        if !ok {
            return Err(format!("Tailscale couldn't stop Funnel: {}", out.trim()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_status_gives_the_name_without_its_dot_and_whether_funnel_is_allowed() {
        let v = json!({"BackendState": "Running", "Self": {"DNSName": "mac.tail0.ts.net.", "Capabilities": ["funnel", "https"]}});
        assert_eq!(parse_status(&v), Some(Node { dns_name: "mac.tail0.ts.net".into(), funnel_allowed: true, running: true }));
        let off = json!({"BackendState": "Stopped", "Self": {"DNSName": "mac.tail0.ts.net.", "CapMap": {"https": null}}});
        assert_eq!(parse_status(&off), Some(Node { dns_name: "mac.tail0.ts.net".into(), funnel_allowed: false, running: false }));
        assert_eq!(parse_status(&json!({"Self": {"DNSName": ""}})), None);
    }

    #[test]
    fn port_443_is_free_ours_or_someone_elses_and_other_ports_dont_matter() {
        let local = "http://127.0.0.1:47124";
        // The user's Vaultwarden on 8443 is not in the way.
        let vault = json!({"TCP": {"8443": {"HTTPS": true}}, "Web": {"mac.ts.net:8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8222"}}}}});
        assert_eq!(parse_funnel(&vault, "mac.ts.net", local), Port443::Free);
        let ours = json!({"TCP": {"443": {"HTTPS": true}}, "Web": {"mac.ts.net:443": {"Handlers": {"/": {"Proxy": local}}}}, "AllowFunnel": {"mac.ts.net:443": true}});
        assert_eq!(parse_funnel(&ours, "mac.ts.net", local), Port443::Ours { public: true });
        let tailnet_only = json!({"Web": {"mac.ts.net:443": {"Handlers": {"/": {"Proxy": local}}}}});
        assert_eq!(parse_funnel(&tailnet_only, "mac.ts.net", local), Port443::Ours { public: false });
        let theirs = json!({"Web": {"mac.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3000"}}}}});
        assert!(matches!(parse_funnel(&theirs, "mac.ts.net", local), Port443::Taken(_)));
        let more = json!({"Web": {"mac.ts.net:443": {"Handlers": {"/": {"Proxy": local}, "/x": {"Path": "/tmp"}}}}});
        assert!(matches!(parse_funnel(&more, "mac.ts.net", local), Port443::Taken(_)), "a path of theirs beside ours");
        assert!(matches!(parse_funnel(&json!({"TCP": {"443": {"TCPForward": "x"}}}), "mac.ts.net", local), Port443::Taken(_)));
    }

    #[test]
    fn the_enable_link_is_found_in_what_tailscale_printed() {
        let out = "Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=abc.\n";
        assert_eq!(url_in(out).as_deref(), Some("https://login.tailscale.com/f/funnel?node=abc"));
        assert_eq!(url_in("nothing here"), None);
    }
}
