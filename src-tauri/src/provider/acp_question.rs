//! An ACP agent's question (`elicitation/create` with a form), shown as the question card Claude's AskUserQuestion gets,
//! and the card's answers turned back into the form's content.
//!
//! Antigravity's `ask_question` tool sends one form for all its questions: a field `qN` per question (a string with
//! `oneOf` options, or an array whose `items` has `anyOf` options when several may be picked), each with a `qN_other`
//! string for an answer in the user's own words. The options' values are numbers as strings ("1", "2"…) and their titles
//! are what the user reads. Checked against agy 1.5.15: picking, picking several, an answer of one's own and declining.

use serde_json::{json, Map, Value};

/// The tool name a question card goes to the window and the phone as.
pub const QUESTION_TOOL: &str = "AskUserQuestion";

/// One question of the form: where its answer goes, and what can be picked.
#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    /// The form's key for the picked option(s), and for an answer of one's own (when the form has one).
    key: String,
    other: Option<String>,
    question: String,
    /// Each option's value, and the title the user reads. Empty: the question is answered in words only.
    options: Vec<(String, String)>,
    multi: bool,
}

/// The form's questions, and the card's input for them (AskUserQuestion's shape), or why the form can't be shown as one.
pub fn read_form(params: &Value) -> Result<(Value, Vec<Field>), String> {
    // A URL elicitation sends the user to a web page; the card can only ask.
    if params.get("mode").is_some_and(|m| m.as_str() != Some("form")) {
        return Err("it asks the user to open a web page".into());
    }
    let schema = &params["requestedSchema"];
    let Some(props) = schema["properties"].as_object().filter(|p| !p.is_empty()) else { return Err("its question has no fields".into()) };
    let unreadable = || "it asks for something the question card can't show".to_string();
    let mut fields: Vec<Field> = Vec::new();
    for (key, prop) in props {
        // An answer of one's own belongs to the question it names; it is read with that question.
        if let Some(base) = key.strip_suffix("_other") {
            if props.contains_key(base) {
                if prop["type"].as_str() != Some("string") {
                    return Err(unreadable());
                }
                continue;
            }
        }
        let question = prop["title"].as_str().or_else(|| prop["description"].as_str()).map(str::trim).filter(|t| !t.is_empty()).ok_or_else(unreadable)?;
        let (choices, multi) = match prop["type"].as_str() {
            Some("string") => (prop.get("oneOf").or_else(|| prop.get("anyOf")), false),
            Some("array") => (prop["items"].get("anyOf").or_else(|| prop["items"].get("oneOf")), true),
            _ => return Err(unreadable()),
        };
        let options = match choices {
            None if !multi => vec![],
            None => return Err(unreadable()),
            Some(list) => list
                .as_array()
                .ok_or_else(unreadable)?
                .iter()
                .map(|o| match (o["const"].as_str(), o["title"].as_str().or_else(|| o["const"].as_str())) {
                    (Some(value), Some(title)) if !title.trim().is_empty() => Ok((value.to_string(), title.trim().to_string())),
                    _ => Err(unreadable()),
                })
                .collect::<Result<Vec<_>, _>>()?,
        };
        if multi && options.is_empty() {
            return Err(unreadable());
        }
        let other = format!("{key}_other");
        let other = props.contains_key(&other).then_some(other);
        fields.push(Field { key: key.clone(), other, question: question.to_string(), options, multi });
    }
    if fields.is_empty() {
        return Err(unreadable());
    }
    // The card's answers are keyed by the question's words: two questions worded alike couldn't be told apart.
    if fields.iter().enumerate().any(|(i, f)| fields[..i].iter().any(|g| g.question == f.question)) {
        return Err("two of its questions read the same".into());
    }
    // In the order they were asked: q1, q2… q10 (the form's keys are read sorted as text, where q10 comes before q2).
    fields.sort_by_key(|f| order_of(&f.key));
    let questions: Vec<Value> = fields
        .iter()
        .map(|f| json!({"question": f.question, "header": "", "options": f.options.iter().map(|(_, t)| json!({"label": t, "description": ""})).collect::<Vec<_>>(), "multiSelect": f.multi}))
        .collect();
    Ok((json!({"questions": questions}), fields))
}

