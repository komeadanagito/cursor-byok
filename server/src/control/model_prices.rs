//! Implements model-pricing endpoints keyed by (provider_url, model_id).
use axum::{extract::State, Json};
use serde::Deserialize;

use crate::{
    model::{ModelPrice, ModelPriceEntry},
    Result,
};

use super::ControlService;

pub async fn list(State(service): State<ControlService>) -> Result<Json<Vec<ModelPriceEntry>>> {
    Ok(Json(service.model_price_entries().await?))
}

/// URL keys contain slashes, so they travel in the body, not the path.
#[derive(Deserialize)]
pub struct ModelPriceInput {
    provider_url: String,
    model_id: String,
    input_per_million: f64,
    output_per_million: f64,
    #[serde(default)]
    cache_read_per_million: Option<f64>,
    #[serde(default)]
    cache_write_per_million: Option<f64>,
    #[serde(default = "default_currency")]
    currency: String,
}

pub async fn upsert(
    State(service): State<ControlService>,
    Json(input): Json<ModelPriceInput>,
) -> Result<Json<ModelPrice>> {
    Ok(Json(
        service
            .set_model_price(
                &input.provider_url,
                &input.model_id,
                input.input_per_million,
                input.output_per_million,
                input.cache_read_per_million,
                input.cache_write_per_million,
                &input.currency,
            )
            .await?,
    ))
}

#[derive(Deserialize)]
pub struct ModelPriceKey {
    provider_url: String,
    model_id: String,
}

pub async fn clear(
    State(service): State<ControlService>,
    Json(key): Json<ModelPriceKey>,
) -> Result<()> {
    service
        .clear_model_price(&key.provider_url, &key.model_id)
        .await
}

fn default_currency() -> String {
    "USD".into()
}
