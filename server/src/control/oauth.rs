use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use crate::{Error, Result};
use super::ControlService;

pub const DEFAULT_XAI_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
pub const XAI_DEVICE_CODE_URL: &str = "https://auth.x.ai/oauth2/device/code";
pub const XAI_TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";
pub const XAI_DEFAULT_SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";

#[derive(Debug, Deserialize, Serialize)]
pub struct GrokDeviceCodeInput {
    pub client_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct GrokDeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct GrokTokenPollInput {
    pub device_code: String,
    pub client_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct GrokTokenPollResponse {
    pub status: String, // "success", "pending", "slow_down", "expired", "error"
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub token_type: Option<String>,
    pub expires_in: Option<u64>,
    pub error_message: Option<String>,
}

pub async fn grok_device_code(
    State(service): State<ControlService>,
    Json(input): Json<GrokDeviceCodeInput>,
) -> Result<Json<GrokDeviceCodeResponse>> {
    let client = crate::network::client(service.store()).await?;
    let client_id = input
        .client_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_XAI_CLIENT_ID.to_string());

    let params = [
        ("client_id", client_id.as_str()),
        ("scope", XAI_DEFAULT_SCOPE),
    ];

    let response = client
        .post(XAI_DEVICE_CODE_URL)
        .form(&params)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(Error::Provider(format!(
            "Failed to request xAI device code (HTTP {status}): {body}"
        )));
    }

    let parsed: GrokDeviceCodeResponse = response.json().await?;
    Ok(Json(parsed))
}

pub async fn grok_token_poll(
    State(service): State<ControlService>,
    Json(input): Json<GrokTokenPollInput>,
) -> Result<Json<GrokTokenPollResponse>> {
    let client = crate::network::client(service.store()).await?;
    let client_id = input
        .client_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_XAI_CLIENT_ID.to_string());

    let params = [
        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ("client_id", client_id.as_str()),
        ("device_code", input.device_code.as_str()),
    ];

    let response = client
        .post(XAI_TOKEN_URL)
        .form(&params)
        .send()
        .await?;

    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or_default();

    if status.is_success() {
        let access_token = body.get("access_token").and_then(|v| v.as_str()).map(ToString::to_string);
        let refresh_token = body.get("refresh_token").and_then(|v| v.as_str()).map(ToString::to_string);
        let token_type = body.get("token_type").and_then(|v| v.as_str()).map(ToString::to_string);
        let expires_in = body.get("expires_in").and_then(|v| v.as_u64());

        return Ok(Json(GrokTokenPollResponse {
            status: "success".into(),
            access_token,
            refresh_token,
            token_type,
            expires_in,
            error_message: None,
        }));
    }

    let error_code = body.get("error").and_then(|v| v.as_str()).unwrap_or("");
    let error_desc = body
        .get("error_description")
        .and_then(|v| v.as_str())
        .map(ToString::to_string);

    match error_code {
        "authorization_pending" => Ok(Json(GrokTokenPollResponse {
            status: "pending".into(),
            access_token: None,
            refresh_token: None,
            token_type: None,
            expires_in: None,
            error_message: None,
        })),
        "slow_down" => Ok(Json(GrokTokenPollResponse {
            status: "slow_down".into(),
            access_token: None,
            refresh_token: None,
            token_type: None,
            expires_in: None,
            error_message: None,
        })),
        "expired_token" => Ok(Json(GrokTokenPollResponse {
            status: "expired".into(),
            access_token: None,
            refresh_token: None,
            token_type: None,
            expires_in: None,
            error_message: error_desc.or_else(|| Some("Device authorization code expired".into())),
        })),
        "access_denied" => Ok(Json(GrokTokenPollResponse {
            status: "access_denied".into(),
            access_token: None,
            refresh_token: None,
            token_type: None,
            expires_in: None,
            error_message: error_desc.or_else(|| Some("User denied authorization".into())),
        })),
        _ => Ok(Json(GrokTokenPollResponse {
            status: "error".into(),
            access_token: None,
            refresh_token: None,
            token_type: None,
            expires_in: None,
            error_message: error_desc.or_else(|| Some(format!("OAuth error: {error_code}"))),
        })),
    }
}
