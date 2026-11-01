//! Lantern's durable, provider-neutral conversations. Provider session ids are transport details;
//! a conversation keeps its first id when its provider changes. Native transcripts remain readable.
use crate::{provider::ProviderId, session::SessionConfig, ui_event::UiEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, path::PathBuf, sync::Mutex};

pub const HANDOFF_MARKER: &str = "\n\nConversation continued from another provider.";

#[derive(Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub folder: String,
    pub provider: ProviderId,
    pub endpoint: Option<String>,
    pub native_id: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    pub updated_ms: u64,
    pub events: Vec<Value>,
}
impl Conversation {
    pub fn edits(&self) -> (Vec<(String, Option<String>)>, usize) {
        let mut edits = Vec::new();
        let mut before_last = 0;
        for event in self.replay() {
            match event {
                UiEvent::UserText { .. } => before_last = edits.len(),
                UiEvent::EditApplied { path, original, .. } => edits.push((path, original)),
                _ => {},
            }
        }
        (edits, before_last)
    }
    pub fn replay(&self) -> Vec<UiEvent> { self.events.iter().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect() }
    pub fn words(&self) -> String {
        self.events.iter().filter_map(|e| match e["kind"].as_str()? {
            "user_text" => Some(format!("User: {}", e["text"].as_str()?)),
            "assistant_text" if e["parent"].is_null() => Some(format!("Assistant: {}", e["text"].as_str()?)),
            _ => None,
        }).collect::<Vec<_>>().join("\n\n")
    }
    pub fn handoff(&self, limit: usize) -> String {
        let words = self.words();
        if words.chars().count() <= limit { return words; }
        let head: String = words.chars().take(limit / 4).collect();
        let tail: String = words.chars().rev().take(limit * 3 / 4).collect::<String>().chars().rev().collect();
        format!("{head}\n\n[Middle exchanges omitted from this handoff; the full history is kept by Lantern.]\n\n{tail}")
    }
    pub fn has_user_messages(&self) -> bool { self.events.iter().any(|e|e["kind"] == "user_text") }
    pub fn title(&self) -> String {
        self.events.iter().find(|e| e["kind"] == "user_text").and_then(|e| e["text"].as_str()).unwrap_or("New chat").chars().take(80).collect()
    }
}
#[derive(Default)]
struct Data { chats: HashMap<String, Conversation>, slots: HashMap<String, Conversation> }
pub struct Store { root: Option<PathBuf>, data: Mutex<Data> }
impl Store {
    pub fn load(root: Option<PathBuf>) -> Self {
        let mut data = Data::default();
        if let Some(root) = &root {
            if let Ok(files) = std::fs::read_dir(root) {
                for file in files.flatten().filter(|f| f.path().extension().is_some_and(|x| x == "json")) {
                    if let Ok(bytes) = std::fs::read(file.path()) {
                        if let Ok(c) = serde_json::from_slice::<Conversation>(&bytes) { data.chats.insert(c.id.clone(), c); }
                    }
                }
            }
        }
        Self { root, data: Mutex::new(data) }
    }
    pub fn get(&self, id: &str) -> Option<Conversation> { self.data.lock().unwrap().chats.get(id).cloned() }
    pub fn all(&self) -> Vec<Conversation> { self.data.lock().unwrap().chats.values().cloned().collect() }
    pub fn detach(&self, slot: &str) { self.data.lock().unwrap().slots.remove(slot); }
    pub fn attach(&self, slot: &str, mut chat: Conversation) {
        chat.updated_ms = crate::remote::now_ms();
        let mut d = self.data.lock().unwrap();
        if !chat.id.is_empty() { self.persist(&chat); d.chats.insert(chat.id.clone(), chat.clone()); }
        d.slots.insert(slot.into(), chat);
    }
    pub fn configure(&self, slot: &str, cfg: &SessionConfig) {
        let mut d = self.data.lock().unwrap();
        let c = d.slots.entry(slot.into()).or_insert_with(|| Conversation { id: String::new(), folder: cfg.folder.display().to_string(), provider: cfg.provider, endpoint: None, native_id: String::new(), model: None, effort: None, updated_ms: 0, events: vec![] });
        c.provider = cfg.provider;
        c.endpoint = cfg.endpoint.as_ref().map(|e| e.id.clone());
        c.folder = cfg.folder.display().to_string();
        c.model = cfg.model.clone();
        c.effort = cfg.effort.clone();
        if !c.id.is_empty() {
            let c = c.clone();
            self.persist(&c);
            d.chats.insert(c.id.clone(), c);
        }
    }
    fn persist(&self, c: &Conversation) {
        let Some(root) = &self.root else { return; };
        if !crate::history::valid_id(&c.id) { return; }
        let saved = (|| -> Result<(), Box<dyn std::error::Error>> {
            use std::io::Write;
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            std::fs::create_dir_all(root)?;
            std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
            let path = root.join(format!("{}.json", c.id));
            let tmp = path.with_extension("json.tmp");
            let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
            file.write_all(&serde_json::to_vec(c)?)?;
            file.sync_all()?;
            std::fs::rename(tmp, path)?;
            Ok(())
        })();
        if let Err(e) = saved { eprintln!("Saving conversation {}: {e}", c.id); }
    }

