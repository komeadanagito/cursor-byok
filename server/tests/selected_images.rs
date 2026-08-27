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
    store::BlobId,
};
use prost::Message;

#[tokio::test]
async fn selected_image_bytes_flow_from_run_request_to_history_providers_and_checkpoint() {
    let (_directory, store) = fixtures::temp_store().await;
    let stored_image = vec![4, 5];
    let stored_image_id = store.put_blob(&stored_image, &[]).await.unwrap();
    let provider = fake_provider::FakeProvider::default();
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "model".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("seen".into()),
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
    let handle = registry.get_or_create("image-run").await.unwrap();
    let mut output = handle.subscribe();
    handle
        .command(CursorCommand::Append {
            seqno: 0,
            message: Box::new(request(&stored_image_id)),
        })
        .await
        .unwrap();

    let mut seqno = 1;
    let mut checkpoints = Vec::new();
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
                checkpoints.push(state)
            }
            _ => {}
        }
    }

    let requests = provider.requests();
    let user = requests[0]
        .history
        .iter()
        .find(|message| {
            message
                .message_id
                .starts_with("runtime:cursor:user:image-user:")
        })
        .unwrap();
    let ProjectedContent::Parts(parts) = &user.content else {
        panic!("runtime user message must retain typed parts")
    };
    assert!(matches!(
        &parts[0],
        ContentPart::Text { text } if text.contains("<user_query>\nwhat is this?\n</user_query>")
    ));
    assert_eq!(
        &parts[1..],
        &[
            ContentPart::Image {
                mime_type: "image/png".into(),
                data: vec![1, 2, 3],
            },
            ContentPart::Image {
                mime_type: "image/webp".into(),
                data: stored_image,
            },
            ContentPart::Image {
                mime_type: "image/jpeg".into(),
                data: vec![6, 7, 8],
            },
        ]
    );
    let serialized_request = serde_json::to_string(&requests[0]).unwrap();
    assert!(!serialized_request.contains("private-image-uuid"));
    assert!(!serialized_request.contains("/private/image/path"));

    let state = checkpoints
        .iter()
        .find(|state| state.root_prompt_messages_json.len() >= 2)
        .unwrap();
    let mut user_root = None;
    for raw_id in &state.root_prompt_messages_json {
        let id = BlobId::from_bytes(raw_id).unwrap();
        let bytes = store.get_blob(&id).await.unwrap().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        if value["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("runtime:cursor:user:image-user:"))
        {
            user_root = Some(value);
            break;
        }
    }
    let user_root = user_root.unwrap();
    assert_eq!(user_root["content"][1]["type"], "image");
    assert_eq!(user_root["content"][1]["mimeType"], "image/png");
    assert_eq!(user_root["content"][1]["image"], "AQID");
    assert!(user_root["content"][1].get("data").is_none());
    assert_eq!(user_root["content"][2]["mimeType"], "image/webp");
    assert_eq!(user_root["content"][2]["image"], "BAU=");
    assert!(user_root["content"][2].get("data").is_none());
    assert_eq!(user_root["content"][3]["mimeType"], "image/jpeg");
    assert_eq!(user_root["content"][3]["image"], "BgcI");
    assert!(user_root["content"][3].get("data").is_none());
}

fn request(stored_image_id: &BlobId) -> pb::AgentClientMessage {
    let data = vec![1, 2, 3];
    let inline_blob_data = vec![6, 7, 8];
    let inline_blob_id = BlobId::digest(&inline_blob_data);
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                requested_model: Some(pb::RequestedModel {
                    model_id: "test-model".into(),
                    ..Default::default()
                }),
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::UserMessageAction(
                        pb::UserMessageAction {
                            user_message: Some(pb::UserMessage {
                                text: "what is this?".into(),
                                message_id: "image-user".into(),
                                selected_context: Some(pb::SelectedContext {
                                    selected_images: vec![
                                        pb::SelectedImage {
                                            uuid: "private-image-uuid".into(),
                                            path: "/private/image/path".into(),
                                            mime_type: "image/png".into(),
                                            data_or_blob_id: Some(
                                                pb::selected_image::DataOrBlobId::Data(data),
                                            ),
                                            ..Default::default()
                                        },
                                        pb::SelectedImage {
                                            uuid: "stored-image".into(),
                                            path: "/private/stored/path".into(),
                                            mime_type: "image/webp".into(),
                                            data_or_blob_id: Some(
                                                pb::selected_image::DataOrBlobId::BlobId(
                                                    stored_image_id.as_bytes().to_vec(),
                                                ),
                                            ),
                                            ..Default::default()
                                        },
                                        pb::SelectedImage {
                                            uuid: "inline-blob-image".into(),
                                            path: "/private/inline/path".into(),
                                            mime_type: "image/jpeg".into(),
                                            data_or_blob_id: Some(
                                                pb::selected_image::DataOrBlobId::BlobIdWithData(
                                                    pb::selected_image::BlobIdWithData {
                                                        blob_id: inline_blob_id.as_bytes().to_vec(),
                                                        data: inline_blob_data,
                                                    },
                                                ),
                                            ),
                                            ..Default::default()
                                        },
                                    ],
                                    ..Default::default()
                                }),
                                mode: pb::AgentMode::Agent as i32,
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                conversation_id: Some("image-conversation".into()),
                run_id: Some("image-run".into()),
                ..Default::default()
            },
        )),
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
