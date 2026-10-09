//! Work that runs off claude's stream: a Workflow's agents, and subagents started with run_in_background. Claude
//! only says they started; what they do is written to transcripts beside the session's own
//! (`<session>/subagents/`), so this follows those files and turns them into the same events as streamed work: each
//! workflow agent an Agent step under its Workflow step, and every agent's own steps under it.

use crate::stream_parser::StreamParser;
use crate::ui_event::{Sink, UiEvent};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const POLL: Duration = Duration::from_millis(500);
/// A watch gives up after this long, ended or not.
const MAX_WATCH: Duration = Duration::from_secs(6 * 3600);

/// What's being followed.
pub enum Source {
    /// A Workflow call and its transcript folder (journal.jsonl, agent-<id>.jsonl).
    Workflow { tool_use_id: String, dir: PathBuf },
    /// A background Agent call; its transcript is the one in `subagents` whose meta names the call.
    Agent { tool_use_id: String, subagents: PathBuf },
}

/// The id a workflow agent's Agent step gets (the chat has no tool call for it): from its journal key, which stays
/// the same when a resumed run starts it again under a new agent id, so a retry continues the same step.
pub fn agent_step_id(entry: &Value) -> String {
    let key = entry["key"].as_str().and_then(|k| k.split(':').nth(1)).map(|h| &h[..h.len().min(16)]);
    format!("wfa-{}", key.or(entry["agentId"].as_str()).unwrap_or("agent"))
}

/// A transcript file read as it grows: complete lines only.
#[derive(Default)]
struct Tail {
    offset: u64,
    partial: String,
}

impl Tail {
    fn new_lines(&mut self, path: &Path) -> Vec<String> {
        let Ok(mut f) = std::fs::File::open(path) else { return vec![] };
        if f.seek(SeekFrom::Start(self.offset)).is_err() {
            return vec![];
        }
        let mut buf = String::new();
        let Ok(n) = f.read_to_string(&mut buf) else { return vec![] };
        self.offset += n as u64;
        self.partial.push_str(&buf);
        let Some(end) = self.partial.rfind('\n') else { return vec![] };
        let complete: String = self.partial.drain(..=end).collect();
        complete.lines().filter(|l| !l.trim().is_empty()).map(String::from).collect()
    }
}

/// One agent's transcript, turned into events as if streamed under `parent`.
struct AgentFeed {
    path: PathBuf,
    parent: String,
    tail: Tail,
    parser: StreamParser,
}

impl AgentFeed {
    fn new(path: PathBuf, parent: String) -> Self {
        AgentFeed { path, parent, tail: Tail::default(), parser: StreamParser::default() }
    }

    fn poll(&mut self, sink: &Sink) {
        for line in self.tail.new_lines(&self.path) {
            let Ok(mut v) = serde_json::from_str::<Value>(&line) else { continue };
            if !matches!(v["type"].as_str(), Some("assistant" | "user")) {
                continue;
            }
            v["parent_tool_use_id"] = Value::String(self.parent.clone());
            for ev in self.parser.parse_line(&v.to_string()) {
                // Its context isn't the conversation's; edits are tracked from disk like any change outside claude.
                if !matches!(ev, UiEvent::ContextUsed { .. } | UiEvent::EditApplied { .. }) {
                    sink(ev);
                }
            }
        }
    }
}

/// A workflow agent as its journal and meta describe it.
fn workflow_agent(dir: &Path, entry: &Value) -> (String, String, String) {
    let id = entry["agentId"].as_str().unwrap_or("").to_string();
    let meta: Value = std::fs::read_to_string(dir.join(format!("agent-{id}.meta.json"))).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let label = entry["label"].as_str().or(meta["description"].as_str()).unwrap_or("agent").to_string();
    let phase = entry["phase"].as_str().or(meta["workflowPhase"].as_str()).unwrap_or("workflow").to_string();
    (id, label, phase)
}

/// The transcript of the subagent that `tool_use_id` started, once its meta file exists.
fn find_agent(subagents: &Path, tool_use_id: &str) -> Option<PathBuf> {
    for e in std::fs::read_dir(subagents).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_prefix("agent-").and_then(|n| n.strip_suffix(".meta.json")) else { continue };
        let meta: Value = std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        if meta["toolUseId"] == tool_use_id {
            return Some(subagents.join(format!("agent-{id}.jsonl")));
        }
    }
    None
}

/// What's been read of a source so far, to read only what's new each time.
struct Follower {
    source: Source,
    journal: Tail,
    feeds: HashMap<String, AgentFeed>,
}

impl Follower {
    fn new(source: Source) -> Self {
        Follower { source, journal: Tail::default(), feeds: HashMap::new() }
    }

