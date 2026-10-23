//! A stand-in for the app behind the gateway (see gateway::Host): three scripted chats and the way Claude answers them,
//! so the phone app can be tried and tested against the real gateway without a Mac's chats (the example
//! `fixture_gateway` serves it; the phone's integration tests and a simulator connect to that).
//!
//! The chats: "Release 0.1.53" is waiting on you (a permission to push, and a question); "Mobile gateway design" is
//! working; "Network tab filters" is asleep, with 30 turns of history to page through.

use super::bus::EventBus;
use super::gateway::{BoxFut, Host};
use super::hub::{SessionHub, Since};

use super::{now_ms, Remote, WindowChat};
use crate::history::{self, Page};
use crate::permission::bridge::Pending;
use crate::ui_event::{Hunk, UiEvent};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const RELEASE: &str = "release";
pub const DESIGN: &str = "design";
pub const NETWORK: &str = "network";

pub const PUSH_PROMPT: &str = "perm-fixture-push";
pub const QUESTION_PROMPT: &str = "perm-fixture-question";

pub struct FixtureHost {
    bus: Arc<EventBus>,
    hub: Arc<SessionHub>,
    pending: Mutex<HashMap<String, Vec<Pending>>>,
    history: HashMap<String, Vec<UiEvent>>,
    /// How long Claude's scripted answers take between steps.
    pace: Duration,
    /// How many chats a phone has started here (they are "new1", "new2"…).
    started: AtomicUsize,
}

/// The projects the fixture offers to start a chat in.
pub const PROJECTS: [(&str, &str); 2] = [("/Users/you/dev/lantern", "lantern"), ("/Users/you/dev/website", "website")];

/// What the fixture's "Claude" suggests: a chat to carry on, another to carry on, and a new chat in a project.
pub const SUGGESTIONS: &str = r#"[
  {"kind":"continue","slot":"release","title":"Write the 0.1.53 release notes","why":"The release branch is cut and only waiting on a push.","message":"Once the push goes through, write the release notes for 0.1.53 from the commits since 0.1.52."},
  {"kind":"continue","slot":"design","title":"Ask for the design's risks","why":"The gateway design is still being drafted.","message":"List the three biggest risks in this design and how we would test each one."},
  {"kind":"new","project":"website","title":"Check the footer links","why":"A quick tidy while nothing is waiting on you.","message":"Check every link in the footer and fix the ones that are broken."}
]"#;

/// A chat's title from the first thing said in it: its first line, cut short.
fn title_of(text: &str) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("New chat").trim();
    if line.chars().count() > 40 {
        format!("{}…", line.chars().take(39).collect::<String>().trim_end())
    } else {
        line.to_string()
    }
}

fn user(text: &str, at: u64) -> UiEvent {
    UiEvent::UserText { text: text.into(), at: Some(at), sent_by: None }
}

