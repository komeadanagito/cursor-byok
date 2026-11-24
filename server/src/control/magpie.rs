//! Manages the independent Magpie channel without editing manual providers.
use super::ControlService;
use crate::{provider::magpie::Catalog, Result};
use axum::{extract::State, http::StatusCode, Json};

pub(super) async fn status(State(service): State<ControlService>) -> Result<Json<Option<Catalog>>> {
    Ok(Json(service.magpie.catalog().await?))
}
pub(super) async fn connect(State(service): State<ControlService>) -> Result<StatusCode> {
    service.magpie.sync(true).await?;
    Ok(StatusCode::NO_CONTENT)
}
pub(super) async fn disconnect(State(service): State<ControlService>) -> Result<StatusCode> {
    service.magpie.disconnect().await?;
    Ok(StatusCode::NO_CONTENT)
}
pub(super) async fn select(
    State(service): State<ControlService>,
    Json(ids): Json<Vec<String>>,
) -> Result<StatusCode> {
    service.magpie.select(ids).await?;
    Ok(StatusCode::NO_CONTENT)
}
