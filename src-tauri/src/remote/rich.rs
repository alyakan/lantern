//! The words of a notification that say what Claude is asking (the whole command, the file and what changes), for a phone that
//! made a push key and a user who turned "Show what Claude asks in notifications" on. The words are encrypted with the phone's
//! key (ChaCha20-Poly1305) and ride in the push beside the generic ones; the phone's notification extension decrypts them and
//! swaps them in, so Apple carries only bytes it can't read. If the extension can't (no key, a bad tag, any trouble) the generic
//! words are shown, as they always were.
//!
//! The format, shared with the extension (mobile/src/protocol/push-vector.json is checked by both): `enc` is the standard base64
//! of `nonce(12) || ciphertext || tag(16)`; the key is 32 bytes; the AAD is `lantern.push.v1:` and the chat's slot; the plaintext
//! is JSON `{"title", "subtitle"?, "body"}`.

use super::live_activity::{Alert, Needs};
use super::pairing::PUSH_KEY_LEN;
use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305};
use serde_json::Value;

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

fn aad(slot: &str) -> Vec<u8> {
    format!("{AAD_PREFIX}{slot}").into_bytes()
}

/// Encrypts `plaintext` for the chat `slot` with the phone's key (standard base64, 32 bytes).
pub fn seal(key: &str, slot: &str, plaintext: &[u8]) -> Result<String, String> {
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).map_err(|e| format!("No randomness for a nonce: {e}"))?;
    seal_with_nonce(key, slot, plaintext, nonce)
}

fn cipher(key: &str) -> Result<LessSafeKey, String> {
    let bytes = B64.decode(key).map_err(|_| "The push key isn't base64.".to_string())?;
    if bytes.len() != PUSH_KEY_LEN {
        return Err("The push key isn't 32 bytes.".into());
    }
    UnboundKey::new(&CHACHA20_POLY1305, &bytes).map(LessSafeKey::new).map_err(|_| "The push key isn't usable.".to_string())
}

fn seal_with_nonce(key: &str, slot: &str, plaintext: &[u8], nonce: [u8; 12]) -> Result<String, String> {
    let key = cipher(key)?;
    let mut buffer = plaintext.to_vec();
    key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(aad(slot)), &mut buffer).map_err(|_| "Couldn't encrypt.".to_string())?;
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

