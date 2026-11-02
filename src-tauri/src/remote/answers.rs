//! What a phone's answer to a prompt may carry besides allow or deny. Claude Code runs a tool with the input it is
//! answered with, so a phone never sends a tool's input: it may only answer AskUserQuestion's questions, and Lantern
//! adds those answers to the input Claude sent, the way the window does (src/lib/questions.ts). Every answer must be to
//! one of the questions asked.

use serde_json::Value;
use std::collections::BTreeMap;

pub const QUESTION_TOOL: &str = "AskUserQuestion";

/// The longest answer taken.
const ANSWER_MAX: usize = 10_000;

/// The tool's input to run with: `original` with `answers` in it, or why not.
pub fn with_answers(tool_name: &str, original: &Value, answers: &BTreeMap<String, String>) -> Result<Value, String> {
    if tool_name != QUESTION_TOOL {
        return Err("Only a question can be answered with answers.".into());
    }
    let Some(input) = original.as_object() else { return Err("That question can't be answered here.".into()) };
    let questions: Vec<&str> = input.get("questions").and_then(Value::as_array).map(|qs| qs.iter().filter_map(|q| q.get("question").and_then(Value::as_str)).collect()).unwrap_or_default();
    if answers.is_empty() {
        return Err("Those answers aren't to this question.".into());
    }
    let mut out_answers = serde_json::Map::new();
    for (key, a) in answers {
        let asked = asked_as(&questions, key).filter(|_| a.len() <= ANSWER_MAX).ok_or("Those answers aren't to this question.")?;
        // Two answers to one question is not an answer.
        if out_answers.insert(asked.to_string(), Value::String(a.clone())).is_some() {
            return Err("Those answers aren't to this question.".into());
        }
    }
    let mut out = input.clone();
    out.insert("answers".into(), Value::Object(out_answers));
    Ok(Value::Object(out))
}

/// The question asked that a phone's `key` is to, in Claude's own words. The phone was shown it with the spaces around it
/// trimmed (mobile/src/view/prompts.ts), and a long one cut short (protocol::trimmed), so either of those is it too, as
/// long as it is that one question alone (two long ones may read the same, cut short).
fn asked_as<'a>(questions: &[&'a str], key: &str) -> Option<&'a str> {
    if let Some(q) = questions.iter().copied().find(|q| *q == key) {
        return Some(q);
    }
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    let shown_as = |q: &str| q.trim() == key || super::protocol::trimmed(&Value::String(q.to_string())).as_str().is_some_and(|shown| shown.trim() == key);
    let mut matches = questions.iter().copied().filter(|q| shown_as(q));
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn question() -> Value {
        json!({"questions": [{"question": "Which theme?", "header": "Theme", "options": [{"label": "Dark"}, {"label": "Light"}]}]})
    }

    fn answers(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(q, a)| (q.to_string(), a.to_string())).collect()
    }

    #[test]
    fn a_questions_answers_are_added_to_the_input_claude_sent() {
        let out = with_answers(QUESTION_TOOL, &question(), &answers(&[("Which theme?", "Dark")])).unwrap();
        assert_eq!(out["answers"], json!({"Which theme?": "Dark"}));
        assert_eq!(out["questions"], question()["questions"], "the rest is Claude's own input");
    }

    #[test]
    fn no_other_tool_can_be_answered_with_answers() {
        assert!(with_answers("Bash", &json!({"command": "npm test"}), &answers(&[("command", "rm -rf ~")])).is_err());
    }

    #[test]
    fn only_the_questions_asked_can_be_answered() {
        assert!(with_answers(QUESTION_TOOL, &question(), &answers(&[("Delete everything?", "yes")])).is_err());
        assert!(with_answers(QUESTION_TOOL, &question(), &answers(&[])).is_err(), "no answers is no answer");
        assert!(with_answers(QUESTION_TOOL, &question(), &answers(&[("Which theme?", &"x".repeat(ANSWER_MAX + 1))])).is_err());
        assert!(with_answers(QUESTION_TOOL, &json!("not an object"), &answers(&[("Which theme?", "Dark")])).is_err());
    }

    #[test]
    fn a_question_the_phone_was_shown_trimmed_is_answered_in_claudes_own_words() {
        let spaced = json!({"questions": [{"question": "  Which theme?\n", "options": [{"label": "Dark"}]}]});
        let out = with_answers(QUESTION_TOOL, &spaced, &answers(&[("Which theme?", "my own words")])).unwrap();
        assert_eq!(out["answers"], json!({"  Which theme?\n": "my own words"}));

        let long = "q".repeat(super::super::protocol::INPUT_TEXT_MAX + 50);
        let shown = super::super::protocol::trimmed(&json!(long.clone())).as_str().unwrap().to_string();
        let out = with_answers(QUESTION_TOOL, &json!({"questions": [{"question": long.clone()}]}), &answers(&[(&shown, "yes")])).unwrap();
        assert_eq!(out["answers"][long.as_str()], "yes");
    }

    #[test]
    fn two_answers_to_one_question_or_a_blank_key_are_refused() {
        let spaced = json!({"questions": [{"question": "Which theme?"}]});
        assert!(with_answers(QUESTION_TOOL, &spaced, &answers(&[("Which theme?", "a"), (" Which theme? ", "b")])).is_err());
        assert!(with_answers(QUESTION_TOOL, &json!({"questions": [{"question": "   "}]}), &answers(&[("", "a")])).is_err());
    }

    #[test]
    fn two_long_questions_that_read_the_same_cut_short_are_not_guessed_between() {
        let start = "q".repeat(super::super::protocol::INPUT_TEXT_MAX);
        let (a, b) = (format!("{start} first?"), format!("{start} second?"));
        let shown = super::super::protocol::trimmed(&json!(a.clone())).as_str().unwrap().to_string();
        assert!(with_answers(QUESTION_TOOL, &json!({"questions": [{"question": a.clone()}, {"question": b}]}), &answers(&[(&shown, "yes")])).is_err());
        let out = with_answers(QUESTION_TOOL, &json!({"questions": [{"question": a.clone()}, {"question": "Other?"}]}), &answers(&[(&a, "yes")])).unwrap();
        assert_eq!(out["answers"][a.as_str()], "yes", "its whole words are still that one question");
    }

    #[test]
    fn a_question_with_long_text_can_still_be_answered() {
        // The phone was shown it cut short (protocol::trimmed); the answer goes onto the whole input.
        let long = json!({"questions": [{"question": "Which?", "description": "y".repeat(50_000)}]});
        let out = with_answers(QUESTION_TOOL, &long, &answers(&[("Which?", "this")])).unwrap();
        assert_eq!(out["questions"][0]["description"].as_str().unwrap().len(), 50_000);
    }
}
