#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::sync::Arc;

use cursor_server::{
    cursor::{
        connect,
        prompting::{PromptAssets, PromptCompiler},
        proto::agent::v1 as pb,
        CursorCommand, CursorSessionRegistry,
    },
    model::{ContentPart, ProjectedContent},
    provider::{FinishReason, ModelEvent},
    store::{BlobId, Store},
};
use prost::Message;

#[tokio::test]
async fn retrying_the_same_edited_input_reuses_its_initial_branch() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    for (call, answer) in [
        ("model", "answer"),
        ("model-retry", "retry answer"),
        ("model-edit", "edited answer"),
        ("model-context-edit", "context edited answer"),
    ] {
        provider.push(vec![
            ModelEvent::Start {
                model_call_id: call.into(),
            },
            ModelEvent::TextStart,
            ModelEvent::TextDelta(answer.into()),
            ModelEvent::TextEnd,
            ModelEvent::Done(FinishReason::Stop),
        ]);
    }
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = CursorSessionRegistry::new(
        store.clone(),
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
        Default::default(),
    );

    for (request_id, text, visible_file) in [
        ("edited-input", "explain this", "/workspace/src/main.rs"),
        (
            "edited-input-retry",
            "explain this",
            "/workspace/src/main.rs",
        ),
        (
            "edited-input-changed",
            "explain the edited version",
            "/workspace/src/main.rs",
        ),
        (
            "edited-input-context-changed",
            "explain this",
            "/workspace/src/edited.rs",
        ),
    ] {
        let handle = registry.get_or_create(request_id).await.unwrap();
        let mut output = handle.subscribe();
        let mut request = run_request(references(&store).await);
        let Some(pb::agent_client_message::Message::RunRequest(run)) = request.message.as_mut()
        else {
            unreachable!("run_request always returns a RunRequest")
        };
        let Some(pb::conversation_action::Action::UserMessageAction(action)) = run
            .action
            .as_mut()
            .and_then(|action| action.action.as_mut())
        else {
            unreachable!("run_request always contains a UserMessageAction")
        };
        action
            .user_message
            .as_mut()
            .expect("run_request always contains a UserMessage")
            .text = text.into();
        let user = action
            .user_message
            .as_mut()
            .expect("run_request always contains a UserMessage");
        let Some(pb::invocation_context::Data::IdeState(ide)) = user
            .selected_context
            .as_mut()
            .and_then(|selected| selected.invocation_context.as_mut())
            .and_then(|invocation| invocation.data.as_mut())
        else {
            unreachable!("run_request always contains IDE state")
        };
        ide.visible_files[0].path = visible_file.into();
        handle
            .command(CursorCommand::Append {
                seqno: 0,
                message: Box::new(request),
            })
            .await
            .unwrap();
        let mut seqno = 1;
        loop {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
                .await
                .unwrap()
                .expect("retry must finish without closing the stream early");
            let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
            if flags & connect::END_STREAM_FLAG != 0 {
                let end = serde_json::from_slice::<serde_json::Value>(&payload).unwrap();
                assert_eq!(end, serde_json::json!({}));
                break;
            }
            let message = pb::AgentServerMessage::decode(payload).unwrap();
            if let Some(pb::agent_server_message::Message::KvServerMessage(kv)) = message.message {
                handle
                    .command(CursorCommand::Append {
                        seqno,
                        message: Box::new(kv_ack(kv.id)),
                    })
                    .await
                    .unwrap();
                seqno += 1;
            }
        }
    }

    let requests = provider.requests();
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[1].history, requests[0].history);
    assert_eq!(requests[2].history.len(), requests[0].history.len());
    assert_ne!(
        requests[2].history.last().unwrap().message_id,
        requests[0].history.last().unwrap().message_id
    );
    let ProjectedContent::Parts(parts) = &requests[2].history.last().unwrap().content else {
        panic!("edited runtime message must use typed parts")
    };
    let [ContentPart::Text { text }] = parts.as_slice() else {
        panic!("this fixture has no images")
    };
    assert!(text.contains("<user_query>\nexplain the edited version\n</user_query>"));
    assert_ne!(
        requests[3].history.last().unwrap().message_id,
        requests[0].history.last().unwrap().message_id
    );
    let ProjectedContent::Parts(parts) = &requests[3].history.last().unwrap().content else {
        panic!("context-edited runtime message must use typed parts")
    };
    let [ContentPart::Text { text }] = parts.as_slice() else {
        panic!("this fixture has no images")
    };
    assert!(text.contains("/workspace/src/edited.rs"));
}

