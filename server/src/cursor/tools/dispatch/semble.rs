//! Asynchronous dispatch for the application-owned Semble search tools.

use std::sync::Arc;

use semble_core::{ContentType, FindRelatedRequest, SearchEngine, SearchRequest, SembleConfig};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::OnceCell;

use crate::{model::ToolCall, store::Store, Error, Result};

use super::ToolStart;
use crate::cursor::tools::{
    result::{self, ToolResultSender},
    runtime::now_ms,
};

static ENGINE: OnceCell<Arc<SearchEngine>> = OnceCell::const_new();

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ContentSelection {
    #[default]
    Code,
    Docs,
    Config,
    All,
}

#[derive(Debug, Deserialize)]
struct SearchArguments {
    query: String,
    repo: String,
    #[serde(default = "default_top_k")]
    top_k: usize,
    #[serde(default = "default_snippet_lines")]
    max_snippet_lines: Option<usize>,
    #[serde(default)]
    content: ContentSelection,
}

#[derive(Debug, Deserialize)]
struct FindRelatedArguments {
    repo: String,
    file_path: String,
    line: usize,
    #[serde(default = "default_top_k")]
    top_k: usize,
    #[serde(default = "default_snippet_lines")]
    max_snippet_lines: Option<usize>,
    #[serde(default)]
    content: ContentSelection,
}

pub(super) fn start(
    results: &ToolResultSender,
    call: &ToolCall,
    store: Option<Store>,
) -> Result<ToolStart> {
    let operation = match super::normalized(&call.name).as_str() {
        "semblesearch" => Operation::Search(serde_json::from_value(call.arguments.clone())?),
        "semblefindrelated" => {
            Operation::FindRelated(serde_json::from_value(call.arguments.clone())?)
        }
        _ => {
            return Err(Error::Protocol(format!(
                "unsupported Semble tool: {}",
                call.name
            )))
        }
    };
    let call = call.clone();
    let results = results.clone();
    let started_at_ms = now_ms();
    tokio::spawn(async move {
        let output = execute(operation, store).await;
        match result::semble(&call, started_at_ms, output) {
            Ok(completion) => results.send(completion),
            Err(error) => results.send_error(error),
        }
    });
    Ok(ToolStart {
        messages: Vec::new(),
        completion: None,
    })
}

enum Operation {
    Search(SearchArguments),
    FindRelated(FindRelatedArguments),
}

async fn execute(operation: Operation, store: Option<Store>) -> std::result::Result<Value, String> {
    let engine = engine(store).await.map_err(|error| error.to_string())?;
    tokio::task::spawn_blocking(move || match operation {
        Operation::Search(arguments) => engine
            .search(SearchRequest {
                query: arguments.query,
                repo: arguments.repo.into(),
                top_k: arguments.top_k,
                max_snippet_lines: arguments.max_snippet_lines,
                content: content(arguments.content),
            })
            .and_then(json_value),
        Operation::FindRelated(arguments) => engine
            .find_related(FindRelatedRequest {
                repo: arguments.repo.into(),
                file_path: arguments.file_path,
                line: arguments.line,
                top_k: arguments.top_k,
                max_snippet_lines: arguments.max_snippet_lines,
                content: content(arguments.content),
            })
            .and_then(json_value),
    })
    .await
    .map_err(|error| format!("Semble search worker failed: {error}"))?
    .map_err(|error| error.to_string())
}

async fn engine(store: Option<Store>) -> Result<Arc<SearchEngine>> {
    ENGINE
        .get_or_try_init(|| async move {
            let builder = match store {
                Some(store) => crate::network::blocking_client_builder(&store).await?,
                None => reqwest::blocking::Client::builder().use_native_tls(),
            };
            tokio::task::spawn_blocking(move || {
                let client = builder.build()?;
                SearchEngine::load_default_with_client(SembleConfig::default(), &client)
                    .map(Arc::new)
                    .map_err(|error| Error::Config(format!("load Semble search engine: {error}")))
            })
            .await
            .map_err(|error| Error::Config(format!("load Semble search engine: {error}")))?
        })
        .await
        .cloned()
}

fn json_value(response: semble_core::SearchResponse) -> semble_core::Result<serde_json::Value> {
    serde_json::to_value(response)
        .map_err(|error| semble_core::Error::Serialization(error.to_string()))
}

fn content(selection: ContentSelection) -> Vec<ContentType> {
    match selection {
        ContentSelection::Code => vec![ContentType::Code],
        ContentSelection::Docs => vec![ContentType::Docs],
        ContentSelection::Config => vec![ContentType::Config],
        ContentSelection::All => vec![ContentType::Code, ContentType::Docs, ContentType::Config],
    }
}

fn default_top_k() -> usize {
    5
}

fn default_snippet_lines() -> Option<usize> {
    Some(10)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn search_arguments_use_code_search_defaults() {
        let arguments: SearchArguments = serde_json::from_value(json!({
            "query": "request persistence",
            "repo": "/tmp/repo"
        }))
        .unwrap();
        assert_eq!(arguments.top_k, 5);
        assert_eq!(arguments.max_snippet_lines, Some(10));
        assert!(matches!(arguments.content, ContentSelection::Code));
    }

    #[test]
    fn find_related_does_not_require_a_ui_description() {
        let arguments: FindRelatedArguments = serde_json::from_value(json!({
            "repo": "/tmp/repo",
            "file_path": "src/auth.ts",
            "line": 42
        }))
        .unwrap();
        assert_eq!(arguments.file_path, "src/auth.ts");
        assert_eq!(arguments.line, 42);
    }

    #[test]
    fn all_content_expands_to_every_indexed_scope() {
        assert_eq!(
            content(ContentSelection::All),
            vec![ContentType::Code, ContentType::Docs, ContentType::Config]
        );
    }
}
