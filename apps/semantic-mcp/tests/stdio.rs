//! Drives the MCP server over a real JSON-RPC stream: initialize, tools/list, tools/call.

use std::{fs, path::Path, sync::Arc};

use byok_semantic::SemanticServer;
use rmcp::ServiceExt;
use semble_core::{Embedder, Result, SearchEngine, SembleConfig};
use serde_json::{json, Value};
use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader as TokioBufReader};

struct KeywordEmbedder;

impl Embedder for KeywordEmbedder {
    fn id(&self) -> &str {
        "keyword-v1"
    }

    fn dimensions(&self) -> usize {
        3
    }

    fn encode(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        Ok(texts
            .iter()
            .map(|text| {
                let text = text.to_ascii_lowercase();
                let mut vector = vec![
                    usize::from(text.contains("auth")) as f32,
                    usize::from(text.contains("invoice")) as f32,
                    usize::from(text.contains("parse")) as f32,
                ];
                let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
                if norm > 0.0 {
                    vector.iter_mut().for_each(|value| *value /= norm);
                }
                vector
            })
            .collect())
    }
}

fn workspace() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::write(
        dir.path().join("src/auth.rs"),
        "pub fn authenticate_request() {\n    verify_token();\n}\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("src/billing.rs"),
        "pub fn create_invoice() {\n    charge_customer();\n}\n",
    )
    .unwrap();
    dir
}

fn engine(cache: &Path) -> SearchEngine {
    SearchEngine::with_embedder(SembleConfig::new(cache), Arc::new(KeywordEmbedder))
}

struct McpClient {
    writer: tokio::io::WriteHalf<tokio::io::DuplexStream>,
    reader: tokio::io::Lines<TokioBufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>,
    next_id: u64,
}

impl McpClient {
    async fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.writer
            .write_all(message.to_string().as_bytes())
            .await
            .unwrap();
        self.writer.write_all(b"\n").await.unwrap();
        loop {
            let line = self.reader.next_line().await.unwrap().unwrap();
            let reply: Value = serde_json::from_str(&line).unwrap();
            if reply["id"] == id {
                return reply;
            }
        }
    }

    async fn notify(&mut self, method: &str) {
        let message = json!({"jsonrpc": "2.0", "method": method});
        self.writer
            .write_all(message.to_string().as_bytes())
            .await
            .unwrap();
        self.writer.write_all(b"\n").await.unwrap();
    }
}

async fn session(source: &Path, cache: &Path) -> (McpClient, tokio::task::JoinHandle<()>) {
    let (client_stream, server_stream) = duplex(4096);
    let server = SemanticServer::with_engine(source.to_path_buf(), engine(cache));
    let task = tokio::spawn(async move {
        let running = server.serve(server_stream).await.unwrap();
        running.waiting().await.unwrap();
    });
    let (reader, writer) = tokio::io::split(client_stream);
    let mut client = McpClient {
        writer,
        reader: TokioBufReader::new(reader).lines(),
        next_id: 0,
    };
    client
        .request(
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "fixture", "version": "0"},
            }),
        )
        .await;
    client.notify("notifications/initialized").await;
    (client, task)
}

#[tokio::test]
async fn tools_list_exposes_search_and_find_related_without_repo() {
    let source = workspace();
    let cache = tempfile::tempdir().unwrap();
    let (mut client, _task) = session(source.path(), cache.path()).await;

    let reply = client.request("tools/list", json!({})).await;
    let tools = reply["result"]["tools"].as_array().unwrap();
    let names: Vec<_> = tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    // tools/list replies are sorted by name.
    assert_eq!(names, ["find_related", "search"]);
    for tool in tools {
        let properties = tool["inputSchema"]["properties"].as_object().unwrap();
        assert!(
            !properties.contains_key("repo"),
            "{} must not expose a repo argument: {properties:?}",
            tool["name"]
        );
    }
    let search = tools.iter().find(|tool| tool["name"] == "search").unwrap();
    let required = search["inputSchema"]["required"].as_array().unwrap();
    assert_eq!(required, &["query"]);
    let related_required = tools
        .iter()
        .find(|tool| tool["name"] == "find_related")
        .unwrap()["inputSchema"]["required"]
        .as_array()
        .unwrap();
    assert_eq!(related_required, &["file_path", "line"]);
}

#[tokio::test]
async fn initialize_advertises_instructions_and_server_name() {
    let source = workspace();
    let cache = tempfile::tempdir().unwrap();
    let (client_stream, server_stream) = duplex(4096);
    let server = SemanticServer::with_engine(source.path().to_path_buf(), engine(cache.path()));
    let _task = tokio::spawn(async move {
        let running = server.serve(server_stream).await.unwrap();
        running.waiting().await.unwrap();
    });
    let (reader, mut writer) = tokio::io::split(client_stream);
    let mut lines = TokioBufReader::new(reader).lines();
    writer
        .write_all(
            br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"fixture","version":"0"}}}
"#,
        )
        .await
        .unwrap();
    let reply: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    assert_eq!(reply["result"]["serverInfo"]["name"], "byok-semantic");
    let instructions = reply["result"]["instructions"].as_str().unwrap();
    assert!(
        instructions.contains("one-based source lines"),
        "{instructions}"
    );
    assert!(instructions.contains("Grep"), "{instructions}");
}

#[tokio::test]
async fn search_call_returns_workspace_results_with_one_based_lines() {
    let source = workspace();
    let cache = tempfile::tempdir().unwrap();
    let (mut client, _task) = session(source.path(), cache.path()).await;

    let reply = client
        .request(
            "tools/call",
            json!({
                "name": "search",
                "arguments": {"query": "authenticate request", "top_k": 1},
            }),
        )
        .await;
    let result = &reply["result"];
    assert_ne!(result["isError"], true, "{result}");
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("src/auth.rs"), "{text}");
    assert!(text.contains("lines 1-"), "{text}");
    assert!(text.contains("pub fn authenticate_request"), "{text}");
}

#[tokio::test]
async fn engine_failure_is_a_tool_error_not_empty_results() {
    let source = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let (mut client, _task) = session(source.path(), cache.path()).await;

    let reply = client
        .request(
            "tools/call",
            json!({
                "name": "search",
                "arguments": {"query": "anything"},
            }),
        )
        .await;
    let result = &reply["result"];
    assert_eq!(result["isError"], true, "{result}");
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("index is empty"), "{text}");
}
