//! Workspace-bound MCP tool handlers over one lazily loaded search engine.

use std::path::PathBuf;
use std::sync::Arc;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use schemars::JsonSchema;
use semble_core::{FindRelatedRequest, SearchEngine, SearchRequest, SembleConfig};
use serde::Deserialize;
use tokio::sync::OnceCell;

const INSTRUCTIONS: &str = "Use search for a natural-language code location in this workspace. \
     Results contain one-based source lines. Use the language server for definitions and \
     references and Grep for exact literals.";
const DEFAULT_TOP_K: usize = 5;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchArguments {
    /// A natural-language description of the code you want, or a symbol name.
    /// Prefix with a receiver for method lookup, like "Config.load".
    pub query: String,
    /// Maximum results to return.
    pub top_k: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FindRelatedArguments {
    /// The relative path of the source file, like "src/auth.rs".
    pub file_path: String,
    /// A 1-based line number inside `file_path`.
    pub line: usize,
    /// Maximum results to return.
    pub top_k: Option<usize>,
}

/// Binds the search tools to one workspace root; `repo` never crosses the wire.
pub struct SemanticServer {
    root: PathBuf,
    // Loading downloads model assets and takes seconds, so it is deferred from
    // construction to the first tool call and cached for the process lifetime.
    engine: OnceCell<Arc<SearchEngine>>,
}

impl SemanticServer {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            engine: OnceCell::new(),
        }
    }

    /// Lets tests serve an engine built on an injected embedder instead of the
    /// real model assets.
    pub fn with_engine(root: PathBuf, engine: SearchEngine) -> Self {
        Self {
            root,
            engine: OnceCell::new_with(Some(Arc::new(engine))),
        }
    }

    async fn engine(&self) -> Result<Arc<SearchEngine>, String> {
        self.engine
            .get_or_try_init(|| async {
                // The engine embedder is a shared global inside semble-core, but
                // model loading is blocking work that must not stall the stdio loop.
                let engine = tokio::task::spawn_blocking(|| {
                    SearchEngine::load_default(SembleConfig::default())
                })
                .await
                .map_err(|error| format!("semantic engine loader panicked: {error}"))?;
                engine
                    .map(Arc::new)
                    .map_err(|error| format!("failed to load the semantic engine: {error}"))
            })
            .await
            .cloned()
    }

    fn format_results(response: &semble_core::SearchResponse) -> Vec<ContentBlock> {
        if response.results.is_empty() {
            return vec![ContentBlock::text(format!(
                "No code locations matched `{}`.",
                response.query
            ))];
        }
        let mut text = String::new();
        for result in &response.results {
            text.push_str(&result.file_path);
            text.push_str(&format!(
                "\nlines {}-{}",
                result.start_line, result.end_line
            ));
            text.push_str("\n```\n");
            if let Some(content) = &result.content {
                text.push_str(content);
                if !content.ends_with('\n') {
                    text.push('\n');
                }
            }
            text.push_str("```\n\n");
        }
        vec![ContentBlock::text(text)]
    }
}

#[tool_router]
impl SemanticServer {
    /// Locate an implementation in this workspace by behavior or name.
    /// Returns file paths and 1-based lines.
    #[tool(name = "search")]
    async fn search(
        &self,
        Parameters(arguments): Parameters<SearchArguments>,
    ) -> Result<CallToolResult, ErrorData> {
        let engine = match self.engine().await {
            Ok(engine) => engine,
            Err(error) => return Ok(CallToolResult::error(vec![ContentBlock::text(error)])),
        };
        let root = self.root.clone();
        let mut request = SearchRequest::new(arguments.query, root);
        request.top_k = arguments.top_k.unwrap_or(DEFAULT_TOP_K);
        let response = tokio::task::spawn_blocking(move || engine.search(request))
            .await
            .map_err(|error| {
                ErrorData::internal_error(format!("search worker panicked: {error}"), None)
            })?;
        match response {
            Ok(response) => Ok(CallToolResult::success(Self::format_results(&response))),
            Err(error) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "{error}"
            ))])),
        }
    }

    /// Find similar code in this workspace from a file path and one-based
    /// line number.
    #[tool(name = "find_related")]
    async fn find_related(
        &self,
        Parameters(arguments): Parameters<FindRelatedArguments>,
    ) -> Result<CallToolResult, ErrorData> {
        let engine = match self.engine().await {
            Ok(engine) => engine,
            Err(error) => return Ok(CallToolResult::error(vec![ContentBlock::text(error)])),
        };
        let root = self.root.clone();
        let request = FindRelatedRequest {
            repo: root,
            file_path: arguments.file_path,
            line: arguments.line,
            top_k: arguments.top_k.unwrap_or(DEFAULT_TOP_K),
            max_snippet_lines: Some(10),
            content: vec![semble_core::ContentType::Code],
        };
        let response = tokio::task::spawn_blocking(move || engine.find_related(request))
            .await
            .map_err(|error| {
                ErrorData::internal_error(format!("find_related worker panicked: {error}"), None)
            })?;
        match response {
            Ok(response) => Ok(CallToolResult::success(Self::format_results(&response))),
            Err(error) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "{error}"
            ))])),
        }
    }
}