#[tokio::test]
async fn unchanged_request_context_is_not_repeated_and_preserves_the_provider_prefix() {
    let (_directory, store) = fixtures::temp_store().await;
    let first_references = references(&store).await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "model".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("answer".into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]);
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "model-2".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("answer again".into()),
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
        store.clone(),
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
        Default::default(),
    );
    let handle = registry.get_or_create("ask-request").await.unwrap();
    let mut output = handle.subscribe();
    handle
        .command(CursorCommand::Append {
            seqno: 0,
            message: Box::new(run_request(first_references)),
        })
        .await
        .unwrap();

    let mut seqno = 1;
    let mut checkpoint = None;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .unwrap();
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            break;
        }
        let message = pb::AgentServerMessage::decode(payload).unwrap();
        match message.message {
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
            Some(pb::agent_server_message::Message::ConversationCheckpointUpdate(state)) => {
                checkpoint = Some(state);
            }
            _ => {}
        }
    }

    let requests = provider.requests();
    let request = &requests[0];
    assert!(request
        .prompt
        .tools
        .iter()
        .any(|tool| tool.name == "AskQuestion"));
    assert!(!request
        .prompt
        .tools
        .iter()
        .any(|tool| tool.name == "GenerateImage"));
    assert_eq!(request.history.len(), 2);
    assert!(request.history[0]
        .message_id
        .starts_with("request-context:"));
    let ProjectedContent::Parts(context_parts) = &request.history[0].content else {
        panic!("request context message must use typed parts")
    };
    let [ContentPart::Text { text: context_text }] = context_parts.as_slice() else {
        panic!("request context message must contain one text part")
    };
    assert!(request.history[1]
        .message_id
        .starts_with("runtime:cursor:user:wire-user:"));
    assert!(!request.prompt.instructions.contains("workspace rule"));
    assert!(!request.prompt.instructions.contains("<mcp_meta_tools>"));
    let ProjectedContent::Parts(parts) = &request.history[1].content else {
        panic!("runtime message must use typed parts")
    };
    let [ContentPart::Text { text }] = parts.as_slice() else {
        panic!("this fixture has no images")
    };
    for expected in [
        "<user_rule>\nworkspace rule\n</user_rule>",
        "<agent_skill fullPath=\"/skills/test/SKILL.md\">test skill</agent_skill>",
        "<subagent name=\"reviewer\">review code</subagent>",
        "<mcp_meta_tool_server name=\"test\" identifier=\"mcp-test\">",
        "<mcp_tool name=\"lookup\">",
        "<definition_path>/tmp/mcp-test/lookup.json</definition_path>",
        "<input_schema>{&quot;properties&quot;:{&quot;query&quot;:{&quot;type&quot;:&quot;string&quot;}},&quot;type&quot;:&quot;object&quot;}</input_schema>",
        "Call a listed tool directly with CallMcpTool without calling GetMcpTools first.",
    ] {
        assert!(
            context_text.contains(expected),
            "missing request context section: {expected}"
        );
    }
    assert!(!context_text.contains("complete skill body"));
    assert!(!context_text.contains("complete MCP server instructions"));
    for expected in [
        "Ask mode is active.",
        "<user_query>\nexplain this\n</user_query>",
    ] {
        assert!(
            text.contains(expected),
            "missing runtime section: {expected}"
        );
    }
    assert!(!text.contains("<rules>"));
    assert!(!text.contains("<mcp_meta_tools>"));
    assert!(text.contains("/workspace/src/main.rs"));

    let second = registry.get_or_create("ask-request-2").await.unwrap();
    let mut second_output = second.subscribe();
    second
        .command(CursorCommand::Append {
            seqno: 0,
            message: Box::new(run_request_with_state(
                references(&store).await,
                checkpoint.expect("first Run must publish a checkpoint"),
            )),
        })
        .await
        .unwrap();
    let mut second_seqno = 1;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), second_output.recv())
            .await
            .unwrap()
            .unwrap();
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            break;
        }
        let message = pb::AgentServerMessage::decode(payload).unwrap();
        if let Some(pb::agent_server_message::Message::KvServerMessage(kv)) = message.message {
            second
                .command(CursorCommand::Append {
                    seqno: second_seqno,
                    message: Box::new(kv_ack(kv.id)),
                })
                .await
                .unwrap();
            second_seqno += 1;
        }
    }

    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1].prompt.instructions, requests[0].prompt.instructions,
        "unchanged request context must not rewrite the system prompt"
    );
    assert_eq!(
        requests[1].history[..requests[0].history.len()],
        requests[0].history,
        "the previous provider history must remain an exact prefix"
    );
    assert_eq!(
        requests[1]
            .history
            .iter()
            .filter(|message| message.message_id.starts_with("request-context:"))
            .count(),
        1,
        "identical request context must not be appended again"
    );
}

