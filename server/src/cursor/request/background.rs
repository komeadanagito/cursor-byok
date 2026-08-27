use std::collections::BTreeMap;

use crate::{cursor::proto::agent::v1 as pb, Error, Result};

pub(super) const FOLLOW_UP: &str = concat!(
    "Perform any necessary follow-up actions in response to the subagent completion above. ",
    "If no follow-up work is needed, no further action is required. ",
    "If you mention an agent or subagent in your response, link it with the `[Name](id)` ",
    "Don't use generic label such as `[agent]`, `[worker]`, or `[subagent]`. ",
    "For cloud subagents, when the agent has edited code, link to `[Review](bc-id#changes)`, ",
    "or, if you know the exact added and deleted line counts, `[Review +A −D](bc-id#changes)`, ",
    "replacing A and D with those counts. Never write A or D literally. ",
    "Use `[Try Live](bc-id#desktop)` only when the agent used computer use. ",
    "Don't repeat the same confirmation every time."
);

pub(super) const SHELL_FOLLOW_UP: &str = concat!(
    "Briefly inform the user about the task result and perform any follow-up actions (if needed). ",
    "If there's no follow-ups needed, don't explicitly say that."
);

#[derive(Debug)]
pub(super) struct Projection {
    pub context: String,
    pub turn_user: pb::UserMessage,
}

pub(super) fn project(
    action: &pb::BackgroundTaskCompletionAction,
    mode: i32,
) -> Result<Projection> {
    if action.completions.is_empty() {
        return Err(Error::Protocol(
            "background task completion action contains no completion".into(),
        ));
    }

    let mut completions = BTreeMap::new();
    let mut has_shell = false;
    let mut has_subagent = false;
    for completion in &action.completions {
        let kind = pb::BackgroundTaskKind::try_from(completion.kind).map_err(|_| {
            Error::Protocol(format!("unknown background task kind: {}", completion.kind))
        })?;
        if kind == pb::BackgroundTaskKind::Unspecified {
            return Err(Error::Protocol(format!(
                "background task completion has invalid kind: {}",
                kind.as_str_name()
            )));
        }
        let reason =
            pb::BackgroundTaskCompletionReason::try_from(completion.reason).map_err(|_| {
                Error::Protocol(format!(
                    "unknown background task completion reason: {}",
                    completion.reason
                ))
            })?;
        if reason != pb::BackgroundTaskCompletionReason::TaskFinished {
            return Err(Error::Protocol(format!(
                "background task notification is not a finished task: {}",
                reason.as_str_name()
            )));
        }
        if completion.task_id.is_empty() || completion.title.is_empty() {
            return Err(Error::Protocol(
                "background task completion requires task_id and title".into(),
            ));
        }
        let agent_id = match kind {
            pb::BackgroundTaskKind::Shell => {
                has_shell = true;
                None
            }
            pb::BackgroundTaskKind::Subagent => {
                has_subagent = true;
                Some(
                    completion
                        .subagent_id
                        .as_deref()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(|| {
                            Error::Protocol(
                                "background subagent completion has no subagent_id".into(),
                            )
                        })?,
                )
            }
            pb::BackgroundTaskKind::Unspecified => unreachable!(),
        };
        let tool_call_id = completion
            .tool_call_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                Error::Protocol("background task completion has no tool_call_id".into())
            })?;
        let task_identity = agent_id.unwrap_or(&completion.task_id);
        let identity = format!("{}:{task_identity}:{tool_call_id}", kind.as_str_name());
        let context = completion_context(completion, kind, agent_id)?;
        if completions
            .insert(identity.clone(), (completion, context))
            .is_some()
        {
            return Err(Error::Protocol(format!(
                "duplicate background task completion: {identity}"
            )));
        }
    }

    let (first, _) = completions
        .values()
        .next()
        .expect("background completion action was validated as non-empty");
    let text = match (has_shell, has_subagent) {
        (true, false) => SHELL_FOLLOW_UP.into(),
        (false, true) => FOLLOW_UP.into(),
        (true, true) => format!("{SHELL_FOLLOW_UP}\n\n{FOLLOW_UP}"),
        (false, false) => unreachable!(),
    };
    Ok(Projection {
        context: completions
            .values()
            .map(|(_, context)| context.as_str())
            .collect::<Vec<_>>()
            .join("\n\n"),
        turn_user: pb::UserMessage {
            text,
            message_id: format!(
                "background-completed:{}",
                completions.keys().cloned().collect::<Vec<_>>().join(":")
            ),
            mode,
            is_simulated_msg: Some(true),
            simulated_msg_reason: Some(pb::SimulatedMsgReason::BackgroundTaskCompletion as i32),
            simulated_message_metadata: Some(pb::user_message::SimulatedMessageMetadata {
                title: Some(first.title.clone()),
                task_id: Some(first.task_id.clone()),
                ..Default::default()
            }),
            ..Default::default()
        },
    })
}

