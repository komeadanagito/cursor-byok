#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::sync::Arc;

use cursor_server::{
    cursor::prompting::{PromptAssets, PromptCompiler},
    cursor::{connect, proto::agent::v1 as pb},
    cursor::{CursorCommand, CursorSessionRegistry},
    model::{ConversationId, ModelSpec, PreparedRun, PromptSpec, RunAction, RunId, RunKind},
    provider::{FinishReason, ModelEvent},
    run::RunRegistry,
    store::RunStatus,
};
use prost::Message;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn generic_run_registry_cancels_the_previous_client_for_a_conversation() {
    let registry = RunRegistry::default();
    let conversation = cursor_server::model::ConversationId::new("conversation");
    let first = CancellationToken::new();
    let second = CancellationToken::new();
    registry
        .activate(
            conversation.clone(),
            cursor_server::model::RunId::new("first"),
            first.clone(),
            cursor_server::client::session(1).1.commands,
        )
        .await;
    registry
        .activate(
            conversation.clone(),
            cursor_server::model::RunId::new("second"),
            second.clone(),
            cursor_server::client::session(1).1.commands,
        )
        .await;

    assert!(first.is_cancelled());
    assert!(!second.is_cancelled());
    registry
        .release(&conversation, &cursor_server::model::RunId::new("first"))
        .await;
    registry.shutdown().await;
    assert!(second.is_cancelled());
}

#[tokio::test]
async fn a_replaced_run_cannot_overwrite_its_cancelled_status() {
    let (_directory, store) = fixtures::temp_store().await;
    let conversation_id = ConversationId::new("conversation");
    let base_revision_id = store.ensure_conversation(&conversation_id).await.unwrap();
    let prepared = |run_id: &str| PreparedRun {
        run_id: RunId::new(run_id),
        cursor_request_id: None,
        conversation_id: conversation_id.clone(),
        kind: RunKind::Root,
        model: ModelSpec::new("model"),
        prompt: PromptSpec {
            instructions: String::new(),
            tools: Vec::new(),
        },
        initial_messages: Vec::new(),
        action: RunAction::Resume {
            pending_tool_round: None,
        },
        base_revision_id,
    };
    let first = prepared("first");
    let second = prepared("second");

    store.claim_run(&first).await.unwrap();
    sqlx::query(
        "INSERT INTO llm_calls(
            call_id, run_id, conversation_id, provider_call_index,
            provider_type, provider_url, request_type, request_url,
            model_id, display_name, status,
            created_at_ms, message_count, tool_count, detailed
         ) VALUES (
            'first:0', 'first', 'conversation', 0,
            'openai-chat', 'https://example.com/v1',
            'openai-chat', 'https://example.com/v1/chat/completions',
            'model', 'Model', 'running',
            unixepoch('subsec') * 1000, 1, 0, 0
         )",
    )
    .execute(store.pool())
    .await
    .unwrap();
    store.claim_run(&second).await.unwrap();
    assert!(!store
        .finish_run(&first.run_id, RunStatus::Completed, None, None,)
        .await
        .unwrap());

    let status: String = sqlx::query_scalar("SELECT status FROM runs WHERE run_id = 'first'")
        .fetch_one(store.pool())
        .await
        .unwrap();
    let active: Option<String> = sqlx::query_scalar(
        "SELECT active_run_id FROM conversations WHERE conversation_id = 'conversation'",
    )
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(status, "cancelled");
    assert_eq!(active.as_deref(), Some("second"));
    let call: (String, Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT status, finished_at_ms, duration_ms FROM llm_calls WHERE call_id = 'first:0'",
    )
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(call.0, "cancelled");
    assert!(call.1.is_some());
    assert!(call.2.is_some());
}

