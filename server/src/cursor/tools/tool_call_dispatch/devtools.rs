//! Runs injected desktop tools and renders their results as native Cursor MCP calls.

use std::{path::PathBuf, process::Stdio, time::Duration};

use base64::Engine;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

use crate::{
    cursor::tools::{
        browser_bridge, codec, devtools,
        runtime::{self, CursorToolRuntime, ExecContext, PendingInteraction},
        tool_call_result::{self as result, ToolCompletion, ToolResultSender},
    },
    model::ToolCall,
    Error, Result,
};

use super::{pb, ToolStart};

const QUESTION: &str = "byok-desktop-command";
const APPROVE: &str = "run-once";

pub(super) fn is_local_mcp(call: &ToolCall) -> bool {
    super::normalized(&call.name) == "callmcptool"
        && call.arguments.get("server").and_then(Value::as_str) == Some(devtools::SERVER)
}

pub(super) fn is_local_run(call: &ToolCall) -> bool {
    is_local_mcp(call)
        && call.arguments.get("toolName").and_then(Value::as_str) == Some("local_run")
}

pub(super) async fn start(
    runtime: &CursorToolRuntime,
    results: &ToolResultSender,
    call: &ToolCall,
) -> Result<ToolStart> {
    let (name, arguments) = tool_arguments(call)?;
    if !devtools::has_tool(name) {
        return Err(Error::Protocol(format!(
            "Unknown {} tool: {name}",
            devtools::SERVER
        )));
    }
    let mut messages = Vec::new();
    if is_local_run(call) {
        let local = LocalCommand::new(arguments)?;
        let mut approved_call = call.clone();
        // Resolve the cwd before showing it so approval and execution share the same input.
        approved_call.arguments["arguments"]["cwd"] = json!(local.cwd);
        let id = runtime.reserve_interaction(&approved_call).await?;
        let question = approval_question(&approved_call)?;
        messages.push(codec::tool_started(&question, None)?);
        messages.push(codec::tool_query(id, &question)?);
    } else {
        let call = call.clone();
        let sender = results.clone();
        let (name, arguments) = (name.to_string(), arguments.clone());
        let started = runtime::now_ms();
        tokio::spawn(async move {
            let outcome = browser_bridge::call(name, arguments).await;
            send(&sender, &call, started, outcome);
        });
    }
    Ok(ToolStart {
        messages,
        completion: None,
    })
}

pub(super) fn resume(
    results: &ToolResultSender,
    pending: PendingInteraction,
    response: &pb::InteractionResponse,
) -> Result<ToolStart> {
    let messages = settle_question(&pending, response)?;
    let failure = |message: String| -> Result<ToolStart> {
        Ok(ToolStart {
            messages: messages.clone(),
            completion: Some(result::mcp_failure(&pending.call, message)?),
        })
    };
    if !approved(response) {
        return failure("Desktop command was not approved.".into());
    }
    let local = match LocalCommand::new(tool_arguments(&pending.call)?.1) {
        Ok(local) => local,
        Err(error) => return failure(error.to_string()),
    };
    let sender = results.clone();
    tokio::spawn(async move {
        let outcome = local.run().await;
        send(&sender, &pending.call, pending.started_at_ms, outcome);
    });
    Ok(ToolStart {
        messages,
        completion: None,
    })
}

/// The approval is a separate card: Cursor finds a question's card by its call
/// id, and the local_run call's id already belongs to an MCP card, which cannot
/// display a question.
fn approval_question(call: &ToolCall) -> Result<ToolCall> {
    let arguments = tool_arguments(call)?.1;
    let text = |name: &str| {
        arguments
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
    };
    let mut question = call.clone();
    question.call_id = format!("{}-approval", call.call_id);
    question.name = "AskQuestion".into();
    question.arguments = json!({"title":"Run a command on this desktop?", "questions":[{
        "id": QUESTION,
        "prompt": format!("Desktop directory: {}\nCommand:\n{}", text("cwd"), text("command")),
        "options":[{"id": APPROVE,"label":"Run once"},{"id":"deny","label":"Reject"}]
    }]});
    question.arguments_text = question.arguments.to_string();
    Ok(question)
}

/// Cursor interrupts the run to redeliver an answer whose question card is not
/// completed within 30 seconds, so the card settles before the command runs.
fn settle_question(
    pending: &PendingInteraction,
    response: &pb::InteractionResponse,
) -> Result<Vec<pb::AgentServerMessage>> {
    use pb::interaction_response::Result::AskQuestionInteractionResponse;
    if !matches!(response.result.as_ref(), Some(AskQuestionInteractionResponse(reply)) if reply.result.is_some())
    {
        return Ok(Vec::new());
    }
    let question = approval_question(&pending.call)?;
    let completion = result::from_interaction(
        PendingInteraction {
            call: question.clone(),
            started_at_ms: pending.started_at_ms,
        },
        response,
    )?;
    Ok(vec![codec::tool_completed(&question, &completion)])
}

