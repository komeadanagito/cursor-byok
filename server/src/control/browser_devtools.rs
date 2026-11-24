//! Pairs the Chrome extension with the local management listener.

use axum::{
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde_json::json;

use crate::cursor::tools::browser_bridge::{self, BrowserReply};

pub async fn pair(headers: HeaderMap) -> impl IntoResponse {
    let trusted_host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<axum::http::uri::Authority>().ok())
        .is_some_and(|host| matches!(host.host(), "127.0.0.1" | "[::1]"));
    if !trusted_host
        || headers
            .get("sec-fetch-site")
            .and_then(|value| value.to_str().ok())
            != Some("same-origin")
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let token = browser_bridge::pair_browser().await;
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"token": token})),
    )
        .into_response()
}

pub async fn next(headers: HeaderMap) -> impl IntoResponse {
    let Some(token) = token(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    match browser_bridge::next(token).await {
        Some(Some(request)) => Json(request).into_response(),
        Some(None) => StatusCode::NO_CONTENT.into_response(),
        None => StatusCode::UNAUTHORIZED.into_response(),
    }
}

pub async fn reply(headers: HeaderMap, Json(reply): Json<BrowserReply>) -> StatusCode {
    let Some(token) = token(&headers) else {
        return StatusCode::UNAUTHORIZED;
    };
    if browser_bridge::reply(token, reply).await {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

fn token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