/// A file's path as the chat's folder sees it: without the folder, which is long and the same for every prompt.
fn shown_path(path: &str, folder: Option<&str>) -> String {
    let relative = folder.and_then(|f| path.strip_prefix(f.trim_end_matches('/'))).and_then(|p| p.strip_prefix('/')).unwrap_or(path);
    clip(&visible(relative), 120)
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

fn edit_text(tool: &str, input: &Value, folder: Option<&str>) -> Option<String> {
    let path = input["file_path"].as_str().or_else(|| input["notebook_path"].as_str())?;
    let change = change_of(tool, input);
    let verb = if tool == "Write" { "write" } else { "change" };
    let mut out = format!("Wants to {verb} {}", shown_path(path, folder));
    if change.whole {
        out.push_str(&format!("\n{} {}", change.added.len(), if change.added.len() == 1 { "line" } else { "lines" }));
        for l in change.added.iter().take(FILE_LINES) {
            out.push_str(&format!("\n{}", clip(&visible(l), LINE_MAX)));
        }
        if change.added.len() > FILE_LINES {
            out.push_str("\n…");
        }
    } else {
        out.push_str(&format!("\n+{} −{}", change.added.len(), change.removed.len()));
        for (mark, lines) in [("−", &change.removed), ("+", &change.added)] {
            for l in lines.iter().take(CHANGE_LINES) {
                out.push_str(&format!("\n{mark} {}", clip(&visible(l), LINE_MAX)));
            }
            if lines.len() > CHANGE_LINES {
                out.push_str(&format!("\n{mark} …"));
            }
        }
    }
    Some(out)
}

fn tool_text(tool: &str, input: &Value) -> String {
    let name = match tool.strip_prefix("mcp__").and_then(|r| r.split_once("__")) {
        Some((server, t)) => format!("{server}: {}", t.replace('_', " ")),
        None => tool.to_string(),
    };
    let mut out = format!("Wants to use {}", clip(&visible(&name), 80));
    if let Some(map) = input.as_object() {
        for (k, v) in map.iter().take(TOOL_KEYS) {
            let value = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            out.push_str(&format!("\n{}: {}", clip(&visible(k), 30), clip(&visible(&value.replace('\n', " ")), TOOL_VALUE)));
        }
        if map.len() > TOOL_KEYS {
            out.push_str("\n…");
        }
    }
    out
}

fn question_text(input: &Value) -> Option<String> {
    let q = input["questions"].as_array()?.first()?;
    let mut out = format!("Has a question:\n{}", clip(&visible(q["question"].as_str()?), 400));
    for o in q["options"].as_array().map(Vec::as_slice).unwrap_or_default().iter().take(4) {
        if let Some(label) = o["label"].as_str() {
            out.push_str(&format!("\n• {}", clip(&visible(label), 60)));
        }
    }
    Some(out)
}

/// What a prompt asks, in words for a notification: the command, the file and what changes, the tool and what it is given, or the
/// question. None for a plan or a merge (read in the app) and for anything without words to show.
pub fn prompt_text(needs: Needs, tool: &str, input: &Value, folder: Option<&str>) -> Option<String> {
    let text = match needs {
        Needs::Command => format!("Wants to run:\n{}", visible(input["command"].as_str()?.trim())),
        Needs::Edit => edit_text(tool, input, folder)?,
        Needs::Tool => tool_text(tool, input),
        Needs::Question => question_text(input)?,
        Needs::Approval => return None,
    };
    if text.len() <= BODY_MAX {
        return Some(text);
    }
    Some(format!("{}{MORE}", clip(&text, BODY_MAX - MORE.len()).trim_end_matches('…')))
}

/// `base` (the generic notification) with the real words sealed in for the phone's extension: the generic words stay as they are,
/// the push is marked mutable, and `enc` joins the data. None when it can't be done (a bad key, or a push too big for Apple),
/// which leaves the generic one to go.
pub fn sealed_alert(base: &Alert, key: &str, slot: &str, title: &str, subtitle: Option<&str>, body: &str) -> Option<Alert> {
    let mut words = serde_json::json!({"title": clip(&visible(title), TITLE_MAX), "body": body});
    if let Some(s) = subtitle {
        words["subtitle"] = clip(&visible(s), TITLE_MAX).into();
    }
    let enc = seal(key, slot, words.to_string().as_bytes()).ok()?;
    let mut out = base.body.clone();
    out["aps"]["mutable-content"] = 1.into();
    out["body"]["enc"] = enc.into();
    (out.to_string().len() <= PUSH_LIMIT).then_some(Alert { body: out })
}

/// What the phone's extension does, for the tests: opens what `seal` made, or None.
#[cfg(test)]
pub(crate) fn open(key: &str, slot: &str, enc: &str) -> Option<Vec<u8>> {
    let bytes = B64.decode(enc).ok()?;
    let (nonce, sealed) = bytes.split_at_checked(12)?;
    let mut buffer = sealed.to_vec();
    let plain = cipher(key).ok()?.open_in_place(Nonce::try_assume_unique_for_key(nonce).ok()?, Aad::from(aad(slot)), &mut buffer).ok()?;
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

    #[test]
    fn the_sealed_bytes_are_the_ones_another_implementation_made_and_open_to_the_words() {
        let v = vector();
        let (key, slot) = (v["key_b64"].as_str().unwrap(), v["slot"].as_str().unwrap());
        let nonce: [u8; 12] = B64.decode(v["nonce_b64"].as_str().unwrap()).unwrap().try_into().unwrap();
        let plaintext = v["plaintext"].as_str().unwrap();
        assert_eq!(seal_with_nonce(key, slot, plaintext.as_bytes(), nonce).unwrap(), v["enc"].as_str().unwrap());
        assert_eq!(open(key, slot, v["enc"].as_str().unwrap()).unwrap(), plaintext.as_bytes());
    }

    #[test]
    fn what_is_sealed_for_one_chat_does_not_open_for_another_or_when_changed() {
        let v = vector();
        let key = v["key_b64"].as_str().unwrap();
        let enc = seal(key, "chat-1", b"words").unwrap();
        assert_eq!(open(key, "chat-1", &enc).unwrap(), b"words");
        assert!(open(key, "chat-2", &enc).is_none());
        let mut bytes = B64.decode(&enc).unwrap();
        bytes[14] ^= 1;
        assert!(open(key, "chat-1", &B64.encode(bytes)).is_none());
        // Each push has its own nonce.
        assert_ne!(seal(key, "chat-1", b"words").unwrap(), enc);
    }

    #[test]
    fn a_key_that_is_not_32_bytes_of_base64_seals_nothing() {
        assert!(seal("not base64!", "a", b"x").is_err());
        assert!(seal(&B64.encode([1u8; 16]), "a", b"x").is_err());
    }

    #[test]
    fn a_command_is_shown_whole_and_what_cannot_be_seen_is_spelled_out() {
        let t = prompt_text(Needs::Command, "Bash", &json!({"command": "ls && rm -rf ~"}), None).unwrap();
        assert_eq!(t, "Wants to run:\nls && rm -rf ~");
        // A right-to-left override, a zero-width space and an escape are each named, so the line reads as it is.
        let t = prompt_text(Needs::Command, "Bash", &json!({"command": "echo \u{202E}evil\u{200B}\u{1b}[31m"}), None).unwrap();
        assert!(t.contains("⟦U+202E⟧") && t.contains("⟦U+200B⟧") && t.contains("⟦U+001B⟧"), "{t}");
        assert!(!t.contains('\u{202E}') && !t.contains('\u{200B}') && !t.contains('\u{1b}'));
    }

    #[test]
    fn a_long_command_is_cut_and_says_the_rest_is_in_the_app() {
        let t = prompt_text(Needs::Command, "Bash", &json!({"command": "x".repeat(5000)}), None).unwrap();
        assert!(t.len() <= BODY_MAX && t.ends_with("(the rest is in the app)"), "{}", t.len());
        // On a character, however many bytes it takes.
        let t = prompt_text(Needs::Command, "Bash", &json!({"command": "é".repeat(3000)}), None).unwrap();
        assert!(t.len() <= BODY_MAX);
    }

    #[test]
    fn an_edit_names_the_file_without_the_folder_and_shows_a_few_changed_lines() {
        let input = json!({"file_path": "/Users/a/proj/src/main.rs", "old_string": "let a = 1;\nlet b = 2;", "new_string": "let a = 10;\nlet b = 20;\nlet c = 30;\nlet d = 40;"});
        let t = prompt_text(Needs::Edit, "Edit", &input, Some("/Users/a/proj")).unwrap();
        assert_eq!(t, "Wants to change src/main.rs\n+4 −2\n− let a = 1;\n− let b = 2;\n+ let a = 10;\n+ let b = 20;\n+ let c = 30;\n+ …");
        // A file outside the folder keeps its whole path.
        assert!(prompt_text(Needs::Edit, "Edit", &input, Some("/Users/b/other")).unwrap().starts_with("Wants to change /Users/a/proj/src/main.rs"));
    }

    #[test]
    fn a_new_file_a_multi_edit_and_a_notebook_each_say_what_they_do() {
        let t = prompt_text(Needs::Edit, "Write", &json!({"file_path": "/p/new.txt", "content": "a\nb\nc\nd\ne\nf"}), Some("/p")).unwrap();
        assert_eq!(t, "Wants to write new.txt\n6 lines\na\nb\nc\nd\n…");
        let t = prompt_text(Needs::Edit, "MultiEdit", &json!({"file_path": "/p/x.ts", "edits": [{"old_string": "a", "new_string": "b"}, {"old_string": "c\nd", "new_string": "e"}]}), Some("/p")).unwrap();
        assert!(t.starts_with("Wants to change x.ts\n+2 −3"), "{t}");
        let t = prompt_text(Needs::Edit, "NotebookEdit", &json!({"notebook_path": "/p/n.ipynb", "new_source": "print(1)"}), Some("/p")).unwrap();
        assert_eq!(t, "Wants to change n.ipynb\n+1 −0\n+ print(1)");
    }

    #[test]
    fn a_tool_says_its_name_and_a_few_of_what_it_is_given() {
        let t = prompt_text(Needs::Tool, "mcp__linear__create_issue", &json!({"title": "Fix it", "team": "ENG"}), None).unwrap();
        assert!(t.starts_with("Wants to use linear: create issue") && t.contains("title: Fix it") && t.contains("team: ENG"), "{t}");
        assert_eq!(prompt_text(Needs::Tool, "WebFetch", &json!({}), None).unwrap(), "Wants to use WebFetch");
    }

    #[test]
    fn a_question_is_shown_with_its_options_and_a_plan_or_merge_with_nothing() {
        let input = json!({"questions": [{"question": "Which database?", "options": [{"label": "Postgres"}, {"label": "SQLite"}]}]});
        assert_eq!(prompt_text(Needs::Question, "AskUserQuestion", &input, None).unwrap(), "Has a question:\nWhich database?\n• Postgres\n• SQLite");
        assert!(prompt_text(Needs::Approval, "ExitPlanMode", &json!({"plan": "x"}), None).is_none());
        assert!(prompt_text(Needs::Command, "Bash", &json!({}), None).is_none());
    }

    #[test]
    fn the_sealed_push_keeps_its_generic_words_and_adds_the_marker_and_the_words() {
        let v = vector();
        let key = v["key_b64"].as_str().unwrap();
        let base = Alert { body: json!({"aps": {"alert": {"title": "Lantern", "body": "A chat wants to run a command."}, "sound": "default", "thread-id": "a", "category": "lantern_decide"}, "body": {"slot": "a", "kind": "needs_you", "request_id": "r1"}}) };
        let sealed = sealed_alert(&base, key, "a", "Release 0.1.70", Some("Fix the build"), "Wants to run:\ngit push").unwrap();
        assert_eq!(sealed.body["aps"]["alert"]["body"], "A chat wants to run a command.");
        assert_eq!(sealed.body["aps"]["category"], "lantern_decide");
        assert_eq!(sealed.body["aps"]["mutable-content"], 1);
        assert_eq!(sealed.body["body"]["request_id"], "r1");
        let words: Value = serde_json::from_slice(&open(key, "a", sealed.body["body"]["enc"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!(words, json!({"title": "Release 0.1.70", "subtitle": "Fix the build", "body": "Wants to run:\ngit push"}));
        // A key that isn't one leaves the generic push to go.
        assert!(sealed_alert(&base, "nope", "a", "t", None, "b").is_none());
        // The generic one is untouched.
        assert!(base.body["aps"].get("mutable-content").is_none() && base.body["body"].get("enc").is_none());
    }

    #[test]
    fn a_push_that_would_be_too_big_for_apple_goes_with_generic_words_only() {
        let key = vector()["key_b64"].as_str().unwrap().to_string();
        let base = Alert { body: json!({"aps": {"alert": {"title": "Lantern", "body": "x".repeat(3000)}}, "body": {"slot": "a"}}) };
        assert!(sealed_alert(&base, &key, "a", "t", None, &"y".repeat(1500)).is_none());
    }
}