fn order_of(key: &str) -> (u64, String) {
    (key.strip_prefix('q').and_then(|n| n.parse().ok()).unwrap_or(u64::MAX), key.to_string())
}

/// The reply to the form: what the user answered (the card's `answers`, by question), or declined when they skipped it or
/// sent no answers.
pub fn reply(fields: &[Field], allow: bool, answered: Option<&Value>) -> Value {
    let Some(answers) = answered.and_then(|a| a["answers"].as_object()).filter(|_| allow) else { return json!({"action": "decline"}) };
    let mut content = Map::new();
    for f in fields {
        let Some(text) = answers.get(&f.question).and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()) else { continue };
        if let Some(picked) = picked(f, text) {
            content.insert(f.key.clone(), picked);
        } else if let Some(other) = &f.other {
            content.insert(other.clone(), text.into());
        } else if f.options.is_empty() {
            content.insert(f.key.clone(), text.into());
        }
    }
    json!({"action": "accept", "content": content})
}

/// The option(s) `text` names: one title, or (when several may be picked) titles joined with ", " as the card joins them.
fn picked(f: &Field, text: &str) -> Option<Value> {
    let value_of = |title: &str| f.options.iter().find(|(_, t)| t == title).map(|(v, _)| Value::String(v.clone()));
    if !f.multi {
        return value_of(text);
    }
    // A title that has ", " in it is taken whole before the text is split.
    if let Some(v) = value_of(text) {
        return Some(json!([v]));
    }
    text.split(", ").map(value_of).collect::<Option<Vec<_>>>().map(Value::Array)
}

