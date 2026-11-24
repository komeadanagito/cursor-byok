//! Persists model and provider configuration.
use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
};

use sqlx::{Row, SqliteConnection};

use crate::{
    model::{
        model_fingerprint, normalize_model_input, ModelConfig, ModelConfigInput, ModelType,
        MANUAL_MODEL_PREFIX,
    },
    Error, Result,
};

use super::{now_ms, Store};

const MODEL_COLUMNS: &str = r#"
    model_hash, sort_order, display_name, group_name, model_type, base_url, use_full_url, api_key, tooltip_data,
    model_id, reasoning_effort, openai_endpoint, openai_extra_params_enabled,
    openai_extra_params_json, custom_headers_enabled, custom_headers_json,
    anthropic_extra_params_enabled, anthropic_extra_params_json, context_window_tokens,
    max_completion_tokens, anthropic_max_tokens, anthropic_thinking_effort,
    thinking_budget_tokens, supports_images, created_at_ms, updated_at_ms
"#;

impl Store {
    pub async fn models(&self) -> Result<Vec<ModelConfig>> {
        let query =
            format!("SELECT {MODEL_COLUMNS} FROM model_configs ORDER BY sort_order, display_name");
        sqlx::query(&query)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(model_from_row)
            .collect()
    }

    pub async fn model(&self, hash: &str) -> Result<Option<ModelConfig>> {
        let query = format!("SELECT {MODEL_COLUMNS} FROM model_configs WHERE model_hash = ?");
        sqlx::query(&query)
            .bind(hash)
            .fetch_optional(&self.pool)
            .await?
            .map(model_from_row)
            .transpose()
    }

    pub async fn create_model(&self, input: &ModelConfigInput) -> Result<ModelConfig> {
        let mut models = self.create_models(std::slice::from_ref(input)).await?;
        Ok(models.remove(0))
    }

    pub async fn create_models(&self, inputs: &[ModelConfigInput]) -> Result<Vec<ModelConfig>> {
        if inputs.is_empty() {
            return Err(Error::Config("at least one model is required".into()));
        }
        let inputs = inputs
            .iter()
            .map(normalize_model_input)
            .collect::<Result<Vec<_>>>()?;
        let ids = self.insert_new_models(&inputs, false).await?;
        let mut saved = Vec::with_capacity(ids.len());
        for id in ids {
            saved.push(self.model(&id).await?.expect("inserted model must exist"));
        }
        Ok(saved)
    }

    pub async fn create_models_if_missing(&self, inputs: &[ModelConfigInput]) -> Result<usize> {
        let inputs = inputs
            .iter()
            .map(normalize_model_input)
            .collect::<Result<Vec<_>>>()?;
        Ok(self.insert_new_models(&inputs, true).await?.len())
    }

    async fn insert_new_models(
        &self,
        inputs: &[ModelConfigInput],
        skip_existing: bool,
    ) -> Result<Vec<String>> {
        let now = now_ms();
        let mut session = self.write_session().await?;
        let mut transaction = session.begin().await?;
        let mut fingerprints = model_fingerprints(&mut transaction).await?;
        let mut inserted = Vec::with_capacity(inputs.len());
        for input in inputs {
            let fingerprint = model_fingerprint(input)?;
            if fingerprints.contains_key(&fingerprint) {
                if skip_existing {
                    continue;
                }
                return Err(Error::Config("model configurations must be unique".into()));
            }
            let id = format!("{MANUAL_MODEL_PREFIX}{}", uuid::Uuid::new_v4());
            insert_model(&mut transaction, &id, input, now).await?;
            fingerprints.insert(fingerprint, id.clone());
            inserted.push(id);
        }
        transaction.commit().await?;
        session.committed();
        Ok(inserted)
    }

