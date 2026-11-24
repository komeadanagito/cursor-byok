//! Searches the web through Exa's public MCP service.
use std::{error::Error as StdError, future::Future, sync::LazyLock, time::Duration};

use regex::Regex;
use rmcp::{
    model::{CallToolRequestParam, CallToolResult},
    transport::streamable_http_client::{
        StreamableHttpClientTransport, StreamableHttpClientTransportConfig, StreamableHttpError,
    },
    ServiceError, ServiceExt,
};
use serde_json::json;
use tokio::{sync::Mutex, time::Instant};

use crate::store::Store;

const ENDPOINT: &str = "https://mcp.exa.ai/mcp";
const TOOL: &str = "web_search_exa";
// Eight excerpts are about as many as the model-visible result limit holds.
const MAX_RESULTS: usize = 8;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
// Anonymous callers may search twice a second.
const SEARCH_INTERVAL: Duration = Duration::from_millis(600);

/// When the next search may start. The limit counts the whole desktop, so every
/// conversation shares it.
static NEXT_SEARCH: LazyLock<Mutex<Instant>> = LazyLock::new(|| Mutex::new(Instant::now()));

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub chunk: String,
}

#[derive(Debug, thiserror::Error)]
#[error("Exa web search failed: {0}")]
pub struct SearchError(String);

#[derive(Clone)]
pub struct WebSearch {
    client: SearchClient,
    endpoint: String,
}

#[derive(Clone)]
enum SearchClient {
    Managed(Store),
    Direct,
}

impl SearchHit {
    pub fn new(title: impl Into<String>, url: impl Into<String>, chunk: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            url: url.into(),
            chunk: chunk.into(),
        }
    }
}

impl WebSearch {
    pub fn built_in() -> Self {
        Self {
            client: SearchClient::Direct,
            endpoint: ENDPOINT.into(),
        }
    }

    pub(crate) fn managed(store: Store) -> Self {
        Self {
            client: SearchClient::Managed(store),
            endpoint: ENDPOINT.into(),
        }
    }

    #[cfg(test)]
    fn with_endpoint(endpoint: String) -> Self {
        Self {
            client: SearchClient::Direct,
            endpoint,
        }
    }

    pub async fn search(&self, query: &str) -> Result<Vec<SearchHit>, SearchError> {
        let query = query.trim();
        if query.is_empty() {
            return Err(SearchError("query is empty".into()));
        }
        let client = match &self.client {
            SearchClient::Managed(store) => crate::network::client(store)
                .await
                .map_err(|error| SearchError(format!("HTTP client: {error}")))?,
            SearchClient::Direct => reqwest::Client::new(),
        };
        let transport = StreamableHttpClientTransport::with_client(
            client,
            StreamableHttpClientTransportConfig::with_uri(self.endpoint.clone()),
        );
        let session = deadline(().serve(transport))
            .await?
            .map_err(|error| SearchError(format!("cannot connect: {error}")))?;
        let arguments = json!({
            "query": query,
            "objective": format!("Rank pages that directly answer this search first and leave out pages that only share generic words with it: {query}"),
            "numResults": MAX_RESULTS,
        });
        wait_for_turn().await;
        let reply = deadline(session.call_tool(CallToolRequestParam {
            name: TOOL.into(),
            arguments: arguments.as_object().cloned(),
        }))
        .await?
        .map_err(call_error)?;
        read_reply(reply)
    }
}

async fn deadline<T>(operation: impl Future<Output = T>) -> Result<T, SearchError> {
    tokio::time::timeout(REQUEST_TIMEOUT, operation)
        .await
        .map_err(|_| SearchError("request timed out".into()))
}

async fn wait_for_turn() {
    let mut next = NEXT_SEARCH.lock().await;
    tokio::time::sleep_until(*next).await;
    *next = Instant::now() + SEARCH_INTERVAL;
}

