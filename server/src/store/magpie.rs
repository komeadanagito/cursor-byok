//! Persists the followed Magpie catalog separately from manually editable models.
use super::{now_ms, Store};
use crate::{
    model::ModelConfig,
    provider::magpie::{Catalog, PREFIX},
    Result,
};

impl Store {
    pub(crate) async fn magpie_catalog(&self) -> Result<Option<Catalog>> {
        let json: Option<String> = sqlx::query_scalar(
            "SELECT value_json FROM service_settings WHERE setting_key='magpie'",
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(json.map(|s| serde_json::from_str(&s)).transpose()?)
    }
    pub(crate) async fn save_magpie_catalog(&self, catalog: Option<&Catalog>) -> Result<()> {
        let _guard = self.writes.lock().await;
        if let Some(catalog) = catalog {
            sqlx::query("INSERT INTO service_settings(setting_key,value_json,updated_at_ms) VALUES ('magpie',?,?) ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at_ms=excluded.updated_at_ms").bind(serde_json::to_string(catalog)?).bind(now_ms()).execute(&self.pool).await?;
        } else {
            sqlx::query("DELETE FROM service_settings WHERE setting_key='magpie'")
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }
    pub(crate) async fn configured_models(&self) -> Result<Vec<ModelConfig>> {
        let mut all = self.models().await?;
        if let Some(catalog) = self.magpie_catalog().await? {
            all.extend(catalog.configurations());
        }
        Ok(all)
    }
    pub(crate) async fn configured_model(&self, id: &str) -> Result<Option<ModelConfig>> {
        if id.starts_with(PREFIX) {
            return Ok(self
                .magpie_catalog()
                .await?
                .and_then(|c| c.configurations().find(|m| m.model_hash == id)));
        }
        self.model(id).await
    }
}
