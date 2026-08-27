#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use cursor_server::{
    cursor::prompting::{PromptAssets, PromptCompiler},
    cursor::{
        connect,
        proto::{agent::v1 as pb, aiserver::v1 as ai},
    },
    cursor::{CursorCommand, CursorSessionRegistry},
    model::{MessageContent, Role},
    provider::{FinishReason, ModelEvent},
    Error,
};
use prost::Message;

#[tokio::test]
async fn provider_failure_keeps_the_initial_checkpoint_then_returns_structured_error() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push_error(Error::Provider("provider failed".into()));
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = CursorSessionRegistry::new(
        store.clone(),
        Arc::new(provider),
        PromptCompiler::new(assets),
        Default::default(),
    );
    let handle = registry.get_or_create("failed-request").await.unwrap();
    let mut output = handle.subscribe();
    handle
        .command(CursorCommand::Append {
            seqno: 0,
            message: Box::new(client_run()),
        })
        .await
        .unwrap();

    let mut append_seqno = 1;
    let mut checkpoints = Vec::new();
    let mut saw_turn_ended = false;
    let error_json = loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before EndStream");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            break serde_json::from_slice::<serde_json::Value>(&payload).unwrap();
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        match server.message {
            Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                handle
                    .command(CursorCommand::Append {
                        seqno: append_seqno,
                        message: Box::new(kv_ack(kv.id)),
                    })
                    .await
                    .unwrap();
                append_seqno += 1;
            }
            Some(pb::agent_server_message::Message::ConversationCheckpointUpdate(state)) => {
                checkpoints.push(state);
            }
            Some(pb::agent_server_message::Message::InteractionUpdate(update)) => {
                if matches!(
                    update.message,
                    Some(pb::interaction_update::Message::TurnEnded(_))
                ) {
                    saw_turn_ended = true;
                }
                if let Some(pb::interaction_update::Message::TextDelta(delta)) = update.message {
                    assert!(!delta.text.contains("Cursor server error"));
                }
            }
            _ => {}
        }
    };

    assert_eq!(
        checkpoints.len(),
        1,
        "the initial user state is checkpointed"
    );
    assert!(checkpoints[0].pending_tool_calls.is_empty());
    assert!(!saw_turn_ended);
    assert_eq!(error_json["error"]["code"], "unavailable");
    let detail = &error_json["error"]["details"][0];
    assert_eq!(detail["type"], "aiserver.v1.ErrorDetails");
    let encoded = detail["value"].as_str().unwrap();
    assert!(!encoded.ends_with('='));
    let decoded = STANDARD_NO_PAD.decode(encoded).unwrap();
    let decoded = ai::ErrorDetails::decode(decoded.as_slice()).unwrap();
    assert_eq!(
        decoded.error,
        ai::error_details::Error::ProviderError as i32
    );
    assert_eq!(decoded.is_expected, Some(true));
    let custom = decoded.details.unwrap();
    assert_eq!(custom.title, "Provider Error");
    assert_eq!(custom.is_retryable, Some(true));
    assert_eq!(custom.should_show_immediate_error, Some(false));
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(1), output.recv())
            .await
            .unwrap(),
        None
    );

    let messages = store
        .load_current_messages(&cursor_server::model::ConversationId::new(
            "failed-conversation",
        ))
        .await
        .unwrap();
    assert!(messages.iter().any(|message| message.role == Role::User));
    assert!(!messages.iter().any(|message| {
        matches!(
            &message.content,
            MessageContent::Assistant { text, .. } if text.contains("Cursor server error")
        )
    }));
}

