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

// OpenAI / ChatGPT Codex OAuth Device Code Flow
pub const DEFAULT_CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const CODEX_DEVICE_CODE_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
pub const CODEX_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
pub const CODEX_VERIFICATION_URI: &str = "https://auth.openai.com/codex/device";

#[derive(Debug, Deserialize, Serialize)]
pub struct CodexDeviceCodeInput {
    pub client_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CodexDeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CodexTokenPollInput {
    pub device_code: String,
    pub client_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CodexTokenPollResponse {
    pub status: String, // "success", "pending", "slow_down", "expired", "error"
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub token_type: Option<String>,
    pub expires_in: Option<u64>,
    pub error_message: Option<String>,
}

pub async fn codex_device_code(
    State(service): State<ControlService>,
    Json(input): Json<CodexDeviceCodeInput>,
) -> Result<Json<CodexDeviceCodeResponse>> {
    let client = crate::network::client(service.store()).await?;
    let client_id = input
        .client_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CODEX_CLIENT_ID.to_string());

    let payload = serde_json::json!({
        "client_id": client_id,
    });

    let response = client
        .post(CODEX_DEVICE_CODE_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&payload)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(Error::Provider(format!(
            "Failed to request OpenAI Codex device code (HTTP {status}): {body}"
        )));
    }

    let body: serde_json::Value = response.json().await.unwrap_or_default();
    let user_code = body
        .get("user_code")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let device_code = body
        .get("device_auth_id")
        .or_else(|| body.get("device_code"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let expires_in = body.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(900);
    let interval = body.get("interval").and_then(|v| v.as_u64()).unwrap_or(5);

    Ok(Json(CodexDeviceCodeResponse {
        device_code,
        user_code,
        verification_uri: CODEX_VERIFICATION_URI.into(),
        verification_uri_complete: Some(CODEX_VERIFICATION_URI.into()),
        expires_in,
        interval,
    }))
}

pub async fn codex_token_poll(
    State(service): State<ControlService>,
    Json(input): Json<CodexTokenPollInput>,
) -> Result<Json<CodexTokenPollResponse>> {
    let client = crate::network::client(service.store()).await?;
    let client_id = input
        .client_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CODEX_CLIENT_ID.to_string());

    let payload = serde_json::json!({
        "client_id": client_id,
        "device_auth_id": input.device_code,
    });

    let response = client
        .post(CODEX_TOKEN_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&payload)
        .send()
        .await?;

    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or_default();

    if status.is_success() {
        let access_token = body.get("access_token").and_then(|v| v.as_str()).map(ToString::to_string);
        let refresh_token = body.get("refresh_token").and_then(|v| v.as_str()).map(ToString::to_string);
        let token_type = body.get("token_type").and_then(|v| v.as_str()).map(ToString::to_string);
        let expires_in = body.get("expires_in").and_then(|v| v.as_u64());

        if access_token.is_some() {
            return Ok(Json(CodexTokenPollResponse {
                status: "success".into(),
                access_token,
                refresh_token,
                token_type,
                expires_in,
                error_message: None,
            }));
        }
    }

    let error_code = body
        .get("error")
        .and_then(|v| if v.is_string() { v.as_str() } else { v.get("code").and_then(|c| c.as_str()) })
        .unwrap_or("");

    let error_desc = body
        .get("error_description")
        .or_else(|| body.get("message"))
        .or_else(|| body.get("error").and_then(|e| e.get("message")))
        .and_then(|v| v.as_str())
        .map(ToString::to_string);

    match error_code {
        "authorization_pending" | "pending" => Ok(Json(CodexTokenPollResponse {
            status: "pending".into(),
            access_token: None,
            refresh_token: None,
            token_type: None,
            expires_in: None,
            error_message: None,
        })),
        "slow_down" => Ok(Json(CodexTokenPollResponse {
            status: "slow_down".into(),
            access_token: None,
            refresh_token: None,
            token_type: None,
            expires_in: None,
            error_message: None,
        })),
        "expired_token" | "expired" => Ok(Json(CodexTokenPollResponse {
            status: "expired".into(),
            access_token: None,
            refresh_token: None,
            token_type: None,
            expires_in: None,
            error_message: error_desc.or_else(|| Some("Device authorization code expired".into())),
        })),
        "access_denied" | "denied" => Ok(Json(CodexTokenPollResponse {
            status: "access_denied".into(),
            access_token: None,
            refresh_token: None,
            token_type: None,
            expires_in: None,
            error_message: error_desc.or_else(|| Some("User denied authorization".into())),
        })),
        _ => {
            let msg = error_desc.unwrap_or_else(|| {
                if !error_code.is_empty() {
                    format!("OAuth error: {error_code}")
                } else {
                    "授权等待中或需在 ChatGPT 安全设置中启用 Codex 设备代码授权".into()
                }
            });
            Ok(Json(CodexTokenPollResponse {
                status: "error".into(),
                access_token: None,
                refresh_token: None,
                token_type: None,
                expires_in: None,
                error_message: Some(msg),
            }))
        }
    }
}
