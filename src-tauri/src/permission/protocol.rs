use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Helper → app: one permission request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BridgeRequest {
    pub tool_name: String,
    pub input: Value,
    pub tool_use_id: Option<String>,
}

/// App → helper: the user's decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BridgeResponse {
    pub allow: bool,
    pub message: Option<String>,
}

/// The JSON the permission prompt tool must return to claude.
pub fn decision_json(input: &Value, resp: &BridgeResponse) -> Value {
    if resp.allow {
        json!({"behavior": "allow", "updatedInput": input})
    } else {
        json!({"behavior": "deny", "message": resp.message.clone().unwrap_or_else(|| "The user denied this action.".into())})
    }
}
