//! The words of a notification that say what Claude is asking (the whole command, the file and what changes), for a phone that
//! made a push key and a user who turned "Show what Claude asks in notifications" on. The words are encrypted with the phone's
//! key (ChaCha20-Poly1305) and ride in the push beside the generic ones; the phone's notification extension decrypts them and
//! swaps them in, so Apple carries only bytes it can't read. If the extension can't (no key, a bad tag, any trouble) the generic
//! words are shown, as they always were.
//!
//! The format, shared with the extension (mobile/src/protocol/push-vector.json is checked by both): `enc` is the standard base64
//! of `nonce(12) || ciphertext || tag(16)`; the key is 32 bytes; the AAD is `lantern.push.v1:<slot>:<request id>` (the id is empty
//! when the push has none), so words can't be moved to another chat's push or to another prompt's Allow button; the plaintext is
//! JSON `{"title", "subtitle"?, "body"}`.
//!
//! The buttons of a notification (Allow, Deny) stay only when the words say the whole of what they would allow: a command or an
//! edit that was cut to fit has none, and the notification opens the app, where it is shown in full.

use super::live_activity::{Alert, Needs};
use super::pairing::PUSH_KEY_LEN;
use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305};
use serde_json::Value;
use std::cell::Cell;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const AAD_PREFIX: &str = "lantern.push.v1:";

/// How many bytes of the prompt a notification carries: a push may hold 4096 in all, and the rest of it is the generic words, the
/// ids, and what encrypting and base64 add. A longer prompt is cut, and says the rest is in the app.
const BODY_MAX: usize = 1500;
const LINE_MAX: usize = 90;
const TITLE_MAX: usize = 100;
/// Lines of a change shown, each way, and lines of a new file.
const CHANGE_LINES: usize = 3;
const FILE_LINES: usize = 4;
/// Keys of a tool's input shown, and how much of each value.
const TOOL_KEYS: usize = 4;
const TOOL_VALUE: usize = 80;
/// A push is refused over 4096 bytes: a notification that would be bigger than this goes with its generic words only.
const PUSH_LIMIT: usize = 3900;

const MORE: &str = "\n… (the rest is in the app)";

fn aad(slot: &str, request_id: &str) -> Vec<u8> {
    format!("{AAD_PREFIX}{slot}:{request_id}").into_bytes()
}

/// Encrypts `plaintext` for the chat `slot` and the prompt `request_id` (empty for a push with none), with the phone's key
/// (standard base64, 32 bytes).
pub fn seal(key: &str, slot: &str, request_id: &str, plaintext: &[u8]) -> Result<String, String> {
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).map_err(|e| format!("No randomness for a nonce: {e}"))?;
    seal_with_nonce(key, slot, request_id, plaintext, nonce)
}

fn cipher(key: &str) -> Result<LessSafeKey, String> {
    let bytes = B64.decode(key).map_err(|_| "The push key isn't base64.".to_string())?;
    if bytes.len() != PUSH_KEY_LEN {
        return Err("The push key isn't 32 bytes.".into());
    }
    UnboundKey::new(&CHACHA20_POLY1305, &bytes).map(LessSafeKey::new).map_err(|_| "The push key isn't usable.".to_string())
}

fn seal_with_nonce(key: &str, slot: &str, request_id: &str, plaintext: &[u8], nonce: [u8; 12]) -> Result<String, String> {
    let key = cipher(key)?;
    let mut buffer = plaintext.to_vec();
    key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(aad(slot, request_id)), &mut buffer).map_err(|_| "Couldn't encrypt.".to_string())?;
    let mut out = nonce.to_vec();
    out.extend(buffer);
    Ok(B64.encode(out))
}

/// Cuts `text` to at most `max` bytes, on a character, with an ellipsis.
fn clip(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max.saturating_sub(3);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", text[..end].trim_end())
}

