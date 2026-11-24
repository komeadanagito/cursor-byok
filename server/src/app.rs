//! Assembles server dependencies and starts the application services.
use std::{future::IntoFuture, net::SocketAddr, time::Duration};

use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::{
    api,
    config::{Config, ConsoleSource},
    control,
    cursor::{
        prompting::{PromptAssets, PromptCompiler},
        transport::TransportRegistry,
    },
    local_app::CursorHarness,
    plugin::{PluginRegistry, PluginRuntime},
    provider::ProviderRouter,
    search::WebCache,
    store::Store,
    Result,
};

pub struct App {
    config: Config,
    router: axum::Router,
    inference: axum::Router,
    registry: TransportRegistry,
    harness: CursorHarness,
    magpie: crate::provider::magpie::Magpie,
    store: Store,
}

pub struct AppListeners {
    local: TcpListener,
    inference: TcpListener,
}

impl AppListeners {
    pub fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.local.local_addr()
    }
}

impl App {
    pub async fn new(mut config: Config) -> Result<Self> {
        if !config.listen_addr.ip().is_loopback() {
            return Err(crate::Error::Config(
                "the management listener must use a loopback address".into(),
            ));
        }
        let store = Store::connect(&config.database_url).await?;
        if config.use_persisted_ports {
            let ports = store.port_settings().await?;
            config.listen_addr.set_port(ports.service_port);
            config.inference_addr.set_port(ports.inference_port);
        }
        let assets = PromptAssets::embedded()?;
        let compiler = PromptCompiler::new(assets);
        let plugin_runtime = PluginRuntime::managed()?;
        let plugins = PluginRegistry::managed(
            store.clone(),
            plugin_runtime.clone(),
            config.app_version.clone(),
        )?;
        let clients = crate::network::NetworkClients::new(store.clone());
        let provider = std::sync::Arc::new(ProviderRouter::new(
            store.clone(),
            plugins.clone(),
            clients.clone(),
            config.provider_request_timeout,
            config.provider_stream_idle_timeout,
        ));
        let inference = api::byok::router(
            store.clone(),
            plugins.clone(),
            provider.clone(),
            Some(api::byok::NativeForwarder::new(
                store.clone(),
                clients.clone(),
                config.provider_request_timeout,
                config.provider_stream_idle_timeout,
            )),
        );
        let registry = TransportRegistry::with_plugins(
            store.clone(),
            provider.clone(),
            compiler,
            WebCache::managed()?,
            plugins.clone(),
            crate::config::managed_data_dir()?.join("rules"),
        );
        let control = control::ControlService::new(
            store.clone(),
            provider,
            plugin_runtime,
            plugins,
            clients.clone(),
            config.app_version.clone(),
        )?;
        let harness = control.cursor_harness().clone();
        let mut router = api::router(registry.clone(), clients)?.nest(
            "/byok",
            axum::Router::new().fallback(|| async { axum::http::StatusCode::NOT_FOUND }),
        );
        router = match &config.console {
            Some(ConsoleSource::Directory(directory)) => {
                router.merge(control::web_router(control.clone(), directory))
            }
            Some(ConsoleSource::Proxy(target)) => {
                router.merge(control::proxy_web_router(control.clone(), target.clone()))
            }
            None => router.merge(control::api_router(control.clone())),
        };
        Ok(Self {
            router,
            inference,
            registry,
            harness,
            magpie: control.magpie().clone(),
            store,
            config,
        })
    }

    pub fn merge_router(mut self, router: axum::Router) -> Self {
        self.router = self.router.merge(router);
        self
    }

    pub async fn bind(&self) -> Result<AppListeners> {
        let local =
            bind_service_listener(self.config.listen_addr, self.config.use_persisted_ports).await?;
        let inference =
            bind_service_listener(self.config.inference_addr, self.config.use_persisted_ports)
                .await?;
        if self.config.use_persisted_ports {
            let mut ports = self.store.port_settings().await?;
            ports.service_port = local.local_addr()?.port();
            ports.inference_port = inference.local_addr()?.port();
            self.store.set_port_settings(ports).await?;
        }
        Ok(AppListeners { local, inference })
    }

    pub fn harness(&self) -> CursorHarness {
        self.harness.clone()
    }

    pub fn store(&self) -> Store {
        self.store.clone()
    }

    pub async fn serve(self) -> Result<()> {
        let listener = self.bind().await?;
        let shutdown = CancellationToken::new();
        let signal_shutdown = shutdown.clone();
        let running = self.serve_on(listener, shutdown);
        tokio::pin!(running);
        tokio::select! {
            result = &mut running => result,
            () = shutdown_signal() => {
                tracing::info!("shutdown signal received; cancelling active runs");
                signal_shutdown.cancel();
                running.await
            }
        }
    }

