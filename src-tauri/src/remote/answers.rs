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
    if answers.is_empty() || answers.iter().any(|(q, a)| !questions.contains(&q.as_str()) || a.len() > ANSWER_MAX) {
        return Err("Those answers aren't to this question.".into());
    }
    let mut out = input.clone();
    out.insert("answers".into(), Value::Object(answers.iter().map(|(q, a)| (q.clone(), Value::String(a.clone()))).collect()));
    Ok(Value::Object(out))
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
    fn a_question_with_long_text_can_still_be_answered() {
        // The phone was shown it cut short (protocol::trimmed); the answer goes onto the whole input.
        let long = json!({"questions": [{"question": "Which?", "description": "y".repeat(50_000)}]});
        let out = with_answers(QUESTION_TOOL, &long, &answers(&[("Which?", "this")])).unwrap();
        assert_eq!(out["questions"][0]["description"].as_str().unwrap().len(), 50_000);
    }
}
