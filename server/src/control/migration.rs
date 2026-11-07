//! Exports and imports a device's configuration as one portable file.
//!
//! Moving to another machine used to mean dragging the whole SQLite database
//! across. What actually needs to move is the configuration — model entries
//! with their keys and the plugin credentials — so that is what this file
//! carries. Secrets live in it, so it is written by hand and never committed.

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use super::service::ControlService;
use crate::{
    model::{ModelConfig, ModelConfigInput},
    Result,
};

pub const FORMAT: &str = "cursor-byok-migration";
pub const VERSION: u32 = 1;

/// The plugin's resource accounts, kept in the shape the plugin's own import
/// parser already understands so import reuses that path instead of growing a
/// second one.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MigrationPluginResources {
    pub plugin_id: String,
    pub resource_type: String,
    pub accounts: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MigrationFile {
    pub format: String,
    pub version: u32,
    pub app_version: String,
    pub exported_at_ms: i64,
    pub models: Vec<ModelConfigInput>,
    pub plugin_resources: Vec<MigrationPluginResources>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MigrationResult {
    pub models_added: usize,
    pub models_total: usize,
    pub resources_added: usize,
    pub resources_updated: usize,
    pub warnings: Vec<String>,
}

pub async fn export(State(service): State<ControlService>) -> Result<axum::response::Response> {
    let file = service.migration_export().await?;
    let body = serde_json::to_vec_pretty(&file)?;
    Ok(axum::response::Response::builder()
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"cursor-byok-migration-{}.json\"",
                chrono::Utc::now().format("%Y%m%d")
            ),
        )
        .body(axum::body::Body::from(body))
        .expect("static migration export response"))
}

pub async fn import(
    State(service): State<ControlService>,
    Json(file): Json<MigrationFile>,
) -> Result<Json<MigrationResult>> {
    Ok(Json(service.migration_import(file).await?))
}

impl From<&ModelConfig> for ModelConfigInput {
    fn from(model: &ModelConfig) -> Self {
        ModelConfigInput {
            sort_order: model.sort_order,
            display_name: model.display_name.clone(),
            group_name: model.group_name.clone(),
            model_type: model.model_type,
            base_url: model.base_url.clone(),
            use_full_url: model.use_full_url,
            api_key: model.api_key.clone(),
            tooltip_data: model.tooltip_data.clone(),
            model_id: model.model_id.clone(),
            reasoning_effort: model.reasoning_effort.clone(),
            openai_endpoint: model.openai_endpoint.clone(),
            openai_extra_params_enabled: model.openai_extra_params_enabled,
            openai_extra_params: model.openai_extra_params.clone(),
            custom_headers_enabled: model.custom_headers_enabled,
            custom_headers: model.custom_headers.clone(),
            anthropic_extra_params_enabled: model.anthropic_extra_params_enabled,
            anthropic_extra_params: model.anthropic_extra_params.clone(),
            context_window_tokens: model.context_window_tokens,
            max_completion_tokens: model.max_completion_tokens,
            anthropic_max_tokens: model.anthropic_max_tokens,
            anthropic_thinking_effort: model.anthropic_thinking_effort.clone(),
            thinking_budget_tokens: model.thinking_budget_tokens,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> ModelConfig {
        ModelConfig {
            model_hash: "hash".into(),
            sort_order: 3,
            display_name: "glm-5.3-官方".into(),
            group_name: Some("智谱".into()),
            model_type: crate::model::ModelType::OpenAi,
            base_url: "https://open.bigmodel.cn/api/coding/paas/v4".into(),
            use_full_url: true,
            api_key: "sk-secret".into(),
            tooltip_data: "GLM".into(),
            model_id: "glm-5.3".into(),
            reasoning_effort: Some("max".into()),
            openai_endpoint: "/v1/chat/completions".into(),
            openai_extra_params_enabled: true,
            openai_extra_params: serde_json::json!({"tool_stream": true}),
            custom_headers_enabled: true,
            custom_headers: serde_json::json!({"X-ZCode-Agent": "glm"}),
            anthropic_extra_params_enabled: false,
            anthropic_extra_params: serde_json::json!({}),
            context_window_tokens: Some(1_000_000),
            max_completion_tokens: Some(65_536),
            anthropic_max_tokens: None,
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
            created_at_ms: 1,
            updated_at_ms: 2,
        }
    }

    /// The whole point of the file is carrying the key across machines, so the
    /// export must keep it and drop only the identity the destination assigns.
    #[test]
    fn export_carries_the_key_and_drops_the_local_identity() {
        let input = ModelConfigInput::from(&model());
        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(json["api_key"], "sk-secret");
        assert_eq!(json["display_name"], "glm-5.3-官方");
        assert!(
            json.get("model_hash").is_none(),
            "hash is assigned on import"
        );
        assert!(json.get("created_at_ms").is_none());
    }

    #[test]
    fn the_file_format_is_identified() {
        let file = MigrationFile {
            format: FORMAT.into(),
            version: VERSION,
            app_version: "1.0.2".into(),
            exported_at_ms: 0,
            models: Vec::new(),
            plugin_resources: Vec::new(),
        };
        let json = serde_json::to_value(&file).unwrap();
        assert_eq!(json["format"], FORMAT);
        assert_eq!(json["version"], VERSION);
    }
}
