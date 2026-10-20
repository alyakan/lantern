//! What a phone's answer to a prompt may carry besides allow or deny. Claude Code runs a tool with the input it is
//! answered with, so an answer that changed the input could approve one command and run another. A phone may only fill
//! in AskUserQuestion's answers, the way the window does (src/lib/questions.ts): the rest of the input stays as Claude
//! sent it, and every answer is to one of its questions.

use serde_json::Value;

pub const QUESTION_TOOL: &str = "AskUserQuestion";

/// Whether `updated` is `original` with AskUserQuestion's answers filled in, and nothing else changed.
pub fn allowed_update(tool_name: &str, original: &Value, updated: &Value) -> bool {
    if tool_name != QUESTION_TOOL {
        return false;
    }
    let (Some(orig), Some(upd)) = (original.as_object(), updated.as_object()) else { return false };
    let without = |m: &serde_json::Map<String, Value>| m.iter().filter(|(k, _)| k.as_str() != "answers").map(|(k, v)| (k.clone(), v.clone())).collect::<serde_json::Map<_, _>>();
    if without(orig) != without(upd) {
        return false;
    }
    let questions: Vec<&str> = orig.get("questions").and_then(Value::as_array).map(|qs| qs.iter().filter_map(|q| q.get("question").and_then(Value::as_str)).collect()).unwrap_or_default();
    let Some(answers) = upd.get("answers").and_then(Value::as_object) else { return false };
    answers.iter().all(|(q, a)| questions.contains(&q.as_str()) && a.as_str().is_some_and(|a| a.len() <= 10_000))
}

/// An answer's input as it goes to the bridge: None, or one `allowed_update` passed. Anything else is refused, with why.
pub fn checked(tool_name: &str, original: &Value, updated: Option<Value>) -> Result<Option<Value>, String> {
    match updated {
        None => Ok(None),
        Some(u) if allowed_update(tool_name, original, &u) => Ok(Some(u)),
        Some(_) => Err("An answer from a phone can only fill in a question's answers.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn question() -> Value {
        json!({"questions": [{"question": "Which theme?", "header": "Theme", "options": [{"label": "Dark"}, {"label": "Light"}]}]})
    }

    #[test]
    fn a_questions_answers_can_be_filled_in() {
        let mut answered = question();
        answered["answers"] = json!({"Which theme?": "Dark"});
        assert!(allowed_update(QUESTION_TOOL, &question(), &answered));
        assert_eq!(checked(QUESTION_TOOL, &question(), Some(answered.clone())), Ok(Some(answered)));
        assert_eq!(checked("Bash", &json!({"command": "npm test"}), None), Ok(None));
    }

    #[test]
    fn no_other_tools_input_can_be_changed() {
        let original = json!({"command": "npm test"});
        let swapped = json!({"command": "rm -rf ~"});
        assert!(!allowed_update("Bash", &original, &swapped));
        assert!(!allowed_update("Bash", &original, &original), "not even to itself: only a question has answers");
        assert!(checked("Bash", &original, Some(swapped)).is_err());
    }

    #[test]
    fn a_question_cant_be_changed_beyond_its_answers() {
        let mut reworded = question();
        reworded["questions"][0]["question"] = json!("Delete everything?");
        reworded["answers"] = json!({"Delete everything?": "yes"});
        assert!(!allowed_update(QUESTION_TOOL, &question(), &reworded));
        let mut extra = question();
        extra["answers"] = json!({"Which theme?": "Dark"});
        extra["command"] = json!("rm -rf ~");
        assert!(!allowed_update(QUESTION_TOOL, &question(), &extra));
        let mut unknown = question();
        unknown["answers"] = json!({"Something else?": "x"});
        assert!(!allowed_update(QUESTION_TOOL, &question(), &unknown));
        let mut not_text = question();
        not_text["answers"] = json!({"Which theme?": {"run": "x"}});
        assert!(!allowed_update(QUESTION_TOOL, &question(), &not_text));
        assert!(!allowed_update(QUESTION_TOOL, &question(), &question()), "an answer with no answers isn't one");
    }
}
