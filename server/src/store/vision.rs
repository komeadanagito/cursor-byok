//! Stores the chosen image reader and stable image descriptions for conversation replay.
use super::{now_ms, Store};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum VisionSettings {
    #[default]
    Cursor,
    Model {
        model_id: String,
    },
    Mcp {
        url: String,
        tool: String,
    },
}

impl Store {
    pub async fn vision_settings(&self) -> Result<VisionSettings> {
        let row: Option<String> = sqlx::query_scalar(
            "SELECT value_json FROM service_settings WHERE setting_key = 'vision'",
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(row
            .map(|json| serde_json::from_str(&json))
            .transpose()?
            .unwrap_or_default())
    }

    pub async fn set_vision_settings(&self, settings: &VisionSettings) -> Result<()> {
        match settings {
            VisionSettings::Model { model_id } if model_id.trim().is_empty() => {
                return Err(Error::Config("vision model ID is empty".into()))
            }
            VisionSettings::Mcp { url, tool }
                if !reqwest::Url::parse(url).is_ok_and(|u| {
                    matches!(u.scheme(), "http" | "https") && u.host().is_some()
                }) || tool.trim().is_empty() =>
            {
                return Err(Error::Config(
                    "vision MCP requires an HTTP(S) URL and tool name".into(),
                ));
            }
            _ => {}
        }
        let _write = self.writes.lock().await;
        sqlx::query("INSERT INTO service_settings(setting_key,value_json,updated_at_ms) VALUES ('vision',?,?) ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at_ms=excluded.updated_at_ms").bind(serde_json::to_string(settings)?).bind(now_ms()).execute(&self.pool).await?;
        Ok(())
    }

    pub(crate) async fn image_description(
        &self,
        conversation: &str,
        message: &str,
        digest: &str,
    ) -> Result<Option<String>> {
        Ok(sqlx::query_scalar("SELECT description FROM image_descriptions WHERE conversation_id=? AND message_id=? AND image_digest=?").bind(conversation).bind(message).bind(digest).fetch_optional(&self.pool).await?)
    }

    pub(crate) async fn save_image_description(
        &self,
        conversation: &str,
        message: &str,
        digest: &str,
        description: &str,
    ) -> Result<String> {
        let _write = self.writes.lock().await;
        sqlx::query("INSERT INTO image_descriptions(conversation_id,message_id,image_digest,description) VALUES (?,?,?,?) ON CONFLICT DO NOTHING").bind(conversation).bind(message).bind(digest).bind(description).execute(&self.pool).await?;
        self.image_description(conversation, message, digest)
            .await?
            .ok_or_else(|| Error::Store("saved image description is missing".into()))
    }
}