    /// Reads what's been written since the last poll and sends it as events.
    fn poll(&mut self, sink: &Sink) {
        let feeds = &mut self.feeds;
        match &self.source {
            Source::Workflow { tool_use_id, dir } => {
                for line in self.journal.new_lines(&dir.join("journal.jsonl")) {
                    let Ok(entry) = serde_json::from_str::<Value>(&line) else { continue };
                    let (id, label, phase) = workflow_agent(dir, &entry);
                    if id.is_empty() {
                        continue;
                    }
                    let step = agent_step_id(&entry);
                    match entry["type"].as_str() {
                        Some("started") if !feeds.contains_key(&id) => {
                            // A retry (a resumed run) carries on in the step its first attempt opened.
                            if !feeds.values().any(|f| f.parent == step) {
                                sink(UiEvent::ToolStarted { parent: Some(tool_use_id.clone()), tool_use_id: step.clone(), name: "Agent".into(), summary: label.clone() });
                                sink(UiEvent::AgentStarted { tool_use_id: step.clone(), subagent_type: phase, description: label, model: None });
                            }
                            feeds.insert(id.clone(), AgentFeed::new(dir.join(format!("agent-{id}.jsonl")), step));
                        }
                        Some(kind @ ("result" | "failed")) => {
                            // What it found came back to the workflow: read the rest of its transcript first.
                            if let Some(f) = feeds.get_mut(&id) {
                                f.poll(sink);
                            }
                            let output = entry["result"].as_str().map(String::from).unwrap_or_else(|| entry["result"].to_string());
                            sink(UiEvent::ToolFinished { parent: Some(tool_use_id.clone()), tool_use_id: step, is_error: kind == "failed", output: crate::stream_parser::truncate(&output, 2000) });
                        }
                        _ => {}
                    }
                }
            }
            Source::Agent { tool_use_id, subagents } => {
                if !feeds.contains_key(tool_use_id) {
                    if let Some(path) = find_agent(subagents, tool_use_id) {
                        feeds.insert(tool_use_id.clone(), AgentFeed::new(path, tool_use_id.clone()));
                    }
                }
            }
        }
        for f in feeds.values_mut() {
            f.poll(sink);
        }
    }
}

/// Everything written so far, at once: for a reopened session, whose background work is over.
pub fn read_once(source: Source) -> Vec<UiEvent> {
    let out = Arc::new(Mutex::new(vec![]));
    let collect = out.clone();
    let sink: Sink = Arc::new(move |e| collect.lock().unwrap().push(e));
    let mut f = Follower::new(source);
    f.poll(&sink);
    // Agents' transcripts open during the first pass are read now.
    f.poll(&sink);
    drop(sink);
    let events = std::mem::take(&mut *out.lock().unwrap());
    events
}

/// Follows `source` until `done` is set (claude said the task ended; a last read then catches what's left) or the
/// session stops.
pub async fn follow(source: Source, sink: Sink, done: Arc<AtomicBool>, stopping: Arc<AtomicBool>) {
    let started = std::time::Instant::now();
    let mut f = Follower::new(source);
    loop {
        let last = done.load(Ordering::SeqCst);
        f.poll(&sink);
        if last || stopping.load(Ordering::SeqCst) || started.elapsed() > MAX_WATCH {
            return;
        }
        tokio::time::sleep(POLL).await;
    }
}

/// The watches a session runs, by the call they follow, so claude saying a task ended can end its watch.
#[derive(Default, Clone)]
pub struct Watches {
    done: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl Watches {
    /// Starts following `source` (once per call).
    pub fn start(&self, source: Source, sink: Sink, stopping: Arc<AtomicBool>) {
        let id = match &source {
            Source::Workflow { tool_use_id, .. } | Source::Agent { tool_use_id, .. } => tool_use_id.clone(),
        };
        let mut done = self.done.lock().unwrap();
        if done.contains_key(&id) {
            return;
        }
        let flag = Arc::new(AtomicBool::new(false));
        done.insert(id, flag.clone());
        tokio::spawn(follow(source, sink, flag, stopping));
    }

    /// Claude says the task this call started has ended: one last read, then stop.
    pub fn ended(&self, tool_use_id: &str) {
        if let Some(flag) = self.done.lock().unwrap().remove(tool_use_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tokio::sync::mpsc;

    fn append(path: &Path, line: &str) {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        writeln!(f, "{line}").unwrap();
    }

    async fn until(rx: &mut mpsc::UnboundedReceiver<UiEvent>, pred: impl Fn(&UiEvent) -> bool) -> Vec<UiEvent> {
        let mut seen = vec![];
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let ev = rx.recv().await.unwrap();
                let stop = pred(&ev);
                seen.push(ev);
                if stop {
                    return;
                }
            }
        })
        .await
        .expect("timed out");
        seen
    }

