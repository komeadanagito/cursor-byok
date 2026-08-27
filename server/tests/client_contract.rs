#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::sync::Arc;

use cursor_server::{
    client::{session, ClientCommand, ClientEvent, CommitCause},
    model::{
        ConversationId, ModelSpec, PreparedRun, PromptSpec, RunAction, RunId, RunKind,
        ToolDefinition, ToolResult,
    },
    provider::{FinishReason, ModelEvent},
    run::{RunEngine, RunOutcome},
};
use tokio::{sync::oneshot, time::Duration};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn a_client_without_checkpoint_protocol_runs_the_same_text_loop() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "call-1".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("hello".into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let prepared = prepared(&store).await;
    let (port, mut client) = session(32);
    let engine = RunEngine::new(store.clone(), Arc::new(provider));
    let run =
        tokio::spawn(async move { engine.run(prepared, port, CancellationToken::new()).await });

    let mut saw_final_commit = false;
    while let Some(event) = client.events.recv().await {
        match event {
            ClientEvent::TextDelta(text) => assert_eq!(text, "hello"),
            ClientEvent::StateCommitted(state) => {
                saw_final_commit |= state.cause == CommitCause::FinalTurn;
                state.barrier.complete(Ok(()));
            }
            ClientEvent::Ended(outcome) => {
                assert_eq!(outcome, RunOutcome::Completed);
                break;
            }
            _ => {}
        }
    }
    assert!(saw_final_commit);
    assert_eq!(run.await.unwrap(), RunOutcome::Completed);
}

#[tokio::test]
async fn inserted_messages_wait_for_the_next_model_call_without_interrupting_the_active_call() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    let first_ready = provider.push_gated(vec![
        ModelEvent::Start {
            model_call_id: "call-1".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("first answer".into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]);
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "call-2".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("followed up".into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let prepared = prepared(&store).await;
    let (port, mut client) = session(32);
    let commands = client.commands.clone();
    let engine = RunEngine::new(store, Arc::new(provider.clone()));
    let run =
        tokio::spawn(async move { engine.run(prepared, port, CancellationToken::new()).await });

    while provider.requests().is_empty() {
        if let Ok(Some(ClientEvent::StateCommitted(state))) =
            tokio::time::timeout(Duration::from_millis(20), client.events.recv()).await
        {
            state.barrier.complete(Ok(()));
        }
    }
    let (delivered, mut delivery) = oneshot::channel();
    commands
        .send(ClientCommand::InsertMessages(
            cursor_server::client::MessageInsertion {
                messages: vec![cursor_server::model::RuntimeEvent {
                    event_id: "background:finished".into(),
                    text: "background work finished".into(),
                }
                .into_message()],
                delivered,
            },
        ))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut delivery)
            .await
            .is_err()
    );

    first_ready.notify_one();
    while let Some(event) = client.events.recv().await {
        match event {
            ClientEvent::StateCommitted(state) => state.barrier.complete(Ok(())),
            ClientEvent::Ended(outcome) => {
                assert_eq!(outcome, RunOutcome::Completed);
                break;
            }
            _ => {}
        }
    }
    assert_eq!(run.await.unwrap(), RunOutcome::Completed);
    delivery.await.unwrap();

    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    let history = &requests[1].history;
    assert!(matches!(
        history[1].role,
        cursor_server::model::Role::Assistant
    ));
    assert_eq!(history[2].message_id, "runtime:background:finished");
}

#[tokio::test]
async fn a_failed_claim_cannot_overwrite_the_existing_run() {
    let (_directory, store) = fixtures::temp_store().await;
    let prepared = prepared(&store).await;
    store.claim_run(&prepared).await.unwrap();
    let (port, mut client) = session(8);
    let outcome = RunEngine::new(
        store.clone(),
        Arc::new(fake_provider::FakeProvider::default()),
    )
    .run(prepared, port, CancellationToken::new())
    .await;

    assert!(matches!(outcome, RunOutcome::Failed(_)));
    assert!(matches!(
        client.events.recv().await,
        Some(ClientEvent::Ended(RunOutcome::Failed(_)))
    ));
    let status: String = sqlx::query_scalar("SELECT status FROM runs WHERE run_id = 'run'")
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(status, "running");
}