/// What can't be seen is shown as what it is. A command with a right-to-left mark, a zero-width space or an escape in it would
/// read as something else next to an Allow button; here each such character is spelled `⟦U+XXXX⟧` (a new line and a tab stay).
fn visible(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        let u = c as u32;
        let hidden = (c.is_control() && c != '\n' && c != '\t')
            || matches!(u, 0xAD | 0x61C | 0x180E | 0x200B..=0x200F | 0x2028..=0x202E | 0x2060..=0x206F | 0xFEFF | 0xFFF9..=0xFFFB | 0xE0000..=0xE007F);
        if hidden {
            out.push_str(&format!("⟦U+{u:04X}⟧"));
        } else {
            out.push(c);
        }
    }
    out
}

/// What a prompt asks, in words for a notification, and whether they are the whole of it. `whole` is false as soon as anything
/// was left out to fit (a command or a line cut, changed lines not shown, a tool's input not all listed): the buttons of a
/// notification would otherwise sit beside a harmless-looking part of something bigger.
#[derive(Debug, Clone)]
pub struct Prompt {
    pub text: String,
    pub whole: bool,
}

/// Cuts `text` and notes in `whole` whether anything was lost.
fn fit(text: &str, max: usize, whole: &Cell<bool>) -> String {
    if text.len() > max {
        whole.set(false);
    }
    clip(text, max)
}

/// A file's path as the chat's folder sees it: without the folder, which is long and the same for every prompt.
fn shown_path(path: &str, folder: Option<&str>, whole: &Cell<bool>) -> String {
    let relative = folder.and_then(|f| path.strip_prefix(f.trim_end_matches('/'))).and_then(|p| p.strip_prefix('/')).unwrap_or(path);
    fit(&visible(relative), 120, whole)
}

/// The lines an edit takes away and puts in, and whether it is a whole file written.
struct Change {
    removed: Vec<String>,
    added: Vec<String>,
    whole: bool,
}

fn lines_of(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    text.lines().map(str::to_string).collect()
}

fn change_of(tool: &str, input: &Value) -> Change {
    let pair = |old: &Value, new: &Value| (lines_of(old.as_str().unwrap_or("")), lines_of(new.as_str().unwrap_or("")));
    match tool {
        "Write" => Change { removed: vec![], added: lines_of(input["content"].as_str().unwrap_or("")), whole: true },
        "NotebookEdit" => Change { removed: vec![], added: lines_of(input["new_source"].as_str().unwrap_or("")), whole: false },
        "MultiEdit" => {
            let (mut removed, mut added) = (vec![], vec![]);
            for e in input["edits"].as_array().map(Vec::as_slice).unwrap_or_default() {
                let (r, a) = pair(&e["old_string"], &e["new_string"]);
                removed.extend(r);
                added.extend(a);
            }
            Change { removed, added, whole: false }
        }
        _ => {
            let (removed, added) = pair(&input["old_string"], &input["new_string"]);
            Change { removed, added, whole: false }
        }
    }
}

fn edit_text(tool: &str, input: &Value, folder: Option<&str>, whole: &Cell<bool>) -> Option<String> {
    let path = input["file_path"].as_str().or_else(|| input["notebook_path"].as_str())?;
    let change = change_of(tool, input);
    let verb = if tool == "Write" { "write" } else { "change" };
    let mut out = format!("Wants to {verb} {}", shown_path(path, folder, whole));
    if change.whole {
        out.push_str(&format!("\n{} {}", change.added.len(), if change.added.len() == 1 { "line" } else { "lines" }));
        for l in change.added.iter().take(FILE_LINES) {
            out.push_str(&format!("\n{}", fit(&visible(l), LINE_MAX, whole)));
        }
        if change.added.len() > FILE_LINES {
            whole.set(false);
            out.push_str("\n…");
        }
    } else {
        out.push_str(&format!("\n+{} −{}", change.added.len(), change.removed.len()));
        for (mark, lines) in [("−", &change.removed), ("+", &change.added)] {
            for l in lines.iter().take(CHANGE_LINES) {
                out.push_str(&format!("\n{mark} {}", fit(&visible(l), LINE_MAX, whole)));
            }
            if lines.len() > CHANGE_LINES {
                whole.set(false);
                out.push_str(&format!("\n{mark} …"));
            }
        }
    }
    Some(out)
}

