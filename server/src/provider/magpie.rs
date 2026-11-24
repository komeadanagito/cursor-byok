//! Discovers the local Magpie gateway and follows its chat-model catalog.
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Mutex;

use crate::{
    model::{ModelConfig, ModelType},
    store::Store,
    Error, Result,
};

pub(crate) const PREFIX: &str = "magpie-";
const APP_KEY: &str = "magpie-cursor-byok";
const DEFAULT_PORT: u16 = 3425;

pub(super) fn set_session_affinity(
    headers: &mut reqwest::header::HeaderMap,
    conversation_id: &str,
) -> Result<()> {
    let session = reqwest::header::HeaderValue::from_str(conversation_id)
        .map_err(|error| Error::Config(format!("invalid Magpie conversation header: {error}")))?;
    // Keep routing stable through tool rounds and checkpoint resumes. The run
    // and provider call identifiers change during one conversation.
    for name in ["session_id", "x-client-request-id", "x-session-affinity"] {
        headers.insert(name, session.clone());
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Catalog {
    pub port: u16,
    pub models: Vec<GatewayModel>,
    pub disabled: HashSet<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct GatewayModel {
    id: String,
    magpie_label: Option<String>,
    display_name: Option<String>,
    context_window: Option<u64>,
    max_output_tokens: Option<u64>,
    #[serde(default)]
    reasoning_levels: Vec<String>,
    #[serde(default)]
    reasoning: bool,
    modalities: Option<Modalities>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Modalities {
    #[serde(default)]
    input: Vec<String>,
}

impl Catalog {
    pub(crate) fn configurations(&self) -> impl Iterator<Item = ModelConfig> + '_ {
        self.models
            .iter()
            .filter(|m| !self.disabled.contains(&m.id))
            .map(|m| {
                use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
                ModelConfig {
                    supports_images: m
                        .modalities
                        .as_ref()
                        .is_some_and(|m| m.input.iter().any(|s| s == "image")),
                    model_hash: format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(&m.id)),
                    sort_order: i64::MAX,
                    display_name: m
                        .magpie_label
                        .as_ref()
                        .or(m.display_name.as_ref())
                        .unwrap_or(&m.id)
                        .clone(),
                    group_name: Some("Magpie".into()),
                    model_type: ModelType::Anthropic,
                    base_url: format!("http://127.0.0.1:{}", self.port),
                    use_full_url: false,
                    api_key: APP_KEY.into(),
                    tooltip_data: "Magpie".into(),
                    model_id: m.id.clone(),
                    reasoning_effort: None,
                    openai_endpoint: String::new(),
                    openai_extra_params_enabled: false,
                    openai_extra_params: json!({}),
                    custom_headers_enabled: true,
                    custom_headers: json!({"User-Agent":"cursor-byok"}),
                    anthropic_extra_params_enabled: false,
                    anthropic_extra_params: json!({}),
                    context_window_tokens: m.context_window,
                    max_completion_tokens: None,
                    anthropic_max_tokens: m.max_output_tokens,
                    anthropic_thinking_effort: None,
                    thinking_budget_tokens: None,
                    created_at_ms: 0,
                    updated_at_ms: 0,
                    gateway_capabilities: Some(crate::model::GatewayCapabilities {
                        efforts: m.reasoning_levels.clone(),
                        thinking: m.reasoning || !m.reasoning_levels.is_empty(),
                    }),
                }
            })
    }
}

#[derive(Clone)]
pub(crate) struct Magpie {
    store: Store,
    settings: PathBuf,
    client: reqwest::Client,
    refreshed: Arc<Mutex<Option<Instant>>>,
}

impl Magpie {
    pub(crate) fn managed(store: Store) -> Result<Self> {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|p| p.join(".config")))
            .ok_or_else(|| Error::Config("cannot locate Magpie settings directory".into()))?;
        Self::new(store, config.join("magpie/settings.json"))
    }
    fn new(store: Store, settings: PathBuf) -> Result<Self> {
        Ok(Self {
            store,
            settings,
            client: local_client(Duration::from_secs(4))?,
            refreshed: Default::default(),
        })
    }
    pub(crate) async fn catalog(&self) -> Result<Option<Catalog>> {
        self.store.magpie_catalog().await
    }

    pub(crate) async fn sync(&self, connect: bool) -> Result<()> {
        let requested = Instant::now();
        let mut refreshed = self.refreshed.lock().await;
        let previous = self.catalog().await?;
        if !connect && previous.is_none() || refreshed.is_some_and(|t| t >= requested) {
            return Ok(());
        }
        let port = read_port(&self.settings).await?;
        let base = format!("http://127.0.0.1:{port}");
        verify_gateway(&self.client, &base).await?;
        #[derive(Deserialize)]
        struct List {
            data: Vec<GatewayModel>,
        }
        let models = self
            .client
            .get(format!("{base}/v1/models"))
            .bearer_auth(APP_KEY)
            .send()
            .await?
            .error_for_status()?
            .json::<List>()
            .await?
            .data;
        let mut ids = HashSet::new();
        if models
            .iter()
            .any(|m| m.id.trim().is_empty() || !ids.insert(&m.id))
        {
            return Err(Error::Provider(
                "Magpie catalog contains an empty or duplicate model ID".into(),
            ));
        }
        let catalog = Catalog {
            port,
            models,
            disabled: previous.map(|c| c.disabled).unwrap_or_default(),
        };
        self.store.save_magpie_catalog(Some(&catalog)).await?;
        *refreshed = Some(Instant::now());
        Ok(())
    }

    pub(crate) async fn select(&self, ids: Vec<String>) -> Result<()> {
        let _guard = self.refreshed.lock().await;
        let mut catalog = self
            .catalog()
            .await?
            .ok_or_else(|| Error::Config("Magpie is not connected".into()))?;
        let enabled: HashSet<_> = ids.into_iter().collect();
        for model in &catalog.models {
            if enabled.contains(&model.id) {
                catalog.disabled.remove(&model.id);
            } else {
                catalog.disabled.insert(model.id.clone());
            }
        }
        self.store.save_magpie_catalog(Some(&catalog)).await
    }

    pub(crate) async fn disconnect(&self) -> Result<()> {
        let mut refreshed = self.refreshed.lock().await;
        self.store.save_magpie_catalog(None).await?;
        *refreshed = None;
        Ok(())
    }

    pub(crate) async fn follow(&self) {
        loop {
            if let Err(error) = self.sync(false).await {
                tracing::warn!(%error,"Magpie catalog refresh failed");
            }
            tokio::time::sleep(Duration::from_secs(600)).await;
        }
    }
}

async fn read_port(path: &Path) -> Result<u16> {
    #[derive(Deserialize)]
    struct Settings {
        port: Option<std::num::NonZeroU16>,
    }
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(serde_json::from_slice::<Settings>(&bytes)?
            .port
            .map_or(DEFAULT_PORT, |p| p.get())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(DEFAULT_PORT),
        Err(err) => Err(err.into()),
    }
}

pub(crate) fn local_client(timeout: Duration) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .user_agent("cursor-byok")
        .build()?)
}

pub(crate) async fn verify_gateway(client: &reqwest::Client, base: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Hello {
        name: String,
    }
    let hello = client
        .get(format!("{base}/api/hello"))
        .timeout(Duration::from_secs(4))
        .send()
        .await?
        .error_for_status()?
        .json::<Hello>()
        .await?;
    if hello.name != "magpie" {
        return Err(Error::Provider(format!("{base} is not a Magpie gateway")));
    }
    Ok(())
}

#[cfg(test)]
#[path = "magpie_tests.rs"]
mod tests;