    /// Called before publishing, including desktop user messages. Never retain streaming deltas,
    /// secrets, or account-wide usage. Completed events replay identically on either client.
    pub fn observe(&self, slot: &str, event: &mut UiEvent) {
        let mut d = self.data.lock().unwrap();
        let Some(c) = d.slots.get_mut(slot) else { return };
        if let UiEvent::SessionStarted { session_id, .. } = event {
            c.native_id = session_id.clone();
            if c.id.is_empty() { c.id = session_id.clone(); }
            *session_id = c.id.clone();
        }
        if matches!(event, UiEvent::TextDelta { .. } | UiEvent::Thinking { .. } | UiEvent::PlanUsage { .. } | UiEvent::WeekUsage { .. } | UiEvent::ShellOutput { .. } | UiEvent::ShellSecret { .. }) { return }
        c.updated_ms = crate::remote::now_ms();
        c.events.push(encode(event));
        if c.id.is_empty() { return; }
        let flush = matches!(event, UiEvent::SessionStarted { .. } | UiEvent::UserText { .. } | UiEvent::TurnDone { .. } | UiEvent::SessionEnded { .. } | UiEvent::ConversationReset | UiEvent::PermissionResolved { .. } | UiEvent::PermissionWithdrawn { .. });
        if flush {
            let c = c.clone();
            d.chats.insert(c.id.clone(), c.clone());
            self.persist(&c);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn switching_preserves_identity_native_session_and_history_across_reload() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::load(Some(dir.path().into()));
        let c = Conversation { id: "aaaa-bbbb".into(), native_id: "aaaa-bbbb".into(), model: None, effort: None, folder: "/p".into(), provider: ProviderId::Claude, endpoint: None, updated_ms: 0, events: vec![serde_json::json!({"kind":"user_text","text":"Fix the bug"})] };
        store.attach("s1", c);
        store.observe("s1", &mut UiEvent::SessionStarted { session_id: "cccc-dddd".into(), model: "gpt".into(), cwd: "/p".into(), permission_mode: "ask".into(), claude_version: "".into() });
        let restored = Store::load(Some(dir.path().into())).get("aaaa-bbbb").unwrap();
        assert_eq!(restored.native_id, "cccc-dddd");
        assert!(restored.words().contains("Fix the bug"));
        assert_eq!(restored.events.last().unwrap()["session_id"], "aaaa-bbbb");
    }
}

impl Store {
    /// Read Codex's native rollouts through its adapter. Do not rewrite CLI files or
    /// create another conversation for a native session already attached to one.
    pub fn import_codex(&self, root: &std::path::Path) {
        fn files(root: &std::path::Path, depth: usize, out: &mut Vec<PathBuf>) {
            if depth == 0 { return; }
            if let Ok(entries) = std::fs::read_dir(root) {
                for e in entries.flatten() {
                    let Ok(kind) = e.file_type() else { continue };
                    if kind.is_dir() { files(&e.path(), depth - 1, out); }
                    else if kind.is_file() && e.path().extension().is_some_and(|x| x == "jsonl") { out.push(e.path()); }
                }
            }
        }
        let mut paths = vec![];
        files(root, 5, &mut paths);
        use std::io::BufRead;
        for path in paths {
            let Ok(file) = std::fs::File::open(&path) else { continue };
            let mut chat = None;
            for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                let payload = &v["payload"];
                if v["type"] == "session_meta" {
                    let (Some(id), Some(folder)) = (payload["id"].as_str(), payload["cwd"].as_str()) else { break };
                    if !crate::history::valid_id(id) { break; }
                    if self.data.lock().unwrap().chats.values().any(|c| c.id == id || c.native_id == id) { break; }
                    chat = Some(Conversation { id: id.into(), native_id: id.into(), model: None, effort: None, folder: folder.into(), provider: ProviderId::Codex, endpoint: None, updated_ms: crate::history::modified_ms(&path), events: vec![] });
                } else if v["type"] == "turn_context" {
                    if let Some(c) = chat.as_mut() {
                        c.model = payload["model"].as_str().map(str::to_string);
                        c.effort = payload["effort"].as_str().map(str::to_string);
                    }
                } else if v["type"] == "response_item" && payload["type"] == "message" {
                    let Some(c) = chat.as_mut() else { continue };
                    let role = payload["role"].as_str().unwrap_or("");
                    if role != "user" && role != "assistant" { continue; }
                    let text = payload["content"].as_array().map(|items| items.iter().filter(|p| p["type"] == "input_text" || p["type"] == "output_text").filter_map(|p|p["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default();
                    if text.trim().is_empty() || text.starts_with("<environment_context>") || text.starts_with("<permissions instructions>") { continue; }
                    let event = if role == "user" { serde_json::json!({"kind":"user_text","text":text,"images":0}) }
                        else { serde_json::json!({"kind":"assistant_text","parent":null,"block_id":format!("imported-{}",c.events.len()),"text":text}) };
                    c.events.push(event);
                }
            }
            if let Some(c) = chat.filter(|c| c.events.iter().any(|e|e["kind"] == "user_text")) {
                self.data.lock().unwrap().chats.insert(c.id.clone(), c);
            }
        }
    }
}

/// Shared wire contract consumed by both clients. The provider's adapter supplies the operations;
/// the clients do not classify providers by their names.
#[derive(Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct ConversationConfiguration {
    pub provider: String,
    pub capabilities: crate::provider::Capabilities,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub models: Vec<String>,
    pub effort_levels: Vec<String>,
}

pub fn merge_search(archived: Vec<Conversation>, query: &str, scope: &crate::history_search::Scope<'_>, result: &mut crate::history_search::Results) {
        if query.trim().chars().count() >= 2 && !result.cancelled {
            let needle = query.trim().to_lowercase();
            for c in archived {
                let folder = scope.moved.get(&c.folder).cloned().unwrap_or_else(||c.folder.clone());
                if !std::path::Path::new(&folder).is_dir() || !c.has_user_messages() { continue; }
                let title = scope.renamed.get(&c.id).or_else(|| scope.titles.get(&c.id)).cloned().unwrap_or_else(||c.title());
                if !title.to_lowercase().contains(&needle) && !c.words().to_lowercase().contains(&needle) { continue; }
                result.chats.retain(|h| h.id != c.id);
                let snippets = c.events.iter().filter(|e| e["kind"] == "user_text" || e["kind"] == "assistant_text").filter_map(|e| {
                    let text = e["text"].as_str()?;
                    text.to_lowercase().contains(&needle).then(|| crate::history_search::Snippet { role: if e["kind"] == "user_text" { "user" } else { "assistant" }, pieces: crate::history_search::highlight_text(text, query, true) })
                }).take(2).collect();
                result.chats.push(crate::history_search::ChatHit { id: c.id, title: crate::history_search::highlight_text(&title, query, false), project: std::path::Path::new(&folder).file_name().unwrap_or_default().to_string_lossy().into(), folder, updated_ms: c.updated_ms, snippets });
            }
            result.chats.sort_by_key(|c| std::cmp::Reverse(c.updated_ms));
            if result.chats.len() > 200 { result.partial = true; result.chats.truncate(200); }
        }
}

/// The private archive retains edit originals for Changes/Restore. Public events still
/// omit them through UiEvent's serialization rule.
pub fn encode(event: &UiEvent) -> Value {
    let mut value = serde_json::to_value(event).unwrap();
    if let UiEvent::EditApplied { original, .. } = event { value["original"] = serde_json::to_value(original).unwrap(); }
    value
}

#[cfg(test)]
mod regression_tests {
    use super::*;
    use serde_json::json;
    fn chat(id: &str) -> Conversation { Conversation { id: id.into(), native_id: id.into(), model: None, effort: None, folder: "/p".into(), provider: ProviderId::Codex, endpoint: None, updated_ms: 0, events: vec![] } }