    pub async fn update_model(
        &self,
        current_hash: &str,
        input: &ModelConfigInput,
    ) -> Result<ModelConfig> {
        let now = now_ms();
        let mut session = self.write_session().await?;
        let mut transaction = session.begin().await?;
        let query = format!("SELECT {MODEL_COLUMNS} FROM model_configs WHERE model_hash = ?");
        let current = sqlx::query(&query)
            .bind(current_hash)
            .fetch_optional(&mut *transaction)
            .await?
            .map(model_from_row)
            .transpose()?
            .ok_or_else(|| Error::RunNotFound(format!("model {current_hash}")))?;
        let mut input = input.clone();
        let old_url = reqwest::Url::parse(&current.request_url()?).expect("validated model URL");
        let new_url = crate::model::resolve_request_url(
            input.model_type,
            &input.base_url,
            &input.openai_endpoint,
            input.use_full_url,
        )?;
        let new_url = reqwest::Url::parse(&new_url).expect("validated model URL");
        if old_url.origin() == new_url.origin() {
            if input.api_key.trim().is_empty() {
                input.api_key = current.api_key;
            }
            if input.custom_headers.is_null() {
                input.custom_headers = current.custom_headers;
            }
        } else if input.custom_headers.is_null() {
            input.custom_headers = serde_json::json!({});
        }
        let input = normalize_model_input(&input)?;
        let fingerprint = model_fingerprint(&input)?;
        if model_fingerprints(&mut transaction)
            .await?
            .get(&fingerprint)
            .is_some_and(|id| id != current_hash)
        {
            return Err(Error::Config("model configurations must be unique".into()));
        }
        let result = sqlx::query(
            r#"UPDATE model_configs SET
                sort_order = ?, display_name = ?, group_name = ?, model_type = ?, base_url = ?,
                use_full_url = ?, api_key = ?, tooltip_data = ?, model_id = ?, reasoning_effort = ?,
                openai_endpoint = ?, openai_extra_params_enabled = ?, openai_extra_params_json = ?,
                custom_headers_enabled = ?, custom_headers_json = ?,
                anthropic_extra_params_enabled = ?, anthropic_extra_params_json = ?,
                context_window_tokens = ?, max_completion_tokens = ?, anthropic_max_tokens = ?,
                anthropic_thinking_effort = ?, thinking_budget_tokens = ?, supports_images = ?, updated_at_ms = ?
            WHERE model_hash = ?"#,
        )
        .bind(input.sort_order)
        .bind(&input.display_name)
        .bind(&input.group_name)
        .bind(input.model_type.as_str())
        .bind(&input.base_url)
        .bind(input.use_full_url)
        .bind(&input.api_key)
        .bind(&input.tooltip_data)
        .bind(&input.model_id)
        .bind(&input.reasoning_effort)
        .bind(&input.openai_endpoint)
        .bind(input.openai_extra_params_enabled)
        .bind(serde_json::to_string(&input.openai_extra_params)?)
        .bind(input.custom_headers_enabled)
        .bind(serde_json::to_string(&input.custom_headers)?)
        .bind(input.anthropic_extra_params_enabled)
        .bind(serde_json::to_string(&input.anthropic_extra_params)?)
        .bind(input.context_window_tokens.map(to_i64).transpose()?)
        .bind(input.max_completion_tokens.map(to_i64).transpose()?)
        .bind(input.anthropic_max_tokens.map(to_i64).transpose()?)
        .bind(&input.anthropic_thinking_effort)
        .bind(input.thinking_budget_tokens.map(to_i64).transpose()?)
        .bind(input.supports_images)
        .bind(now)
        .bind(current_hash)
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() != 1 {
            return Err(Error::RunNotFound(format!("model {current_hash}")));
        }
        transaction.commit().await?;
        session.committed();
        Ok(self
            .model(current_hash)
            .await?
            .expect("updated model must exist"))
    }

    pub async fn delete_model(&self, hash: &str) -> Result<()> {
        let mut session = self.write_session().await?;
        let mut transaction = session.begin().await?;
        sqlx::query("UPDATE llm_calls SET model_hash = NULL WHERE model_hash = ?")
            .bind(hash)
            .execute(&mut *transaction)
            .await?;
        let result = sqlx::query("DELETE FROM model_configs WHERE model_hash = ?")
            .bind(hash)
            .execute(&mut *transaction)
            .await?;
        if result.rows_affected() != 1 {
            return Err(Error::RunNotFound(format!("model {hash}")));
        }
        transaction.commit().await?;
        session.committed();
        Ok(())
    }