#[tokio::test]
async fn registry_shutdown_cancels_runs_and_closes_run_sse_outputs() {
    let (_directory, store) = fixtures::temp_store().await;
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = CursorSessionRegistry::new(
        store,
        Arc::new(fake_provider::FakeProvider::default()),
        PromptCompiler::new(assets),
        Default::default(),
    );
    let handle = registry.get_or_create("active-run").await.unwrap();
    let mut output = handle.subscribe();

    registry.shutdown().await;

    assert!(handle.cancellation().is_cancelled());
    let terminal = output.recv().await.expect("canceled EndStream");
    let (flags, payload) = connect::decode_frames(&terminal).unwrap().pop().unwrap();
    assert_eq!(flags, connect::END_STREAM_FLAG);
    let payload: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    assert_eq!(payload["error"]["code"], "canceled");
    assert_eq!(output.recv().await, None);
}

#[tokio::test]
async fn client_heartbeat_returns_a_server_protocol_heartbeat() {
    let (_directory, store) = fixtures::temp_store().await;
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = CursorSessionRegistry::new(
        store,
        Arc::new(fake_provider::FakeProvider::default()),
        PromptCompiler::new(assets),
        Default::default(),
    );
    let handle = registry.get_or_create("heartbeat-run").await.unwrap();
    let mut output = handle.subscribe();

    cursor_server::cursor::bidi_append::append(
        &registry,
        cursor_server::cursor::bidi_append::DecodedAppend {
            request_id: "heartbeat-run".into(),
            // A transport heartbeat must not wait for missing application messages.
            seqno: 1,
            message: pb::AgentClientMessage {
                message: Some(pb::agent_client_message::Message::ClientHeartbeat(
                    pb::ClientHeartbeat {},
                )),
            },
        },
        None,
    )
    .await
    .unwrap();

    let frame = tokio::time::timeout(std::time::Duration::from_secs(1), output.recv())
        .await
        .unwrap()
        .unwrap();
    let (_, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
    let message = pb::AgentServerMessage::decode(payload).unwrap();
    assert!(matches!(
        message.message,
        Some(pb::agent_server_message::Message::InteractionUpdate(
            pb::InteractionUpdate {
                message: Some(pb::interaction_update::Message::Heartbeat(_)),
            }
        ))
    ));

    registry.shutdown().await;
}

#[tokio::test]
async fn runtime_user_message_action_aborts_active_exec_before_canceled_end_stream() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "ignored".into(),
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
    let handle = registry.get_or_create("cancel-request").await.unwrap();
    let mut output = handle.subscribe();
    handle
        .command(CursorCommand::Append {
            seqno: 0,
            message: Box::new(client_run()),
        })
        .await
        .unwrap();

    let mut append_seqno = 1;
    let exec_id = loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .unwrap();
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        assert_eq!(
            flags & connect::END_STREAM_FLAG,
            0,
            "Run ended before Exec: {}",
            String::from_utf8_lossy(&payload)
        );
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
            Some(pb::agent_server_message::Message::ExecServerMessage(exec)) => break exec.id,
            _ => {}
        }
    };

    handle
        .command(CursorCommand::Append {
            seqno: append_seqno,
            message: Box::new(runtime_user_message()),
        })
        .await
        .unwrap();
    let mut saw_abort = false;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before canceled EndStream");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            let json: serde_json::Value = serde_json::from_slice(&payload).unwrap();
            assert_eq!(json["error"]["code"], "canceled");
            assert!(saw_abort, "ExecServerAbort must precede canceled EndStream");
            break;
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        if let Some(pb::agent_server_message::Message::ExecServerControlMessage(control)) =
            server.message
        {
            let Some(pb::exec_server_control_message::Message::Abort(abort)) = control.message
            else {
                panic!("expected ExecServerAbort")
            };
            assert_eq!(abort.id, exec_id);
            saw_abort = true;
        }
    }
    assert_eq!(output.recv().await, None);
}