fn status(completion: &pb::BackgroundTaskCompletion) -> Result<pb::BackgroundTaskStatus> {
    let status = pb::BackgroundTaskStatus::try_from(completion.status).map_err(|_| {
        Error::Protocol(format!(
            "unknown background task status: {}",
            completion.status
        ))
    })?;
    if status == pb::BackgroundTaskStatus::Unspecified {
        return Err(Error::Protocol(
            "background task completion has unspecified status".into(),
        ));
    }
    Ok(status)
}

fn completion_context(
    completion: &pb::BackgroundTaskCompletion,
    kind: pb::BackgroundTaskKind,
    agent_id: Option<&str>,
) -> Result<String> {
    let status = status(completion)?;
    let mut fields = vec![
        format!(
            "kind: {}",
            match kind {
                pb::BackgroundTaskKind::Shell => "shell",
                pb::BackgroundTaskKind::Subagent => "subagent",
                pb::BackgroundTaskKind::Unspecified => unreachable!(),
            }
        ),
        format!("status: {}", status_name(status)),
        format!("task_id: {}", completion.task_id),
        format!("title: {}", completion.title),
    ];
    optional_field(
        &mut fields,
        "tool_call_id",
        completion.tool_call_id.as_deref(),
    );
    optional_field(&mut fields, "agent_id", agent_id);
    optional_field(&mut fields, "detail", completion.detail.as_deref());
    optional_field(
        &mut fields,
        "output_path",
        completion.output_path.as_deref(),
    );
    optional_field(&mut fields, "thread_id", completion.thread_id.as_deref());
    Ok(format!(
        "<system_notification>\nThe following task has finished. If you were already aware, ignore this notification and do not restate prior responses.\n\n<task>\n{}\n</task>\n</system_notification>",
        fields.join("\n")
    ))
}

fn optional_field(fields: &mut Vec<String>, name: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        fields.push(format!("{name}: {value}"));
    }
}