    #[test]
    fn the_first_user_message_is_kept_when_the_native_id_arrives_later() {
        let store = Store::load(None);
        store.attach("s1", chat(""));
        store.observe("s1", &mut UiEvent::UserText { text: "Keep my first message".into(), at: None, sent_by: Some("desktop".into()), images: 0 });
        store.observe("s1", &mut UiEvent::SessionStarted { session_id: "aaaa".into(), model: "m".into(), cwd: "/p".into(), permission_mode: "ask".into(), claude_version: "".into() });
        assert!(store.get("aaaa").unwrap().words().contains("Keep my first message"));
    }

    #[test]
    fn approval_outcomes_are_durable_before_the_turn_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::load(Some(dir.path().into()));
        store.attach("s1", chat("aaaa"));
        store.observe("s1", &mut UiEvent::PermissionRequested { request_id: "allowed".into(), tool_name: "Bash".into(), input: serde_json::json!({}) });
        store.observe("s1", &mut UiEvent::PermissionResolved { request_id: "allowed".into(), allow: true, by: "desktop".into() });
        store.observe("s1", &mut UiEvent::PermissionRequested { request_id: "cancelled".into(), tool_name: "Bash".into(), input: serde_json::json!({}) });
        store.observe("s1", &mut UiEvent::PermissionWithdrawn { request_id: "cancelled".into() });
        let replay = Store::load(Some(dir.path().into())).get("aaaa").unwrap().replay();
        assert!(replay.iter().any(|e| matches!(e, UiEvent::PermissionResolved { request_id, allow: true, .. } if request_id == "allowed")));
        assert!(replay.iter().any(|e| matches!(e, UiEvent::PermissionWithdrawn { request_id } if request_id == "cancelled")));
    }