#[tokio::test]
async fn required_client_state_failure_prevents_a_completed_run() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "call-1".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("hello".into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let prepared = prepared(&store).await;
    let (port, mut client) = session(32);
    let engine = RunEngine::new(store, Arc::new(provider));
    let run =
        tokio::spawn(async move { engine.run(prepared, port, CancellationToken::new()).await });

    while let Some(event) = client.events.recv().await {
        match event {
            ClientEvent::StateCommitted(state) if state.cause == CommitCause::FinalTurn => {
                state.barrier.complete(Err("snapshot failed".into()));
            }
            ClientEvent::StateCommitted(state) => state.barrier.complete(Ok(())),
            ClientEvent::Ended(outcome) => {
                assert_eq!(
                    outcome,
                    RunOutcome::Failed(cursor_server::run::RunFailure::Client(
                        "snapshot failed".into()
                    ))
                );
                break;
            }
            _ => {}
        }
    }
    assert_eq!(
        run.await.unwrap(),
        RunOutcome::Failed(cursor_server::run::RunFailure::Client(
            "snapshot failed".into()
        ))
    );
}

#[tokio::test]
async fn generic_engine_waits_for_every_tool_result_without_any_cursor_wire_id() {
    let (_directory, store) = fixtures::temp_store().await;
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "call-1".into(),
        },
        tool_start(0, "A"),
        ModelEvent::ToolCallArgumentsDelta {
            index: 0,
            delta: "{}".into(),
        },
        ModelEvent::ToolCallEnd { index: 0 },
        tool_start(1, "B"),
        ModelEvent::ToolCallArgumentsDelta {
            index: 1,
            delta: "{}".into(),
        },
        ModelEvent::ToolCallEnd { index: 1 },
        ModelEvent::Done(FinishReason::ToolUse),
    ]);
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "call-2".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("done".into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let prepared = prepared(&store).await;
    let (port, mut client) = session(64);
    let commands = client.commands.clone();
    let engine = RunEngine::new(store, Arc::new(provider));
    let run =
        tokio::spawn(async move { engine.run(prepared, port, CancellationToken::new()).await });
    while let Some(event) = client.events.recv().await {
        match event {
            ClientEvent::ExecuteToolRound { calls, .. } => {
                assert_eq!(calls.len(), 2);
                commands
                    .send(ClientCommand::ToolResult(ToolResult {
                        call_id: "B".into(),
                        content: "result-B".into(),
                        is_error: false,
                        image: None,
                    }))
                    .await
                    .unwrap();
                commands
                    .send(ClientCommand::ToolResult(ToolResult {
                        call_id: "A".into(),
                        content: "result-A".into(),
                        is_error: false,
                        image: None,
                    }))
                    .await
                    .unwrap();
            }
            ClientEvent::StateCommitted(state) => state.barrier.complete(Ok(())),
            ClientEvent::Ended(outcome) => {
                assert_eq!(outcome, RunOutcome::Completed);
                break;
            }
            _ => {}
        }
    }
    assert_eq!(run.await.unwrap(), RunOutcome::Completed);
}

async fn prepared(store: &cursor_server::store::Store) -> PreparedRun {
    let conversation_id = ConversationId::new("conversation");
    let root = store.ensure_conversation(&conversation_id).await.unwrap();
    PreparedRun {
        run_id: RunId::new("run"),
        cursor_request_id: None,
        conversation_id,
        kind: RunKind::Root,
        model: ModelSpec::new("model"),
        prompt: PromptSpec {
            instructions: "system".into(),
            tools: vec![ToolDefinition {
                name: "Tool".into(),
                description: "test".into(),
                parameters: serde_json::json!({"type":"object"}),
            }],
        },
        initial_messages: vec![fixtures::user("user", "hello")],
        action: RunAction::Start,
        base_revision_id: root,
    }
}

fn tool_start(index: usize, call_id: &str) -> ModelEvent {
    ModelEvent::ToolCallStart {
        index,
        call_id: call_id.into(),
        name: "Tool".into(),
    }
}
