//! Restores Conversation Messages and pending Tool state from a checkpoint.
use futures_util::{stream, StreamExt, TryStreamExt};

use crate::{
    cursor::{checkpoint::messages, protocol::proto::agent::v1 as pb},
    model::CanonicalMessage,
    store::BlobId,
    Error, Result,
};

use super::CheckpointBuilder;

const ROOT_READ_WINDOW: usize = 4;

impl CheckpointBuilder {
    pub async fn import_prefetched(&self, blobs: &[pb::PreFetchedBlob]) -> Result<()> {
        for blob in blobs {
            let expected = BlobId::from_bytes(&blob.id)?;
            let actual = self.store.put_blob(&blob.value, &[]).await?;
            if expected != actual {
                return Err(Error::Protocol(format!(
                    "prefetched Blob hash mismatch: {}",
                    expected.to_base64()
                )));
            }
        }
        Ok(())
    }

    pub async fn hydrate_messages(
        &self,
        state: Option<&pb::ConversationStateStructure>,
    ) -> Result<Vec<CanonicalMessage>> {
        let Some(state) = state else {
            return Ok(Vec::new());
        };
        let ids = state
            .root_prompt_messages_json
            .iter()
            .map(|raw| BlobId::from_bytes(raw))
            .collect::<Result<Vec<_>>>()?;
        // Keep a small window over the client connection without reordering the history.
        let sync = self.sync.clone();
        let mut messages: Vec<_> = stream::iter(ids.into_iter().enumerate())
            .map(move |(ordinal, id)| {
                let sync = sync.clone();
                async move {
                    let Some(data) = sync.get(&id).await? else {
                        return Err(Error::Protocol(format!(
                            "missing message Blob {}",
                            id.to_base64()
                        )));
                    };
                    messages::decode(&data, format!("cursor-root:{}:{ordinal}", id.to_base64()))
                }
            })
            .buffered(ROOT_READ_WINDOW)
            .try_collect()
            .await?;
        // Cursor can hand back a root list that still carries an abandoned
        // pending tool round. Canonical history has to be well-formed before it
        // is persisted, so settle the pairs here rather than at projection time.
        crate::model::settle_tool_pairs(&mut messages);
        Ok(messages)
    }
}
