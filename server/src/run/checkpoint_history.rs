//! Shares one immutable checkpoint snapshot between a Run and its adapter.
use std::{sync::Arc, time::Instant};

use tokio::sync::Mutex;

use crate::{
    model::{CanonicalMessage, CheckpointId},
    store::Store,
    Result,
};

type Messages = Arc<Vec<CanonicalMessage>>;

#[derive(Clone, Default)]
pub(crate) struct CheckpointHistory {
    latest: Arc<Mutex<Option<(CheckpointId, Messages)>>>,
}

impl CheckpointHistory {
    pub(crate) async fn load(&self, store: &Store, checkpoint: CheckpointId) -> Result<Messages> {
        let mut latest = self.latest.lock().await;
        if let Some((id, messages)) = latest.as_ref() {
            if *id == checkpoint {
                tracing::trace!(
                    checkpoint_id = checkpoint.0,
                    "reused Run checkpoint history"
                );
                return Ok(messages.clone());
            }
        }

        // Both readers see the same committed snapshot, even when they arrive together.
        let started = Instant::now();
        let messages = Arc::new(store.load_checkpoint_messages(checkpoint).await?);
        tracing::debug!(
            checkpoint_id = checkpoint.0,
            messages = messages.len(),
            elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0,
            "loaded Run checkpoint history from SQLite"
        );
        *latest = Some((checkpoint, messages.clone()));
        Ok(messages)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{ConversationId, Origin, Role, RunId},
        run::channel,
    };

    #[tokio::test]
    async fn engine_and_publisher_share_one_load_per_current_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!("sqlite://{}", dir.path().join("run.db").display()))
            .await
            .unwrap();
        let conversation = ConversationId::new("conversation");
        let empty = store.ensure_conversation(&conversation).await.unwrap();
        let messages = [CanonicalMessage::text(
            "u1",
            Role::User,
            Origin::User,
            "hello",
        )];
        let committed = store
            .import_checkpoint(&conversation, &messages)
            .await
            .unwrap();
        let (engine, publisher, _) = channel(RunId::new("run"), 1);

        let (a, b) = tokio::join!(
            engine.history.load(&store, committed),
            publisher.history.load(&store, committed),
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a.as_slice(), &messages);
        assert!(Arc::ptr_eq(&a, &b), "both readers must share the same load");

        let current = publisher.history.load(&store, empty).await.unwrap();
        assert!(current.is_empty());
        assert_eq!(
            a.as_slice(),
            &messages,
            "an in-flight reader keeps its own snapshot"
        );
        let older = engine.history.load(&store, committed).await.unwrap();
        assert_eq!(older.as_slice(), &messages);
        assert!(
            !Arc::ptr_eq(&a, &older),
            "the previous checkpoint was evicted"
        );
    }
}
