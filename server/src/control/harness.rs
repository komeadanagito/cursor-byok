//! Implements local application control endpoints.
use axum::{extract::State, Json};

use crate::{
    local_app::{CursorHarnessStatus, SetEnabled},
    Result,
};

use super::ControlService;

pub async fn status(State(service): State<ControlService>) -> Result<Json<CursorHarnessStatus>> {
    Ok(Json(service.cursor_harness().status().await?))
}

pub async fn initialize_ca(
    State(service): State<ControlService>,
) -> Result<Json<CursorHarnessStatus>> {
    Ok(Json(service.cursor_harness().initialize_ca().await?))
}

pub async fn set_enabled(
    State(service): State<ControlService>,
    Json(input): Json<SetEnabled>,
) -> Result<Json<CursorHarnessStatus>> {
    Ok(Json(
        service.cursor_harness().set_enabled(input.enabled).await?,
    ))
}

pub async fn workspace_extension_status(
    State(service): State<ControlService>,
) -> Result<Json<crate::local_app::WorkspaceExtensionStatus>> {
    Ok(Json(
        service
            .cursor_harness()
            .workspace_extension_status()
            .await?,
    ))
}

pub async fn install_workspace_extension(
    State(service): State<ControlService>,
) -> Result<Json<crate::local_app::WorkspaceExtensionStatus>> {
    Ok(Json(
        service
            .cursor_harness()
            .install_workspace_extension()
            .await?,
    ))
}

#[derive(serde::Serialize)]
pub struct SavedVsix {
    saved_to: String,
}

pub async fn save_workspace_extension_vsix(
    State(service): State<ControlService>,
) -> Result<Json<SavedVsix>> {
    let path = service
        .cursor_harness()
        .save_workspace_extension_vsix()
        .await?;
    Ok(Json(SavedVsix {
        saved_to: path.to_string_lossy().into_owned(),
    }))
}
