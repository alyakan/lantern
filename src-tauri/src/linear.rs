//! Linear, for the Desk's Your work: the issues assigned to you that aren't done (Ready, In Review and Testing, which this
//! workflow files as completed, count as not done), with their team, project, the branch name
//! Linear suggests and the pull requests linked to them, and the workspace's teams. Read-only: one GraphQL query to
//! api.linear.app, nothing is ever written there. The personal API key is kept in the login Keychain (never in a file, and
//! never sent to the window: it only hears whether one is set). What Linear says (titles, names) is shown on the Desk, never
//! handed to Claude: a step names an issue by its identifier and link only.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

/// The Keychain item: the real app's, and a dev run's of its own (see LANTERN_REMOTE_FILE in lib.rs).
pub const SERVICE: &str = "Lantern Linear";
pub const DEV_SERVICE: &str = "Lantern Linear (dev)";
const ACCOUNT: &str = "api-key";
/// The Keychain's "no such item".
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
const URL: &str = "https://api.linear.app/graphql";
/// How long what Linear said is used before it is asked again, and how often a Refresh may ask sooner.
const FRESH: Duration = Duration::from_secs(90);
const FRESH_MIN: Duration = Duration::from_secs(15);
const TIMEOUT: Duration = Duration::from_secs(20);
/// The issues asked for, at most.
const ISSUES_MAX: usize = 100;

/// The "completed" issues asked for, at most.
const FINISHED_MAX: usize = 100;

/// The query asks for your open issues, and for the issues in a state of the "completed" kind that isn't Done or Closed. A
/// workflow may file work that is still going under that kind (this one's In Review and Testing, and Ready: merged, not yet
/// released), and a pull request is open for it: without the issue the pull request has no feature. Done, Closed, Canceled and
/// duplicates are gone from the Desk.
const QUERY: &str = r#"query DeskWork {
  viewer {
    name
    organization { name }
    assignedIssues(first: 100, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }) { nodes { ...Work } }
    finished: assignedIssues(first: 100, orderBy: updatedAt, filter: { state: { type: { eq: "completed" }, name: { nin: ["Done", "Closed"] } } }) { nodes { ...Work } }
  }
  teams(first: 100) { nodes { key name } }
}
fragment Work on Issue {
  identifier title url priority dueDate branchName
  state { name type }
  team { key }
  project { id name }
  attachments { nodes { url } }
}"#;

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct LinearIssue {
    /// "ENG-142".
    pub identifier: String,
    pub title: String,
    pub url: String,
    /// 0 none, 1 urgent, 2 high, 3 medium, 4 low.
    pub priority: u8,
    /// "2026-11-05", when it has a due date.
    pub due: Option<String>,
    /// Its state's name ("In Progress") and type: triage, backlog, unstarted or started, or completed for a state of that kind
    /// that isn't Done or Closed (Ready, In Review, Testing).
    pub state: String,
    pub state_type: String,
    /// Its team's key ("ENG").
    pub team: String,
    pub project: Option<String>,
    pub project_id: Option<String>,
    /// The branch name Linear suggests for it.
    pub branch: Option<String>,
    /// What is attached to it: a linked pull request's GitHub URL among them.
    pub links: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct LinearTeam {
    pub key: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct LinearWork {
    /// A key is kept.
    pub connected: bool,
    pub viewer: Option<String>,
    pub org: Option<String>,
    pub teams: Vec<LinearTeam>,
    pub issues: Vec<LinearIssue>,
    /// Why Linear couldn't be asked this time (what it said before is kept).
    pub error: Option<String>,
}

/// The key as read from the Keychain once (None inside: there is none), so a poll doesn't go to the Keychain every time.
static KEY: Mutex<Option<Option<String>>> = Mutex::new(None);
static CACHE: Mutex<Option<(Instant, LinearWork)>> = Mutex::new(None);

/// A personal API key as Linear makes them: printable, no spaces, a sane length. Anything else isn't sent anywhere.
pub fn valid_key(key: &str) -> bool {
    (10..=200).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_graphic())
}

fn read_key(service: &str) -> Result<Option<String>, String> {
    if let Some(known) = KEY.lock().ok().and_then(|k| k.clone()) {
        return Ok(known);
    }
    let got = match security_framework::passwords::get_generic_password(service, ACCOUNT) {
        Ok(raw) => Some(String::from_utf8(raw).map_err(|_| "The Linear key in the Keychain isn't readable: connect again.".to_string())?),
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => None,
        Err(e) => return Err(format!("Couldn't read the Linear key from the Keychain: {e}")),
    };
    if let Ok(mut k) = KEY.lock() {
        *k = Some(got.clone());
    }
    Ok(got)
}

fn forget() {
    if let Ok(mut c) = CACHE.lock() {
        *c = None;
    }
}

/// What `QUERY` returned, as the Desk reads it. A response with `errors` and no data is Linear refusing (most often the key).
pub fn parse(body: &Value) -> Result<LinearWork, String> {
    if body["data"].is_null() {
        let said = body["errors"][0]["message"].as_str().unwrap_or("no data");
        return Err(format!("Linear said: {}", said.chars().take(200).collect::<String>()));
    }
    let viewer = &body["data"]["viewer"];
    let text = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(String::from);
    let issue_of = |i: &Value| {
        Some(LinearIssue {
            identifier: text(&i["identifier"])?,
            title: i["title"].as_str().unwrap_or("").to_string(),
            url: text(&i["url"]).filter(|u| u.starts_with("https://linear.app/"))?,
            // A Float in Linear's schema: 2 or 2.0.
            priority: i["priority"].as_f64().filter(|p| (0.0..=4.0).contains(p)).map(|p| p as u8).unwrap_or(0),
            due: text(&i["dueDate"]),
            state: i["state"]["name"].as_str().unwrap_or("").to_string(),
            state_type: i["state"]["type"].as_str().unwrap_or("").to_string(),
            team: i["team"]["key"].as_str().unwrap_or("").to_string(),
            project: text(&i["project"]["name"]),
            project_id: text(&i["project"]["id"]),
            branch: text(&i["branchName"]),
            links: i["attachments"]["nodes"].as_array().map(|a| a.iter().filter_map(|n| text(&n["url"])).collect()).unwrap_or_default(),
        })
    };
    let listed = |key: &str, max: usize| -> Vec<LinearIssue> { viewer[key]["nodes"].as_array().map(|list| list.iter().take(max).filter_map(issue_of).collect()).unwrap_or_default() };
    let mut issues = listed("assignedIssues", ISSUES_MAX);
    for done in listed("finished", FINISHED_MAX) {
        if !issues.iter().any(|i| i.identifier == done.identifier) {
            issues.push(done);
        }
    }
    let teams = body["data"]["teams"]["nodes"]
        .as_array()
        .map(|list| list.iter().filter_map(|t| Some(LinearTeam { key: text(&t["key"])?, name: t["name"].as_str().unwrap_or("").to_string() })).collect())
        .unwrap_or_default();
    Ok(LinearWork { connected: true, viewer: text(&viewer["name"]), org: text(&viewer["organization"]["name"]), teams, issues, error: None })
}

/// Asks Linear with `key`: one POST to its API, no redirects followed.
async fn ask(key: &str) -> Result<LinearWork, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder().timeout(TIMEOUT).redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
    let res = client
        .post(URL)
        .header("Authorization", key)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "query": QUERY }))
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "Linear didn't answer in time.".to_string() } else { "Couldn't reach Linear.".to_string() })?;
    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Linear didn't accept the key.".into());
    }
    let body: Value = res.json().await.map_err(|_| format!("Linear answered {status} with something that isn't JSON."))?;
    parse(&body)
}

