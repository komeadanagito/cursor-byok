//! Defines Tool calls, results, and Tool round identities.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::ProviderReplayState;

const PROVIDER_TOOL_NAME_LIMIT: usize = 64;

pub fn normalize_tool_name(name: &str) -> String {
    let normalized = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if normalized.is_empty() {
        return "_".into();
    }
    if normalized.len() <= PROVIDER_TOOL_NAME_LIMIT {
        return normalized;
    }
    // Cursor prefixes the action with the extension and workspace IDs. Keep the
    // action visible and use the full wire name to distinguish workspace routes.
    let digest = Sha256::digest(name.as_bytes());
    let fingerprint = hex::encode(&digest[..8]);
    let tail_len = PROVIDER_TOOL_NAME_LIMIT - fingerprint.len() - 1;
    let tail = &normalized[normalized.len() - tail_len..];
    format!("{fingerprint}_{tail}")
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ToolCall {
    pub index: usize,
    pub call_id: String,
    pub model_call_id: String,
    pub name: String,
    pub arguments_text: String,
    pub arguments: Value,
    pub argument_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolResult {
    pub call_id: String,
    pub content: String,
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<super::ContentPart>,
    pub image: Option<ToolImageReference>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolImageReference {
    pub blob_id: String,
    pub mime_type: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ToolRoundAssistant {
    pub text: String,
    pub thinking: String,
    pub model_call_id: String,
    pub replay_state: Option<ProviderReplayState>,
}
