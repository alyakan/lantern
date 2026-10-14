use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Helper → app: one permission request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BridgeRequest {
    pub tool_name: String,
    pub input: Value,
    pub tool_use_id: Option<String>,
    /// An orchestra tool call from the main agent (see orchestra.rs), not a permission prompt: `tool_name` is the tool and
    /// `input` its arguments. The helper sets it, never the model, so a prompt can't pose as one. The reply's `allow` says
    /// whether the call worked and its `message` is the result the model reads.
    #[serde(default)]
    pub orchestra: bool,
    /// A network_* tool call (see network.rs), answered by the app like an orchestra call but open to every chat. Set by
    /// the helper only.
    #[serde(default)]
    pub network: bool,
}

impl BridgeRequest {
    pub fn permission(tool_name: String, input: Value, tool_use_id: Option<String>) -> Self {
        Self { tool_name, input, tool_use_id, orchestra: false, network: false }
    }
}

/// App → helper: the user's decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BridgeResponse {
    pub allow: bool,
    pub message: Option<String>,
    /// On allow, the tool's input as it should run, when the user changed it: AskUserQuestion's with their answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_input: Option<Value>,
}

/// The JSON the permission prompt tool must return to claude.
pub fn decision_json(input: &Value, resp: &BridgeResponse) -> Value {
    if resp.allow {
        json!({"behavior": "allow", "updatedInput": resp.updated_input.clone().unwrap_or_else(|| input.clone())})
    } else {
        json!({"behavior": "deny", "message": resp.message.clone().unwrap_or_else(|| "The user denied this action.".into())})
    }
}

#[cfg(test)]
mod answer_tests {
    use super::*;

    #[test]
    fn an_answer_goes_back_in_the_input_and_a_plain_allow_keeps_it() {
        let input = json!({"questions": [{"question": "Which database?", "options": [{"label": "Postgres"}, {"label": "SQLite"}]}]});
        let mut answered = input.clone();
        answered["answers"] = json!({"Which database?": "SQLite"});
        let resp = BridgeResponse { allow: true, message: None, updated_input: Some(answered.clone()) };
        assert_eq!(decision_json(&input, &resp), json!({"behavior": "allow", "updatedInput": answered}));
        let plain = BridgeResponse { allow: true, message: None, updated_input: None };
        assert_eq!(decision_json(&input, &plain)["updatedInput"], input);
        // Older helpers' replies (no updated_input) still read.
        let old: BridgeResponse = serde_json::from_str(r#"{"allow":true,"message":null}"#).unwrap();
        assert_eq!(old.updated_input, None);
    }
}
