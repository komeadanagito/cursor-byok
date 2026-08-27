use crate::{
    cursor::{
        interaction,
        proto::agent::v1 as pb,
        tools::{
            edit,
            result::{self, ToolCompletion},
            runtime::{CursorToolRuntime, ExecStage, PendingExec},
        },
    },
    model::ToolCall,
    Error, Result,
};

use super::request::{await_read_request, edit_write_request};

pub enum ClientExecEvent {
    Delta(Box<pb::AgentServerMessage>),
    Message(Box<pb::AgentServerMessage>),
    Completed(Box<ToolCompletion>),
    Pending,
}

pub async fn client_event(
    message: &pb::ExecClientMessage,
    pending: &CursorToolRuntime,
) -> Result<ClientExecEvent> {
    let call = match pending.exec_call(message.id).await {
        Some(call) => call,
        None if pending.completed_call(message.id).await.is_some() => {
            return Err(Error::Protocol(format!(
                "duplicate terminal ExecClientMessage id: {}",
                message.id
            )))
        }
        None => {
            return Err(Error::Protocol(format!(
                "unknown ExecClientMessage id: {}",
                message.id
            )))
        }
    };
    let Some(wire_result) = &message.message else {
        return Ok(ClientExecEvent::Pending);
    };
    let pb::exec_client_message::Message::ShellStream(stream) = wire_result else {
        let entry = take(message.id, pending).await?;
        return match entry.stage {
            ExecStage::EditRead => advance_edit(entry, wire_result, pending).await,
            ExecStage::Await(_) => advance_await(entry, wire_result, pending).await,
            ExecStage::Direct | ExecStage::DynamicMcp(_) | ExecStage::EditWrite(_) => {
                completed(entry, wire_result.clone())
            }
        };
    };
    use pb::shell_stream::Event;
    let event = match &stream.event {
        Some(Event::Stdout(stdout)) => {
            if pending.append_stdout(message.id, &stdout.data).await {
                ClientExecEvent::Delta(Box::new(shell_delta(&call, true, &stdout.data)))
            } else {
                ClientExecEvent::Pending
            }
        }
        Some(Event::Stderr(stderr)) => {
            if pending.append_stderr(message.id, &stderr.data).await {
                ClientExecEvent::Delta(Box::new(shell_delta(&call, false, &stderr.data)))
            } else {
                ClientExecEvent::Pending
            }
        }
        Some(Event::Start(_)) | Some(Event::HookContext(_)) => ClientExecEvent::Pending,
        Some(Event::Exit(exit)) => {
            let entry = take(message.id, pending).await?;
            let result = shell_exit_result(message, exit, &entry.stdout, &entry.stderr);
            completed(entry, pb::exec_client_message::Message::ShellResult(result))?
        }
        Some(Event::Backgrounded(backgrounded)) => {
            let entry = take(message.id, pending).await?;
            let result = shell_backgrounded_result(
                backgrounded,
                &entry.stdout,
                &entry.stderr,
                &entry.context.terminals_folder,
            );
            completed(entry, pb::exec_client_message::Message::ShellResult(result))?
        }
        Some(Event::Rejected(value)) => {
            let result = pb::ShellResult {
                result: Some(pb::shell_result::Result::Rejected(value.clone())),
                ..Default::default()
            };
            complete(
                message.id,
                pending,
                pb::exec_client_message::Message::ShellResult(result),
            )
            .await?
        }
        Some(Event::PermissionDenied(value)) => {
            let result = pb::ShellResult {
                result: Some(pb::shell_result::Result::PermissionDenied(value.clone())),
                ..Default::default()
            };
            complete(
                message.id,
                pending,
                pb::exec_client_message::Message::ShellResult(result),
            )
            .await?
        }
        Some(Event::SandboxUnsupported(value)) => {
            let result = pb::ShellResult {
                result: Some(pb::shell_result::Result::SpawnError(pb::ShellSpawnError {
                    command: value.command.clone(),
                    working_directory: value.working_directory.clone(),
                    error: value.reason.clone(),
                })),
                ..Default::default()
            };
            complete(
                message.id,
                pending,
                pb::exec_client_message::Message::ShellResult(result),
            )
            .await?
        }
        None => ClientExecEvent::Pending,
    };
    Ok(event)
}

