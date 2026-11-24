//! Prices provider_llm calls per (provider_url, model_id) and lists priced targets.

use sqlx::Row;
use url::Url;

use crate::{
    model::{ModelPrice, ModelPriceEntry},
    Error, Result,
};

use super::{now_ms, Store};

impl Store {
    /// Every (provider_url, model_id) seen in llm_calls, newest call first.
    pub async fn model_price_entries(&self) -> Result<Vec<ModelPriceEntry>> {
        let rows = sqlx::query(
            "SELECT
                c.provider_url,
                c.model_id,
                c.last_call_ms,
                c.magpie,
                COALESCE(m.group_name, '') AS group_name,
                p.input_per_million,
                p.output_per_million,
                p.cache_read_per_million,
                p.cache_write_per_million,
                p.currency,
                p.updated_at_ms
             FROM (
                SELECT provider_url, model_id,
                       MAX(created_at_ms) AS last_call_ms,
                       MAX(model_hash LIKE 'magpie-%') AS magpie
                 FROM llm_calls
                 GROUP BY provider_url, model_id
             ) c
             LEFT JOIN model_configs m
                ON m.model_hash IN (SELECT model_hash FROM llm_calls
                                    WHERE provider_url = c.provider_url
                                      AND model_id = c.model_id
                                      AND model_hash IS NOT NULL
                                    ORDER BY created_at_ms DESC
                                    LIMIT 1)
             LEFT JOIN model_prices p
                ON p.provider_url = c.provider_url AND p.model_id = c.model_id
             ORDER BY c.last_call_ms DESC",
        )
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                let provider_url: String = row.try_get("provider_url")?;
                let model_id: String = row.try_get("model_id")?;
                let group_name: String = row.try_get("group_name")?;
                let magpie: bool = row.try_get::<i64, _>("magpie")? != 0;
                let currency: Option<String> = row.try_get("currency")?;
                let price = currency.map(|currency| ModelPrice {
                    input_per_million: row.try_get("input_per_million").unwrap_or(0.0),
                    output_per_million: row.try_get("output_per_million").unwrap_or(0.0),
                    cache_read_per_million: row.try_get("cache_read_per_million").unwrap_or(None),
                    cache_write_per_million: row.try_get("cache_write_per_million").unwrap_or(None),
                    currency,
                    updated_at_ms: row.try_get("updated_at_ms").unwrap_or(0),
                });
                Ok(ModelPriceEntry {
                    channel_name: channel_name(&group_name, magpie, &provider_url),
                    provider_url,
                    model_id,
                    last_call_ms: row.try_get("last_call_ms")?,
                    price,
                })
            })
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn set_model_price(
        &self,
        provider_url: &str,
        model_id: &str,
        input_per_million: f64,
        output_per_million: f64,
        cache_read_per_million: Option<f64>,
        cache_write_per_million: Option<f64>,
        currency: &str,
    ) -> Result<ModelPrice> {
        check_price("input_per_million", input_per_million)?;
        check_price("output_per_million", output_per_million)?;
        if let Some(price) = cache_read_per_million {
            check_price("cache_read_per_million", price)?;
        }
        if let Some(price) = cache_write_per_million {
            check_price("cache_write_per_million", price)?;
        }
        if !matches!(currency, "USD" | "CNY") {
            return Err(Error::Config(format!(
                "currency must be USD or CNY, got {currency}"
            )));
        }
        let updated_at_ms = now_ms();
        sqlx::query(
            "INSERT INTO model_prices(
                provider_url, model_id, input_per_million, output_per_million,
                cache_read_per_million, cache_write_per_million, currency, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(provider_url, model_id) DO UPDATE SET
                input_per_million = excluded.input_per_million,
                output_per_million = excluded.output_per_million,
                cache_read_per_million = excluded.cache_read_per_million,
                cache_write_per_million = excluded.cache_write_per_million,
                currency = excluded.currency,
                updated_at_ms = excluded.updated_at_ms",
        )
        .bind(provider_url)
        .bind(model_id)
        .bind(input_per_million)
        .bind(output_per_million)
        .bind(cache_read_per_million)
        .bind(cache_write_per_million)
        .bind(currency)
        .bind(updated_at_ms)
        .execute(&self.pool)
        .await?;
        Ok(ModelPrice {
            input_per_million,
            output_per_million,
            cache_read_per_million,
            cache_write_per_million,
            currency: currency.into(),
            updated_at_ms,
        })
    }

    pub async fn clear_model_price(&self, provider_url: &str, model_id: &str) -> Result<()> {
        sqlx::query("DELETE FROM model_prices WHERE provider_url = ? AND model_id = ?")
            .bind(provider_url)
            .bind(model_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

fn check_price(field: &str, value: f64) -> Result<()> {
    if !value.is_finite() || value < 0.0 {
        return Err(Error::Config(format!(
            "{field} must be a non-negative number"
        )));
    }
    Ok(())
}

/// Channel label for a priced model: configured group name, then Magpie for
/// local gateway models, then the provider hostname.
fn channel_name(group_name: &str, magpie: bool, provider_url: &str) -> String {
    if !group_name.is_empty() {
        return group_name.into();
    }
    if magpie {
        return "Magpie".into();
    }
    Url::parse(provider_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .or_else(|| {
            provider_url
                .split("://")
                .nth(1)
                .or(Some(provider_url))
                .map(|rest| rest.split('/').next().unwrap_or(provider_url).to_owned())
        })
        .unwrap_or_else(|| provider_url.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{NewLlmCall, ProviderType};

    async fn store() -> Store {
        let directory = tempfile::tempdir().unwrap();
        Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap()
    }

    async fn record_call(store: &Store, call_id: &str, provider_url: &str, model_id: &str) {
        store
            .start_llm_call(&NewLlmCall {
                call_id: call_id.into(),
                run_id: "run".into(),
                conversation_id: "conversation".into(),
                provider_call_index: 0,
                model_hash: format!("hash-{call_id}"),
                provider_type: ProviderType::OpenAiChat,
                provider_url: provider_url.into(),
                request_type: ProviderType::OpenAiChat,
                request_url: provider_url.into(),
                model_id: model_id.into(),
                display_name: model_id.into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn price_entries_list_unpriced_models_newest_first() {
        let store = store().await;
        record_call(
            &store,
            "a",
            "https://api.openai.com/v1/chat/completions",
            "gpt-5",
        )
        .await;
        record_call(
            &store,
            "b",
            "https://api.deepseek.com/v1/chat/completions",
            "deepseek-chat",
        )
        .await;

        let entries = store.model_price_entries().await.unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].last_call_ms >= entries[1].last_call_ms);
        assert!(entries.iter().all(|entry| entry.price.is_none()));
        let openai = entries
            .iter()
            .find(|entry| entry.model_id == "gpt-5")
            .unwrap();
        assert_eq!(openai.channel_name, "api.openai.com");
    }

    #[tokio::test]
    async fn price_upsert_and_clear_round_trips() {
        let store = store().await;
        record_call(
            &store,
            "a",
            "https://api.openai.com/v1/chat/completions",
            "gpt-5",
        )
        .await;

        let saved = store
            .set_model_price(
                "https://api.openai.com/v1/chat/completions",
                "gpt-5",
                2.0,
                8.0,
                None,
                Some(3.0),
                "CNY",
            )
            .await
            .unwrap();
        assert_eq!(saved.currency, "CNY");
        assert_eq!(saved.cache_read_per_million, None);

        let entries = store.model_price_entries().await.unwrap();
        let price = entries[0].price.as_ref().unwrap();
        assert_eq!(price.input_per_million, 2.0);
        assert_eq!(price.cache_write_per_million, Some(3.0));

        store
            .set_model_price(
                "https://api.openai.com/v1/chat/completions",
                "gpt-5",
                1.0,
                4.0,
                Some(0.5),
                None,
                "USD",
            )
            .await
            .unwrap();
        let entries = store.model_price_entries().await.unwrap();
        assert_eq!(entries[0].price.as_ref().unwrap().currency, "USD");
        assert_eq!(
            entries[0].price.as_ref().unwrap().cache_read_per_million,
            Some(0.5)
        );

        store
            .clear_model_price("https://api.openai.com/v1/chat/completions", "gpt-5")
            .await
            .unwrap();
        assert!(store.model_price_entries().await.unwrap()[0]
            .price
            .is_none());
    }

    #[tokio::test]
    async fn price_validation_names_the_field_and_constraint() {
        let store = store().await;
        let error = store
            .set_model_price("https://a", "m", -1.0, 1.0, None, None, "USD")
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "configuration error: input_per_million must be a non-negative number"
        );
        let error = store
            .set_model_price("https://a", "m", 1.0, 1.0, Some(f64::NAN), None, "USD")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("cache_read_per_million"));
        let error = store
            .set_model_price("https://a", "m", 1.0, 1.0, None, None, "EUR")
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "configuration error: currency must be USD or CNY, got EUR"
        );
    }

    #[tokio::test]
    async fn channel_name_prefers_group_name_then_magpie_then_host() {
        let store = store().await;
        // A Magpie-routed model keeps model_hash like "magpie-<base64>" and no group_name.
        store
            .start_llm_call(&NewLlmCall {
                call_id: "m".into(),
                run_id: "run".into(),
                conversation_id: "conversation".into(),
                provider_call_index: 0,
                model_hash: "magpie-AAAA".into(),
                provider_type: ProviderType::OpenAiChat,
                provider_url: "http://127.0.0.1:8642/v1/chat/completions".into(),
                request_type: ProviderType::OpenAiChat,
                request_url: "http://127.0.0.1:8642/v1/chat/completions".into(),
                model_id: "gpt-test".into(),
                display_name: "gpt-test".into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
            })
            .await
            .unwrap();
        let entries = store.model_price_entries().await.unwrap();
        assert_eq!(entries[0].channel_name, "Magpie");

        // Plugin-style URLs without an http host fall back to the host segment.
        record_call(&store, "p", "plugin://dev.example/codex", "gpt-x").await;
        let entries = store.model_price_entries().await.unwrap();
        let plugin = entries
            .iter()
            .find(|entry| entry.model_id == "gpt-x")
            .unwrap();
        assert_eq!(plugin.channel_name, "dev.example");
    }
}