#[tokio::test]
async fn injected_user_context_restarts_only_the_active_model_cycle() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push_pending();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "continued".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("continued after injection".into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = CursorSessionRegistry::new(
        store,
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
        Default::default(),
    );
    let handle = registry.get_or_create("inject-request").await.unwrap();
    let mut output = handle.subscribe();
    handle
        .command(CursorCommand::Append {
            seqno: 0,
            message: Box::new(client_run_for("inject-request", "inject-conversation")),
        })
        .await
        .unwrap();

    let mut append_seqno = 1;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while provider.requests().is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "provider did not start"
        );
        if let Ok(Some(frame)) =
            tokio::time::timeout(std::time::Duration::from_millis(20), output.recv()).await
        {
            acknowledge_kv(&handle, &mut append_seqno, &frame).await;
        }
    }
    handle
        .command(CursorCommand::Append {
            seqno: append_seqno,
            message: Box::new(runtime_injection()),
        })
        .await
        .unwrap();
    append_seqno += 1;

    let mut protocol_events = Vec::new();
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before successful EndStream");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            assert_eq!(payload.as_ref(), b"{}");
            break;
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        if let Some(pb::agent_server_message::Message::InteractionUpdate(update)) = server.message {
            match update.message {
                Some(pb::interaction_update::Message::ContextInjectionState(update)) => {
                    assert_eq!(update.injection_id, "injection-1");
                    match update.state.and_then(|state| state.state) {
                        Some(pb::context_injection_state::State::Queued(_)) => {
                            protocol_events.push("queued")
                        }
                        Some(pb::context_injection_state::State::Delivered(delivered)) => {
                            assert!(!delivered.delivery_batch_id.is_empty());
                            assert!(delivered.delivered_at_ms > 0);
                            protocol_events.push("delivered");
                        }
                        _ => {}
                    }
                }
                Some(pb::interaction_update::Message::UserMessageAppended(update)) => {
                    let user = update.user_message.expect("appended user message");
                    assert_eq!(user.message_id, "injected-user");
                    assert_eq!(user.text, "injected follow-up");
                    protocol_events.push("user_message_appended");
                }
                Some(pb::interaction_update::Message::TextDelta(update))
                    if update.text.contains("continued after injection") =>
                {
                    protocol_events.push("continued_output");
                }
                _ => {}
            }
        }
        acknowledge_kv(&handle, &mut append_seqno, &frame).await;
    }

    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    let continued_history = serde_json::to_string(&requests[1].history).unwrap();
    assert!(continued_history.contains("injected follow-up"));
    assert!(!handle.cancellation().is_cancelled());
    assert_eq!(
        protocol_events,
        [
            "queued",
            "delivered",
            "user_message_appended",
            "continued_output"
        ]
    );
}

#[tokio::test]
async fn cancel_subagent_action_aborts_the_target_task_and_keeps_the_parent_running() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "task-cycle".into(),
        },
        ModelEvent::ToolCallStart {
            index: 0,
            call_id: "task-call".into(),
            name: "Task".into(),
        },
        ModelEvent::ToolCallArgumentsDelta {
            index: 0,
            delta: serde_json::json!({
                "description": "Inspect protocol",
                "prompt": "Inspect the protocol",
                "subagent_type": "generalPurpose",
                "run_in_background": false
            })
            .to_string(),
        },
        ModelEvent::ToolCallEnd { index: 0 },
        ModelEvent::Done(FinishReason::ToolUse),
    ]);
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "continued".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("continued after subagent cancellation".into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = CursorSessionRegistry::new(
        store,
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
        Default::default(),
    );
    let handle = registry
        .get_or_create("cancel-subagent-request")
        .await
        .unwrap();
    let mut output = handle.subscribe();
    handle
        .command(CursorCommand::Append {
            seqno: 0,
            message: Box::new(client_run_for(
                "cancel-subagent-request",
                "cancel-subagent-conversation",
            )),
        })
        .await
        .unwrap();

    let mut append_seqno = 1;
    let exec_id = loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before Task exec");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        assert_eq!(flags & connect::END_STREAM_FLAG, 0);
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
                let Some(pb::exec_server_message::Message::SubagentArgs(args)) = exec.message
                else {
                    continue;
                };
                assert_eq!(args.tool_call_id, "task-call");
                break exec.id;
            }
            _ => {}
        }
    };

    handle
        .command(CursorCommand::Append {
            seqno: append_seqno,
            message: Box::new(runtime_cancel_subagent("task-call")),
        })
        .await
        .unwrap();
    append_seqno += 1;

    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before Task abort");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        assert_eq!(flags & connect::END_STREAM_FLAG, 0);
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        match server.message {
            Some(pb::agent_server_message::Message::ExecServerControlMessage(control)) => {
                let Some(pb::exec_server_control_message::Message::Abort(abort)) = control.message
                else {
                    continue;
                };
                assert_eq!(abort.id, exec_id);
                break;
            }
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
            _ => {}
        }
    }

    handle
        .command(CursorCommand::Append {
            seqno: append_seqno,
            message: Box::new(subagent_aborted(exec_id)),
        })
        .await
        .unwrap();
    append_seqno += 1;

    let mut saw_continued = false;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .expect("RunSSE closed before successful EndStream");
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            assert_eq!(payload.as_ref(), b"{}");
            break;
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
            Some(pb::agent_server_message::Message::InteractionUpdate(update)) => {
                if let Some(pb::interaction_update::Message::TextDelta(delta)) = update.message {
                    saw_continued |= delta.text.contains("continued after subagent cancellation");
                }
            }
            _ => {}
        }
    }

    assert!(saw_continued);
    assert!(!handle.cancellation().is_cancelled());
    assert_eq!(provider.requests().len(), 2);
}