pub async fn stream_closed(id: u32, pending: &CursorToolRuntime) -> Result<Option<ToolCompletion>> {
    let Some(entry) = pending.take_exec(id).await else {
        return Ok(None);
    };
    let error = "Cursor Exec stream closed before returning a terminal result";
    if entry.call.name.eq_ignore_ascii_case("Shell") {
        let command = entry
            .call
            .arguments
            .get("command")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let working_directory = entry
            .call
            .arguments
            .get("working_directory")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        return Ok(Some(result::from_exec(
            entry,
            &pb::exec_client_message::Message::ShellResult(pb::ShellResult {
                result: Some(pb::shell_result::Result::SpawnError(pb::ShellSpawnError {
                    command,
                    working_directory,
                    error: error.into(),
                })),
                ..Default::default()
            }),
        )?));
    }
    let rendered = match &entry.stage {
        ExecStage::DynamicMcp(definition) => {
            interaction::render_dynamic_mcp(&entry.call, definition, false)
        }
        _ => interaction::render_tool_call(&entry.call, false)?,
    };
    Ok(Some(ToolCompletion::from_rendered(
        &entry.call,
        entry.started_at_ms,
        error.into(),
        true,
        rendered,
    )?))
}

async fn advance_await(
    entry: PendingExec,
    result: &pb::exec_client_message::Message,
    registry: &CursorToolRuntime,
) -> Result<ClientExecEvent> {
    let read = match result {
        pb::exec_client_message::Message::ReadResult(result)
        | pb::exec_client_message::Message::RedactedReadResult(result) => result,
        _ => return Err(Error::Protocol("AwaitShell expected ReadResult".into())),
    };
    let ExecStage::Await(state) = &entry.stage else {
        return Err(Error::Protocol(
            "AwaitShell result reached a non-await execution stage".into(),
        ));
    };
    let content = match read.result.as_ref() {
        Some(pb::read_result::Result::Success(success)) => match success.output.as_ref() {
            Some(pb::read_success::Output::Content(content)) => content.as_str(),
            _ => "",
        },
        Some(pb::read_result::Result::FileNotFound(_)) => "",
        Some(pb::read_result::Result::Error(error)) => {
            return Ok(ClientExecEvent::Completed(Box::new(result::await_error(
                entry,
                &error.error,
            )?)))
        }
        _ => "",
    };
    let regex_match = state
        .regex
        .as_ref()
        .map(|pattern| regex::Regex::new(pattern))
        .transpose()
        .map_err(|error| Error::Protocol(format!("invalid AwaitShell pattern: {error}")))?
        .and_then(|pattern| {
            pattern
                .find(content)
                .map(|found| found.as_str().to_string())
        });
    let exit_code = content.lines().find_map(|line| {
        line.strip_prefix("exit_code:")
            .and_then(|value| value.trim().parse::<i32>().ok())
    });
    if regex_match.is_some() || exit_code.is_some() || std::time::Instant::now() >= state.deadline {
        return Ok(ClientExecEvent::Completed(Box::new(result::await_result(
            entry,
            content.len() as u64,
            regex_match,
            exit_code,
        )?)));
    }
    let state = match entry.stage {
        ExecStage::Await(state) => state,
        _ => {
            return Err(Error::Protocol(
                "AwaitShell result changed execution stage".into(),
            ))
        }
    };
    let wait = state
        .deadline
        .saturating_duration_since(std::time::Instant::now())
        .min(std::time::Duration::from_secs(1));
    tokio::time::sleep(wait).await;
    let call = entry.call.clone();
    let context = entry.context.clone();
    let id = registry
        .reserve_await_again(&call, &context, state, entry.started_at_ms)
        .await?;
    Ok(ClientExecEvent::Message(Box::new(await_read_request(
        id, &call, &context,
    )?)))
}

async fn advance_edit(
    entry: PendingExec,
    result: &pb::exec_client_message::Message,
    registry: &CursorToolRuntime,
) -> Result<ClientExecEvent> {
    let read = match result {
        pb::exec_client_message::Message::ReadResult(result)
        | pb::exec_client_message::Message::RedactedReadResult(result) => result,
        _ => {
            return Err(Error::Protocol(format!(
                "expected ReadResult for edit tool {}",
                entry.call.name
            )))
        }
    };
    let write = match edit::after_read(&entry.call, read) {
        Ok(write) => write,
        Err(error) => {
            return Ok(ClientExecEvent::Completed(Box::new(result::edit_failure(
                entry, error,
            )?)))
        }
    };
    let id = registry
        .reserve_edit_write(
            &entry.call,
            &entry.context,
            write.clone(),
            entry.started_at_ms,
        )
        .await?;
    Ok(ClientExecEvent::Message(Box::new(edit_write_request(
        id,
        &entry.call,
        &write,
    )?)))
}

