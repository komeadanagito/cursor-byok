//! Exercises image routing through real Cursor turns and checkpoint replay.
use super::*;
use cursor_server::store::VisionSettings;

#[tokio::test]
async fn text_only_model_reports_an_unanalyzed_image_without_a_cursor_session() {
    let (_directory, store) = fixtures::temp_store().await;
    let mut input = serde_json::to_value(windowed_model("text-only", None)).unwrap();
    input["supports_images"] = false.into();
    let model = store
        .create_model(&serde_json::from_value(input).unwrap())
        .await
        .unwrap();
    let provider = fake_provider::FakeProvider::default();
    provider.push(text_response("answer", 20, 4));
    let registry = TransportRegistry::new(
        store,
        Arc::new(provider.clone()),
        PromptCompiler::new(PromptAssets::embedded().unwrap()),
    );
    run(&registry, "image-request", image_request(&model.model_hash)).await;
    let requests = provider.requests();
    assert_eq!(
        requests.len(),
        1,
        "an unauthenticated request must not call another BYOK model"
    );
    let body = serde_json::to_string(&requests[0].history).unwrap();
    assert!(
        !body.contains("image/png"),
        "text-only upstream received pixels"
    );
    assert!(body.contains("not analyzed"));
}

fn image_request(model_id: &str) -> pb::AgentClientMessage {
    request(
        "image-conversation",
        model_id,
        None,
        pb::conversation_action::Action::UserMessageAction(pb::UserMessageAction {
            user_message: Some(pb::UserMessage {
                text: "Which button is disabled?".into(),
                message_id: "screen".into(),
                mode: pb::AgentMode::Agent as i32,
                selected_context: Some(pb::SelectedContext {
                    selected_images: vec![pb::SelectedImage {
                        mime_type: "image/png".into(),
                        data_or_blob_id: Some(pb::selected_image::DataOrBlobId::Data(vec![
                            1, 2, 3,
                        ])),
                        ..Default::default()
                    }],
                    ..Default::default()
                }),
                ..Default::default()
            }),
            request_context: Some(pb::RequestContext::default()),
            ..Default::default()
        }),
    )
}

#[tokio::test]
async fn only_text_models_delegate_and_the_next_turn_reuses_the_description() {
    for native in [true, false] {
        let (_dir, store) = fixtures::temp_store().await;
        let mut main = windowed_model("main", None);
        main.supports_images = native;
        let main = store.create_model(&main).await.unwrap();
        let reader = store
            .create_model(&windowed_model("reader", None))
            .await
            .unwrap();
        store
            .set_vision_settings(&VisionSettings::Model {
                model_id: reader.model_hash.clone(),
            })
            .await
            .unwrap();
        let provider = fake_provider::FakeProvider::default();
        if !native {
            provider.push(text_response("Save is disabled", 20, 4));
        }
        provider.push(text_response("answer", 20, 4));
        provider.push(text_response("next", 20, 4));
        let registry = TransportRegistry::new(
            store,
            Arc::new(provider.clone()),
            PromptCompiler::new(PromptAssets::embedded().unwrap()),
        );
        let first = run(&registry, "vision-first", image_request(&main.model_hash)).await;
        run(
            &registry,
            "vision-next",
            user_request(
                "image-conversation",
                "followup",
                "Thanks",
                &main.model_hash,
                first.checkpoints.last().cloned(),
            ),
        )
        .await;
        let requests = provider.requests();
        assert_eq!(requests.len(), if native { 2 } else { 3 });
        let first_main = &requests[usize::from(!native)];
        assert_eq!(first_main.model.model_id, main.model_hash);
        assert_eq!(
            serde_json::to_string(&first_main.history)
                .unwrap()
                .contains("image/png"),
            native
        );
        assert!(requests
            .last()
            .unwrap()
            .history
            .starts_with(&first_main.history));
        if !native {
            assert!(serde_json::to_string(&first_main.history)
                .unwrap()
                .contains("Save is disabled"));
            let request = &requests[0];
            assert_eq!(request.model.model_id, reader.model_hash);
            assert!(request.prompt.tools.is_empty());
            assert_eq!(request.history.len(), 1);
            let ProjectedContent::Parts(parts) = &request.history[0].content else {
                panic!("expected image input")
            };
            assert_eq!(
                parts,
                &[
                    ContentPart::Text {
                        text: "Which button is disabled?".into()
                    },
                    ContentPart::Image {
                        mime_type: "image/png".into(),
                        data: vec![1, 2, 3]
                    }
                ]
            );
        }
    }
}
