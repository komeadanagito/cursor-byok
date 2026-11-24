//! Aggregates llm_calls (and model_prices for cost) into the desktop overview totals and time series.

use std::collections::BTreeMap;

use chrono::Utc;
use sqlx::{query::Query, sqlite::SqliteArguments, Row, Sqlite};

use crate::{
    model::{CurrencyCost, Overview, OverviewBucket, OverviewGranularity, OverviewMetrics},
    Result,
};

use super::Store;

const OVERVIEW_DAYS: u64 = 365;
const MAX_RANGE_BUCKETS: i64 = 60;
const MAX_EXPLICIT_BUCKETS: i64 = 1440;
const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;

/// Time range and model set shared by every overview query; see `bind_filter`.
const FILTER_SQL: &str = "(? IS NULL OR c.created_at_ms >= ?)
    AND (? IS NULL OR c.created_at_ms < ?)
    AND (? IS NULL OR c.model_hash IN (SELECT value FROM json_each(?)))";

/// Matches the calls page `outputSpeed`: tokens over the time after the first
/// text, so a slow first token does not count against generation speed.
const SPEED_SQL: &str = "CASE WHEN c.output_tokens IS NOT NULL AND c.duration_ms > c.ttft_ms
    THEN c.output_tokens * 1000.0 / (c.duration_ms - c.ttft_ms) END";

/// Non-cached input: Anthropic reports it directly, other protocols include
/// cache traffic inside `input_tokens`.
const FRESH_INPUT_SQL: &str = "CASE
    WHEN c.request_type = 'anthropic' THEN MAX(0, COALESCE(c.input_tokens, 0))
    ELSE MAX(0, COALESCE(c.input_tokens, 0)
        - COALESCE(c.cache_read_tokens, 0)
        - COALESCE(c.cache_write_tokens, 0))
 END";

fn cost_sql() -> String {
    format!(
        "(({FRESH_INPUT_SQL}) * p.input_per_million
          + COALESCE(c.cache_read_tokens, 0) * COALESCE(p.cache_read_per_million, p.input_per_million)
          + COALESCE(c.cache_write_tokens, 0) * COALESCE(p.cache_write_per_million, p.input_per_million)
          + COALESCE(c.output_tokens, 0) * p.output_per_million) / 1000000.0"
    )
}