fn approved(response: &pb::InteractionResponse) -> bool {
    use pb::{
        ask_question_result::Result::Success,
        interaction_response::Result::AskQuestionInteractionResponse,
    };
    matches!(response.result.as_ref(), Some(AskQuestionInteractionResponse(reply)) if
        matches!(reply.result.as_ref().and_then(|result| result.result.as_ref()),
            Some(Success(success)) if matches!(success.answers.as_slice(), [answer] if
                answer.question_id == QUESTION && answer.selected_option_ids == [APPROVE])))
}

fn tool_arguments(call: &ToolCall) -> Result<(&str, &Value)> {
    let name = call
        .arguments
        .get("toolName")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Protocol("cursor-devtools requires toolName".into()))?;
    let args = call
        .arguments
        .get("arguments")
        .filter(|value| value.is_object())
        .ok_or_else(|| Error::Protocol("cursor-devtools requires an arguments object".into()))?;
    Ok((name, args))
}

fn send(
    sender: &ToolResultSender,
    call: &ToolCall,
    started: u64,
    outcome: std::result::Result<Value, String>,
) {
    let completion = match outcome {
        Ok(value) => complete(call, started, value),
        Err(error) => result::mcp_failure(call, error),
    };
    match completion {
        Ok(value) => sender.send(value),
        Err(error) => sender.send_error(error),
    }
}

fn complete(call: &ToolCall, started: u64, value: Value) -> Result<ToolCompletion> {
    use pb::mcp_tool_result_content_item::Content;
    let rendered = if let Some(image) = value.get("png").and_then(Value::as_str) {
        let data = base64::engine::general_purpose::STANDARD
            .decode(image)
            .map_err(|error| Error::Protocol(format!("Chrome screenshot base64: {error}")))?;
        Content::Image(pb::McpImageContent {
            mime_type: "image/png".into(),
            data,
        })
    } else {
        Content::Text(pb::McpTextContent {
            text: serde_json::to_string(&value)?,
            output_location: None,
        })
    };
    let wire = pb::exec_client_message::Message::McpResult(pb::McpResult {
        result: Some(pb::mcp_result::Result::Success(pb::McpSuccess {
            content: vec![pb::McpToolResultContentItem {
                content: Some(rendered),
            }],
            ..Default::default()
        })),
    });
    result::from_exec(
        runtime::PendingExec {
            call: call.clone(),
            context: ExecContext::default(),
            started_at_ms: started,
            stdout: String::new(),
            stderr: String::new(),
            stage: runtime::ExecStage::Direct,
        },
        &wire,
    )
}

struct LocalCommand {
    command: String,
    cwd: PathBuf,
    timeout: Duration,
}

impl LocalCommand {
    fn new(args: &Value) -> Result<Self> {
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| Error::Protocol("local_run requires a nonempty command".into()))?;
        let cwd = match args.get("cwd").and_then(Value::as_str) {
            Some(cwd) => PathBuf::from(cwd),
            None => dirs::home_dir().ok_or_else(|| {
                Error::Config("Cannot resolve the desktop user's home directory".into())
            })?,
        };
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(Error::Protocol(format!(
                "local_run requires a desktop directory: {}",
                cwd.display()
            )));
        }
        let timeout = args
            .get("timeout")
            .and_then(Value::as_u64)
            .unwrap_or(120)
            .clamp(1, 1800);
        Ok(Self {
            command: command.into(),
            cwd,
            timeout: Duration::from_secs(timeout),
        })
    }

    async fn run(self) -> std::result::Result<Value, String> {
        #[cfg(unix)]
        let mut command = {
            let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
            let mut command = Command::new(shell);
            command.args(["-lc", &self.command]);
            command
        };
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command", &self.command]);
            command
        };
        let mut child = command
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("Start desktop command: {error}"))?;
        let (stdout, stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
        let (status, stdout, stderr) = tokio::time::timeout(self.timeout, async {
            tokio::try_join!(child.wait(), tail(stdout), tail(stderr))
        })
        .await
        .map_err(|_| "Desktop command timed out")?
        .map_err(|error| format!("Read desktop command result: {error}"))?;
        Ok(json!({"exit_code":status.code(),"stdout":stdout,"stderr":stderr}))
    }
}

async fn tail(mut reader: impl AsyncRead + Unpin) -> std::io::Result<String> {
    const LIMIT: usize = 15_000;
    let mut result = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        result.extend_from_slice(&buffer[..count]);
        if result.len() > LIMIT {
            result.drain(..result.len() - LIMIT);
        }
    }
    Ok(String::from_utf8_lossy(&result).into_owned())
}
