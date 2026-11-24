//! Covers the injected MCP routing and desktop command approval boundary.

use std::collections::BTreeMap;

use serde_json::json;

use super::*;
use crate::cursor::tools::runtime::CursorToolRuntime;

fn call(tool: &str, arguments: serde_json::Value) -> ToolCall {
    let arguments = json!({"server":"cursor-devtools", "toolName":tool, "arguments":arguments});
    ToolCall {
        index: 0,
        call_id: "local-tool-1".into(),
        model_call_id: "model-local-tool-1".into(),
        name: "CallMcpTool".into(),
        arguments_text: arguments.to_string(),
        arguments,
        argument_error: None,
    }
}

fn approval_query(messages: &[pb::AgentServerMessage]) -> (u32, &pb::AskQuestionInteractionQuery) {
    messages
        .iter()
        .find_map(|message| match message.message.as_ref()? {
            pb::agent_server_message::Message::InteractionQuery(query) => {
                match query.query.as_ref()? {
                    pb::interaction_query::Query::AskQuestionInteractionQuery(ask) => {
                        Some((query.id, ask))
                    }
                    _ => None,
                }
            }
            _ => None,
        })
        .expect("local_run must ask for approval in Cursor before running")
}

fn answer(id: u32, option: &str) -> pb::InteractionResponse {
    pb::InteractionResponse {
        id,
        result: Some(
            pb::interaction_response::Result::AskQuestionInteractionResponse(
                pb::AskQuestionInteractionResponse {
                    result: Some(pb::AskQuestionResult {
                        result: Some(pb::ask_question_result::Result::Success(
                            pb::AskQuestionSuccess {
                                answers: vec![pb::ask_question_success::Answer {
                                    question_id: "byok-desktop-command".into(),
                                    selected_option_ids: vec![option.into()],
                                    freeform_text: String::new(),
                                }],
                            },
                        )),
                    }),
                },
            ),
        ),
    }
}

fn started_ids(messages: &[pb::AgentServerMessage]) -> Vec<&str> {
    updates(messages)
        .filter_map(|update| match update {
            pb::interaction_update::Message::ToolCallStarted(started) => {
                Some(started.call_id.as_str())
            }
            _ => None,
        })
        .collect()
}

fn completed_ids(messages: &[pb::AgentServerMessage]) -> Vec<&str> {
    updates(messages)
        .filter_map(|update| match update {
            pb::interaction_update::Message::ToolCallCompleted(completed) => {
                Some(completed.call_id.as_str())
            }
            _ => None,
        })
        .collect()
}

fn updates(
    messages: &[pb::AgentServerMessage],
) -> impl Iterator<Item = &pb::interaction_update::Message> {
    messages
        .iter()
        .filter_map(|message| match message.message.as_ref()? {
            pb::agent_server_message::Message::InteractionUpdate(update) => update.message.as_ref(),
            _ => None,
        })
}

async fn start_call(
    runtime: &CursorToolRuntime,
    results: &ToolResultSender,
    call: &ToolCall,
) -> ToolStart {
    start(
        runtime,
        results,
        call,
        0,
        &BTreeMap::new(),
        &ExecContext::default(),
    )
    .await
    .unwrap()
}