fn bind_filter<'q>(
    query: Query<'q, Sqlite, SqliteArguments<'q>>,
    from_ms: Option<i64>,
    end_ms: Option<i64>,
    model_hashes: Option<&'q str>,
) -> Query<'q, Sqlite, SqliteArguments<'q>> {
    query
        .bind(from_ms)
        .bind(from_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(model_hashes)
        .bind(model_hashes)
}

impl Store {
    pub async fn overview(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        model_hashes: Option<&str>,
        bucket_ms: Option<i64>,
    ) -> Result<Overview> {
        let call_sql = format!(
            "SELECT
                COUNT(*) AS llm_calls,
                COALESCE(SUM(c.status = 'completed'), 0) AS successful_calls,
                COALESCE(SUM(c.status != 'completed'), 0) AS failed_calls,
                AVG(c.ttft_ms) AS avg_ttft_ms,
                AVG({SPEED_SQL}) AS output_tokens_per_second
             FROM llm_calls c
             WHERE c.status != 'running' AND {FILTER_SQL}"
        );
        let call_row = bind_filter(sqlx::query(&call_sql), start_ms, end_ms, model_hashes)
            .fetch_one(&self.pool)
            .await?;
        let token_sql = format!(
            "SELECT
                COALESCE(SUM({FRESH_INPUT_SQL}), 0) AS input_tokens,
                COALESCE(SUM(COALESCE(c.cache_read_tokens, 0)), 0) AS cache_read_tokens,
                COALESCE(SUM(COALESCE(c.cache_write_tokens, 0)), 0) AS cache_write_tokens,
                COALESCE(SUM(COALESCE(c.output_tokens, 0)), 0) AS output_tokens
             FROM llm_calls c
             WHERE {FILTER_SQL}"
        );
        let token_row = bind_filter(sqlx::query(&token_sql), start_ms, end_ms, model_hashes)
            .fetch_one(&self.pool)
            .await?;

        let input_tokens = non_negative(token_row.try_get("input_tokens")?);
        let cache_read_tokens = non_negative(token_row.try_get("cache_read_tokens")?);
        let cache_write_tokens = non_negative(token_row.try_get("cache_write_tokens")?);
        let output_tokens = non_negative(token_row.try_get("output_tokens")?);
        let prompt_tokens = saturating_sum(&[input_tokens, cache_read_tokens, cache_write_tokens]);

        let totals_cost_sql = format!(
            "SELECT p.currency AS currency, COALESCE(SUM({cost}), 0) AS amount
             FROM llm_calls c
             JOIN model_prices p ON p.provider_url = c.provider_url AND p.model_id = c.model_id
             WHERE {FILTER_SQL}
             GROUP BY p.currency
             ORDER BY p.currency",
            cost = cost_sql(),
        );
        let costs = bind_filter(
            sqlx::query(&totals_cost_sql),
            start_ms,
            end_ms,
            model_hashes,
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| {
            Ok(CurrencyCost {
                currency: row.try_get("currency")?,
                amount: row.try_get("amount")?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
        let unpriced_sql = format!(
            "SELECT COUNT(*) AS unpriced FROM llm_calls c
             WHERE NOT EXISTS (
                SELECT 1 FROM model_prices p
                WHERE p.provider_url = c.provider_url AND p.model_id = c.model_id)
               AND {FILTER_SQL}"
        );
        let unpriced_calls: i64 =
            bind_filter(sqlx::query(&unpriced_sql), start_ms, end_ms, model_hashes)
                .fetch_one(&self.pool)
                .await?
                .try_get("unpriced")?;

        let metrics = OverviewMetrics {
            llm_calls: call_row.try_get("llm_calls")?,
            successful_calls: call_row.try_get("successful_calls")?,
            failed_calls: call_row.try_get("failed_calls")?,
            token_usage: prompt_tokens.saturating_add(output_tokens),
            prompt_tokens,
            input_tokens,
            cache_read_tokens,
            cache_write_tokens,
            output_tokens,
            costs,
            unpriced_calls,
            avg_ttft_ms: call_row.try_get("avg_ttft_ms")?,
            output_tokens_per_second: call_row.try_get("output_tokens_per_second")?,
        };

        let (granularity, bucket_ms, series_start_ms, bucket_count) =
            overview_buckets(start_ms, end_ms, bucket_ms);
        let series_from_ms = Some(start_ms.unwrap_or(series_start_ms).max(series_start_ms));
        // Token totals keep in-flight calls (their usage is already spent); call
        // counts and timings only cover finished calls, like the totals above.
        let series_sql = format!(
            "SELECT
                (c.created_at_ms / {bucket_ms}) * {bucket_ms} AS bucket_start_ms,
                COALESCE(SUM({FRESH_INPUT_SQL}), 0) AS input_tokens,
                COALESCE(SUM(COALESCE(c.cache_read_tokens, 0)), 0) AS cache_read_tokens,
                COALESCE(SUM(COALESCE(c.cache_write_tokens, 0)), 0) AS cache_write_tokens,
                COALESCE(SUM(COALESCE(c.output_tokens, 0)), 0) AS output_tokens,
                COALESCE(SUM(c.status != 'running'), 0) AS calls,
                COALESCE(SUM(c.status NOT IN ('running', 'completed')), 0) AS failed_calls,
                AVG(CASE WHEN c.status != 'running' THEN c.ttft_ms END) AS avg_ttft_ms,
                AVG(CASE WHEN c.status != 'running' THEN {SPEED_SQL} END) AS output_tokens_per_second
             FROM llm_calls c
             WHERE {FILTER_SQL}
             GROUP BY bucket_start_ms"
        );
        let mut recorded = bind_filter(
            sqlx::query(&series_sql),
            series_from_ms,
            end_ms,
            model_hashes,
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| {
            let bucket_start_ms: i64 = row.try_get("bucket_start_ms")?;
            Ok((
                bucket_start_ms,
                OverviewBucket {
                    bucket_start_ms,
                    input_tokens: non_negative(row.try_get("input_tokens")?),
                    cache_read_tokens: non_negative(row.try_get("cache_read_tokens")?),
                    cache_write_tokens: non_negative(row.try_get("cache_write_tokens")?),
                    output_tokens: non_negative(row.try_get("output_tokens")?),
                    calls: row.try_get("calls")?,
                    failed_calls: row.try_get("failed_calls")?,
                    avg_ttft_ms: row.try_get("avg_ttft_ms")?,
                    output_tokens_per_second: row.try_get("output_tokens_per_second")?,
                    costs: Vec::new(),
                },
            ))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;
        let series_cost_sql = format!(
            "SELECT
                (c.created_at_ms / {bucket_ms}) * {bucket_ms} AS bucket_start_ms,
                p.currency AS currency,
                SUM({cost}) AS amount
             FROM llm_calls c
             JOIN model_prices p ON p.provider_url = c.provider_url AND p.model_id = c.model_id
             WHERE {FILTER_SQL}
             GROUP BY bucket_start_ms, p.currency
             ORDER BY p.currency",
            cost = cost_sql(),
        );
        for row in bind_filter(
            sqlx::query(&series_cost_sql),
            series_from_ms,
            end_ms,
            model_hashes,
        )
        .fetch_all(&self.pool)
        .await?
        {
            let bucket_start_ms: i64 = row.try_get("bucket_start_ms")?;
            // A priced call always lands in a bucket the series query also saw.
            if let Some(bucket) = recorded.get_mut(&bucket_start_ms) {
                bucket.costs.push(CurrencyCost {
                    currency: row.try_get("currency")?,
                    amount: row.try_get("amount")?,
                });
            }
        }
        let series = (0..bucket_count)
            .map(|offset| series_start_ms.saturating_add(offset.saturating_mul(bucket_ms)))
            .map(|bucket_start_ms| {
                recorded.remove(&bucket_start_ms).unwrap_or(OverviewBucket {
                    bucket_start_ms,
                    ..OverviewBucket::default()
                })
            })
            .collect();

        Ok(Overview {
            metrics,
            granularity,
            series,
        })
    }
}

fn overview_buckets(
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    requested_bucket_ms: Option<i64>,
) -> (OverviewGranularity, i64, i64, i64) {
    if let (Some(start_ms), Some(end_ms)) = (start_ms, end_ms) {
        let duration_ms = end_ms.saturating_sub(start_ms).max(1);
        let explicit_bucket_ms = requested_bucket_ms.filter(|bucket_ms| *bucket_ms >= MINUTE_MS);
        let bucket_ms = explicit_bucket_ms.unwrap_or({
            if duration_ms <= HOUR_MS {
                MINUTE_MS
            } else if duration_ms <= MAX_RANGE_BUCKETS * HOUR_MS {
                HOUR_MS
            } else {
                DAY_MS
            }
        });
        let granularity = if bucket_ms < HOUR_MS {
            OverviewGranularity::Minute
        } else if bucket_ms < DAY_MS {
            OverviewGranularity::Hour
        } else {
            OverviewGranularity::Day
        };
        let max_buckets = if explicit_bucket_ms.is_some() {
            MAX_EXPLICIT_BUCKETS
        } else {
            MAX_RANGE_BUCKETS
        };
        let last_bucket_ms = end_ms.saturating_sub(1).div_euclid(bucket_ms) * bucket_ms;
        let first_bucket_ms = start_ms.div_euclid(bucket_ms) * bucket_ms;
        let bucket_count =
            ((last_bucket_ms - first_bucket_ms).div_euclid(bucket_ms) + 1).clamp(1, max_buckets);
        let series_start_ms =
            last_bucket_ms.saturating_sub((bucket_count - 1).saturating_mul(bucket_ms));
        return (granularity, bucket_ms, series_start_ms, bucket_count);
    }

    let today_start_ms = Utc::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .map(|value| value.and_utc().timestamp_millis())
        .unwrap_or(0);
    let series_start_ms = today_start_ms.saturating_sub(
        i64::try_from(OVERVIEW_DAYS - 1)
            .unwrap_or(0)
            .saturating_mul(DAY_MS),
    );
    (
        OverviewGranularity::Day,
        DAY_MS,
        series_start_ms,
        i64::try_from(OVERVIEW_DAYS).unwrap_or(0),
    )
}

fn non_negative(value: i64) -> i64 {
    value.max(0)
}

fn saturating_sum(values: &[i64]) -> i64 {
    values
        .iter()
        .fold(0_i64, |total, value| total.saturating_add(*value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{NewLlmCall, ProviderType, Usage};

    async fn store() -> Store {
        let directory = tempfile::tempdir().unwrap();
        Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap()
    }

    async fn record_call(
        store: &Store,
        call_id: &str,
        request_type: ProviderType,
        provider_url: &str,
        model_id: &str,
        usage: Usage,
    ) {
        store
            .start_llm_call(&NewLlmCall {
                call_id: call_id.into(),
                run_id: "run".into(),
                conversation_id: "conversation".into(),
                provider_call_index: 0,
                model_hash: format!("hash-{call_id}"),
                provider_type: request_type,
                provider_url: provider_url.into(),
                request_type,
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
        store.record_llm_usage(call_id, usage).await.unwrap();
    }

    fn cost(overview: &Overview, currency: &str) -> Option<f64> {
        overview
            .metrics
            .costs
            .iter()
            .find(|cost| cost.currency == currency)
            .map(|cost| cost.amount)
    }

    #[tokio::test]
    async fn overview_cost_sums_per_currency_and_counts_unpriced_calls() {
        let store = store().await;
        record_call(
            &store,
            "usd",
            ProviderType::OpenAiChat,
            "https://api.openai.com/v1/chat/completions",
            "gpt-5",
            Usage {
                // OpenAI shape: input_tokens already contains cache traffic.
                input_tokens: Some(1_000_000),
                output_tokens: Some(500_000),
                cache_read_tokens: Some(600_000),
                cache_write_tokens: Some(100_000),
                ..Usage::default()
            },
        )
        .await;
        record_call(
            &store,
            "cny",
            ProviderType::Anthropic,
            "https://api.anthropic.com/v1/messages",
            "claude",
            Usage {
                // Anthropic shape: input_tokens excludes cache traffic.
                input_tokens: Some(200_000),
                output_tokens: Some(50_000),
                cache_read_tokens: Some(800_000),
                cache_write_tokens: None,
                ..Usage::default()
            },
        )
        .await;
        record_call(
            &store,
            "free",
            ProviderType::OpenAiChat,
            "https://api.deepseek.com/v1/chat/completions",
            "deepseek-chat",
            Usage::default(),
        )
        .await;

        store
            .set_model_price(
                "https://api.openai.com/v1/chat/completions",
                "gpt-5",
                2.0,
                10.0,
                Some(1.0),
                None,
                "USD",
            )
            .await
            .unwrap();
        // Cache prices left NULL bill the same as fresh input.
        store
            .set_model_price(
                "https://api.anthropic.com/v1/messages",
                "claude",
                3.0,
                15.0,
                None,
                None,
                "CNY",
            )
            .await
            .unwrap();

        let overview = store.overview(None, None, None, None).await.unwrap();

        // fresh input = 1M - 0.6M - 0.1M = 0.3M @2 + 0.6M @1 + 0.1M @2 + 0.5M @10
        let usd = cost(&overview, "USD").unwrap();
        assert!((usd - 6.4).abs() < 1e-9, "usd cost {usd}");
        // fresh input = 0.2M @3 + 0.8M @3 (NULL cache = input rate) + 0.05M @15
        let cny = cost(&overview, "CNY").unwrap();
        assert!((cny - 3.75).abs() < 1e-9, "cny cost {cny}");
        assert_eq!(overview.metrics.unpriced_calls, 1);
    }

    async fn finish_at(
        store: &Store,
        call_id: &str,
        created_at_ms: i64,
        status: &str,
        ttft_ms: Option<i64>,
        duration_ms: i64,
    ) {
        if let Some(ttft_ms) = ttft_ms {
            store.record_llm_first_text(call_id, ttft_ms).await.unwrap();
        }
        store
            .finish_llm_call(call_id, status, None, duration_ms, None, None)
            .await
            .unwrap();
        sqlx::query("UPDATE llm_calls SET created_at_ms = ? WHERE call_id = ?")
            .bind(created_at_ms)
            .bind(call_id)
            .execute(&store.pool)
            .await
            .unwrap();
    }

    fn output_usage(input: u64, output: u64) -> Usage {
        Usage {
            input_tokens: Some(input),
            output_tokens: Some(output),
            ..Usage::default()
        }
    }

    #[tokio::test]
    async fn each_bucket_reports_calls_failures_latency_speed_and_cost() {
        let store = store().await;
        let url = "https://api.openai.com/v1/chat/completions";
        // Aligned to an hour so the two buckets below are exact.
        let start = 472_222 * HOUR_MS;
        for call_id in ["fast", "slow", "broken", "later"] {
            record_call(
                &store,
                call_id,
                ProviderType::OpenAiChat,
                url,
                if call_id == "fast" { "priced" } else { "free" },
                output_usage(1_000_000, if call_id == "later" { 50 } else { 1_000 }),
            )
            .await;
        }
        // 1000 tokens over 1000 ms after the first text = 1000 tok/s.
        finish_at(&store, "fast", start + 1, "completed", Some(200), 1_200).await;
        // 1000 tokens over 2000 ms = 500 tok/s.
        finish_at(&store, "slow", start + 2, "completed", Some(400), 2_400).await;
        finish_at(&store, "broken", start + 3, "failed", None, 50).await;
        // 50 tokens over 500 ms = 100 tok/s, in the next hour.
        finish_at(
            &store,
            "later",
            start + HOUR_MS,
            "completed",
            Some(100),
            600,
        )
        .await;
        store
            .set_model_price(url, "priced", 2.0, 10.0, None, None, "USD")
            .await
            .unwrap();

        let overview = store
            .overview(Some(start), Some(start + 2 * HOUR_MS), None, Some(HOUR_MS))
            .await
            .unwrap();

        let [first, second] = overview.series.as_slice() else {
            panic!("expected two buckets, got {:?}", overview.series);
        };
        assert_eq!((first.calls, first.failed_calls), (3, 1));
        assert_eq!(first.avg_ttft_ms, Some(300.0));
        assert_eq!(first.output_tokens_per_second, Some(750.0));
        // 1M fresh input @2 + 1000 output @10 per million.
        assert_eq!(first.costs.len(), 1);
        assert_eq!(first.costs[0].currency, "USD");
        assert!((first.costs[0].amount - 2.01).abs() < 1e-9);
        assert_eq!((second.calls, second.failed_calls), (1, 0));
        assert_eq!(second.avg_ttft_ms, Some(100.0));
        assert_eq!(second.output_tokens_per_second, Some(100.0));
        assert!(second.costs.is_empty());

        let metrics = &overview.metrics;
        assert!((metrics.avg_ttft_ms.unwrap() - 700.0 / 3.0).abs() < 1e-9);
        assert!((metrics.output_tokens_per_second.unwrap() - 1_600.0 / 3.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn latency_and_speed_are_absent_without_timed_calls() {
        let store = store().await;
        record_call(
            &store,
            "running",
            ProviderType::OpenAiChat,
            "https://api.openai.com/v1/chat/completions",
            "gpt-5",
            output_usage(10, 10),
        )
        .await;
        let overview = store.overview(None, None, None, None).await.unwrap();
        assert_eq!(overview.metrics.avg_ttft_ms, None);
        assert_eq!(overview.metrics.output_tokens_per_second, None);
        assert!(overview.series.iter().all(|bucket| bucket.calls == 0));
    }

    #[tokio::test]
    async fn overview_cost_is_empty_without_prices() {
        let store = store().await;
        record_call(
            &store,
            "a",
            ProviderType::OpenAiChat,
            "https://api.openai.com/v1/chat/completions",
            "gpt-5",
            Usage::default(),
        )
        .await;
        let overview = store.overview(None, None, None, None).await.unwrap();
        assert!(overview.metrics.costs.is_empty());
        assert_eq!(overview.metrics.unpriced_calls, 1);
    }
}