#[tokio::test]
async fn missing_context_parts_use_current_cursor_response_and_cache_its_content() {
    let (_directory, store) = fixtures::temp_store().await;
    let referenced_context = fixture_context();
    let references = references_for(&referenced_context);
    let mut current_context = referenced_context.clone();
    current_context
        .mcp_meta_tool_options
        .as_mut()
        .unwrap()
        .mcp_descriptors
        .push(pb::McpDescriptor {
            server_identifier: "live-mcp".into(),
            tools: vec![pb::McpToolDescriptor {
                tool_name: "current-tool".into(),
                ..Default::default()
            }],
            ..Default::default()
        });
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "model".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("answer".into()),
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
        store.clone(),
        Arc::new(provider.clone()),
        PromptCompiler::new(assets),
        Default::default(),
    );
    let handle = registry.get_or_create("context-request").await.unwrap();
    let mut output = handle.subscribe();
    handle
        .command(CursorCommand::Append {
            seqno: 0,
            message: Box::new(run_request(references)),
        })
        .await
        .unwrap();

    let mut seqno = 1;
    let mut requested_context = false;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .unwrap();
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            break;
        }
        let message = pb::AgentServerMessage::decode(payload).unwrap();
        match message.message {
            Some(pb::agent_server_message::Message::ExecServerMessage(exec)) => {
                assert_eq!(exec.id, 0);
                let Some(pb::exec_server_message::Message::RequestContextArgs(args)) = exec.message
                else {
                    panic!("missing context must use RequestContextArgs")
                };
                assert_eq!(args.notes_session_id.as_deref(), Some("mode-conversation"));
                requested_context = true;
                handle
                    .command(CursorCommand::Append {
                        seqno,
                        message: Box::new(context_stream_close()),
                    })
                    .await
                    .unwrap();
                seqno += 1;
                handle
                    .command(CursorCommand::Append {
                        seqno,
                        message: Box::new(pb::AgentClientMessage {
                            message: Some(pb::agent_client_message::Message::ExecClientMessage(
                                pb::ExecClientMessage {
                                    id: 0,
                                    message: Some(
                                        pb::exec_client_message::Message::RequestContextResult(
                                            pb::RequestContextResult {
                                                result: Some(
                                                    pb::request_context_result::Result::Success(
                                                        pb::RequestContextSuccess {
                                                            request_context: Some(
                                                                current_context.clone(),
                                                            ),
                                                            ..Default::default()
                                                        },
                                                    ),
                                                ),
                                            },
                                        ),
                                    ),
                                    ..Default::default()
                                },
                            )),
                        }),
                    })
                    .await
                    .unwrap();
                seqno += 1;
            }
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
            _ => {}
        }
    }

    assert!(requested_context);
    let requests = provider.requests();
    assert_eq!(requests.len(), 1);
    let ProjectedContent::Parts(parts) = &requests[0].history[0].content else {
        panic!("request context message must use typed parts")
    };
    let [ContentPart::Text { text }] = parts.as_slice() else {
        panic!("request context message must contain one text part")
    };
    assert!(text.contains("<mcp_meta_tool_server name=\"live-mcp\" identifier=\"live-mcp\">"));
    assert!(text.contains("<mcp_tool name=\"current-tool\">"));

    let stale = references_for(&referenced_context);
    let current = references_for(&current_context);
    for (id, _) in [
        current.rules,
        current.skills,
        current.subagents,
        current.mcps,
    ] {
        assert!(store.get_blob(&id).await.unwrap().is_some());
    }
    assert!(store.get_blob(&stale.mcps.0).await.unwrap().is_none());
}

