use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::{
    client::{ClientCommand, ClientPort},
    model::PreparedRun,
    provider::Provider,
    store::Store,
};

use super::{RunEngine, RunOutcome, RunRegistry};

#[derive(Clone)]
pub struct RunActor {
    store: Store,
    provider: Arc<dyn Provider>,
    registry: RunRegistry,
}

impl RunActor {
    pub fn new(store: Store, provider: Arc<dyn Provider>, registry: RunRegistry) -> Self {
        Self {
            store,
            provider,
            registry,
        }
    }

    pub async fn spawn(
        &self,
        prepared: PreparedRun,
        client: ClientPort,
        commands: tokio::sync::mpsc::Sender<ClientCommand>,
        cancellation: CancellationToken,
    ) -> tokio::task::JoinHandle<RunOutcome> {
        let run_id = prepared.run_id.clone();
        let conversation_id = prepared.conversation_id.clone();
        self.registry
            .activate(
                conversation_id.clone(),
                run_id.clone(),
                cancellation.clone(),
                commands,
            )
            .await;
        let actor = self.clone();
        tokio::spawn(async move {
            let outcome = RunEngine::new(actor.store, actor.provider)
                .run(prepared, client, cancellation)
                .await;
            actor.registry.release(&conversation_id, &run_id).await;
            outcome
        })
    }
}
