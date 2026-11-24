//! Exercises gateway discovery and catalog changes against an isolated local gateway.
use super::*;
use axum::{http::HeaderMap, routing::get, Json, Router};
use serde_json::json;

#[tokio::test]
async fn follows_port_changes_and_preserves_group_ids_and_model_choices() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::connect(&format!(
        "sqlite://{}",
        dir.path().join("test.db").display()
    ))
    .await
    .unwrap();
    let settings = dir.path().join("settings.json");
    let channel = Magpie::new(store.clone(), settings.clone()).unwrap();
    let gateway = Router::new().route("/api/hello", get(|| async { Json(json!({"name":"magpie"})) }))
        .route("/v1/models", get(|headers: HeaderMap| async move {
            assert_eq!(headers["authorization"], "Bearer magpie-cursor-byok");
            Json(json!({"data":[{"id":"group/work","magpie_label":"Work","context_window":128000,"max_output_tokens":4096}, {"id":"vendor/b"}]}))
        }));
    let listen = async |router| {
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = socket.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(socket, router).await.unwrap() });
        port
    };
    assert!(store.magpie_catalog().await.unwrap().is_none());
    let first = listen(gateway.clone()).await;
    std::fs::write(&settings, json!({"port":first}).to_string()).unwrap();
    channel.sync(true).await.unwrap();
    channel.select(vec!["group/work".into()]).await.unwrap();
    let before = store.configured_models().await.unwrap().remove(0);
    let second = listen(gateway).await;
    std::fs::write(&settings, json!({"port":second}).to_string()).unwrap();
    channel.sync(false).await.unwrap();
    let models = store.configured_models().await.unwrap();
    assert_eq!(models.len(), 1);
    let after = store
        .configured_model(&before.model_hash)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        after.request_url().unwrap(),
        format!("http://127.0.0.1:{second}/v1/messages")
    );
    assert_eq!(after.model_id, "group/work");
    assert_eq!(after.display_name, "Work");
    assert_eq!(after.context_window_tokens, Some(128000));
    assert_eq!(after.max_output_tokens(), Some(4096));
    let headers =
        |session| crate::provider::router::routed_request_headers(&after, session).unwrap();
    let first_turn = headers("conversation-a");
    assert_eq!(first_turn, headers("conversation-a"));
    let other = headers("conversation-b");
    for key in ["x-session-affinity", "session_id", "x-client-request-id"] {
        assert_eq!(first_turn[key], "conversation-a");
        assert_eq!(other[key], "conversation-b");
    }
    // Models served through an ordinary provider keep their configured headers.
    let mut manual = after.clone();
    manual.model_hash = "byok-manual".into();
    let manual_headers =
        crate::provider::router::routed_request_headers(&manual, "conversation-a").unwrap();
    assert_eq!(manual_headers.len(), 1);
    assert_eq!(manual_headers["user-agent"], "cursor-byok");
    let wrong = listen(Router::new().route(
        "/api/hello",
        get(|| async { Json(json!({"name":"other"})) }),
    ))
    .await;
    std::fs::write(&settings, json!({"port":wrong}).to_string()).unwrap();
    assert!(channel.sync(false).await.is_err());
    assert_eq!(store.magpie_catalog().await.unwrap().unwrap().port, second);
    channel.disconnect().await.unwrap();
    channel.sync(false).await.unwrap();
    assert!(store
        .configured_model(&before.model_hash)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn a_rejected_gateway_records_a_failed_call() {
    use crate::{
        model::{ModelInvocation, ModelRequest, ModelSpec, PromptSpec},
        network::NetworkClients,
        plugin::{PluginRegistry, PluginRuntime},
        provider::{Provider, ProviderRouter},
    };
    use futures_util::StreamExt;
    use tokio_util::sync::CancellationToken;

    let dir = tempfile::tempdir().unwrap();
    let store = Store::connect(&format!(
        "sqlite://{}",
        dir.path().join("test.db").display()
    ))
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let upstream = Router::new().route(
        "/api/hello",
        get(|| async { Json(json!({"name":"other"})) }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let catalog = Catalog {
        port,
        models: vec![serde_json::from_value(json!({"id":"work"})).unwrap()],
        disabled: HashSet::new(),
    };
    store.save_magpie_catalog(Some(&catalog)).await.unwrap();
    let model = catalog.configurations().next().unwrap();
    let plugins = PluginRegistry::managed(
        store.clone(),
        PluginRuntime::managed().unwrap(),
        "1.1.0".into(),
    )
    .unwrap();
    let provider = ProviderRouter::new(
        store.clone(),
        plugins,
        NetworkClients::new(store.clone()),
        Duration::from_secs(5),
        Duration::from_secs(5),
    );
    let invocation = ModelInvocation {
        call_id: "gateway-call".into(),
        run_id: "gateway-run".into(),
        conversation_id: "gateway-conversation".into(),
        provider_call_index: 0,
        request: ModelRequest {
            model: ModelSpec::new(&model.model_hash),
            prompt: PromptSpec {
                instructions: String::new(),
                tools: Vec::new(),
            },
            history: Vec::new(),
        },
    };
    let mut stream = provider.stream(invocation, CancellationToken::new());
    assert!(stream.next().await.unwrap().is_err());
    let call = store.llm_call("gateway-call").await.unwrap().unwrap();
    assert_eq!(call.status, "error");
    assert!(call
        .error_message
        .unwrap()
        .contains("is not a Magpie gateway"));
    server.abort();
}
