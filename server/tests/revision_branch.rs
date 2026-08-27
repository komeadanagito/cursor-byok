#[path = "support/fixtures.rs"]
mod fixtures;

use cursor_server::model::{
    ConversationId, ModelSpec, PreparedRun, PromptSpec, RunAction, RunId, RunKind,
};

fn prepared(
    run_id: &str,
    conversation_id: &ConversationId,
    base_revision_id: cursor_server::model::RevisionId,
) -> PreparedRun {
    PreparedRun {
        run_id: RunId::new(run_id),
        cursor_request_id: None,
        conversation_id: conversation_id.clone(),
        kind: RunKind::Root,
        model: ModelSpec::new("test-model"),
        prompt: PromptSpec {
            instructions: "test".into(),
            tools: Vec::new(),
        },
        initial_messages: Vec::new(),
        action: RunAction::Resume {
            pending_tool_round: None,
        },
        base_revision_id,
    }
}

#[tokio::test]
async fn selecting_an_old_revision_creates_a_branch_without_old_suffixes() {
    let (_directory, store) = fixtures::temp_store().await;
    let conversation_id = ConversationId::new("conversation");
    let root = store.ensure_conversation(&conversation_id).await.unwrap();
    let first = prepared("run-1", &conversation_id, root);
    store.claim_run(&first).await.unwrap();

    let a = fixtures::user("a", "A");
    let revision_a = store
        .append_revision(
            &conversation_id,
            &first.run_id,
            root,
            std::slice::from_ref(&a),
        )
        .await
        .unwrap();
    let b = fixtures::user("b", "B");
    let revision_b = store
        .append_revision(
            &conversation_id,
            &first.run_id,
            revision_a,
            std::slice::from_ref(&b),
        )
        .await
        .unwrap();

    let second = prepared("run-2", &conversation_id, revision_a);
    let claimed = store.claim_run(&second).await.unwrap();
    assert_eq!(claimed.replaced_run_id.as_ref(), Some(&first.run_id));
    let c = fixtures::user("c", "C");
    let revision_c = store
        .append_revision(
            &conversation_id,
            &second.run_id,
            revision_a,
            std::slice::from_ref(&c),
        )
        .await
        .unwrap();

    assert_eq!(
        store.load_revision_messages(revision_b).await.unwrap(),
        vec![a.clone(), b]
    );
    assert_eq!(
        store.load_revision_messages(revision_c).await.unwrap(),
        vec![a, c]
    );
    assert!(store
        .append_revision(
            &conversation_id,
            &first.run_id,
            revision_b,
            &[fixtures::user("late", "late")],
        )
        .await
        .is_err());
}

#[tokio::test]
async fn retrying_the_same_prefix_from_the_same_base_reuses_the_revision() {
    let (_directory, store) = fixtures::temp_store().await;
    let conversation_id = ConversationId::new("retried-conversation");
    let root = store.ensure_conversation(&conversation_id).await.unwrap();
    let first = prepared("run-1", &conversation_id, root);
    store.claim_run(&first).await.unwrap();
    let user = fixtures::user("hello", "你好");
    let first_revision = store
        .append_revision(
            &conversation_id,
            &first.run_id,
            root,
            std::slice::from_ref(&user),
        )
        .await
        .unwrap();

    let second = prepared("run-2", &conversation_id, root);
    store.claim_run(&second).await.unwrap();
    let reused = store
        .append_revision(
            &conversation_id,
            &second.run_id,
            root,
            std::slice::from_ref(&user),
        )
        .await
        .unwrap();
    assert_eq!(reused, first_revision);
    assert_eq!(
        store.load_revision_messages(reused).await.unwrap(),
        vec![user]
    );
}

#[tokio::test]
async fn reused_cursor_request_id_maps_to_the_current_distinct_execution() {
    let (_directory, store) = fixtures::temp_store().await;
    let conversation_id = ConversationId::new("queued-conversation");
    let root = store.ensure_conversation(&conversation_id).await.unwrap();

    let mut first = prepared("reused-request:11111111", &conversation_id, root);
    first.cursor_request_id = Some("reused-request".into());
    store.claim_run(&first).await.unwrap();
    assert_eq!(
        store
            .active_run_for_cursor_request("reused-request")
            .await
            .unwrap(),
        Some(first.run_id.clone())
    );

    let mut second = prepared("reused-request:22222222", &conversation_id, root);
    second.cursor_request_id = Some("reused-request".into());
    store.claim_run(&second).await.unwrap();
    assert_eq!(
        store
            .active_run_for_cursor_request("reused-request")
            .await
            .unwrap(),
        Some(second.run_id)
    );
}

#[tokio::test]
async fn identical_runtime_event_is_exactly_once_and_conflicts_are_rejected() {
    let (_directory, store) = fixtures::temp_store().await;
    let conversation_id = ConversationId::new("runtime");
    let root = store.ensure_conversation(&conversation_id).await.unwrap();
    let run = prepared("run", &conversation_id, root);
    store.claim_run(&run).await.unwrap();
    let event = cursor_server::model::RuntimeEvent {
        event_id: "branch:changed:7".into(),
        text: "runtime state changed".into(),
    }
    .into_message();
    let (revision, inserted) = store
        .append_message_once(&conversation_id, &run.run_id, root, &event)
        .await
        .unwrap();
    assert!(inserted);
    let (same, inserted) = store
        .append_message_once(&conversation_id, &run.run_id, revision, &event)
        .await
        .unwrap();
    assert_eq!(same, revision);
    assert!(!inserted);

    let conflict = cursor_server::model::RuntimeEvent {
        event_id: "branch:changed:7".into(),
        text: "different".into(),
    }
    .into_message();
    assert!(store
        .append_message_once(&conversation_id, &run.run_id, revision, &conflict)
        .await
        .is_err());
}

#[tokio::test]
async fn editing_a_logical_input_discards_its_active_suffix() {
    let (_directory, store) = fixtures::temp_store().await;
    let conversation_id = ConversationId::new("edited-conversation");
    let root = store.ensure_conversation(&conversation_id).await.unwrap();
    let input_id = "cursor:user:stable-id";
    assert_eq!(
        store
            .anchor_input(&conversation_id, input_id, root)
            .await
            .unwrap(),
        root
    );

    let first = prepared("first-run", &conversation_id, root);
    store.claim_run(&first).await.unwrap();
    let original = fixtures::user("original", "original text");
    let original_revision = store
        .append_revision(
            &conversation_id,
            &first.run_id,
            root,
            std::slice::from_ref(&original),
        )
        .await
        .unwrap();
    let suffix = fixtures::user("suffix", "old suffix");
    let old_head = store
        .append_revision(
            &conversation_id,
            &first.run_id,
            original_revision,
            std::slice::from_ref(&suffix),
        )
        .await
        .unwrap();

    let edit_base = store
        .anchor_input(&conversation_id, input_id, old_head)
        .await
        .unwrap();
    assert_eq!(edit_base, root);
    let second = prepared("second-run", &conversation_id, edit_base);
    store.claim_run(&second).await.unwrap();
    let edited = fixtures::user("edited", "edited text");
    let edited_head = store
        .append_revision(
            &conversation_id,
            &second.run_id,
            edit_base,
            std::slice::from_ref(&edited),
        )
        .await
        .unwrap();

    assert_eq!(
        store.load_revision_messages(edited_head).await.unwrap(),
        vec![edited]
    );
    assert_eq!(
        store.load_revision_messages(old_head).await.unwrap(),
        vec![original, suffix]
    );
}
