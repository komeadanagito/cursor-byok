//! Projects canonical Messages into provider-visible model input.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{Error, Result};

use super::{
    normalize_tool_name, CanonicalMessage, ContentPart, MessageContent, ProviderReplayState, Role,
    ToolCallContent, ToolResultContent,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum ProjectedContent {
    Parts(Vec<ContentPart>),
    Assistant {
        text: String,
        thinking: String,
        replay_state: Option<ProviderReplayState>,
        calls: Vec<ToolCallContent>,
    },
    ToolResult(ToolResultContent),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ProjectedMessage {
    pub message_id: String,
    pub role: Role,
    pub content: ProjectedContent,
}

pub fn project_messages(messages: &[CanonicalMessage]) -> Result<Vec<ProjectedMessage>> {
    let mut projected = Vec::new();
    let mut index = 0;
    while index < messages.len() {
        if let Some((group, next)) = project_tool_round(messages, index)? {
            projected.extend(group);
            index = next;
        } else {
            projected.push(project_message(&messages[index]));
            index += 1;
        }
    }
    Ok(projected)
}

fn project_tool_round(
    messages: &[CanonicalMessage],
    start: usize,
) -> Result<Option<(Vec<ProjectedMessage>, usize)>> {
    let MessageContent::Assistant {
        tool_round_id: Some(group_id),
        tool_calls,
        ..
    } = &messages[start].content
    else {
        return Ok(None);
    };
    if tool_calls.is_empty() {
        return Ok(None);
    }

    let mut cursor = start;
    let mut text = String::new();
    let mut thinking = String::new();
    let mut replay_state = None;
    let mut calls = Vec::new();
    let mut results = Vec::new();
    let mut result_ids = HashSet::new();

    while cursor < messages.len() {
        let MessageContent::Assistant {
            text: part_text,
            thinking: part_thinking,
            tool_round_id: Some(candidate_group),
            replay_state: part_replay,
            tool_calls: part_calls,
        } = &messages[cursor].content
        else {
            break;
        };
        if candidate_group != group_id || part_calls.is_empty() {
            break;
        }
        text.push_str(part_text);
        thinking.push_str(part_thinking);
        if replay_state.is_none() {
            replay_state = part_replay.clone();
        } else if part_replay.is_some() {
            return Err(Error::Protocol(
                "tool round repeats provider replay state".into(),
            ));
        }
        calls.extend(part_calls.iter().map(normalized_tool_call));
        cursor += 1;

        while cursor < messages.len() {
            let MessageContent::ToolResult(result) = &messages[cursor].content else {
                break;
            };
            if !calls.iter().any(|call| call.call_id == result.call_id) {
                break;
            }
            if !result_ids.insert(result.call_id.clone()) {
                return Err(Error::Protocol(format!(
                    "duplicate tool result call_id: {}",
                    result.call_id
                )));
            }
            results.push((messages[cursor].message_id.clone(), result.clone()));
            cursor += 1;
        }
    }

    calls.sort_by_key(|call| call.index);
    for call in &calls {
        if !result_ids.contains(&call.call_id) {
            return Err(Error::Protocol(format!(
                "assistant tool call has no result call_id: {}",
                call.call_id
            )));
        }
    }

    let mut output = Vec::with_capacity(results.len() + 1);
    output.push(ProjectedMessage {
        message_id: messages[start].message_id.clone(),
        role: Role::Assistant,
        content: ProjectedContent::Assistant {
            text,
            thinking,
            replay_state,
            calls,
        },
    });
    output.extend(
        results
            .into_iter()
            .map(|(message_id, result)| ProjectedMessage {
                message_id,
                role: Role::Tool,
                content: ProjectedContent::ToolResult(normalized_tool_result(&result)),
            }),
    );
    Ok(Some((output, cursor)))
}

/// Drops tool calls whose tool result never arrives.
///
/// Canonical history requires every assistant tool call to be answered inside
/// its own tool round, but Cursor's root message list can carry an abandoned
/// pending round whose results were never stored. Strip those calls when that
/// history is imported so [`project_messages`] stays a pure structural
/// transform of the canonical history: the projected assistant must never
/// change once the message is in, or a later turn would rewrite an earlier
/// provider-visible message and break prefix stability.
pub fn settle_tool_pairs(messages: &mut [CanonicalMessage]) {
    let mut unpaired: Vec<(usize, String)> = Vec::new();
    let mut index = 0;
    while index < messages.len() {
        let MessageContent::Assistant {
            tool_round_id: Some(group_id),
            tool_calls,
            ..
        } = &messages[index].content
        else {
            index += 1;
            continue;
        };
        if tool_calls.is_empty() {
            index += 1;
            continue;
        }

        let mut calls: HashSet<String> = HashSet::new();
        let mut paired: HashSet<String> = HashSet::new();
        let mut cursor = index;
        while cursor < messages.len() {
            let MessageContent::Assistant {
                tool_round_id: Some(candidate),
                tool_calls: part_calls,
                ..
            } = &messages[cursor].content
            else {
                break;
            };
            if candidate != group_id || part_calls.is_empty() {
                break;
            }
            for call in part_calls {
                calls.insert(call.call_id.clone());
            }
            cursor += 1;

            while cursor < messages.len() {
                let MessageContent::ToolResult(result) = &messages[cursor].content else {
                    break;
                };
                if !calls.contains(&result.call_id) {
                    break;
                }
                paired.insert(result.call_id.clone());
                cursor += 1;
            }
        }

        for (position, message) in messages.iter().enumerate().take(cursor).skip(index) {
            let MessageContent::Assistant { tool_calls, .. } = &message.content else {
                continue;
            };
            for call in tool_calls {
                if !paired.contains(&call.call_id) {
                    unpaired.push((position, call.call_id.clone()));
                }
            }
        }
        index = cursor;
    }

    for (position, call_id) in unpaired {
        let Some(MessageContent::Assistant { tool_calls, .. }) = messages
            .get_mut(position)
            .map(|message| &mut message.content)
        else {
            continue;
        };
        tool_calls.retain(|call| call.call_id != call_id);
    }
}

fn project_message(message: &CanonicalMessage) -> ProjectedMessage {
    let content = match &message.content {
        MessageContent::Parts { parts } => ProjectedContent::Parts(parts.clone()),
        MessageContent::Assistant {
            text,
            thinking,
            replay_state,
            tool_calls,
            ..
        } => ProjectedContent::Assistant {
            text: text.clone(),
            thinking: thinking.clone(),
            replay_state: replay_state.clone(),
            calls: tool_calls.iter().map(normalized_tool_call).collect(),
        },
        MessageContent::ToolResult(result) => {
            ProjectedContent::ToolResult(normalized_tool_result(result))
        }
    };
    ProjectedMessage {
        message_id: message.message_id.clone(),
        role: message.role.clone(),
        content,
    }
}

fn normalized_tool_call(call: &ToolCallContent) -> ToolCallContent {
    let mut call = call.clone();
    call.name = normalize_tool_name(&call.name);
    call
}

fn normalized_tool_result(result: &ToolResultContent) -> ToolResultContent {
    let mut result = result.clone();
    result.name = normalize_tool_name(&result.name);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Origin;
    use serde_json::json;

    #[test]
    fn tool_names_are_normalized_before_provider_dispatch() {
        let messages = [CanonicalMessage {
            message_id: "assistant-1".into(),
            role: Role::Assistant,
            origin: Origin::Assistant,
            content: MessageContent::Assistant {
                text: String::new(),
                thinking: String::new(),
                tool_round_id: None,
                replay_state: None,
                tool_calls: vec![ToolCallContent {
                    index: 0,
                    call_id: "call-1".into(),
                    name: "multi_tool_use.parallel".into(),
                    arguments: json!({}),
                }],
            },
            runtime_event_id: None,
        }];

        let projected = project_messages(&messages).unwrap();
        let ProjectedContent::Assistant { calls, .. } = &projected[0].content else {
            panic!("expected assistant projection");
        };
        assert_eq!(calls[0].name, "multi_tool_use_parallel");
    }

    #[test]
    fn projection_rejects_an_unanswered_tool_round_call() {
        let messages = vec![
            assistant_round(
                "assistant",
                "round",
                vec![call(0, "call-answered"), call(1, "call-abandoned")],
            ),
            tool_result("result", "call-answered"),
        ];

        let error = project_messages(&messages).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("assistant tool call has no result call_id: call-abandoned"),
            "{error}"
        );
    }

    #[test]
    fn settle_tool_pairs_drops_unanswered_tool_round_calls() {
        let mut messages = vec![
            assistant_round(
                "assistant",
                "round",
                vec![call(0, "call-answered"), call(1, "call-abandoned")],
            ),
            tool_result("result", "call-answered"),
        ];

        settle_tool_pairs(&mut messages);
        let MessageContent::Assistant {
            text, tool_calls, ..
        } = &messages[0].content
        else {
            panic!("expected assistant")
        };
        assert_eq!(text, "looking");
        assert_eq!(
            tool_calls
                .iter()
                .map(|call| call.call_id.as_str())
                .collect::<Vec<_>>(),
            ["call-answered"]
        );
        project_messages(&messages).unwrap();
    }

    #[test]
    fn settle_tool_pairs_drops_a_round_whose_results_never_arrive() {
        let mut messages = vec![assistant_round(
            "assistant",
            "round",
            vec![call(0, "call-abandoned")],
        )];

        settle_tool_pairs(&mut messages);
        let MessageContent::Assistant { tool_calls, .. } = &messages[0].content else {
            panic!("expected assistant")
        };
        assert!(tool_calls.is_empty());
        project_messages(&messages).unwrap();
    }

    /// Settling must happen when the message is written, not when it is
    /// projected: a later turn may append the missing result, and that must
    /// not rewrite the assistant already projected to the provider.
    #[test]
    fn settled_history_projects_as_a_stable_prefix() {
        let mut settled = vec![
            assistant_round("assistant", "round", vec![call(0, "c1"), call(1, "c2")]),
            tool_result("result-c1", "c1"),
        ];
        settle_tool_pairs(&mut settled);
        let first = project_messages(&settled).unwrap();

        let mut later = settled.clone();
        later.push(tool_result("result-c2", "c2"));
        let second = project_messages(&later).unwrap();

        assert_eq!(first, second[..first.len()]);
    }

    fn call(index: usize, call_id: &str) -> ToolCallContent {
        ToolCallContent {
            index,
            call_id: call_id.into(),
            name: "Read".into(),
            arguments: json!({"path": "/a"}),
        }
    }

    fn assistant_round(
        message_id: &str,
        tool_round_id: &str,
        tool_calls: Vec<ToolCallContent>,
    ) -> CanonicalMessage {
        CanonicalMessage {
            message_id: message_id.into(),
            role: Role::Assistant,
            origin: Origin::Assistant,
            content: MessageContent::Assistant {
                text: "looking".into(),
                thinking: String::new(),
                tool_round_id: Some(tool_round_id.into()),
                replay_state: None,
                tool_calls,
            },
            runtime_event_id: None,
        }
    }

    fn tool_result(message_id: &str, call_id: &str) -> CanonicalMessage {
        CanonicalMessage {
            message_id: message_id.into(),
            role: Role::Tool,
            origin: Origin::Tool,
            content: MessageContent::ToolResult(ToolResultContent {
                call_id: call_id.into(),
                name: "Read".into(),
                content: "ok".into(),
                is_error: false,
                image: None,
                provider_parts: Vec::new(),
            }),
            runtime_event_id: None,
        }
    }
}