fn tool_text(tool: &str, input: &Value, whole: &Cell<bool>) -> String {
    let name = match tool.strip_prefix("mcp__").and_then(|r| r.split_once("__")) {
        Some((server, t)) => format!("{server}: {}", t.replace('_', " ")),
        None => tool.to_string(),
    };
    let mut out = format!("Wants to use {}", fit(&visible(&name), 80, whole));
    if let Some(map) = input.as_object() {
        for (k, v) in map.iter().take(TOOL_KEYS) {
            let value = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            out.push_str(&format!("\n{}: {}", fit(&visible(k), 30, whole), fit(&visible(&value.replace('\n', " ")), TOOL_VALUE, whole)));
        }
        if map.len() > TOOL_KEYS {
            whole.set(false);
            out.push_str("\n…");
        }
    }
    out
}

fn question_text(input: &Value, whole: &Cell<bool>) -> Option<String> {
    let q = input["questions"].as_array()?.first()?;
    let mut out = format!("Has a question:\n{}", fit(&visible(q["question"].as_str()?), 400, whole));
    let options = q["options"].as_array().map(Vec::as_slice).unwrap_or_default();
    if options.len() > 4 {
        whole.set(false);
    }
    for o in options.iter().take(4) {
        if let Some(label) = o["label"].as_str() {
            out.push_str(&format!("\n• {}", fit(&visible(label), 60, whole)));
        }
    }
    Some(out)
}

/// What a prompt asks, in words for a notification. None for a plan or a merge (read in the app) and for anything without words
/// to show.
pub fn prompt_text(needs: Needs, tool: &str, input: &Value, folder: Option<&str>) -> Option<Prompt> {
    let whole = Cell::new(true);
    let text = match needs {
        Needs::Command => format!("Wants to run:\n{}", visible(input["command"].as_str()?.trim())),
        Needs::Edit => edit_text(tool, input, folder, &whole)?,
        Needs::Tool => tool_text(tool, input, &whole),
        Needs::Question => question_text(input, &whole)?,
        Needs::Approval => return None,
    };
    if text.len() <= BODY_MAX {
        return Some(Prompt { text, whole: whole.get() });
    }
    Some(Prompt { text: format!("{}{MORE}", clip(&text, BODY_MAX - MORE.len()).trim_end_matches('…')), whole: false })
}

/// `base` (the generic notification) with the real words sealed in for the phone's extension: the generic words stay as they are,
/// the push is marked mutable, and `enc` joins the data, bound to this chat and to the prompt id the push itself carries (none
/// when it carries none, so what is authenticated is always what the phone reads beside it). When the words aren't the whole of what a button would allow (`whole` false) the buttons are taken off, so Allow never
/// sits beside part of a command. None when it can't be done (a bad key, or a push too big for Apple), which leaves the generic
/// one to go.
pub fn sealed_alert(base: &Alert, key: &str, slot: &str, title: &str, subtitle: Option<&str>, prompt: &Prompt) -> Option<Alert> {
    let mut words = serde_json::json!({"title": clip(&visible(title), TITLE_MAX), "body": prompt.text});
    if let Some(s) = subtitle {
        words["subtitle"] = clip(&visible(s), TITLE_MAX).into();
    }
    let request_id = base.body["body"]["request_id"].as_str().unwrap_or("");
    let enc = seal(key, slot, request_id, words.to_string().as_bytes()).ok()?;
    let mut out = base.body.clone();
    out["aps"]["mutable-content"] = 1.into();
    out["body"]["enc"] = enc.into();
    if !prompt.whole {
        if let Some(aps) = out["aps"].as_object_mut() {
            aps.remove("category");
        }
    }
    (out.to_string().len() <= PUSH_LIMIT).then_some(Alert { body: out })
}