    #[tokio::test]
    async fn follows_a_workflows_agents_and_their_steps_as_they_are_written() {
        let dir = tempfile::tempdir().unwrap();
        let wf = dir.path();
        std::fs::write(wf.join("agent-a1.meta.json"), r#"{"agentType":"workflow-subagent","description":"propose:reduce","workflowPhase":"Propose"}"#).unwrap();
        append(&wf.join("journal.jsonl"), r#"{"type":"launched"}"#);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sink: Sink = Arc::new(move |e| drop(tx.send(e)));
        let watches = Watches::default();
        watches.start(Source::Workflow { tool_use_id: "toolu_wf".into(), dir: wf.to_path_buf() }, sink, Arc::new(AtomicBool::new(false)));

        append(&wf.join("journal.jsonl"), r#"{"type":"started","key":"v2:x","agentId":"a1","label":"propose:reduce","phase":"Propose"}"#);
        let first = until(&mut rx, |e| matches!(e, UiEvent::AgentStarted { .. })).await;
        assert!(first.contains(&UiEvent::ToolStarted { parent: Some("toolu_wf".into()), tool_use_id: "wfa-x".into(), name: "Agent".into(), summary: "propose:reduce".into() }));
        assert!(first.contains(&UiEvent::AgentStarted { tool_use_id: "wfa-x".into(), subagent_type: "Propose".into(), description: "propose:reduce".into(), model: None }));

        // Its transcript grows: a step, written in two pieces (the first without its line end).
        let t = wf.join("agent-a1.jsonl");
        append(&t, r#"{"type":"user","message":{"role":"user","content":"Propose a design"}}"#);
        let mut f = std::fs::OpenOptions::new().append(true).open(&t).unwrap();
        write!(f, r#"{{"type":"assistant","message":{{"id":"m1","model":"claude-haiku-5-5","content":[{{"type":"tool_use","id":"g1","name":"Glob","#).unwrap();
        drop(f);
        tokio::time::sleep(Duration::from_millis(700)).await;
        append(&t, r#""input":{"pattern":"**/*.swift"}}]}}"#);
        let steps = until(&mut rx, |e| matches!(e, UiEvent::ToolStarted { tool_use_id, .. } if tool_use_id == "g1")).await;
        assert!(steps.contains(&UiEvent::AgentModel { parent: Some("wfa-x".into()), model: "claude-haiku-5-5".into() }));
        assert!(steps.iter().any(|e| matches!(e, UiEvent::ToolStarted { parent: Some(p), name, .. } if p == "wfa-x" && name == "Glob")));

        // A resumed run starts it again under a new id: the same step carries on, no second agent.
        append(&wf.join("journal.jsonl"), r#"{"type":"started","key":"v2:x","agentId":"a2","label":"propose:reduce","phase":"Propose"}"#);
        append(&wf.join("journal.jsonl"), r#"{"type":"result","key":"v2:x","agentId":"a2","result":"Use fewer rows"}"#);
        let end = until(&mut rx, |e| matches!(e, UiEvent::ToolFinished { tool_use_id, .. } if tool_use_id == "wfa-x")).await;
        assert!(!end.iter().any(|e| matches!(e, UiEvent::AgentStarted { .. })));
        assert!(matches!(end.last().unwrap(), UiEvent::ToolFinished { is_error: false, output, .. } if output == "Use fewer rows"));
        watches.ended("toolu_wf");
    }

    #[tokio::test]
    async fn finds_a_background_subagents_transcript_by_its_call() {
        let dir = tempfile::tempdir().unwrap();
        let subs = dir.path();
        std::fs::write(subs.join("agent-other.meta.json"), r#"{"toolUseId":"toolu_x"}"#).unwrap();
        std::fs::write(subs.join("agent-b7.meta.json"), r#"{"agentType":"Explore","toolUseId":"toolu_bg"}"#).unwrap();
        append(&subs.join("agent-b7.jsonl"), r#"{"type":"assistant","message":{"id":"m","model":"claude-haiku-5-5","content":[{"type":"tool_use","id":"r1","name":"Read","input":{"file_path":"/p/a.ts"}}]}}"#);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sink: Sink = Arc::new(move |e| drop(tx.send(e)));
        Watches::default().start(Source::Agent { tool_use_id: "toolu_bg".into(), subagents: subs.to_path_buf() }, sink, Arc::new(AtomicBool::new(false)));
        let evs = until(&mut rx, |e| matches!(e, UiEvent::ToolStarted { .. })).await;
        assert!(evs.iter().any(|e| matches!(e, UiEvent::ToolStarted { parent: Some(p), tool_use_id, .. } if p == "toolu_bg" && tool_use_id == "r1")));
    }

    /// Against a real workflow's folder: LANTERN_WF_DIR=<…/subagents/workflows/wf_…> cargo test real_workflow -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn real_workflow() {
        let dir = PathBuf::from(std::env::var("LANTERN_WF_DIR").expect("LANTERN_WF_DIR"));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sink: Sink = Arc::new(move |e| drop(tx.send(e)));
        let done = Arc::new(AtomicBool::new(true));
        follow(Source::Workflow { tool_use_id: "wf".into(), dir }, sink, done, Arc::new(AtomicBool::new(false))).await;
        let mut agents = vec![];
        let (mut steps, mut models) = (0, std::collections::BTreeSet::new());
        while let Ok(ev) = rx.try_recv() {
            match ev {
                UiEvent::AgentStarted { description, subagent_type, .. } => agents.push(format!("{subagent_type}/{description}")),
                UiEvent::ToolStarted { parent: Some(p), .. } if p.starts_with("wfa-") => steps += 1,
                UiEvent::AgentModel { model, .. } => drop(models.insert(model)),
                _ => {}
            }
        }
        println!("agents: {agents:?}\nsteps: {steps}\nmodels: {models:?}");
        assert!(!agents.is_empty());
    }
}