    #[test]
    fn the_private_archive_keeps_edit_originals_but_public_events_do_not() {
        let event = UiEvent::EditApplied { parent: None, tool_use_id: "t".into(), path: "a.txt".into(), created: false, hunks: vec![], original: Some("original contents".into()) };
        assert!(serde_json::to_value(&event).unwrap().get("original").is_none());
        let mut c = chat("aaaa");
        c.events = vec![encode(&event), json!({"kind":"user_text","text":"next turn","images":0}), encode(&event)];
        let (edits, before) = c.edits();
        assert_eq!(before, 1);
        assert_eq!(edits, vec![("a.txt".into(),Some("original contents".into())); 2]);
    }

    #[test]
    fn codex_rollouts_import_user_and_assistant_messages_and_do_not_duplicate_switched_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rollout.jsonl");
        let lines = [json!({"type":"session_meta","payload":{"id":"aaaa","cwd":"/p"}}), json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix the retry bug"}]}}), json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Fixed with backoff"}]}})];
        std::fs::write(file, lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        let store = Store::load(None);
        store.import_codex(dir.path());
        let imported = store.get("aaaa").unwrap();
        assert_eq!(imported.provider, ProviderId::Codex);
        assert!(imported.words().contains("Fixed with backoff"));
        assert_eq!(imported.replay().len(), 2);
        store.import_codex(dir.path());
        assert_eq!(store.all().len(), 1);
        let other = Store::load(None);
        let mut switched = chat("bbbb"); switched.native_id = "aaaa".into();
        other.attach("s1", switched);
        other.import_codex(dir.path());
        assert_eq!(other.all().len(), 1);
    }

    #[test]
    fn archive_search_merges_providers_deduplicates_and_respects_renames() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = chat("aaaa"); c.folder = dir.path().display().to_string();
        c.events.push(json!({"kind":"user_text","text":"Fix the retry bug","images":0}));
        let mut renamed = HashMap::new(); renamed.insert("aaaa".into(), "Backoff work".into());
        let titles = HashMap::new(); let moved = HashMap::new();
        let scope = crate::history_search::Scope { titles: &titles, renamed: &renamed, moved: &moved };
        let mut result = crate::history_search::Results::default();
        merge_search(vec![c.clone(),c], "RETRY", &scope, &mut result);
        assert_eq!(result.chats.len(), 1);
        assert_eq!(result.chats[0].title[0].text, "Backoff work");
        assert_eq!(result.chats[0].snippets[0].role, "user");
    }

    #[test]
    fn handoff_keeps_the_goal_and_latest_messages_without_cutting_unicode_bytes() {
        let mut c = chat("aaaa");
        c.events = vec![json!({"kind":"user_text","text":format!("Goal {} latest", "مرحبا".repeat(50)),"images":0})];
        let text = c.handoff(60);
        assert!(text.starts_with("User: Goal")); assert!(text.ends_with("latest"));
        assert!(text.contains("Middle exchanges omitted"));
    }
}
