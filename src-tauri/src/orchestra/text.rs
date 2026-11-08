//! The words of workers, and of the user to them, as the main agent gets them: clipped to a line, and kept from passing
//! for Lantern's own notes (see `untrusted` and `defang`). Moved out of orchestra.rs as it was.

use crate::ui_event::UiEvent;
use serde_json::Value;

pub(super) fn clip(s: &str, max: usize) -> String {
    clip_flagged(s, max).0
}

/// `clip`, and whether it cut anything.
pub(super) fn clip_flagged(s: &str, max: usize) -> (String, bool) {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        (flat, false)
    } else {
        (format!("{}…", flat.chars().take(max).collect::<String>().trim_end()), true)
    }
}

/// What a note and `list_agents` add after a closing message that was cut: fixed words, none of the agent's.
pub(super) fn clipped_hint(id: &str) -> String {
    format!(" (clipped: read_agent with id=\"{id}\" shows the whole message)")
}

/// Brackets, braces, angle brackets and quote marks of every script, which could stand in for the ones a note is made of.
pub(super) const OPENING: &str = "[{<（［｛〈《「『【〔〖〘〚⟦⟨⟪⟬⦃⦅❨❪❬❮❰❲❴﹙﹛﹝‹«";
pub(super) const CLOSING: &str = "]}>）］｝〉》」』】〕〗〙〛⟧⟩⟫⟭⦄⦆❩❫❭❯❱❳❵﹚﹜﹞›»";
pub(super) const QUOTES: &str = "\"“”„‟‘’‚‛＂＇`´";
/// Characters that show nothing but change how text reads: they can split a word a filter looks for, or reverse the order
/// of what follows.
pub(super) fn invisible(c: char) -> bool {
    c.is_control() || matches!(c, '\u{ad}' | '\u{61c}' | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206f}' | '\u{feff}')
}

/// Words a worker wrote (or the user wrote to one, or a file name a worker made) as they go into a note for the main
/// agent, which receives the note as a message from the user. One short line; every kind of bracket, brace and quote
/// turned into a plain one of the harmless kind, so the words can't pass for part of the note, or for a note of their
/// own, or end the quoting around them; invisible characters gone; and "Lantern:" however it is spelled, cased or
/// split. A prompt-injected worker still chooses its words: the note says they are quoted data, and the main agent's
/// prompt says to treat them so.
pub(super) fn untrusted(s: &str, max: usize) -> String {
    untrusted_flagged(s, max).0
}

/// `untrusted`, and whether it cut anything.
pub(super) fn untrusted_flagged(s: &str, max: usize) -> (String, bool) {
    static LANTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let lantern = LANTERN.get_or_init(|| regex::Regex::new(r"(?i)lantern\s*[:：﹕꞉∶։]").expect("a valid pattern"));
    let cleaned: String = s
        .chars()
        // A line break or a tab is a space, not nothing: the words either side of it stay apart.
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !invisible(*c))
        .map(|c| {
            if OPENING.contains(c) {
                '('
            } else if CLOSING.contains(c) {
                ')'
            } else if QUOTES.contains(c) {
                '\''
            } else {
                c
            }
        })
        .collect();
    clip_flagged(&lantern.replace_all(&cleaned, "Lantern -"), max)
}

/// What `read_agent` returns keeps a worker's words as they were (code has brackets and line breaks in it), but not a line
/// that opens like one of Lantern's own notes, which would pass for one in what the main agent reads.
pub(super) fn defang(s: &str) -> String {
    static NOTE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let note = NOTE.get_or_init(|| regex::Regex::new(r"(?i)[\[［【]\s*lantern\s*[:：﹕꞉∶։]").expect("a valid pattern"));
    // Invisible characters could split the word to get past the pattern, so they go first.
    let visible: String = s.chars().filter(|c| !invisible(*c) || c.is_whitespace()).collect();
    note.replace_all(&visible, "(Lantern -").into_owned()
}

/// One entry as `read_agent` shows it: what was said cut to `max` characters, and when it was cut, a fixed line (numbers
/// only, never the agent's words) saying so and how to read the rest: `index` is the entry to ask for, None when there is
/// no more to ask for.
pub(super) fn show_entry(entry: &str, max: usize, index: Option<usize>) -> String {
    let (head, body) = entry.split_once(": ").map_or(("", entry), |(h, b)| (h, b));
    let n = body.chars().count();
    if n <= max {
        return entry.to_string();
    }
    let prefix = if head.is_empty() { String::new() } else { format!("{head}: ") };
    let kept: String = body.chars().take(max).collect();
    let how = match index {
        Some(i) => format!("read_agent with entry={i}"),
        None => "ask the agent to put the rest in a file or send it in pieces".to_string(),
    };
    format!("{prefix}{}… (clipped, {} more characters: {how})", kept.trim_end(), n - max)
}

pub(super) fn clip_keep_lines(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>().trim_end())
    }
}

/// What a permission prompt is about, in a few words.
pub(super) fn permission_summary(tool: &str, input: &Value) -> String {
    let detail = ["command", "file_path", "path", "url"].iter().find_map(|k| input[*k].as_str());
    match detail {
        Some(d) => format!("{}: {}", untrusted(tool, 60), untrusted(d, 120)),
        None => untrusted(tool, 60),
    }
}

/// A worker's entries for `read_agent`: what was said and done on its own thread, one line or paragraph each. What was
/// said is whole; `read_agent` clips it to what it shows.
pub fn condense(events: &[UiEvent]) -> Vec<String> {
    let mut out = Vec::new();
    for ev in events {
        match ev {
            UiEvent::UserText { text, .. } => {
                let text = text.trim();
                if let Some(rest) = text.strip_prefix("[From the lead]").or_else(|| text.strip_prefix("[From the main agent]")) {
                    out.push(format!("lead: {}", rest.trim()));
                } else {
                    out.push(format!("user: {text}"));
                }
            }
            UiEvent::AssistantText { parent: None, text, .. } if !text.trim().is_empty() => out.push(format!("agent: {}", text.trim())),
            UiEvent::ToolStarted { parent: None, name, summary, .. } => out.push(format!("tool {name}: {}", clip(summary, 200))),
            UiEvent::EditApplied { parent: None, path, created, .. } => out.push(format!("{} {path}", if *created { "created" } else { "edited" })),
            UiEvent::ToolFinished { parent: None, is_error: true, output, .. } => out.push(format!("tool error: {}", clip(output, 300))),
            UiEvent::TurnDone { is_error, .. } => out.push(if *is_error { "— turn ended with an error —".into() } else { "— turn ended —".into() }),
            _ => {}
        }
    }
    out
}