    pub async fn reorder_models(&self, model_hashes: &[String]) -> Result<Vec<ModelConfig>> {
        let current = self.models().await?;
        let current_hashes = current
            .iter()
            .map(|model| model.model_hash.as_str())
            .collect::<HashSet<_>>();
        let requested_hashes = model_hashes
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        if model_hashes.len() != current.len()
            || requested_hashes.len() != current.len()
            || requested_hashes != current_hashes
        {
            return Err(Error::Config(
                "model configuration changed; refresh and try sorting again".into(),
            ));
        }

        let now = now_ms();
        let mut session = self.write_session().await?;
        let mut transaction = session.begin().await?;
        for (index, hash) in model_hashes.iter().enumerate() {
            sqlx::query(
                "UPDATE model_configs SET sort_order = ?, updated_at_ms = ? WHERE model_hash = ?",
            )
            .bind(i64::try_from(index + 1).expect("model order fits in i64"))
            .bind(now)
            .bind(hash)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        session.committed();
        self.models().await
    }
}

async fn insert_model(
    transaction: &mut SqliteConnection,
    hash: &str,
    input: &ModelConfigInput,
    now: i64,
) -> Result<()> {
    sqlx::query(
        r#"INSERT INTO model_configs(
            model_hash, sort_order, display_name, group_name, model_type, base_url, use_full_url, api_key, tooltip_data,
            model_id, reasoning_effort, openai_endpoint, openai_extra_params_enabled,
            openai_extra_params_json, custom_headers_enabled, custom_headers_json,
            anthropic_extra_params_enabled, anthropic_extra_params_json, context_window_tokens,
            max_completion_tokens, anthropic_max_tokens, anthropic_thinking_effort,
            thinking_budget_tokens, supports_images, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
        .bind(hash)
        .bind(input.sort_order)
        .bind(&input.display_name)
        .bind(&input.group_name)
        .bind(input.model_type.as_str())
        .bind(&input.base_url)
        .bind(input.use_full_url)
        .bind(&input.api_key)
        .bind(&input.tooltip_data)
        .bind(&input.model_id)
        .bind(&input.reasoning_effort)
        .bind(&input.openai_endpoint)
        .bind(input.openai_extra_params_enabled)
        .bind(serde_json::to_string(&input.openai_extra_params)?)
        .bind(input.custom_headers_enabled)
        .bind(serde_json::to_string(&input.custom_headers)?)
        .bind(input.anthropic_extra_params_enabled)
        .bind(serde_json::to_string(&input.anthropic_extra_params)?)
        .bind(input.context_window_tokens.map(to_i64).transpose()?)
        .bind(input.max_completion_tokens.map(to_i64).transpose()?)
        .bind(input.anthropic_max_tokens.map(to_i64).transpose()?)
        .bind(&input.anthropic_thinking_effort)
        .bind(input.thinking_budget_tokens.map(to_i64).transpose()?)
        .bind(input.supports_images)
        .bind(now)
        .bind(now)
        .execute(&mut *transaction)
        .await?;
    Ok(())
}

async fn model_fingerprints(connection: &mut SqliteConnection) -> Result<HashMap<String, String>> {
    let query = format!("SELECT {MODEL_COLUMNS} FROM model_configs");
    sqlx::query(&query)
        .fetch_all(connection)
        .await?
        .into_iter()
        .map(|row| {
            let model = model_from_row(row)?;
            Ok((
                model_fingerprint(&ModelConfigInput::from(&model))?,
                model.model_hash,
            ))
        })
        .collect()
}

fn model_from_row(row: sqlx::sqlite::SqliteRow) -> Result<ModelConfig> {
    Ok(ModelConfig {
        gateway_capabilities: None,
        supports_images: row.try_get("supports_images")?,
        model_hash: row.try_get("model_hash")?,
        sort_order: row.try_get("sort_order")?,
        display_name: row.try_get("display_name")?,
        group_name: row.try_get("group_name")?,
        model_type: ModelType::from_str(row.try_get("model_type")?)?,
        base_url: row.try_get("base_url")?,
        use_full_url: row.try_get("use_full_url")?,
        api_key: row.try_get("api_key")?,
        tooltip_data: row.try_get("tooltip_data")?,
        model_id: row.try_get("model_id")?,
        reasoning_effort: row.try_get("reasoning_effort")?,
        openai_endpoint: row.try_get("openai_endpoint")?,
        openai_extra_params_enabled: row.try_get("openai_extra_params_enabled")?,
        openai_extra_params: serde_json::from_str(
            row.try_get::<String, _>("openai_extra_params_json")?
                .as_str(),
        )?,
        custom_headers_enabled: row.try_get("custom_headers_enabled")?,
        custom_headers: serde_json::from_str(
            row.try_get::<String, _>("custom_headers_json")?.as_str(),
        )?,
        anthropic_extra_params_enabled: row.try_get("anthropic_extra_params_enabled")?,
        anthropic_extra_params: serde_json::from_str(
            row.try_get::<String, _>("anthropic_extra_params_json")?
                .as_str(),
        )?,
        context_window_tokens: optional_u64(&row, "context_window_tokens")?,
        max_completion_tokens: optional_u64(&row, "max_completion_tokens")?,
        anthropic_max_tokens: optional_u64(&row, "anthropic_max_tokens")?,
        anthropic_thinking_effort: row.try_get("anthropic_thinking_effort")?,
        thinking_budget_tokens: optional_u64(&row, "thinking_budget_tokens")?,
        created_at_ms: row.try_get("created_at_ms")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

fn optional_u64(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<Option<u64>> {
    row.try_get::<Option<i64>, _>(column)?
        .map(|value| {
            u64::try_from(value).map_err(|_| Error::Config(format!("{column} cannot be negative")))
        })
        .transpose()
}

fn to_i64(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| Error::Config("token value is too large".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_input(group_name: Option<&str>) -> ModelConfigInput {
        ModelConfigInput {
            supports_images: true,
            sort_order: 0,
            display_name: "Test Model".into(),
            group_name: group_name.map(String::from),
            model_type: ModelType::OpenAi,
            base_url: "https://example.com/v1/chat/completions".into(),
            use_full_url: true,
            api_key: "test-key".into(),
            tooltip_data: "Test Model".into(),
            model_id: "test-model".into(),
            reasoning_effort: None,
            openai_endpoint: crate::model::OPENAI_CHAT_ENDPOINT.into(),
            openai_extra_params_enabled: false,
            openai_extra_params: serde_json::json!({}),
            custom_headers_enabled: false,
            custom_headers: serde_json::json!({}),
            anthropic_extra_params_enabled: false,
            anthropic_extra_params: serde_json::json!({}),
            context_window_tokens: None,
            max_completion_tokens: None,
            anthropic_max_tokens: None,
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
        }
    }

    #[tokio::test]
    async fn manual_model_can_be_marked_text_only_without_changing_its_id() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let mut input = serde_json::to_value(model_input(None)).unwrap();
        let original = store
            .create_model(&serde_json::from_value(input.clone()).unwrap())
            .await
            .unwrap();
        input["supports_images"] = false.into();
        let saved = store
            .update_model(
                &original.model_hash,
                &serde_json::from_value(input).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(saved.model_hash, original.model_hash);
        assert_eq!(
            serde_json::to_value(saved).unwrap()["supports_images"],
            false
        );
    }

    #[tokio::test]
    async fn manual_model_edits_keep_the_existing_id_and_import_does_not_duplicate_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            dir.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let original = store.create_model(&model_input(None)).await.unwrap();
        let mut edited = model_input(None);
        edited.display_name = "Renamed".into();
        edited.api_key = "rotated".into();
        let saved = store
            .update_model(&original.model_hash, &edited)
            .await
            .unwrap();
        assert_eq!(saved.model_hash, original.model_hash);
        assert_eq!(
            store
                .model(&original.model_hash)
                .await
                .unwrap()
                .unwrap()
                .api_key,
            "rotated"
        );
        assert_eq!(store.create_models_if_missing(&[edited]).await.unwrap(), 0);
        assert_eq!(store.models().await.unwrap().len(), 1);
    }

    /// 分组名是纯展示字段:入库时去除首尾空白、空串归一为 NULL,
    /// 更新分组名不得改变模型身份哈希。
    #[tokio::test]
    async fn group_name_round_trips_without_changing_model_identity() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();

        let created = store
            .create_model(&model_input(Some("  My Group  ")))
            .await
            .unwrap();
        assert_eq!(created.group_name.as_deref(), Some("My Group"));

        let renamed = store
            .update_model(&created.model_hash, &model_input(Some("Renamed")))
            .await
            .unwrap();
        assert_eq!(renamed.model_hash, created.model_hash);
        assert_eq!(renamed.group_name.as_deref(), Some("Renamed"));

        let cleared = store
            .update_model(&created.model_hash, &model_input(Some("   ")))
            .await
            .unwrap();
        assert_eq!(cleared.model_hash, created.model_hash);
        assert_eq!(cleared.group_name, None);
    }
}
