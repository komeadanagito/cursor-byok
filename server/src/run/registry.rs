use std::{collections::HashMap, sync::Arc};

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::{
    client::{ClientCommand, MessageInsertion},
    model::{CanonicalMessage, ConversationId, RunId},
};

#[derive(Clone, Default)]
pub struct RunRegistry {
    active: Arc<Mutex<HashMap<ConversationId, ActiveRun>>>,
}

struct ActiveRun {
    run_id: RunId,
    cancellation: CancellationToken,
    commands: tokio::sync::mpsc::Sender<ClientCommand>,
}

impl RunRegistry {
    pub async fn activate(
        &self,
        conversation_id: ConversationId,
        run_id: RunId,
        cancellation: CancellationToken,
        commands: tokio::sync::mpsc::Sender<ClientCommand>,
    ) {
        let previous = self.active.lock().await.insert(
            conversation_id,
            ActiveRun {
                run_id: run_id.clone(),
                cancellation,
                commands,
            },
        );
        if let Some(previous) = previous.filter(|previous| previous.run_id != run_id) {
            previous.cancellation.cancel();
        }
    }

    pub async fn insert_messages(
        &self,
        conversation_id: &ConversationId,
        messages: Vec<CanonicalMessage>,
    ) -> bool {
        if messages.is_empty() {
            return true;
        }
        let commands = self
            .active
            .lock()
            .await
            .get(conversation_id)
            .map(|run| run.commands.clone());
        let Some(commands) = commands else {
            return false;
        };
        let (delivered, delivery) = tokio::sync::oneshot::channel();
        if commands
            .send(ClientCommand::InsertMessages(MessageInsertion {
                messages,
                delivered,
            }))
            .await
            .is_err()
        {
            return false;
        }
        delivery.await.is_ok()
    }

    pub async fn release(&self, conversation_id: &ConversationId, run_id: &RunId) {
        let mut active = self.active.lock().await;
        if active
            .get(conversation_id)
            .is_some_and(|current| &current.run_id == run_id)
        {
            active.remove(conversation_id);
        }
    }

    pub async fn shutdown(&self) {
        let active = std::mem::take(&mut *self.active.lock().await);
        for run in active.into_values() {
            run.cancellation.cancel();
        }
    }
}
