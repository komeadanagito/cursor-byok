use tokio_util::sync::CancellationToken;

use crate::{
    client::{
        ClientCommand, ClientEvent, ClientPort, CommitBarrier, CommitCause, MessageInsertion,
        StateCommitted,
    },
    model::{PreparedRun, RevisionId, ToolCall, ToolRoundAssistant, ToolRoundId},
    store::Store,
};

use super::{RunFailure, RunOutcome};

pub(super) struct ToolRound {
    pub id: ToolRoundId,
    pub assistant: ToolRoundAssistant,
    pub calls: Vec<ToolCall>,
    pub recovered_started_at_ms: Option<u64>,
}

pub(super) async fn execute(
    store: &Store,
    prepared: &PreparedRun,
    client: &mut ClientPort,
    cancellation: &CancellationToken,
    mut revision: RevisionId,
    round: ToolRound,
    insertions: Vec<MessageInsertion>,
) -> std::result::Result<RevisionId, RunOutcome> {
    let ToolRound {
        id: round_id,
        assistant,
        calls,
        recovered_started_at_ms,
    } = round;
    store
        .create_tool_round(
            &round_id,
            &prepared.run_id,
            revision,
            &assistant,
            &calls,
            recovered_started_at_ms,
        )
        .await
        .map_err(failed)?;
    tracing::info!(
        round_id = %round_id,
        revision_id = revision.0,
        calls = calls.len(),
        "tool round started"
    );
    send(
        client,
        ClientEvent::StateCommitted(StateCommitted {
            revision_id: revision,
            tool_round_version: 0,
            cause: CommitCause::ToolRoundStarted(round_id.clone()),
            barrier: CommitBarrier::None,
        }),
    )
    .await?;
    send(
        client,
        ClientEvent::ExecuteToolRound {
            round_id: round_id.clone(),
            calls: calls.clone(),
        },
    )
    .await?;

    let mut remaining = calls.len();
    let mut pending_runtime_messages = insertions
        .into_iter()
        .map(PendingRuntimeMessage::Insertion)
        .collect::<Vec<_>>();
    while remaining > 0 {
        let command = tokio::select! {
            _ = cancellation.cancelled() => return Err(RunOutcome::Cancelled),
            command = client.commands.recv() => command,
        };
        match command {
            Some(ClientCommand::ToolResult(result)) => {
                let call_id = result.call_id.clone();
                let committed = store
                    .commit_tool_result(
                        &prepared.conversation_id,
                        &prepared.run_id,
                        &round_id,
                        &result,
                    )
                    .await
                    .map_err(failed)?;
                revision = committed.revision_id;
                tracing::info!(
                    round_id = %round_id,
                    call_id,
                    revision_id = revision.0,
                    tool_round_version = committed.tool_round_version,
                    completion_seq = committed.completion_seq,
                    settled = committed.settled,
                    "tool result committed"
                );
                remaining -= 1;
                let (barrier, ready) = if committed.settled {
                    let (barrier, ready) = CommitBarrier::before_continue();
                    (barrier, Some(ready))
                } else {
                    (CommitBarrier::None, None)
                };
                send(
                    client,
                    ClientEvent::StateCommitted(StateCommitted {
                        revision_id: revision,
                        tool_round_version: committed.tool_round_version,
                        cause: CommitCause::ToolResult { call_id },
                        barrier,
                    }),
                )
                .await?;
                if let Some(ready) = ready {
                    super::engine::wait_for_state_ready(ready, cancellation).await?;
                }
            }
            Some(ClientCommand::RuntimeEvent(event)) => {
                pending_runtime_messages.push(PendingRuntimeMessage::Message(event.into_message()));
            }
            Some(ClientCommand::RuntimeMessage(message)) => {
                pending_runtime_messages.push(PendingRuntimeMessage::Message(message));
            }
            Some(ClientCommand::InsertMessages(insertion)) => {
                pending_runtime_messages.push(PendingRuntimeMessage::Insertion(insertion))
            }
            Some(ClientCommand::Cancel) => return Err(RunOutcome::Cancelled),
            Some(ClientCommand::ClientClosed { error }) => {
                return Err(RunOutcome::Failed(RunFailure::Client(error)));
            }
            None => return Err(client_failure()),
        }
    }
    for pending in pending_runtime_messages {
        match pending {
            PendingRuntimeMessage::Message(message) => {
                revision = super::engine::append_runtime_message(
                    store,
                    prepared,
                    client,
                    cancellation,
                    revision,
                    message,
                )
                .await?
                .0;
            }
            PendingRuntimeMessage::Insertion(insertion) => {
                revision = super::engine::append_insertions(
                    store,
                    prepared,
                    client,
                    cancellation,
                    revision,
                    vec![insertion],
                )
                .await?
                .0;
            }
        }
    }
    Ok(revision)
}

enum PendingRuntimeMessage {
    Message(crate::model::CanonicalMessage),
    Insertion(MessageInsertion),
}

async fn send(client: &ClientPort, event: ClientEvent) -> std::result::Result<(), RunOutcome> {
    client
        .events
        .send(event)
        .await
        .map_err(|_| client_failure())
}

fn failed(error: crate::Error) -> RunOutcome {
    RunOutcome::Failed(error.into())
}

fn client_failure() -> RunOutcome {
    RunOutcome::Failed(RunFailure::Client("client event channel closed".into()))
}
