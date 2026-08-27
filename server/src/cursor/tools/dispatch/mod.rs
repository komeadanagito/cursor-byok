mod await_shell;
mod edit;
mod exec;
mod interaction;
mod local;
mod semble;

use std::collections::BTreeMap;

use crate::{
    cursor::proto::agent::v1 as pb,
    model::ToolCall,
    store::Store,
    web::{WebFetch, WebSearch},
    Error, Result,
};

use super::{
    result::{ToolCompletion, ToolResultSender},
    runtime::{CursorToolRuntime, ExecContext, PendingInteraction},
};

pub(super) struct ToolStart {
    pub messages: Vec<pb::AgentServerMessage>,
    pub completion: Option<ToolCompletion>,
}

pub(super) enum InteractionContinuation {
    Completed(Box<ToolCompletion>),
    Pending,
}

pub(super) async fn start(
    runtime: &CursorToolRuntime,
    results: &ToolResultSender,
    call: &ToolCall,
    message_index: usize,
    dynamic_mcp: &BTreeMap<String, pb::McpToolDefinition>,
    context: &ExecContext,
    store: Option<&Store>,
) -> Result<ToolStart> {
    if let Some(definition) = dynamic_mcp.get(&call.name) {
        return exec::start_dynamic(runtime, call, definition, context).await;
    }

    if is_mcp_auth(call) {
        return interaction::start(runtime, call).await;
    }

    if context.task_disabled(call) {
        return local::subagents_disabled(call);
    }

    match normalized(&call.name).as_str() {
        "shell" | "read" | "delete" | "grep" | "glob" | "readlints" | "task" | "callmcptool"
        | "fetchmcpresource" | "getmcptools" => exec::start(runtime, call, context).await,
        "write" | "strreplace" | "editnotebook" => edit::start(runtime, call, context).await,
        "askquestion" | "websearch" | "webfetch" | "switchmode" | "createplan"
        | "generateimage" => interaction::start(runtime, call).await,
        "todowrite" | "updatecurrentstep" => local::start(call, message_index),
        "awaitshell" => await_shell::start(runtime, results, call, context).await,
        "semblesearch" | "semblefindrelated" => semble::start(results, call, store.cloned()),
        _ => Err(Error::Protocol(format!("unsupported tool: {}", call.name))),
    }
}

fn is_mcp_auth(call: &ToolCall) -> bool {
    normalized(&call.name) == "callmcptool"
        && call
            .arguments
            .get("toolName")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|tool| normalized(tool) == "mcpauth")
}

pub(super) async fn resume_interaction(
    results: &ToolResultSender,
    search: &WebSearch,
    fetch: &WebFetch,
    pending: PendingInteraction,
    response: &pb::InteractionResponse,
) -> Result<InteractionContinuation> {
    interaction::resume(results, search, fetch, pending, response).await
}

pub(super) fn normalized(name: &str) -> String {
    name.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