fn status_name(status: pb::BackgroundTaskStatus) -> &'static str {
    match status {
        pb::BackgroundTaskStatus::Success => "success",
        pb::BackgroundTaskStatus::Error => "error",
        pb::BackgroundTaskStatus::Aborted => "aborted",
        pb::BackgroundTaskStatus::Unspecified => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finished_subagent_becomes_an_idempotent_user_runtime_event() {
        let action = pb::BackgroundTaskCompletionAction {
            completions: vec![completion()],
        };
        let projection = project(&action, pb::AgentMode::Multitask as i32).unwrap();

        assert!(projection.context.contains("kind: subagent"));
        assert!(projection.context.contains("agent_id: child-id"));
        assert!(projection.context.contains("child result"));

        assert_eq!(projection.turn_user.text, FOLLOW_UP);
        assert_eq!(projection.turn_user.is_simulated_msg, Some(true));
        assert_eq!(
            projection.turn_user.simulated_msg_reason,
            Some(pb::SimulatedMsgReason::BackgroundTaskCompletion as i32)
        );
    }

    #[test]
    fn finished_shell_becomes_the_captured_system_notification() {
        let action = pb::BackgroundTaskCompletionAction {
            completions: vec![shell_completion()],
        };
        let projection = project(&action, pb::AgentMode::Agent as i32).unwrap();

        assert_eq!(projection.turn_user.text, SHELL_FOLLOW_UP);
        assert_eq!(
            projection.context,
            concat!(
                "<system_notification>\n",
                "The following task has finished. If you were already aware, ignore this notification and do not restate prior responses.\n\n",
                "<task>\n",
                "kind: shell\n",
                "status: aborted\n",
                "task_id: 977679\n",
                "title: Start Python HTTP server on 9000\n",
                "tool_call_id: shell-call\n",
                "detail: terminated_by_user\n",
                "output_path: /tmp/977679.txt\n",
                "thread_id: terminal-thread\n",
                "</task>\n",
                "</system_notification>"
            )
        );
        assert_eq!(projection.turn_user.is_simulated_msg, Some(true));
        assert_eq!(
            projection.turn_user.simulated_msg_reason,
            Some(pb::SimulatedMsgReason::BackgroundTaskCompletion as i32)
        );
        let metadata = projection.turn_user.simulated_message_metadata.unwrap();
        assert_eq!(
            metadata.title.as_deref(),
            Some("Start Python HTTP server on 9000")
        );
        assert_eq!(metadata.task_id.as_deref(), Some("977679"));
    }

    #[test]
    fn shell_and_subagent_completions_keep_both_follow_up_contracts() {
        let projection = project(
            &pb::BackgroundTaskCompletionAction {
                completions: vec![shell_completion(), completion()],
            },
            pb::AgentMode::Multitask as i32,
        )
        .unwrap();

        assert!(projection.context.contains("kind: shell"));
        assert!(projection.context.contains("agent_id: child-id"));
        assert!(projection.turn_user.text.contains(SHELL_FOLLOW_UP));
        assert!(projection.turn_user.text.contains(FOLLOW_UP));
    }

    #[test]
    fn completion_batch_projection_is_independent_of_input_order() {
        let first = completion();
        let mut second = completion();
        second.task_id = "child-id-2".into();
        second.subagent_id = Some("child-id-2".into());
        second.tool_call_id = Some("task-call-2".into());
        let forward = project(
            &pb::BackgroundTaskCompletionAction {
                completions: vec![first.clone(), second.clone()],
            },
            pb::AgentMode::Multitask as i32,
        )
        .unwrap();
        let reversed = project(
            &pb::BackgroundTaskCompletionAction {
                completions: vec![second, first],
            },
            pb::AgentMode::Multitask as i32,
        )
        .unwrap();

        assert_eq!(forward.turn_user, reversed.turn_user);
        assert_eq!(forward.context, reversed.context);
    }

    #[test]
    fn resumed_subagent_completions_use_the_task_call_as_part_of_their_identity() {
        let first = project(
            &pb::BackgroundTaskCompletionAction {
                completions: vec![completion()],
            },
            pb::AgentMode::Multitask as i32,
        )
        .unwrap();
        let mut resumed = completion();
        resumed.tool_call_id = Some("task-call-2".into());
        let second = project(
            &pb::BackgroundTaskCompletionAction {
                completions: vec![resumed],
            },
            pb::AgentMode::Multitask as i32,
        )
        .unwrap();

        assert_ne!(first.turn_user.message_id, second.turn_user.message_id);
        assert!(first.turn_user.message_id.ends_with(":task-call"));
        assert!(second.turn_user.message_id.ends_with(":task-call-2"));
    }

    #[test]
    fn completion_requires_the_captured_subagent_identity_and_terminal_reason() {
        let mut value = completion();
        value.subagent_id = None;
        assert!(project(
            &pb::BackgroundTaskCompletionAction {
                completions: vec![value]
            },
            pb::AgentMode::Agent as i32
        )
        .unwrap_err()
        .to_string()
        .contains("subagent_id"));

        let mut value = completion();
        value.reason = pb::BackgroundTaskCompletionReason::TaskProgress as i32;
        assert!(project(
            &pb::BackgroundTaskCompletionAction {
                completions: vec![value]
            },
            pb::AgentMode::Agent as i32
        )
        .unwrap_err()
        .to_string()
        .contains("not a finished task"));
    }

    fn completion() -> pb::BackgroundTaskCompletion {
        pb::BackgroundTaskCompletion {
            task_id: "child-id".into(),
            kind: pb::BackgroundTaskKind::Subagent as i32,
            status: pb::BackgroundTaskStatus::Success as i32,
            title: "Inspect protocol".into(),
            detail: Some("child result".into()),
            reason: pb::BackgroundTaskCompletionReason::TaskFinished as i32,
            subagent_id: Some("child-id".into()),
            tool_call_id: Some("task-call".into()),
            ..Default::default()
        }
    }

    fn shell_completion() -> pb::BackgroundTaskCompletion {
        pb::BackgroundTaskCompletion {
            task_id: "977679".into(),
            kind: pb::BackgroundTaskKind::Shell as i32,
            status: pb::BackgroundTaskStatus::Aborted as i32,
            title: "Start Python HTTP server on 9000".into(),
            detail: Some("terminated_by_user".into()),
            output_path: Some("/tmp/977679.txt".into()),
            thread_id: Some("terminal-thread".into()),
            reason: pb::BackgroundTaskCompletionReason::TaskFinished as i32,
            tool_call_id: Some("shell-call".into()),
            ..Default::default()
        }
    }
}