fn call_error(error: ServiceError) -> SearchError {
    if rejected_status(&error) == Some(reqwest::StatusCode::TOO_MANY_REQUESTS) {
        return SearchError(
            "the free rate limit is used up; try again later, fetch a known URL, or ask the user to install their own search MCP in Cursor".into(),
        );
    }
    SearchError(error.to_string())
}

fn rejected_status(error: &ServiceError) -> Option<reqwest::StatusCode> {
    let ServiceError::TransportSend(error) = error else {
        return None;
    };
    let mut source: Option<&(dyn StdError + 'static)> = Some(error.error.as_ref());
    while let Some(error) = source {
        if let Some(StreamableHttpError::Client(error)) =
            error.downcast_ref::<StreamableHttpError<reqwest::Error>>()
        {
            return error.status();
        }
        source = error.source();
    }
    None
}

fn read_reply(reply: CallToolResult) -> Result<Vec<SearchHit>, SearchError> {
    let text = reply
        .content
        .iter()
        .filter_map(|content| content.as_text().map(|text| text.text.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    if reply.is_error == Some(true) {
        return Err(SearchError(text));
    }
    let hits = parse(&text);
    if hits.is_empty() && !text.starts_with("No search results found") {
        return Err(SearchError("the service sent an unreadable reply".into()));
    }
    Ok(hits)
}

/// Exa separates results with a rule that page excerpts can contain as well, so
/// only a title line followed by a URL line starts a result.
fn parse(text: &str) -> Vec<SearchHit> {
    static HEADING: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?:\A|\n\n---\n\n)Title: ([^\n]*)\nURL: (https?://[^\n]+)\n")
            .expect("valid Exa result heading")
    });
    let headings = HEADING.captures_iter(text).collect::<Vec<_>>();
    headings
        .iter()
        .enumerate()
        .map(|(index, heading)| {
            let start = heading.get(0).expect("whole match").end();
            let end = headings
                .get(index + 1)
                .map_or(text.len(), |next| next.get(0).expect("whole match").start());
            SearchHit::new(&heading[1], &heading[2], excerpt(&text[start..end]))
        })
        .collect()
}

/// Keeps the publication date, which the model needs to judge how current a
/// page is, and drops the labels around the page text.
fn excerpt(body: &str) -> String {
    let (details, text) = body.split_once("Highlights:\n").unwrap_or(("", body));
    details
        .lines()
        .filter(|line| line.starts_with("Published: ") && *line != "Published: N/A")
        .chain([text.trim()])
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{extract::Json, http::StatusCode, response::IntoResponse, routing::post, Router};
    use parking_lot::Mutex;
    use serde_json::{json, Value};

    use super::*;

    type Calls = Arc<Mutex<Vec<(Instant, Value)>>>;

    /// Serves one MCP endpoint whose search tool always gives the same reply.
    async fn exa(status: StatusCode, result: Value) -> (WebSearch, Calls) {
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/mcp", socket.local_addr().unwrap());
        let calls = Calls::default();
        let seen = calls.clone();
        let app = Router::new().route(
            "/mcp",
            post(move |Json(request): Json<Value>| {
                let (seen, result) = (seen.clone(), result.clone());
                async move {
                    let result = match request["method"].as_str().unwrap() {
                        "initialize" => json!({
                            "protocolVersion": request["params"]["protocolVersion"],
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": "exa", "version": "1"}
                        }),
                        "tools/call" => {
                            seen.lock()
                                .push((Instant::now(), request["params"].clone()));
                            if status != StatusCode::OK {
                                return status.into_response();
                            }
                            result
                        }
                        _ => return StatusCode::ACCEPTED.into_response(),
                    };
                    Json(json!({"jsonrpc": "2.0", "id": request["id"], "result": result}))
                        .into_response()
                }
            }),
        );
        tokio::spawn(async move { axum::serve(socket, app).await.unwrap() });
        (WebSearch::with_endpoint(endpoint), calls)
    }

    fn reply(text: &str) -> Value {
        json!({"content": [{"type": "text", "text": text}]})
    }

    #[tokio::test]
    async fn results_keep_exa_order_and_separators_inside_a_page_do_not_split_it() {
        let (search, calls) = exa(
            StatusCode::OK,
            reply(
                "Title: 修复空响应 · Issue #1\nURL: https://example.com/zzz\nPublished: 2026-11-01T00:00:00.000Z\nAuthor: N/A\nHighlights:\nFirst part\n\n---\n\nTitle: not a result heading\nSecond part\n\n---\n\nTitle: Guide\nURL: https://example.com/aaa?id=2\nPublished: N/A\nAuthor: N/A\nHighlights:\nGuide text\n",
            ),
        )
        .await;
        let hits = search.search("  空响应 修复 ").await.unwrap();
        assert_eq!(
            hits,
            [
                SearchHit::new(
                    "修复空响应 · Issue #1",
                    "https://example.com/zzz",
                    "Published: 2026-11-01T00:00:00.000Z\nFirst part\n\n---\n\nTitle: not a result heading\nSecond part",
                ),
                SearchHit::new("Guide", "https://example.com/aaa?id=2", "Guide text"),
            ]
        );
        let (_, params) = calls.lock()[0].clone();
        assert_eq!(params["name"], "web_search_exa");
        assert_eq!(params["arguments"]["query"], "空响应 修复");
        assert!(params["arguments"]["objective"]
            .as_str()
            .unwrap()
            .contains("空响应 修复"));
    }

    #[tokio::test]
    async fn an_empty_search_is_not_an_error_but_an_unreadable_reply_is() {
        let (empty, _) = exa(
            StatusCode::OK,
            reply("No search results found. Please try a different query."),
        )
        .await;
        assert!(empty.search("test").await.unwrap().is_empty());
        let (changed, _) = exa(StatusCode::OK, reply("<html>unexpected</html>")).await;
        let error = changed.search("test").await.unwrap_err().to_string();
        assert!(error.contains("Exa"), "{error}");
        assert!(error.contains("unreadable"), "{error}");
    }

    #[tokio::test]
    async fn a_tool_error_is_reported_with_its_reason() {
        let (search, _) = exa(
            StatusCode::OK,
            json!({"isError": true, "content": [{"type": "text", "text": "upstream unavailable"}]}),
        )
        .await;
        let error = search.search("test").await.unwrap_err().to_string();
        assert!(error.contains("upstream unavailable"), "{error}");
    }

    #[tokio::test]
    async fn an_exhausted_free_quota_is_named_instead_of_looking_like_no_results() {
        let (search, _) = exa(StatusCode::TOO_MANY_REQUESTS, Value::Null).await;
        let error = search.search("test").await.unwrap_err().to_string();
        assert!(error.contains("free rate limit"), "{error}");
        assert!(error.contains("search MCP"), "{error}");
    }

    #[tokio::test]
    async fn an_unreachable_service_fails_instead_of_hanging() {
        let search = WebSearch::with_endpoint("http://127.0.0.1:1/mcp".into());
        let outcome = tokio::time::timeout(Duration::from_secs(30), search.search("test"))
            .await
            .expect("an unreachable service must not hang the tool call");
        assert!(outcome.is_err());
        assert!(search.search("   ").await.is_err());
    }

    // Exa rejects the third anonymous call within one second, and models
    // routinely issue several searches in one round.
    #[tokio::test]
    async fn parallel_searches_are_spaced_out_across_conversations() {
        let (search, calls) = exa(
            StatusCode::OK,
            reply("Title: A\nURL: https://example.com/a\nHighlights:\ntext"),
        )
        .await;
        let searches = (0..3).map(|_| {
            let search = search.clone();
            async move { search.search("test").await }
        });
        for outcome in futures_util::future::join_all(searches).await {
            outcome.unwrap();
        }
        let mut times = calls.lock().iter().map(|(at, _)| *at).collect::<Vec<_>>();
        times.sort();
        assert_eq!(times.len(), 3);
        assert!(
            times[2] - times[0] >= Duration::from_millis(1000),
            "{:?}",
            times[2] - times[0]
        );
    }
}