/// What answers a question the turn was stopped on.
pub fn cancelled() -> Value {
    json!({"action": "cancel"})
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The form agy 1.5.15 sent for two questions, the first one where several may be picked.
    fn two_questions() -> Value {
        json!({"sessionId": "s", "toolCallId": "c", "mode": "form", "message": "The agent has 2 questions.", "requestedSchema": {"type": "object", "properties": {
            "q1": {"type": "array", "title": "Which fruits do you like?", "items": {"anyOf": [{"const": "1", "title": "Apple"}, {"const": "2", "title": "Pear"}, {"const": "3", "title": "Plum"}]}},
            "q1_other": {"type": "string", "title": "Other", "description": "Optional free-form answer to: Which fruits do you like?"},
            "q2": {"type": "string", "title": "Which drink do you want?", "oneOf": [{"const": "1", "title": "Tea"}, {"const": "2", "title": "Coffee"}]},
            "q2_other": {"type": "string", "title": "Other", "description": "Optional free-form answer to: Which drink do you want?"}
        }}})
    }

    fn answers(pairs: &[(&str, &str)]) -> Value {
        json!({"questions": [], "answers": pairs.iter().map(|(q, a)| (q.to_string(), Value::String(a.to_string()))).collect::<Map<_, _>>()})
    }

    #[test]
    fn agys_form_becomes_the_question_card_claude_gets() {
        let (input, fields) = read_form(&two_questions()).unwrap();
        assert_eq!(
            input,
            json!({"questions": [
                {"question": "Which fruits do you like?", "header": "", "options": [{"label": "Apple", "description": ""}, {"label": "Pear", "description": ""}, {"label": "Plum", "description": ""}], "multiSelect": true},
                {"question": "Which drink do you want?", "header": "", "options": [{"label": "Tea", "description": ""}, {"label": "Coffee", "description": ""}], "multiSelect": false}
            ]})
        );
        assert_eq!(fields.len(), 2, "an answer of one's own is part of its question, not a question");
    }

    #[test]
    fn picked_options_go_back_as_their_values_and_words_of_ones_own_as_the_other_answer() {
        let (_, fields) = read_form(&two_questions()).unwrap();
        let r = reply(&fields, true, Some(&answers(&[("Which fruits do you like?", "Apple, Plum"), ("Which drink do you want?", "Coffee")])));
        assert_eq!(r, json!({"action": "accept", "content": {"q1": ["1", "3"], "q2": "2"}}));
        let r = reply(&fields, true, Some(&answers(&[("Which fruits do you like?", "Apple, kiwi"), ("Which drink do you want?", " Water ")])));
        assert_eq!(r, json!({"action": "accept", "content": {"q1_other": "Apple, kiwi", "q2_other": "Water"}}));
    }

    #[test]
    fn a_skipped_question_or_one_sent_without_answers_is_declined() {
        let (_, fields) = read_form(&two_questions()).unwrap();
        assert_eq!(reply(&fields, false, Some(&answers(&[("Which drink do you want?", "Tea")]))), json!({"action": "decline"}));
        assert_eq!(reply(&fields, true, None), json!({"action": "decline"}));
        assert_eq!(reply(&fields, true, Some(&json!({"questions": []}))), json!({"action": "decline"}));
    }

    #[test]
    fn an_option_whose_title_has_a_comma_is_picked_whole() {
        let form = json!({"requestedSchema": {"type": "object", "properties": {"q1": {"type": "array", "title": "Which?", "items": {"anyOf": [{"const": "1", "title": "Red, dark"}, {"const": "2", "title": "Blue"}]}}}}});
        let (_, fields) = read_form(&form).unwrap();
        assert_eq!(reply(&fields, true, Some(&answers(&[("Which?", "Red, dark")]))), json!({"action": "accept", "content": {"q1": ["1"]}}));
    }

    #[test]
    fn questions_keep_the_order_they_were_asked_in_past_nine() {
        let props: Map<String, Value> = (1..=11).map(|n| (format!("q{n}"), json!({"type": "string", "title": format!("Question {n}?")}))).collect();
        let (input, _) = read_form(&json!({"requestedSchema": {"type": "object", "properties": props}})).unwrap();
        let order: Vec<&str> = input["questions"].as_array().unwrap().iter().map(|q| q["question"].as_str().unwrap()).collect();
        assert_eq!(order.first(), Some(&"Question 1?"));
        assert_eq!(order[1], "Question 2?");
        assert_eq!(order.last(), Some(&"Question 11?"));
    }

    #[test]
    fn a_question_without_options_is_answered_in_words() {
        let form = json!({"requestedSchema": {"type": "object", "properties": {"name": {"type": "string", "title": "What should it be called?"}}}});
        let (input, fields) = read_form(&form).unwrap();
        assert_eq!(input["questions"][0]["options"], json!([]));
        assert_eq!(reply(&fields, true, Some(&answers(&[("What should it be called?", "lantern")]))), json!({"action": "accept", "content": {"name": "lantern"}}));
    }

    #[test]
    fn a_form_the_card_cannot_show_is_not_shown() {
        let bad = [
            json!({"mode": "url", "url": "https://example.com", "requestedSchema": {"type": "object", "properties": {"q1": {"type": "string", "title": "x"}}}}),
            json!({"requestedSchema": {"type": "object", "properties": {}}}),
            json!({"requestedSchema": {"type": "object", "properties": {"n": {"type": "number", "title": "How many?"}}}}),
            json!({"requestedSchema": {"type": "object", "properties": {"q1": {"type": "array", "title": "Which?"}}}}),
            json!({"requestedSchema": {"type": "object", "properties": {"q1": {"type": "string", "oneOf": [{"const": "1", "title": "A"}]}}}}),
            json!({"requestedSchema": {"type": "object", "properties": {"q1": {"type": "string", "title": "Same?"}, "q2": {"type": "string", "title": "Same?"}}}}),
            json!({"requestedSchema": {"type": "object", "properties": {"q1": {"type": "string", "title": "x", "oneOf": [{"title": "no value"}]}}}}),
        ];
        for form in bad {
            assert!(read_form(&form).is_err(), "{form}");
        }
    }
}