struct References {
    rules: (BlobId, u32),
    skills: (BlobId, u32),
    subagents: (BlobId, u32),
    mcps: (BlobId, u32),
}

async fn references(store: &Store) -> References {
    let context = fixture_context();
    let references = references_for(&context);
    for data in part_data(&context) {
        store.put_blob(&data, &[]).await.unwrap();
    }
    references
}

fn fixture_context() -> pb::RequestContext {
    pb::RequestContext {
        rules: vec![pb::CursorRule {
            full_path: "/workspace/AGENTS.md".into(),
            content: "workspace rule".into(),
            ..Default::default()
        }],
        non_file_rules: vec![pb::CursorRule {
            full_path: "/skills/test/SKILL.md".into(),
            content: "complete skill body".into(),
            ..Default::default()
        }],
        agent_skills: vec![pb::AgentSkill {
            full_path: "/skills/test/SKILL.md".into(),
            description: "test skill".into(),
            ..Default::default()
        }],
        custom_subagents: vec![pb::CustomSubagent {
            name: "reviewer".into(),
            description: "review code".into(),
            ..Default::default()
        }],
        mcp_meta_tool_options: Some(pb::McpMetaToolOptions {
            enabled: true,
            mcp_descriptors: vec![pb::McpDescriptor {
                server_name: "test".into(),
                server_identifier: "mcp-test".into(),
                server_use_instructions: Some("complete MCP server instructions".into()),
                tools: vec![pb::McpToolDescriptor {
                    tool_name: "lookup".into(),
                    definition_path: Some("/tmp/mcp-test/lookup.json".into()),
                    description: Some("look up a value".into()),
                    input_schema_json: Some(
                        r#"{"type":"object","properties":{"query":{"type":"string"}}}"#.into(),
                    ),
                    ..Default::default()
                }],
                ..Default::default()
            }],
        }),
        ..Default::default()
    }
}

fn references_for(context: &pb::RequestContext) -> References {
    let mut parts = part_data(context).into_iter();
    References {
        rules: reference(&parts.next().unwrap()),
        skills: reference(&parts.next().unwrap()),
        subagents: reference(&parts.next().unwrap()),
        mcps: reference(&parts.next().unwrap()),
    }
}