#[tokio::test]
async fn runtime_protocol_failure_returns_connect_error_end_stream_and_closes() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "model-call".into(),
        },
        ModelEvent::ToolCallStart {
            index: 0,
            call_id: "call-1".into(),
            name: "Read".into(),
        },
        ModelEvent::ToolCallArgumentsDelta {
            index: 0,
            delta: "{\"path\":\"/tmp/a\"}".into(),
        },
        ModelEvent::ToolCallEnd { index: 0 },
        ModelEvent::Done(FinishReason::ToolUse),
    ]);
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = CursorSessionRegistry::new(
        store.clone(),
        Arc::new(provider),
        PromptCompiler::new(assets),
        Default::default(),
    );
    let handle = registry
        .get_or_create("protocol-failed-request")
        .await
        .unwrap();
    let mut output = handle.subscribe();
    handle
        .command(CursorCommand::Append {
            seqno: 0,
            message: Box::new(protocol_client_run()),
        })
        .await
        .unwrap();

    let mut append_seqno = 1;
    let mut saw_turn_ended = false;
    let error_json = loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before Error EndStream");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            break serde_json::from_slice::<serde_json::Value>(&payload).unwrap();
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        match server.message {
            Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                handle
                    .command(CursorCommand::Append {
                        seqno: append_seqno,
                        message: Box::new(kv_ack(kv.id)),
                    })
                    .await
                    .unwrap();
                append_seqno += 1;
            }
            Some(pb::agent_server_message::Message::ExecServerMessage(exec)) => {
                // An unknown numeric bridge id is a runtime protocol error.
                handle
                    .command(CursorCommand::Append {
                        seqno: append_seqno,
                        message: Box::new(pb::AgentClientMessage {
                            message: Some(pb::agent_client_message::Message::ExecClientMessage(
                                pb::ExecClientMessage {
                                    id: exec.id + 1_000,
                                    exec_id: String::new(),
                                    message: None,
                                    ..Default::default()
                                },
                            )),
                        }),
                    })
                    .await
                    .unwrap();
                append_seqno += 1;
            }
            Some(pb::agent_server_message::Message::InteractionUpdate(update)) => {
                if matches!(
                    update.message,
                    Some(pb::interaction_update::Message::TurnEnded(_))
                ) {
                    saw_turn_ended = true;
                }
                if let Some(pb::interaction_update::Message::TextDelta(delta)) = update.message {
                    assert!(!delta.text.contains("unknown tool result"));
                    assert!(!delta.text.contains("protocol error"));
                }
            }
            _ => {}
        }
    };

    assert!(!saw_turn_ended);
    assert_eq!(error_json["error"]["code"], "invalid_argument");
    assert_eq!(
        error_json["error"]["message"],
        "unknown ExecClientMessage id: 1001"
    );
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(1), output.recv())
            .await
            .unwrap(),
        None
    );

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    let (status, failure_summary) = loop {
        let row: (String, Option<String>) =
            sqlx::query_as("SELECT status, failure_summary FROM runs WHERE cursor_request_id = ?")
                .bind("protocol-failed-request")
                .fetch_one(store.pool())
                .await
                .unwrap();
        if row.0 != "running" {
            break row;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Run remained running after the Cursor session failed"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    };
    assert_eq!(status, "failed");
    assert_eq!(
        failure_summary.as_deref(),
        Some("unknown ExecClientMessage id: 1001")
    );
}

#[tokio::test]
async fn duplicate_run_request_on_one_bidi_stream_is_a_protocol_error() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "model-call".into(),
        },
        ModelEvent::ToolCallStart {
            index: 0,
            call_id: "call-1".into(),
            name: "Read".into(),
        },
        ModelEvent::ToolCallArgumentsDelta {
            index: 0,
            delta: "{\"path\":\"/tmp/a\"}".into(),
        },
        ModelEvent::ToolCallEnd { index: 0 },
        ModelEvent::Done(FinishReason::ToolUse),
    ]);
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = CursorSessionRegistry::new(
        store,
        Arc::new(provider),
        PromptCompiler::new(assets),
        Default::default(),
    );
    let handle = registry
        .get_or_create("protocol-failed-request")
        .await
        .unwrap();
    let mut output = handle.subscribe();
    handle
        .command(CursorCommand::Append {
            seqno: 0,
            message: Box::new(protocol_client_run()),
        })
        .await
        .unwrap();

    let mut seqno = 1;
    let mut duplicate_sent = false;
    let error_json = loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before Error EndStream");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            break serde_json::from_slice::<serde_json::Value>(&payload).unwrap();
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        match server.message {
            Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                handle
                    .command(CursorCommand::Append {
                        seqno,
                        message: Box::new(kv_ack(kv.id)),
                    })
                    .await
                    .unwrap();
                seqno += 1;
            }
            Some(pb::agent_server_message::Message::ExecServerMessage(_)) if !duplicate_sent => {
                duplicate_sent = true;
                handle
                    .command(CursorCommand::Append {
                        seqno,
                        message: Box::new(protocol_client_run()),
                    })
                    .await
                    .unwrap();
                seqno += 1;
            }
            _ => {}
        }
    };

    assert!(duplicate_sent);
    assert_eq!(error_json["error"]["code"], "invalid_argument");
    assert_eq!(
        error_json["error"]["message"],
        "duplicate RunRequest for request_id: protocol-failed-request"
    );
}

fn client_run() -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::UserMessageAction(
                        pb::UserMessageAction {
                            user_message: Some(pb::UserMessage {
                                text: "hello".into(),
                                message_id: "failed-user".into(),
                                mode: pb::AgentMode::Agent as i32,
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                conversation_id: Some("failed-conversation".into()),
                run_id: Some("failed-request".into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: "test-model".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    }
}

fn protocol_client_run() -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::UserMessageAction(
                        pb::UserMessageAction {
                            user_message: Some(pb::UserMessage {
                                text: "read it".into(),
                                message_id: "protocol-failed-user".into(),
                                mode: pb::AgentMode::Agent as i32,
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                conversation_id: Some("protocol-failed-conversation".into()),
                run_id: Some("protocol-failed-request".into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: "test-model".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    }
}

fn kv_ack(id: u32) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::KvClientMessage(
            pb::KvClientMessage {
                id,
                message: Some(pb::kv_client_message::Message::SetBlobResult(
                    pb::SetBlobResult { error: None },
                )),
            },
        )),
    }
}