async fn complete(
    id: u32,
    pending: &CursorToolRuntime,
    result: pb::exec_client_message::Message,
) -> Result<ClientExecEvent> {
    completed(take(id, pending).await?, result)
}

async fn take(id: u32, pending: &CursorToolRuntime) -> Result<PendingExec> {
    pending
        .take_exec(id)
        .await
        .ok_or_else(|| Error::Protocol(format!("unknown terminal Exec id: {id}")))
}

fn completed(
    pending: PendingExec,
    result: pb::exec_client_message::Message,
) -> Result<ClientExecEvent> {
    Ok(ClientExecEvent::Completed(Box::new(result::from_exec(
        pending, &result,
    )?)))
}

fn shell_exit_result(
    message: &pb::ExecClientMessage,
    exit: &pb::ShellStreamExit,
    stdout: &str,
    stderr: &str,
) -> pb::ShellResult {
    let result = if exit.code == 0 && !exit.aborted {
        pb::shell_result::Result::Success(pb::ShellSuccess {
            working_directory: exit.cwd.clone(),
            exit_code: exit.code as i32,
            stdout: stdout.into(),
            stderr: stderr.into(),
            interleaved_output: Some(format!("{stdout}{stderr}")),
            local_execution_time_ms: exit
                .local_execution_time_ms
                .or(message.local_execution_time_ms),
            ..Default::default()
        })
    } else {
        pb::shell_result::Result::Failure(pb::ShellFailure {
            working_directory: exit.cwd.clone(),
            exit_code: exit.code as i32,
            stdout: stdout.into(),
            stderr: stderr.into(),
            interleaved_output: Some(format!("{stdout}{stderr}")),
            abort_reason: exit.abort_reason,
            aborted: exit.aborted,
            local_execution_time_ms: exit
                .local_execution_time_ms
                .or(message.local_execution_time_ms),
            ..Default::default()
        })
    };
    pb::ShellResult {
        result: Some(result),
        is_background: Some(false),
        ..Default::default()
    }
}

fn shell_backgrounded_result(
    backgrounded: &pb::ShellStreamBackgrounded,
    stdout: &str,
    stderr: &str,
    terminals_folder: &str,
) -> pb::ShellResult {
    pb::ShellResult {
        result: Some(pb::shell_result::Result::Success(pb::ShellSuccess {
            command: backgrounded.command.clone(),
            working_directory: backgrounded.working_directory.clone(),
            stdout: stdout.into(),
            stderr: stderr.into(),
            shell_id: Some(backgrounded.shell_id),
            pid: backgrounded.pid,
            ms_to_wait: backgrounded.ms_to_wait,
            background_reason: backgrounded.reason,
            interleaved_output: Some(format!("{stdout}{stderr}")),
            ..Default::default()
        })),
        is_background: Some(true),
        terminals_folder: (!terminals_folder.is_empty()).then(|| terminals_folder.into()),
        pid: backgrounded.pid,
        ..Default::default()
    }
}

fn shell_delta(call: &ToolCall, stdout: bool, content: &str) -> pb::AgentServerMessage {
    let delta = if stdout {
        pb::shell_tool_call_delta::Delta::Stdout(pb::ShellToolCallStdoutDelta {
            content: content.into(),
        })
    } else {
        pb::shell_tool_call_delta::Delta::Stderr(pb::ShellToolCallStderrDelta {
            content: content.into(),
        })
    };
    interaction::server_interaction(pb::interaction_update::Message::ToolCallDelta(Box::new(
        pb::ToolCallDeltaUpdate {
            call_id: call.call_id.clone(),
            tool_call_delta: Some(Box::new(pb::ToolCallDelta {
                delta: Some(pb::tool_call_delta::Delta::ShellToolCallDelta(
                    pb::ShellToolCallDelta { delta: Some(delta) },
                )),
            })),
            model_call_id: call.model_call_id.clone(),
        },
    )))
}