async fn respond(
    runtime: &CursorToolRuntime,
    results: &ToolResultSender,
    response: &pb::InteractionResponse,
) -> ToolStart {
    let pending = runtime.take_interaction(response.id).await.unwrap();
    resume_interaction(
        results,
        &WebSearch::built_in(),
        &WebFetch::built_in(),
        pending,
        response,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn local_run_displays_the_exact_command_before_any_execution() {
    let runtime = CursorToolRuntime::default();
    let cmd = "printf cursor-devtools-approval";
    let (results, _) = crate::cursor::tools::tool_call_result::tool_result_channel();
    let started = start_call(
        &runtime,
        &results,
        &call("local_run", json!({"command":cmd})),
    )
    .await;
    assert!(started.completion.is_none());
    let (id, ask) = approval_query(&started.messages);
    assert!(ask.args.as_ref().unwrap().questions[0].prompt.contains(cmd));
    let outcome = respond(
        &runtime,
        &results,
        &pb::InteractionResponse { id, result: None },
    )
    .await;
    let result = outcome
        .completion
        .expect("missing approval must complete as a rejection");
    assert!(result.result().is_error);
}

// Cursor looks up the question card by tool_call_id and reuses any card it
// already has; reusing the MCP card's id hides the question and leaves the
// conversation waiting with its spinner stopped.
#[tokio::test]
async fn local_run_approval_opens_its_own_question_card() {
    let runtime = CursorToolRuntime::default();
    let (results, _) = crate::cursor::tools::tool_call_result::tool_result_channel();
    let mcp_call = call("local_run", json!({"command":"printf approval-card"}));
    let started = start_call(&runtime, &results, &mcp_call).await;
    let (_, ask) = approval_query(&started.messages);
    assert!(!ask.tool_call_id.is_empty());
    assert_ne!(ask.tool_call_id, mcp_call.call_id);
    assert_eq!(started_ids(&started.messages), [ask.tool_call_id.as_str()]);
}

// Without this echo Cursor treats the answer as lost after 30 seconds and
// interrupts the run to redeliver it, while the command may still be running.
#[tokio::test]
async fn answering_the_approval_settles_the_question_card_without_waiting_for_the_command() {
    for option in ["run-once", "deny"] {
        let runtime = CursorToolRuntime::default();
        let (results, _receiver) = crate::cursor::tools::tool_call_result::tool_result_channel();
        let mcp_call = call("local_run", json!({"command":"printf settled"}));
        let started = start_call(&runtime, &results, &mcp_call).await;
        let (id, ask) = approval_query(&started.messages);
        let outcome = respond(&runtime, &results, &answer(id, option)).await;
        assert_eq!(
            completed_ids(&outcome.messages),
            [ask.tool_call_id.as_str()],
            "{option}"
        );
        assert_eq!(outcome.completion.is_some(), option == "deny", "{option}");
    }
}

#[tokio::test]
async fn a_directory_removed_before_approval_fails_the_call_and_still_settles_the_question() {
    let runtime = CursorToolRuntime::default();
    let (results, _receiver) = crate::cursor::tools::tool_call_result::tool_result_channel();
    let directory = tempfile::tempdir().unwrap();
    let mcp_call = call(
        "local_run",
        json!({"command":"printf gone", "cwd":directory.path()}),
    );
    let started = start_call(&runtime, &results, &mcp_call).await;
    let (id, ask) = approval_query(&started.messages);
    directory.close().unwrap();
    let outcome = respond(&runtime, &results, &answer(id, "run-once")).await;
    assert_eq!(
        completed_ids(&outcome.messages),
        [ask.tool_call_id.as_str()]
    );
    assert!(outcome.completion.unwrap().result().is_error);
}

#[tokio::test]
async fn approved_local_run_returns_desktop_output_in_an_mcp_card() {
    let runtime = CursorToolRuntime::default();
    let (results, mut receiver) = crate::cursor::tools::tool_call_result::tool_result_channel();
    let command = if cfg!(windows) {
        "Write-Output cursor-devtools-local"
    } else {
        "printf cursor-devtools-local"
    };
    let mcp_call = call("local_run", json!({"command": command}));
    let started = start_call(&runtime, &results, &mcp_call).await;
    let (id, _) = approval_query(&started.messages);
    let outcome = respond(&runtime, &results, &answer(id, "run-once")).await;
    assert!(outcome.completion.is_none());
    let completion = tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(completion.result().call_id, mcp_call.call_id);
    assert!(completion
        .result()
        .content
        .contains("cursor-devtools-local"));
    assert!(matches!(
        completion.tool_call().tool,
        Some(pb::tool_call::Tool::McpToolCall(_))
    ));
}