/// Checks `key` with Linear and, when it works, keeps it in the Keychain under `service`.
pub async fn connect(service: &str, key: &str) -> Result<LinearWork, String> {
    let key = key.trim();
    if !valid_key(key) {
        return Err("That doesn't look like a Linear API key.".into());
    }
    let work = ask(key).await?;
    security_framework::passwords::set_generic_password(service, ACCOUNT, key.as_bytes()).map_err(|e| format!("Couldn't save the Linear key in the Keychain: {e}"))?;
    if let Ok(mut k) = KEY.lock() {
        *k = Some(Some(key.to_string()));
    }
    if let Ok(mut c) = CACHE.lock() {
        *c = Some((Instant::now(), work.clone()));
    }
    Ok(work)
}

/// Forgets the key: out of the Keychain, and out of memory.
pub fn disconnect(service: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(service, ACCOUNT) {
        Ok(()) => {}
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => {}
        Err(e) => return Err(format!("Couldn't remove the Linear key from the Keychain: {e}")),
    }
    if let Ok(mut k) = KEY.lock() {
        *k = Some(None);
    }
    forget();
    Ok(())
}

/// Your work in Linear: what it said within `FRESH` (`fresh`: within `FRESH_MIN`), else asked again. With no key, not connected;
/// when asking fails, what it said last with the reason.
pub async fn work(service: &str, fresh: bool) -> LinearWork {
    let key = match read_key(service) {
        Ok(Some(k)) => k,
        Ok(None) => return LinearWork::default(),
        Err(e) => return LinearWork { connected: true, error: Some(e), ..Default::default() },
    };
    let kept = CACHE.lock().ok().and_then(|c| c.clone());
    if let Some((at, w)) = &kept {
        if at.elapsed() < if fresh { FRESH_MIN } else { FRESH } {
            return w.clone();
        }
    }
    match ask(&key).await {
        Ok(w) => {
            if let Ok(mut c) = CACHE.lock() {
                *c = Some((Instant::now(), w.clone()));
            }
            w
        }
        Err(e) => {
            let mut last = kept.map(|(_, w)| w).unwrap_or_else(|| LinearWork { connected: true, ..Default::default() });
            last.error = Some(e);
            last
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_your_issues_and_the_teams() {
        let body = serde_json::json!({ "data": {
            "viewer": { "name": "Aly", "organization": { "name": "Acme" }, "assignedIssues": { "nodes": [
                { "identifier": "ENG-142", "title": "Offline queue", "url": "https://linear.app/acme/issue/ENG-142/offline-queue", "priority": 2.0, "dueDate": "2026-11-05", "branchName": "aly/eng-142-offline-queue",
                  "state": { "name": "Todo", "type": "unstarted" }, "team": { "key": "ENG" }, "project": { "id": "p1", "name": "Offline mode" },
                  "attachments": { "nodes": [{ "url": "https://github.com/acme/api/pull/7" }] } },
                { "identifier": "ENG-9", "title": "Not on linear.app", "url": "https://evil.example/x", "state": {}, "team": {} },
                { "title": "No identifier", "url": "https://linear.app/x" }
            ] } },
            "teams": { "nodes": [{ "key": "ENG", "name": "Engineering" }, { "name": "no key" }] }
        } });
        let w = parse(&body).unwrap();
        assert_eq!((w.viewer.as_deref(), w.org.as_deref(), w.connected), (Some("Aly"), Some("Acme"), true));
        assert_eq!(w.issues.len(), 1, "an issue without an identifier or a linear.app link is left out");
        let i = &w.issues[0];
        assert_eq!((i.identifier.as_str(), i.priority, i.due.as_deref(), i.state_type.as_str(), i.project.as_deref()), ("ENG-142", 2, Some("2026-11-05"), "unstarted", Some("Offline mode")));
        assert_eq!(i.links, vec!["https://github.com/acme/api/pull/7"]);
        assert_eq!(w.teams, vec![LinearTeam { key: "ENG".into(), name: "Engineering".into() }]);
    }

    #[test]
    fn issues_in_a_completed_kind_of_state_are_kept_once_beside_the_open_ones() {
        let issue = |id: &str, name: &str, kind: &str| serde_json::json!({ "identifier": id, "title": id, "url": format!("https://linear.app/acme/issue/{id}"), "state": { "name": name, "type": kind }, "team": { "key": "LUM" }, "project": { "id": "p", "name": "Testo integration" } });
        let body = serde_json::json!({ "data": { "viewer": {
            "assignedIssues": { "nodes": [issue("LUM-1", "In Progress", "started")] },
            "finished": { "nodes": [issue("LUM-1", "In Progress", "started"), issue("LUM-2", "Ready", "completed")] }
        }, "teams": { "nodes": [] } } });
        let w = parse(&body).unwrap();
        let got: Vec<_> = w.issues.iter().map(|i| (i.identifier.as_str(), i.state.as_str(), i.state_type.as_str(), i.project.as_deref())).collect();
        assert_eq!(got, vec![("LUM-1", "In Progress", "started", Some("Testo integration")), ("LUM-2", "Ready", "completed", Some("Testo integration"))]);
    }

    #[test]
    fn the_query_leaves_out_done_closed_canceled_and_duplicate_by_state() {
        assert!(QUERY.contains(r#"type: { nin: ["completed", "canceled", "duplicate"] }"#));
        assert!(QUERY.contains(r#"name: { nin: ["Done", "Closed"] }"#));
    }

    #[test]
    fn a_refusal_is_an_error_not_an_empty_list() {
        let body = serde_json::json!({ "errors": [{ "message": "Authentication required, not authenticated" }], "data": null });
        assert_eq!(parse(&body).unwrap_err(), "Linear said: Authentication required, not authenticated");
    }

    #[test]
    fn only_a_plausible_key_is_sent() {
        assert!(valid_key("lin_api_0123456789abcdef"));
        assert!(!valid_key("short"));
        assert!(!valid_key("lin_api_ with space"));
        assert!(!valid_key("lin_api_line\nbreak"));
    }
}