/// What the phone's extension does, for the tests: opens what `seal` made, or None.
#[cfg(test)]
pub(crate) fn open(key: &str, slot: &str, request_id: &str, enc: &str) -> Option<Vec<u8>> {
    let bytes = B64.decode(enc).ok()?;
    let (nonce, sealed) = bytes.split_at_checked(12)?;
    let mut buffer = sealed.to_vec();
    let plain = cipher(key).ok()?.open_in_place(Nonce::try_assume_unique_for_key(nonce).ok()?, Aad::from(aad(slot, request_id)), &mut buffer).ok()?;
    Some(plain.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The vector node's OpenSSL made (see mobile/src/protocol/push-vector.json): the phone's extension is checked against it too.
    fn vector() -> Value {
        serde_json::from_str(include_str!("../../../mobile/src/protocol/push-vector.json")).unwrap()
    }

    fn text(needs: Needs, tool: &str, input: Value, folder: Option<&str>) -> String {
        prompt_text(needs, tool, &input, folder).unwrap().text
    }

    fn whole(needs: Needs, tool: &str, input: Value) -> bool {
        prompt_text(needs, tool, &input, Some("/p")).unwrap().whole
    }

    #[test]
    fn the_sealed_bytes_are_the_ones_another_implementation_made_and_open_to_the_words() {
        let v = vector();
        let (key, slot, id) = (v["key_b64"].as_str().unwrap(), v["slot"].as_str().unwrap(), v["request_id"].as_str().unwrap());
        let nonce: [u8; 12] = B64.decode(v["nonce_b64"].as_str().unwrap()).unwrap().try_into().unwrap();
        let plaintext = v["plaintext"].as_str().unwrap();
        assert_eq!(seal_with_nonce(key, slot, id, plaintext.as_bytes(), nonce).unwrap(), v["enc"].as_str().unwrap());
        assert_eq!(open(key, slot, id, v["enc"].as_str().unwrap()).unwrap(), plaintext.as_bytes());
    }

    #[test]
    fn what_is_sealed_for_one_chat_and_prompt_does_not_open_for_another_or_when_changed() {
        let v = vector();
        let key = v["key_b64"].as_str().unwrap();
        let enc = seal(key, "chat-1", "req-1", b"words").unwrap();
        assert_eq!(open(key, "chat-1", "req-1", &enc).unwrap(), b"words");
        assert!(open(key, "chat-2", "req-1", &enc).is_none(), "another chat");
        // Words moved to another prompt's Allow button, or to a push with none, do not open.
        assert!(open(key, "chat-1", "req-2", &enc).is_none(), "another prompt");
        assert!(open(key, "chat-1", "", &enc).is_none(), "no prompt");
        let mut bytes = B64.decode(&enc).unwrap();
        bytes[14] ^= 1;
        assert!(open(key, "chat-1", "req-1", &B64.encode(bytes)).is_none());
        // Each push has its own nonce.
        assert_ne!(seal(key, "chat-1", "req-1", b"words").unwrap(), enc);
    }

    #[test]
    fn a_key_that_is_not_32_bytes_of_base64_seals_nothing() {
        assert!(seal("not base64!", "a", "", b"x").is_err());
        assert!(seal(&B64.encode([1u8; 16]), "a", "", b"x").is_err());
    }

    #[test]
    fn a_command_is_shown_whole_and_what_cannot_be_seen_is_spelled_out() {
        let t = prompt_text(Needs::Command, "Bash", &json!({"command": "ls && rm -rf ~"}), None).unwrap();
        assert_eq!((t.text.as_str(), t.whole), ("Wants to run:\nls && rm -rf ~", true));
        // A right-to-left override, a zero-width space and an escape are each named, so the line reads as it is.
        let t = text(Needs::Command, "Bash", json!({"command": "echo \u{202E}evil\u{200B}\u{1b}[31m"}), None);
        assert!(t.contains("⟦U+202E⟧") && t.contains("⟦U+200B⟧") && t.contains("⟦U+001B⟧"), "{t}");
        assert!(!t.contains('\u{202E}') && !t.contains('\u{200B}') && !t.contains('\u{1b}'));
    }

    #[test]
    fn a_long_command_is_cut_says_the_rest_is_in_the_app_and_is_not_whole() {
        let t = prompt_text(Needs::Command, "Bash", &json!({"command": "x".repeat(5000)}), None).unwrap();
        assert!(t.text.len() <= BODY_MAX && t.text.ends_with("(the rest is in the app)") && !t.whole, "{}", t.text.len());
        // On a character, however many bytes it takes.
        assert!(text(Needs::Command, "Bash", json!({"command": "é".repeat(3000)}), None).len() <= BODY_MAX);
        // One that just fits is whole.
        assert!(whole(Needs::Command, "Bash", json!({"command": "x".repeat(1400)})));
    }

    #[test]
    fn an_edit_names_the_file_without_the_folder_and_shows_a_few_changed_lines() {
        let input = json!({"file_path": "/Users/a/proj/src/main.rs", "old_string": "let a = 1;\nlet b = 2;", "new_string": "let a = 10;\nlet b = 20;\nlet c = 30;\nlet d = 40;"});
        let t = prompt_text(Needs::Edit, "Edit", &input, Some("/Users/a/proj")).unwrap();
        assert_eq!(t.text, "Wants to change src/main.rs\n+4 −2\n− let a = 1;\n− let b = 2;\n+ let a = 10;\n+ let b = 20;\n+ let c = 30;\n+ …");
        assert!(!t.whole, "four lines went in and three are shown");
        // A file outside the folder keeps its whole path.
        assert!(text(Needs::Edit, "Edit", input, Some("/Users/b/other")).starts_with("Wants to change /Users/a/proj/src/main.rs"));
    }

    #[test]
    fn a_small_edit_is_whole_and_a_cut_line_or_a_long_one_is_not() {
        assert!(whole(Needs::Edit, "Edit", json!({"file_path": "/p/a.rs", "old_string": "a\nb\nc", "new_string": "x\ny\nz"})));
        assert!(!whole(Needs::Edit, "Edit", json!({"file_path": "/p/a.rs", "old_string": "a\nb\nc\nd", "new_string": "x"})), "four lines taken away");
        assert!(!whole(Needs::Edit, "Edit", json!({"file_path": "/p/a.rs", "old_string": "a", "new_string": "y".repeat(200)})), "a line cut short");
    }

    #[test]
    fn a_new_file_a_multi_edit_and_a_notebook_each_say_what_they_do() {
        let t = prompt_text(Needs::Edit, "Write", &json!({"file_path": "/p/new.txt", "content": "a\nb\nc\nd\ne\nf"}), Some("/p")).unwrap();
        assert_eq!(t.text, "Wants to write new.txt\n6 lines\na\nb\nc\nd\n…");
        assert!(!t.whole);
        assert!(whole(Needs::Edit, "Write", json!({"file_path": "/p/new.txt", "content": "a\nb"})));
        let t = text(Needs::Edit, "MultiEdit", json!({"file_path": "/p/x.ts", "edits": [{"old_string": "a", "new_string": "b"}, {"old_string": "c\nd", "new_string": "e"}]}), Some("/p"));
        assert!(t.starts_with("Wants to change x.ts\n+2 −3"), "{t}");
        assert_eq!(text(Needs::Edit, "NotebookEdit", json!({"notebook_path": "/p/n.ipynb", "new_source": "print(1)"}), Some("/p")), "Wants to change n.ipynb\n+1 −0\n+ print(1)");
    }

    #[test]
    fn a_tool_says_its_name_and_a_few_of_what_it_is_given_and_is_whole_only_if_all_of_it_is_shown() {
        let t = text(Needs::Tool, "mcp__linear__create_issue", json!({"title": "Fix it", "team": "ENG"}), None);
        assert!(t.starts_with("Wants to use linear: create issue") && t.contains("title: Fix it") && t.contains("team: ENG"), "{t}");
        assert_eq!(text(Needs::Tool, "WebFetch", json!({}), None), "Wants to use WebFetch");
        assert!(whole(Needs::Tool, "WebFetch", json!({"url": "https://a.test"})));
        assert!(!whole(Needs::Tool, "WebFetch", json!({"a": 1, "b": 2, "c": 3, "d": 4, "e": 5})), "a fifth thing it is given is not shown");
    }

    #[test]
    fn a_question_is_shown_with_its_options_and_a_plan_or_merge_with_nothing() {
        let input = json!({"questions": [{"question": "Which database?", "options": [{"label": "Postgres"}, {"label": "SQLite"}]}]});
        assert_eq!(text(Needs::Question, "AskUserQuestion", input, None), "Has a question:\nWhich database?\n• Postgres\n• SQLite");
        assert!(prompt_text(Needs::Approval, "ExitPlanMode", &json!({"plan": "x"}), None).is_none());
        assert!(prompt_text(Needs::Command, "Bash", &json!({}), None).is_none());
    }

    fn base() -> Alert {
        Alert { body: json!({"aps": {"alert": {"title": "Lantern", "body": "A chat wants to run a command."}, "sound": "default", "thread-id": "a", "category": "lantern_decide"}, "body": {"slot": "a", "kind": "needs_you", "request_id": "r1"}}) }
    }

    fn prompt(text: &str, whole: bool) -> Prompt {
        Prompt { text: text.into(), whole }
    }

    #[test]
    fn the_sealed_push_keeps_its_generic_words_and_buttons_and_adds_the_marker_and_the_words() {
        let key = vector()["key_b64"].as_str().unwrap().to_string();
        let sealed = sealed_alert(&base(), &key, "a", "Release 0.1.70", Some("Fix the build"), &prompt("Wants to run:\ngit push", true)).unwrap();
        assert_eq!(sealed.body["aps"]["alert"]["body"], "A chat wants to run a command.");
        assert_eq!(sealed.body["aps"]["category"], "lantern_decide");
        assert_eq!(sealed.body["aps"]["mutable-content"], 1);
        assert_eq!(sealed.body["body"]["request_id"], "r1");
        let words: Value = serde_json::from_slice(&open(&key, "a", "r1", sealed.body["body"]["enc"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!(words, json!({"title": "Release 0.1.70", "subtitle": "Fix the build", "body": "Wants to run:\ngit push"}));
        // They open only for this prompt: another prompt's id (or none) does not open them.
        assert!(open(&key, "a", "r2", sealed.body["body"]["enc"].as_str().unwrap()).is_none());
        // A key that isn't one leaves the generic push to go; the generic one is untouched.
        assert!(sealed_alert(&base(), "nope", "a", "t", None, &prompt("b", true)).is_none());
        assert!(base().body["aps"].get("mutable-content").is_none() && base().body["body"].get("enc").is_none());
    }

    #[test]
    fn words_that_are_not_the_whole_of_it_have_no_buttons() {
        let key = vector()["key_b64"].as_str().unwrap().to_string();
        let cut = sealed_alert(&base(), &key, "a", "t", None, &prompt("Wants to run:\nls\n… (the rest is in the app)", false)).unwrap();
        assert!(cut.body["aps"].get("category").is_none(), "Allow never sits beside part of a command");
        // Still sealed, still marked, and the prompt's id still rides along for the app.
        assert_eq!(cut.body["aps"]["mutable-content"], 1);
        assert!(cut.body["body"].get("enc").is_some() && cut.body["body"]["request_id"] == "r1");
    }

    #[test]
    fn a_push_that_would_be_too_big_for_apple_goes_with_generic_words_only() {
        let key = vector()["key_b64"].as_str().unwrap().to_string();
        let big = Alert { body: json!({"aps": {"alert": {"title": "Lantern", "body": "x".repeat(3000)}}, "body": {"slot": "a"}}) };
        assert!(sealed_alert(&big, &key, "a", "t", None, &prompt(&"y".repeat(1500), true)).is_none());
    }
}