#[tool_handler]
impl ServerHandler for SemanticServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "byok-semantic",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(INSTRUCTIONS)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use semble_core::{Embedder, Result, SearchEngine, SembleConfig};

    use super::*;

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
            "pub fn authenticate_request() {\n    verify_token();\n}\n\
             \n\
             impl Session {\n    pub fn revoke(&mut self) {\n        self.token = None;\n    }\n}\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("src/billing.rs"),
            "pub fn create_invoice() {\n    charge_customer();\n}\n",
        )
        .unwrap();
        dir
    }

    fn server(source: &Path, cache: &Path) -> SemanticServer {
        let engine =
            SearchEngine::with_embedder(SembleConfig::new(cache), Arc::new(KeywordEmbedder));
        SemanticServer::with_engine(source.to_path_buf(), engine)
    }

    fn text_of(result: &CallToolResult) -> String {
        result
            .content
            .iter()
            .map(|block| {
                block
                    .as_text()
                    .map(|text| text.text.clone())
                    .unwrap_or_default()
            })
            .collect()
    }

    async fn call_search(server: &SemanticServer, arguments: serde_json::Value) -> CallToolResult {
        server
            .search(serde_json::from_value::<Parameters<SearchArguments>>(arguments).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn search_results_are_confined_to_the_workspace_root_and_report_one_based_lines() {
        let source = workspace();
        let cache = tempfile::tempdir().unwrap();
        let server = server(source.path(), cache.path());

        let result = call_search(
            &server,
            serde_json::json!({"query": "authenticate request", "top_k": 2}),
        )
        .await;
        assert_ne!(result.is_error, Some(true), "{}", text_of(&result));
        let text = text_of(&result);
        assert!(text.contains("src/auth.rs"), "{text}");
        assert!(text.contains("lines 1-"), "{text}");
        assert!(
            !text.contains(source.path().to_string_lossy().as_ref()),
            "{text}"
        );
    }

    #[tokio::test]
    async fn qualified_method_query_returns_that_methods_declaration() {
        let source = workspace();
        let cache = tempfile::tempdir().unwrap();
        let server = server(source.path(), cache.path());

        let result = call_search(&server, serde_json::json!({"query": "Session.revoke"})).await;
        assert_ne!(result.is_error, Some(true), "{}", text_of(&result));
        let text = text_of(&result);
        assert!(text.contains("src/auth.rs"), "{text}");
        assert!(text.contains("pub fn revoke"), "{text}");
    }

    #[tokio::test]
    async fn index_failure_is_reported_as_a_tool_error_not_as_empty_results() {
        let source = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let server = server(source.path(), cache.path());

        let result = call_search(&server, serde_json::json!({"query": "anything"})).await;
        assert_eq!(result.is_error, Some(true), "{}", text_of(&result));
        assert!(
            text_of(&result).contains("index is empty"),
            "{}",
            text_of(&result)
        );
    }

    #[test]
    fn zero_matches_are_a_normal_result_not_an_error() {
        // The engine ranks whatever is indexed, so an empty response can only
        // come from the search layer itself; the formatter must still report it
        // as plain text, never as a tool error.
        let blocks = SemanticServer::format_results(&semble_core::SearchResponse {
            query: "unfindable".to_string(),
            results: vec![],
        });
        assert_eq!(blocks.len(), 1);
        let text = blocks[0].as_text().unwrap().text.clone();
        assert!(text.contains("No code locations matched"), "{text}");
        assert!(text.contains("unfindable"), "{text}");
    }

    #[tokio::test]
    async fn tool_schemas_do_not_expose_a_repo_argument() {
        let source = workspace();
        let cache = tempfile::tempdir().unwrap();
        let _server = server(source.path(), cache.path());

        let router = SemanticServer::tool_router();
        let tools = router.list_all();
        let names: Vec<_> = tools.iter().map(|tool| tool.name.as_ref()).collect();
        assert_eq!(names, ["find_related", "search"]);
        for tool in &tools {
            let properties = tool
                .input_schema
                .get("properties")
                .and_then(|value| value.as_object())
                .expect("input schema should list properties");
            assert!(
                !properties.contains_key("repo"),
                "{} must not expose a repo argument: {properties:?}",
                tool.name
            );
        }
        let search = tools.iter().find(|tool| tool.name == "search").unwrap();
        let required = search
            .input_schema
            .get("required")
            .and_then(|value| value.as_array())
            .expect("search should require its query");
        assert_eq!(required, &["query"]);
    }

    #[tokio::test]
    async fn find_related_accepts_a_workspace_relative_path_and_one_based_line() {
        let source = workspace();
        let cache = tempfile::tempdir().unwrap();
        let server = server(source.path(), cache.path());

        let result = server
            .find_related(
                serde_json::from_value::<Parameters<FindRelatedArguments>>(serde_json::json!(
                    {"file_path": "src/auth.rs", "line": 1, "top_k": 1}
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(result.is_error, Some(true), "{}", text_of(&result));
        let text = text_of(&result);
        assert!(text.contains("src/"), "{text}");
        assert!(text.contains("lines "), "{text}");
    }

    #[tokio::test]
    async fn find_related_rejects_line_zero_as_a_tool_error() {
        let source = workspace();
        let cache = tempfile::tempdir().unwrap();
        let server = server(source.path(), cache.path());

        let result = server
            .find_related(
                serde_json::from_value::<Parameters<FindRelatedArguments>>(serde_json::json!(
                    {"file_path": "src/auth.rs", "line": 0}
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(result.is_error, Some(true), "{}", text_of(&result));
        assert!(
            text_of(&result).contains("greater than zero"),
            "{}",
            text_of(&result)
        );
    }
}