fn client_run() -> pb::AgentClientMessage {
    client_run_for("cancel-request", "cancel-conversation")
}

fn client_run_for(request_id: &str, conversation_id: &str) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::UserMessageAction(
                        pb::UserMessageAction {
                            user_message: Some(pb::UserMessage {
                                text: "read".into(),
                                message_id: "cancel-user".into(),
                                mode: pb::AgentMode::Agent as i32,
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                conversation_id: Some(conversation_id.into()),
                run_id: Some(request_id.into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: "test-model".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    }
}

async fn acknowledge_kv(
    handle: &cursor_server::cursor::CursorSessionHandle,
    append_seqno: &mut i64,
    frame: &[u8],
) {
    let (flags, payload) = connect::decode_frames(frame).unwrap().pop().unwrap();
    if flags & connect::END_STREAM_FLAG != 0 {
        return;
    }
    let server = pb::AgentServerMessage::decode(payload).unwrap();
    if let Some(pb::agent_server_message::Message::KvServerMessage(kv)) = server.message {
        handle
            .command(CursorCommand::Append {
                seqno: *append_seqno,
                message: Box::new(kv_ack(kv.id)),
            })
            .await
            .unwrap();
        *append_seqno += 1;
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

fn runtime_user_message() -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::ConversationAction(
            pb::ConversationAction {
                action: Some(pb::conversation_action::Action::UserMessageAction(
                    pb::UserMessageAction {
                        user_message: Some(pb::UserMessage {
                            text: "queued follow-up".into(),
                            message_id: "queued-user".into(),
                            mode: pb::AgentMode::Agent as i32,
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            },
        )),
    }
}

fn runtime_injection() -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::ConversationAction(
            pb::ConversationAction {
                action: Some(pb::conversation_action::Action::InjectContextAction(
                    pb::InjectContextAction {
                        injection_id: "injection-1".into(),
                        expected_run_id: "inject-request".into(),
                        payload: Some(pb::inject_context_action::Payload::UserContext(
                            pb::UserContextInjection {
                                user_message: Some(pb::UserMessage {
                                    text: "injected follow-up".into(),
                                    message_id: "injected-user".into(),
                                    ..Default::default()
                                }),
                                request_context: Some(Default::default()),
                            },
                        )),
                    },
                )),
                ..Default::default()
            },
        )),
    }
}

fn runtime_cancel_subagent(tool_call_id: &str) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::ConversationAction(
            pb::ConversationAction {
                action: Some(pb::conversation_action::Action::CancelSubagentAction(
                    pb::CancelSubagentAction {
                        subagent_id: tool_call_id.into(),
                    },
                )),
                ..Default::default()
            },
        )),
    }
}

fn subagent_aborted(id: u32) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::ExecClientMessage(
            pb::ExecClientMessage {
                id,
                message: Some(pb::exec_client_message::Message::SubagentResult(
                    pb::SubagentResult {
                        result: Some(pb::subagent_result::Result::Error(pb::SubagentError {
                            agent_id: None,
                            error: "Subagent was aborted by the user".into(),
                        })),
                    },
                )),
                ..Default::default()
            },
        )),
    }
}