    pub async fn serve_on(
        self,
        listeners: AppListeners,
        shutdown: CancellationToken,
    ) -> Result<()> {
        let address = listeners.local_addr()?;
        let inference_address = listeners.inference.local_addr()?;
        self.registry.web_cache().set_service_addr(address);
        self.harness.set_backend_addr(address);
        tracing::info!(%address, %inference_address, "management and inference listeners ready");
        let maintenance_store = self.store.clone();
        let maintenance_shutdown = shutdown.clone();
        tokio::spawn(async move {
            tokio::select! {
                () = maintenance_shutdown.cancelled() => return,
                () = tokio::time::sleep(Duration::from_secs(15)) => {}
            }
            if let Err(error) = maintenance_store.prune_dead_lineages().await {
                tracing::warn!(%error, "background lineage prune skipped");
            }
        });
        let registry = self.registry;
        let harness = self.harness;
        let api_addr = control::InferenceAddress(inference_address);
        let local = axum::serve(
            listeners.local,
            self.router.layer(axum::Extension(api_addr)),
        )
        .with_graceful_shutdown(shutdown.clone().cancelled_owned());
        let inference = axum::serve(listeners.inference, self.inference)
            .with_graceful_shutdown(shutdown.clone().cancelled_owned());
        let server = async { tokio::try_join!(local.into_future(), inference.into_future()) };
        tokio::pin!(server);

        tokio::select! {
            () = self.magpie.follow() => unreachable!("catalog follower runs until shutdown"),
            result = &mut server => {
                if let Err(error) = harness.disable().await {
                    tracing::warn!(%error, "failed to disable Cursor harness after server stop");
                }
                result?;
            },
            () = shutdown.cancelled() => {
                if let Err(error) = harness.disable().await {
                    tracing::warn!(%error, "failed to disable Cursor harness during shutdown");
                }
                registry.shutdown().await;
                match tokio::time::timeout(Duration::from_secs(10), &mut server).await {
                    Ok(result) => { result?; }
                    Err(_) => tracing::warn!("graceful shutdown timed out; forcing server close"),
                }
            }
        }
        Ok(())
    }
}

async fn bind_service_listener(
    requested: SocketAddr,
    allow_random_fallback: bool,
) -> Result<TcpListener> {
    match TcpListener::bind(requested).await {
        Ok(listener) => Ok(listener),
        Err(error) if allow_random_fallback && requested.port() != 0 => {
            tracing::warn!(%requested, %error, "configured service port unavailable; selecting a random port");
            Ok(TcpListener::bind(SocketAddr::new(requested.ip(), 0)).await?)
        }
        Err(error) => Err(error.into()),
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}

#[cfg(all(test, unix))]
mod tests {
    use axum::http::StatusCode;
    use std::time::Duration;

    #[tokio::test]
    async fn public_listener_does_not_serve_the_management_api() {
        let dir = tempfile::tempdir().unwrap();
        let reserve = || std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let public = reserve();
        let control = reserve();
        let (public_address, control_address) =
            (public.local_addr().unwrap(), control.local_addr().unwrap());
        drop((public, control));
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap());
        child.kill_on_drop(true);
        child
            .env("BYOK_ISOLATED_APP_TEST", "1")
            .env("HOME", dir.path())
            .env_remove("CURSOR_CONSOLE_DIR")
            .env_remove("CURSOR_CONSOLE_PROXY")
            .env("CURSOR_LISTEN_ADDR", public_address.to_string())
            .env("CURSOR_CONTROL_ADDR", control_address.to_string())
            .env(
                "CURSOR_DATABASE_URL",
                format!("sqlite://{}", dir.path().join("config.db").display()),
            )
            .arg("--exact")
            .arg("app::tests::isolated_app_child");
        let _process = child.spawn().unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let get = |address, path| client.get(format!("http://{address}{path}"));
        let models = "/__byok-api__/api/models";
        let public_status = tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if let Ok(reply) = get(public_address, models).send().await {
                    break reply.status();
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(public_status, StatusCode::NOT_FOUND);
        let settings = get(control_address, "/__byok-api__/api/settings/external-api")
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(
            settings["base_url"],
            format!("http://{public_address}/byok/v1")
        );
        assert_eq!(
            get(control_address, models).send().await.unwrap().status(),
            StatusCode::OK
        );
        assert_eq!(
            get(public_address, "/byok/v1/models")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            get(control_address, "/byok/v1/models")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn isolated_app_child() {
        if std::env::var_os("BYOK_ISOLATED_APP_TEST").is_none() {
            return;
        }
        super::App::new(crate::config::Config::from_env().unwrap())
            .await
            .unwrap()
            .serve()
            .await
            .unwrap();
    }
}