/// What Claude says once what it asked is answered, as a person would say it (not the answers' JSON).
fn in_words(allow: bool, updated_input: Option<&serde_json::Value>) -> String {
    match updated_input {
        Some(input) => {
            let chosen: Vec<&str> = input["answers"].as_object().map(|a| a.values().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
            if chosen.is_empty() {
                "Thanks, that settles it.".into()
            } else {
                format!("Thanks, going with {}.", chosen.join(" and "))
            }
        }
        None if allow => "Allowed, carrying on.".into(),
        None => "Understood, I won't do that.".into(),
    }
}

fn said(block: &str, text: &str) -> UiEvent {
    UiEvent::AssistantText { parent: None, block_id: block.into(), text: text.into() }
}

fn done(result: &str) -> UiEvent {
    UiEvent::TurnDone { is_error: false, result: Some(result.into()), cost_usd: None, tokens: None, session_cost_usd: None, session_tokens: 0, duration_ms: Some(3000), auth_hint: false, denied: 0, context_window: None }
}

impl FixtureHost {
    /// The scripted chats, opened on `remote`'s bus and hub; `pace` is the pause between Claude's scripted steps.
    pub fn new(remote: &Remote, pace: Duration) -> Arc<Self> {
        Self::build(remote, pace, true)
    }

    /// The same chats with nothing waiting on the user (no permission, no question): Home shows what Claude suggests.
    pub fn calm(remote: &Remote, pace: Duration) -> Arc<Self> {
        Self::build(remote, pace, false)
    }

    fn build(remote: &Remote, pace: Duration, waiting: bool) -> Arc<Self> {
        let (bus, hub) = (remote.bus.clone(), remote.hub.clone());
        let chat = |slot: &str, title: &str, asleep: bool| WindowChat { slot: slot.into(), folder: "/Users/you/dev/lantern".into(), title: title.into(), asleep, session_id: Some(format!("session-{slot}")), permissions: None, preset: None, color: None, workflow: None };

        let mut history: HashMap<String, Vec<UiEvent>> = HashMap::new();
        history.insert(
            RELEASE.into(),
            vec![
                user("Cut 0.1.53 with the context menu fix, same flow as last time.", 1_000),
                said("r1", "Bumping the version in the three places it lives, then running the tests."),
                UiEvent::ToolStarted { parent: None, tool_use_id: "t1".into(), name: "Edit".into(), summary: "package.json".into() },
                UiEvent::EditApplied { parent: None, tool_use_id: "t1".into(), path: "/Users/you/dev/lantern/package.json".into(), created: false, hunks: vec![Hunk { old_start: 3, old_lines: 1, new_start: 3, new_lines: 1, lines: vec!["-  \"version\": \"0.1.52\"".into(), "+  \"version\": \"0.1.53\"".into()] }], original: None },
                UiEvent::ToolFinished { parent: None, tool_use_id: "t1".into(), is_error: false, output: String::new() },
                done("Bumped."),
            ],
        );
        // Thirty turns, so "Show earlier messages" has something to bring.
        history.insert(NETWORK.into(), (0..30).flat_map(|i| [user(&format!("Question {i}"), 10_000 + i), said(&format!("n{i}"), &format!("Answer {i}")), done("ok")]).collect());
        history.insert(DESIGN.into(), vec![user("Draft the gateway's design.", 2_000), said("d1", "Starting with the session hub.")]);

        let host = Arc::new(Self { bus: bus.clone(), hub: hub.clone(), pending: Mutex::default(), history, pace, started: AtomicUsize::new(0) });

        hub.opened(RELEASE, "/Users/you/dev/lantern");
        hub.opened(DESIGN, "/Users/you/dev/lantern");
        remote.window_chats(&[chat(RELEASE, "Release 0.1.53", false), chat(DESIGN, "Mobile gateway design", false), chat(NETWORK, "Network tab filters", true)]);

        // Release: a second turn is waiting on two things (unless it is calm).
        if waiting {
            Self::wait_on_release(&bus, &host);
        }

        // Design: working.
        bus.publish(DESIGN, UiEvent::UserText { text: "Keep going.".into(), at: Some(now_ms()), sent_by: Some("desktop".into()) });
        bus.publish(DESIGN, UiEvent::Thinking { parent: None });
        host
    }

    fn wait_on_release(bus: &Arc<EventBus>, host: &Arc<Self>) {
        bus.publish(RELEASE, UiEvent::UserText { text: "Go ahead and push it.".into(), at: Some(now_ms()), sent_by: Some("desktop".into()) });
        let push = Pending { request_id: PUSH_PROMPT.into(), tool_name: "Bash".into(), input: serde_json::json!({"command": "git push origin release/0.1.53", "description": "Push the release branch"}), at: now_ms() };
        let question = Pending {
            request_id: QUESTION_PROMPT.into(),
            tool_name: "AskUserQuestion".into(),
            input: serde_json::json!({"questions": [{"question": "Which channel?", "header": "Channel", "options": [{"label": "Stable", "description": "Everyone gets it"}, {"label": "Beta", "description": "Testers first"}], "multiSelect": false}]}),
            at: now_ms() + 1,
        };
        for p in [&push, &question] {
            bus.publish(RELEASE, UiEvent::PermissionRequested { request_id: p.request_id.clone(), tool_name: p.tool_name.clone(), input: p.input.clone() });
        }
        host.pending.lock().unwrap().insert(RELEASE.into(), vec![push, question]);
    }

    /// Claude's scripted answer to a message or an answered prompt: thinking, an answer in pieces, and the turn's end.
    fn reply(&self, slot: &str, to: String) {
        let (bus, pace, slot) = (self.bus.clone(), self.pace, slot.to_string());
        let block = format!("reply-{}", now_ms());
        tokio::spawn(async move {
            tokio::time::sleep(pace).await;
            bus.publish(&slot, UiEvent::Thinking { parent: None });
            let text = format!("You said: {to}");
            for piece in text.as_bytes().chunks(8) {
                tokio::time::sleep(pace).await;
                bus.publish(&slot, UiEvent::TextDelta { parent: None, block_id: block.clone(), text: String::from_utf8_lossy(piece).into_owned() });
            }
            bus.publish(&slot, UiEvent::AssistantText { parent: None, block_id: block, text });
            bus.publish(&slot, done("ok"));
        });
    }
}

impl Host for FixtureHost {
    fn send(&self, slot: String, text: String, by: String) -> BoxFut<Result<(), String>> {
        self.bus.publish(&slot, UiEvent::UserText { text: text.clone(), at: Some(now_ms()), sent_by: Some(by) });
        self.reply(&slot, text);
        Box::pin(async { Ok(()) })
    }

    fn interrupt(&self, slot: String) -> BoxFut<Result<(), String>> {
        for p in self.pending.lock().unwrap().remove(&slot).unwrap_or_default() {
            self.bus.publish(&slot, UiEvent::PermissionWithdrawn { request_id: p.request_id });
        }
        self.bus.publish(&slot, done("Stopped."));
        Box::pin(async { Ok(()) })
    }

    fn pending(&self, slot: &str) -> Vec<Pending> {
        self.pending.lock().unwrap().get(slot).cloned().unwrap_or_default()
    }

    fn answer(&self, slot: &str, request_id: &str, allow: bool, _message: Option<String>, updated_input: Option<serde_json::Value>, by: &str) -> Result<(), String> {
        let mut pending = self.pending.lock().unwrap();
        let list = pending.get_mut(slot).ok_or("That was answered already.")?;
        let at = list.iter().position(|p| p.request_id == request_id).ok_or("That was answered already.")?;
        list.remove(at);
        drop(pending);
        self.bus.publish(slot, UiEvent::PermissionResolved { request_id: request_id.into(), allow, by: by.into() });
        if self.pending(slot).is_empty() {
            self.reply(slot, in_words(allow, updated_input.as_ref()));
        }
        Ok(())
    }

    fn wake(&self, slot: &str) -> Result<(), String> {
        self.bus.publish(slot, UiEvent::SessionStarted { session_id: format!("session-{slot}"), model: "fixture".into(), cwd: "/Users/you/dev/lantern".into(), permission_mode: "auto".into(), claude_version: "fixture".into() });
        Ok(())
    }

    fn projects(&self) -> BoxFut<Vec<(String, String)>> {
        Box::pin(async { PROJECTS.iter().map(|(f, n)| (f.to_string(), n.to_string())).collect() })
    }

    fn close(&self, slot: &str) -> Result<(), String> {
        self.hub.closed(slot);
        Ok(())
    }

    /// A scripted terminal: it says it ran the command. One with "password" in it asks for one (a secret prompt) and ends when
    /// answered; one with "sleep" in it keeps running until stopped.
    fn shell_run(&self, slot: String, id: String, command: String) -> BoxFut<Result<(), String>> {
        let (bus, pace) = (self.bus.clone(), self.pace);
        bus.publish(&slot, UiEvent::ShellStarted { id: id.clone(), command: command.clone() });
        tokio::spawn(async move {
            tokio::time::sleep(pace).await;
            if command.contains("password") {
                bus.publish(&slot, UiEvent::ShellOutput { id: id.clone(), text: "Password: ".into() });
                bus.publish(&slot, UiEvent::ShellSecret { id, secret: true });
            } else if command.contains("sleep") {
                bus.publish(&slot, UiEvent::ShellOutput { id, text: "waiting…\n".into() });
            } else {
                bus.publish(&slot, UiEvent::ShellOutput { id: id.clone(), text: format!("ran: {command}\n") });
                bus.publish(&slot, UiEvent::ShellDone { id, code: Some(0), stopped: false });
            }
        });
        Box::pin(async { Ok(()) })
    }

    fn shell_input(&self, slot: String, id: String, _text: String) -> BoxFut<Result<(), String>> {
        self.bus.publish(&slot, UiEvent::ShellSecret { id: id.clone(), secret: false });
        self.bus.publish(&slot, UiEvent::ShellOutput { id: id.clone(), text: "\nthanks\n".into() });
        self.bus.publish(&slot, UiEvent::ShellDone { id, code: Some(0), stopped: false });
        Box::pin(async { Ok(()) })
    }

    fn shell_stop(&self, slot: &str, id: &str) -> Result<(), String> {
        self.bus.publish(slot, UiEvent::ShellDone { id: id.to_string(), code: None, stopped: true });
        Ok(())
    }

    fn set_permissions(&self, slot: &str, permissions: super::protocol::RemotePermissions) -> Result<(), String> {
        self.hub.controls(slot, permissions.as_str(), None);
        Ok(())
    }

    fn set_preset(&self, slot: &str, preset: &str) -> Result<(), String> {
        let permissions = self.hub.chat(slot).and_then(|c| c.permissions).unwrap_or_else(|| "ask".into());
        self.hub.controls(slot, &permissions, Some(preset));
        Ok(())
    }

    fn set_workflow(&self, slot: &str, workflow: super::protocol::RemoteWorkflow) -> Result<(), String> {
        self.hub.flow(slot, workflow.as_str());
        Ok(())
    }

    fn new_chat(&self, folder: String, text: String, by: String, permissions: super::protocol::RemotePermissions, preset: Option<String>, workflow: super::protocol::RemoteWorkflow) -> BoxFut<Result<String, String>> {
        let slot = format!("new{}", self.started.fetch_add(1, Ordering::SeqCst) + 1);
        self.hub.opened(&slot, &folder);
        self.hub.controls(&slot, permissions.as_str(), preset.as_deref());
        self.hub.flow(&slot, workflow.as_str());
        self.hub.titled(&slot, &title_of(&text));
        self.bus.publish(&slot, UiEvent::UserText { text: text.clone(), at: Some(now_ms()), sent_by: Some(by) });
        self.reply(&slot, text);
        Box::pin(async move { Ok(slot) })
    }

    fn suggest_reply(&self, _prompt: String) -> BoxFut<Result<String, String>> {
        // Claude takes a few seconds to think; here it takes as long as ten of the fixture's pauses.
        let wait = self.pace * 10;
        Box::pin(async move {
            tokio::time::sleep(wait).await;
            Ok(SUGGESTIONS.to_string())
        })
    }

    fn diff(&self, _slot: String, path: String) -> BoxFut<Result<String, String>> {
        Box::pin(async move {
            if path == "/Users/you/dev/lantern/package.json" {
                Ok("--- /Users/you/dev/lantern/package.json\n+++ /Users/you/dev/lantern/package.json\n@@ -3 +3 @@\n-  \"version\": \"0.1.52\"\n+  \"version\": \"0.1.53\"\n".into())
            } else {
                Err("That file wasn't changed in this chat.".into())
            }
        })
    }

    fn history(&self, slot: String, before: Option<usize>) -> BoxFut<Result<Page, String>> {
        let mut events = self.history.get(&slot).cloned().unwrap_or_default();
        if events.is_empty() {
            // A chat a phone started has no transcript file here: what the hub kept of it is its transcript, without the
            // streamed pieces (the finished text is there).
            if let Some(Since::Events(kept) | Since::TooOld { kept }) = self.hub.since(&slot, 0) {
                events = kept.into_iter().map(|e| e.event).filter(|e| !matches!(e, UiEvent::TextDelta { .. } | UiEvent::Thinking { .. })).collect();
            }
        }
        Box::pin(async move { Ok(history::page(events, before, history::PAGE_TURNS)) })
    }

    fn mac_name(&self) -> String {
        "Fixture Mac".into()
    }

    fn app_version(&self) -> String {
        "fixture".into()
    }
}

#[cfg(test)]
mod tests {
    use super::{in_words, title_of};
    use serde_json::json;

    #[test]
    fn a_new_chat_is_titled_by_the_first_line_of_what_it_started_with() {
        assert_eq!(title_of("Fix the login bug"), "Fix the login bug");
        assert_eq!(title_of("\n\n  Fix it  \nand more"), "Fix it");
        assert_eq!(title_of("   "), "New chat");
        let long = title_of(&"word ".repeat(30));
        assert!(long.ends_with('…') && long.chars().count() <= 40, "{long}");
    }

    #[test]
    fn what_claude_says_once_answered_is_a_sentence_not_the_answers_json() {
        assert_eq!(in_words(true, Some(&json!({"answers": {"Which channel?": "Stable"}}))), "Thanks, going with Stable.");
        assert_eq!(in_words(true, Some(&json!({"answers": {"a": "Stable", "b": "Beta"}}))), "Thanks, going with Stable and Beta.");
        assert_eq!(in_words(true, Some(&json!({"answers": {}}))), "Thanks, that settles it.");
        assert_eq!(in_words(true, None), "Allowed, carrying on.");
        assert_eq!(in_words(false, None), "Understood, I won't do that.");
        let said = in_words(true, Some(&json!({"answers": {"Which channel?": "Stable"}})));
        assert!(!said.contains('{') && !said.contains('"'), "{said}");
    }
}
