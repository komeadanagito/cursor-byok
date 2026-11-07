//! Renders per-invocation placeholders in user-configured provider request values.
//!
//! Placeholders live inside string values so a model's custom headers and
//! extra body params can carry per-request identity (the same fingerprint the
//! official clients send) without the user hard-coding values that must change
//! on every call.

use std::env::consts::{ARCH, OS};

const SESSION_ID_PLACEHOLDER: &str = "{{SessionId}}";
const UUID_PLACEHOLDER: &str = "{{Uuid}}";
const OS_CATEGORY_PLACEHOLDER: &str = "{{OsCategory}}";
const OS_PLATFORM_PLACEHOLDER: &str = "{{OsPlatform}}";

fn os_category() -> &'static str {
    match OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    }
}

/// The `darwin-arm64` / `windows-x64` shape the official clients put in their
/// platform header.
fn os_platform() -> String {
    let arch = match ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    let family = match OS {
        "macos" => "darwin",
        "windows" => "windows",
        _ => "linux",
    };
    format!("{family}-{arch}")
}

pub(super) fn render_json_strings(
    value: &serde_json::Value,
    conversation_id: &str,
) -> serde_json::Value {
    match value {
        serde_json::Value::String(value) => serde_json::Value::String(
            value
                .replace(SESSION_ID_PLACEHOLDER, conversation_id)
                .replace(UUID_PLACEHOLDER, &uuid::Uuid::new_v4().to_string())
                .replace(OS_CATEGORY_PLACEHOLDER, os_category())
                .replace(OS_PLATFORM_PLACEHOLDER, &os_platform()),
        ),
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .iter()
                .map(|value| render_json_strings(value, conversation_id))
                .collect(),
        ),
        serde_json::Value::Object(values) => serde_json::Value::Object(
            values
                .iter()
                .map(|(name, value)| (name.clone(), render_json_strings(value, conversation_id)))
                .collect(),
        ),
        value => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_session_id_in_nested_json_string_values() {
        let template = serde_json::json!({
            "session": "{{SessionId}}",
            "nested": {
                "label": "conversation={{SessionId}}/{{SessionId}}",
                "values": ["{{SessionId}}", 42, true, null]
            }
        });

        assert_eq!(
            render_json_strings(&template, "cursor-conversation-id"),
            serde_json::json!({
                "session": "cursor-conversation-id",
                "nested": {
                    "label": "conversation=cursor-conversation-id/cursor-conversation-id",
                    "values": ["cursor-conversation-id", 42, true, null]
                }
            })
        );
    }

    #[test]
    fn leaves_json_property_names_and_unrelated_strings_unchanged() {
        let template = serde_json::json!({
            "{{SessionId}}": "literal",
            "other": "{{sessionId}}"
        });

        assert_eq!(
            render_json_strings(&template, "cursor-conversation-id"),
            template
        );
    }

    #[test]
    fn renders_a_fresh_uuid_per_string_value() {
        let template = serde_json::json!({
            "a": "{{Uuid}}",
            "b": "prefix-{{Uuid}}-suffix"
        });

        let rendered = render_json_strings(&template, "cursor-conversation-id");
        let a = rendered["a"].as_str().unwrap();
        let b = rendered["b"].as_str().unwrap();
        assert_ne!(a, "{{Uuid}}", "placeholder must be replaced");
        assert!(a.len() > 10);
        assert!(b.starts_with("prefix-") && b.ends_with("-suffix"));
        // A second render must not reuse the first call's values.
        assert_ne!(
            render_json_strings(&template, "cursor-conversation-id")["a"],
            rendered["a"]
        );
    }

    #[test]
    fn renders_machine_facts() {
        let template = serde_json::json!({
            "category": "{{OsCategory}}",
            "platform": "{{OsPlatform}}"
        });
        let rendered = render_json_strings(&template, "x");
        assert_eq!(rendered["category"].as_str(), Some(os_category()));
        assert_eq!(rendered["platform"].as_str(), Some(os_platform().as_str()));
    }
}