fn part_data(context: &pb::RequestContext) -> Vec<Vec<u8>> {
    vec![
        pb::RequestContextRulesPart {
            rules: context.rules.clone(),
            non_file_rules: context.non_file_rules.clone(),
            cloud_rule: context.cloud_rule.clone(),
        }
        .encode_to_vec(),
        pb::RequestContextSkillsPart {
            agent_skills: context.agent_skills.clone(),
            skill_options: context.skill_options.clone(),
        }
        .encode_to_vec(),
        pb::RequestContextSubagentsPart {
            custom_subagents: context.custom_subagents.clone(),
        }
        .encode_to_vec(),
        pb::RequestContextMcpsPart {
            tools: context.tools.clone(),
            mcp_instructions: context.mcp_instructions.clone(),
            mcp_file_system_options: context.mcp_file_system_options.clone(),
            mcp_meta_tool_options: context.mcp_meta_tool_options.clone(),
        }
        .encode_to_vec(),
    ]
}

fn reference(data: &[u8]) -> (BlobId, u32) {
    (BlobId::digest(data), data.len() as u32)
}

fn run_request(references: References) -> pb::AgentClientMessage {
    let (rules, rules_byte_length) = references.rules;
    let (skills, skills_byte_length) = references.skills;
    let (subagents, subagents_byte_length) = references.subagents;
    let (mcps, mcps_byte_length) = references.mcps;
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                conversation_state: Some(pb::ConversationStateStructure {
                    mode: Some(pb::AgentMode::Agent as i32),
                    ..Default::default()
                }),
                action: Some(pb::ConversationAction {
                    request_context_parts: Some(pb::RequestContextPartReferences {
                        rules_blob_id: rules.as_bytes().to_vec(),
                        rules_byte_length,
                        skills_blob_id: skills.as_bytes().to_vec(),
                        skills_byte_length,
                        subagents_blob_id: subagents.as_bytes().to_vec(),
                        subagents_byte_length,
                        mcps_blob_id: mcps.as_bytes().to_vec(),
                        mcps_byte_length,
                        dynamic_context: Some(pb::RequestContext {
                            env: Some(pb::RequestContextEnv {
                                os_version: "darwin".into(),
                                workspace_paths: vec!["/workspace".into()],
                                shell: "zsh".into(),
                                time_zone: "UTC".into(),
                                ..Default::default()
                            }),
                            ..Default::default()
                        }),
                    }),
                    action: Some(pb::conversation_action::Action::UserMessageAction(
                        pb::UserMessageAction {
                            user_message: Some(pb::UserMessage {
                                text: "explain this".into(),
                                message_id: "wire-user".into(),
                                mode: pb::AgentMode::Ask as i32,
                                selected_context: Some(pb::SelectedContext {
                                    invocation_context: Some(pb::InvocationContext {
                                        data: Some(pb::invocation_context::Data::IdeState(
                                            pb::invocation_context::IdeState {
                                                visible_files: vec![
                                                    pb::invocation_context::ide_state::File {
                                                        path: "/workspace/src/main.rs".into(),
                                                        total_lines: 10,
                                                        ..Default::default()
                                                    },
                                                ],
                                                ..Default::default()
                                            },
                                        )),
                                    }),
                                    ..Default::default()
                                }),
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                conversation_id: Some("mode-conversation".into()),
                run_id: Some("wire-run".into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: "test-model".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    }
}

fn run_request_with_state(
    references: References,
    state: pb::ConversationStateStructure,
) -> pb::AgentClientMessage {
    let mut message = run_request(references);
    let Some(pb::agent_client_message::Message::RunRequest(request)) = message.message.as_mut()
    else {
        unreachable!("run_request always returns a RunRequest")
    };
    request.conversation_state = Some(state);
    let Some(pb::conversation_action::Action::UserMessageAction(action)) = request
        .action
        .as_mut()
        .and_then(|action| action.action.as_mut())
    else {
        unreachable!("run_request always contains a UserMessageAction")
    };
    action
        .user_message
        .as_mut()
        .expect("run_request always contains a UserMessage")
        .message_id = "wire-user-2".into();
    message
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

fn context_stream_close() -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::ExecClientControlMessage(
            pb::ExecClientControlMessage {
                message: Some(pb::exec_client_control_message::Message::StreamClose(
                    pb::ExecClientStreamClose { id: 0 },
                )),
            },
        )),
    }
}
