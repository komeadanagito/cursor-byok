//! Prunes dead checkpoint lineages and reclaims SQLite space at startup.

use sqlx::{Sqlite, Transaction};

use crate::Result;

use super::{now_ms, Store};

/// Prune lineages that have been detached for at least this long, so a run in
/// flight when the process last exited keeps its recovery window.
pub(crate) const PRUNE_GRACE_MS: i64 = 24 * 60 * 60 * 1000;

/// Wire blobs younger than this are kept even when unreferenced: the client
/// KV store holds them anyway, but deleting recent ones trades a round trip
/// back to the client for no meaningful space.
pub(crate) const BLOB_GRACE_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Reclaimable freelist bytes that justify a VACUUM on moderately sized files.
pub(crate) const VACUUM_THRESHOLD_BYTES: i64 = 32 * 1024 * 1024;

/// Multi-gigabyte databases hold an exclusive write lock across the full file
/// copy during VACUUM; SQLite reuses freelist pages automatically above this cap.
const MAX_AUTO_VACUUM_DB_BYTES: i64 = 512 * 1024 * 1024;

impl Store {
    /// Removes checkpoints, messages, tool rounds, and wire blobs that no
    /// live lineage references, then rewrites the file when that is expected
    /// to free meaningful space without stalling a multi-gigabyte database.
    pub(crate) async fn prune_dead_lineages(&self) -> Result<()> {
        let mut session = self.write_session().await?;
        let mut tx = session.begin().await?;
        let pruned = prune_tx(&mut tx).await?;
        tx.commit().await?;
        session.committed();
        // VACUUM takes its own write session; retaining this guard would deadlock.
        drop(session);
        if pruned.checkpoints == 0 && pruned.messages == 0 && pruned.blobs == 0 {
            return Ok(());
        }
        tracing::info!(
            checkpoints = pruned.checkpoints,
            messages = pruned.messages,
            tool_rounds = pruned.tool_rounds,
            blobs = pruned.blobs,
            reclaimable_bytes = pruned.reclaimable_bytes,
            total_bytes = pruned.total_bytes,
            "pruned dead checkpoint lineages"
        );
        if pruned.reclaimable_bytes >= VACUUM_THRESHOLD_BYTES
            && pruned.total_bytes <= MAX_AUTO_VACUUM_DB_BYTES
        {
            self.vacuum().await?;
        }
        Ok(())
    }

    /// VACUUM cannot run inside a transaction. The write session holds every
    /// other writer out while it rewrites the file.
    pub async fn vacuum(&self) -> Result<()> {
        let mut session = self.write_session().await?;
        session.execute_direct("VACUUM").await?;
        session.committed();
        tracing::info!("database vacuumed");
        Ok(())
    }
}

#[derive(Debug, Default, PartialEq)]
struct PruneResult {
    checkpoints: i64,
    messages: i64,
    tool_rounds: i64,
    blobs: i64,
    reclaimable_bytes: i64,
    total_bytes: i64,
}

/// One canonical definition of checkpoint liveness: every ancestor of a
/// conversation head, where a head only counts while its conversation has an
/// active run or was updated inside the grace window. Everything else is a
/// dead branch left behind by compaction replacement or an abandoned resume.
async fn fill_live_checkpoints(tx: &mut Transaction<'_, Sqlite>) -> Result<()> {
    sqlx::query(
        "CREATE TEMP TABLE IF NOT EXISTS live_checkpoints(checkpoint_id INTEGER PRIMARY KEY)",
    )
    .execute(&mut **tx)
    .await?;
    sqlx::query("DELETE FROM live_checkpoints")
        .execute(&mut **tx)
        .await?;
    // A conversation is live while a run holds it or its head checkpoint was
    // written inside the grace window. conversations.updated_at_ms refreshes
    // on every run finish, so it cannot distinguish a quiet conversation
    // from one that just compacted; the head checkpoint's own creation time
    // is the lineage's last real write.
    sqlx::query(
        "WITH RECURSIVE lineage(checkpoint_id) AS (
             SELECT current_checkpoint_id FROM conversations c
             JOIN conversation_checkpoints h ON h.checkpoint_id = c.current_checkpoint_id
             WHERE c.current_checkpoint_id IS NOT NULL
               AND (c.active_run_id IS NOT NULL OR h.created_at_ms >= ?)
             UNION
             SELECT ck.parent_checkpoint_id
             FROM lineage l
             JOIN conversation_checkpoints ck ON ck.checkpoint_id = l.checkpoint_id
             WHERE ck.parent_checkpoint_id IS NOT NULL
         )
         INSERT OR IGNORE INTO live_checkpoints
         SELECT checkpoint_id FROM lineage",
    )
    .bind(now_ms() - PRUNE_GRACE_MS)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn prune_tx(tx: &mut Transaction<'_, Sqlite>) -> Result<PruneResult> {
    fill_live_checkpoints(tx).await?;

    let has_dead_checkpoints: i64 = sqlx::query_scalar(
        "SELECT EXISTS(
             SELECT 1 FROM conversation_checkpoints
             WHERE checkpoint_id NOT IN (SELECT checkpoint_id FROM live_checkpoints)
         )",
    )
    .fetch_one(&mut **tx)
    .await?;

    let (checkpoints, messages, tool_rounds) = if has_dead_checkpoints != 0 {
        // Every constraint here is NO ACTION, so deletes run leaves-first:
        // tool_round_calls before tool_rounds, tool_rounds and runs before the
        // checkpoints they pin, and only after the checkpoints are gone do
        // messages lose their last referencer. Runs whose base or head sits on a
        // dead checkpoint belong to that lineage and must go too — a run still
        // marked running over a dead lineage is the crashed-run case pruning
        // exists to clear.
        sqlx::query(
            "DELETE FROM checkpoint_messages
             WHERE checkpoint_id NOT IN (SELECT checkpoint_id FROM live_checkpoints)",
        )
        .execute(&mut **tx)
        .await?;
        // Input anchors pin a base checkpoint so retries of the same input id
        // resolve to the same lineage; an anchor into a dead lineage can never be
        // retried again.
        sqlx::query(
            "DELETE FROM input_anchors
             WHERE base_checkpoint_id NOT IN (SELECT checkpoint_id FROM live_checkpoints)",
        )
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "DELETE FROM tool_round_calls
             WHERE round_id NOT IN (
                 SELECT round_id FROM tool_rounds
                 WHERE base_checkpoint_id IN (SELECT checkpoint_id FROM live_checkpoints)
             )",
        )
        .execute(&mut **tx)
        .await?;
        let tool_rounds = sqlx::query(
            "DELETE FROM tool_rounds
             WHERE base_checkpoint_id NOT IN (SELECT checkpoint_id FROM live_checkpoints)",
        )
        .execute(&mut **tx)
        .await?
        .rows_affected() as i64;
        sqlx::query(
            "DELETE FROM runs
             WHERE base_checkpoint_id NOT IN (SELECT checkpoint_id FROM live_checkpoints)
                OR (head_checkpoint_id IS NOT NULL
                    AND head_checkpoint_id NOT IN (SELECT checkpoint_id FROM live_checkpoints))",
        )
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "UPDATE conversations
             SET current_checkpoint_id = NULL
             WHERE current_checkpoint_id IS NOT NULL
               AND current_checkpoint_id NOT IN (SELECT checkpoint_id FROM live_checkpoints)",
        )
        .execute(&mut **tx)
        .await?;
        let checkpoints = sqlx::query(
            "DELETE FROM conversation_checkpoints
             WHERE checkpoint_id NOT IN (SELECT checkpoint_id FROM live_checkpoints)",
        )
        .execute(&mut **tx)
        .await?
        .rows_affected() as i64;
        let messages = sqlx::query(
            "DELETE FROM messages
             WHERE message_id NOT IN (SELECT message_id FROM checkpoint_messages)",
        )
        .execute(&mut **tx)
        .await?
        .rows_affected() as i64;
        (checkpoints, messages, tool_rounds)
    } else {
        (0, 0, 0)
    };

    // Wire blobs are a cache of what was handed to the client KV store; the
    // client still holds them and blob_sync falls back to a KV GET when one
    // is missing. Keep anything recent, plus anything a retained trace still
    // references. Edges reference blobs from both sides, so the dead set is
    // pinned first and its edges go before the blobs they point at.
    sqlx::query("CREATE TEMP TABLE IF NOT EXISTS dead_blobs(blob_id BLOB PRIMARY KEY)")
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM dead_blobs")
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "INSERT OR IGNORE INTO dead_blobs
         SELECT blob_id FROM blobs
         WHERE created_at_ms < ?
           AND blob_id NOT IN (SELECT blob_id FROM cursor_run_trace_artifacts)",
    )
    .bind(now_ms() - BLOB_GRACE_MS)
    .execute(&mut **tx)
    .await?;

    let has_dead_blobs: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM dead_blobs)")
        .fetch_one(&mut **tx)
        .await?;

    let blobs = if has_dead_blobs != 0 {
        // Read tool attachments are durable message references, not wire cache.
        let read_images: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT json_extract(payload_json, '$.content.image.blob_id')
             FROM messages
             WHERE payload_json LIKE '%\"blob_id\"%'
               AND json_type(payload_json, '$.content.image.blob_id') = 'text'",
        )
        .fetch_all(&mut **tx)
        .await?;
        for image in read_images {
            let id = super::BlobId::from_base64(&image)?;
            sqlx::query("DELETE FROM dead_blobs WHERE blob_id = ?")
                .bind(id.as_bytes().as_slice())
                .execute(&mut **tx)
                .await?;
        }
        sqlx::query(
            "DELETE FROM blob_edges WHERE parent_blob_id IN (SELECT blob_id FROM dead_blobs)",
        )
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "DELETE FROM blob_edges WHERE child_blob_id IN (SELECT blob_id FROM dead_blobs)",
        )
        .execute(&mut **tx)
        .await?;
        sqlx::query("DELETE FROM blobs WHERE blob_id IN (SELECT blob_id FROM dead_blobs)")
            .execute(&mut **tx)
            .await?
            .rows_affected() as i64
    } else {
        0
    };

    let (reclaimable_bytes, total_bytes) = sqlx::query_as::<_, (i64, i64)>(
        "SELECT freelist_count * page_size, page_count * page_size
         FROM pragma_freelist_count(), pragma_page_count(), pragma_page_size()",
    )
    .fetch_one(&mut **tx)
    .await
    .unwrap_or((0, 0));

    Ok(PruneResult {
        checkpoints,
        messages,
        tool_rounds,
        blobs,
        reclaimable_bytes,
        total_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ConversationId, RunId};
    use crate::store::Store;
    use std::collections::HashSet;

    async fn store() -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().unwrap();
        let database_url = format!("sqlite://{}", directory.path().join("test.db").display());
        let store = Store::connect(&database_url).await.unwrap();
        (directory, store)
    }

    use crate::model::{ModelSpec, PreparedRun, PromptSpec, RunAction, RunKind};

    async fn checkpoint_line(store: &Store, conversation: &str, heads: usize) -> Vec<i64> {
        let conversation_id = ConversationId::new(conversation);
        let base = store.ensure_conversation(&conversation_id).await.unwrap();
        let run_id = RunId::new(format!("{conversation}-run"));
        store
            .claim_run(&PreparedRun {
                run_id: run_id.clone(),
                cursor_request_id: None,
                conversation_id: conversation_id.clone(),
                kind: RunKind::Root,
                model: ModelSpec::new("test-model"),
                prompt: PromptSpec {
                    instructions: String::new(),
                    tools: Vec::new(),
                },
                initial_messages: Vec::new(),
                action: RunAction::Start,
                base_checkpoint_id: base,
            })
            .await
            .unwrap();
        let mut current = base;
        let mut ids = Vec::new();
        for index in 0..heads {
            let message = crate::model::CanonicalMessage::text(
                format!("{conversation}-m{index}"),
                crate::model::Role::User,
                crate::model::Origin::User,
                "x",
            );
            current = store
                .append_checkpoint(&conversation_id, &run_id, current, &[message])
                .await
                .unwrap();
            ids.push(current.0);
        }
        store
            .finish_run(&run_id, crate::store::RunStatus::Completed, None, None)
            .await
            .unwrap();
        ids
    }

    async fn checkpoint_ids(store: &Store) -> HashSet<i64> {
        let rows: Vec<(i64,)> =
            sqlx::query_as("SELECT checkpoint_id FROM conversation_checkpoints")
                .fetch_all(store.pool())
                .await
                .unwrap();
        rows.into_iter().map(|row| row.0).collect()
    }

    #[tokio::test]
    async fn prunes_dead_lineages_and_keeps_the_live_one() {
        let (_directory, store) = store().await;
        let live = checkpoint_line(&store, "live", 3).await;
        let dead = checkpoint_line(&store, "dead", 2).await;
        let dead_head = *dead.last().expect("dead lineage has a head");
        sqlx::query(
            "UPDATE conversation_checkpoints SET created_at_ms = ? WHERE checkpoint_id = ?",
        )
        .bind(now_ms() - PRUNE_GRACE_MS - 1)
        .bind(dead_head)
        .execute(store.pool())
        .await
        .unwrap();

        store.prune_dead_lineages().await.unwrap();

        let remaining = checkpoint_ids(&store).await;
        assert!(live.iter().all(|id| remaining.contains(id)));
        assert!(dead.iter().all(|id| !remaining.contains(id)));
        let messages: Vec<(String,)> =
            sqlx::query_as("SELECT message_id FROM messages WHERE message_id LIKE 'dead-%'")
                .fetch_all(store.pool())
                .await
                .unwrap();
        assert!(messages.is_empty());
    }

    #[tokio::test]
    async fn cleanup_keeps_old_read_images_referenced_by_live_messages() {
        use crate::model::{
            CanonicalMessage, MessageContent, Origin, Role, ToolImageReference, ToolResultContent,
        };
        let (_directory, store) = store().await;
        let image = store.put_blob(b"read image", &[]).await.unwrap();
        let unused = store
            .put_blob(b"unreferenced wire data", &[])
            .await
            .unwrap();
        let conversation = ConversationId::new("with-image");
        let checkpoint = store
            .import_checkpoint(
                &conversation,
                &[CanonicalMessage {
                    message_id: "read-image".into(),
                    role: Role::Tool,
                    origin: Origin::Tool,
                    runtime_event_id: None,
                    content: MessageContent::ToolResult(ToolResultContent {
                        call_id: "read".into(),
                        name: "Read".into(),
                        content: "image".into(),
                        is_error: false,
                        image: Some(ToolImageReference {
                            blob_id: image.to_base64(),
                            mime_type: "image/png".into(),
                            path: "a.png".into(),
                        }),
                        provider_parts: Vec::new(),
                    }),
                }],
            )
            .await
            .unwrap();
        sqlx::query("UPDATE conversations SET current_checkpoint_id=? WHERE conversation_id=?")
            .bind(checkpoint.0)
            .bind(conversation.as_str())
            .execute(store.pool())
            .await
            .unwrap();
        sqlx::query("UPDATE blobs SET created_at_ms = ?")
            .bind(now_ms() - BLOB_GRACE_MS - 1)
            .execute(store.pool())
            .await
            .unwrap();
        store.prune_dead_lineages().await.unwrap();
        assert_eq!(
            store.get_blob(&image).await.unwrap().as_deref(),
            Some(b"read image".as_slice())
        );
        assert!(store.get_blob(&unused).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn keeps_a_recently_detached_lineage_inside_the_grace_window() {
        let (_directory, store) = store().await;
        let detached = checkpoint_line(&store, "detached", 2).await;
        // Detached but recent: the head checkpoint was written moments ago, so
        // the lineage stays for its recovery window without any manual pin.
        store.prune_dead_lineages().await.unwrap();

        let remaining = checkpoint_ids(&store).await;
        assert!(detached.iter().all(|id| remaining.contains(id)));
    }

    #[tokio::test]
    async fn startup_pruning_finishes_when_large_databases_need_vacuum() {
        let (directory, store) = store().await;
        let live = checkpoint_line(&store, "live", 2).await;
        let dead = checkpoint_line(&store, "dead", 2).await;
        sqlx::query(
            "UPDATE conversation_checkpoints SET created_at_ms = ? WHERE checkpoint_id = ?",
        )
        .bind(now_ms() - PRUNE_GRACE_MS - 1)
        .bind(dead.last().unwrap())
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query("INSERT INTO blobs(blob_id, data, created_at_ms) VALUES (?, zeroblob(?), ?)")
            .bind([0_u8; 32].as_slice())
            .bind(VACUUM_THRESHOLD_BYTES)
            .bind(now_ms() - BLOB_GRACE_MS - 1)
            .execute(store.pool())
            .await
            .unwrap();

        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            store.prune_dead_lineages(),
        )
        .await
        .expect("startup pruning must finish when vacuuming a large database")
        .unwrap();

        let remaining = checkpoint_ids(&store).await;
        assert!(live.iter().all(|id| remaining.contains(id)));
        assert!(dead.iter().all(|id| !remaining.contains(id)));
        let database_bytes: i64 = sqlx::query_scalar(
            "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
        )
        .fetch_one(store.pool())
        .await
        .unwrap();
        assert!(database_bytes < VACUUM_THRESHOLD_BYTES);
        checkpoint_line(&store, "after-vacuum", 1).await;

        store.pool().close().await;
        let reopened = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        reopened.prune_dead_lineages().await.unwrap();
        assert_eq!(checkpoint_ids(&reopened).await.len(), remaining.len() + 2);
    }

    #[tokio::test]
    async fn vacuum_rewrites_the_file_without_error() {
        let (_directory, store) = store().await;
        checkpoint_line(&store, "v", 2).await;
        store.vacuum().await.unwrap();
        // Still writable after the rewrite.
        checkpoint_line(&store, "v2", 1).await;
    }

    #[tokio::test]
    async fn pruning_tiny_dead_lineage_in_large_database_skips_full_file_vacuum() {
        let (_directory, store) = store().await;
        let _live = checkpoint_line(&store, "live", 2).await;
        let dead = checkpoint_line(&store, "dead", 20).await;
        sqlx::query(
            "UPDATE conversation_checkpoints SET created_at_ms = ? WHERE checkpoint_id = ?",
        )
        .bind(now_ms() - PRUNE_GRACE_MS - 1)
        .bind(dead.last().unwrap())
        .execute(store.pool())
        .await
        .unwrap();
        // Dead blob frees several 4 KiB pages (< 1 MiB) while the live blob
        // keeps total file size above VACUUM_THRESHOLD_BYTES.
        sqlx::query("INSERT INTO blobs(blob_id, data, created_at_ms) VALUES (?, zeroblob(?), ?)")
            .bind([2_u8; 32].as_slice())
            .bind(64 * 1024_i64)
            .bind(now_ms() - BLOB_GRACE_MS - 1)
            .execute(store.pool())
            .await
            .unwrap();
        sqlx::query("INSERT INTO blobs(blob_id, data, created_at_ms) VALUES (?, zeroblob(?), ?)")
            .bind([1_u8; 32].as_slice())
            .bind(VACUUM_THRESHOLD_BYTES + 4 * 1024 * 1024)
            .bind(now_ms())
            .execute(store.pool())
            .await
            .unwrap();

        store.prune_dead_lineages().await.unwrap();

        let freelist_pages: i64 = sqlx::query_scalar("SELECT * FROM pragma_freelist_count()")
            .fetch_one(store.pool())
            .await
            .unwrap();
        assert!(
            freelist_pages > 0,
            "expected freed pages to stay on freelist without rewriting a large file via VACUUM"
        );
    }

    #[tokio::test]
    async fn pruned_idle_conversation_can_resume_without_foreign_key_error() {
        let (_directory, store) = store().await;
        let dead = checkpoint_line(&store, "idle-chat", 2).await;
        sqlx::query(
            "UPDATE conversation_checkpoints SET created_at_ms = ? WHERE checkpoint_id = ?",
        )
        .bind(now_ms() - PRUNE_GRACE_MS - 1)
        .bind(dead.last().unwrap())
        .execute(store.pool())
        .await
        .unwrap();

        store.prune_dead_lineages().await.unwrap();

        let conversation_id = ConversationId::new("idle-chat");
        let base_checkpoint_id = store.ensure_conversation(&conversation_id).await.unwrap();
        let anchored = store
            .anchor_input(&conversation_id, "resume-input-1", base_checkpoint_id)
            .await
            .unwrap();
        assert_eq!(anchored, base_checkpoint_id);
    }
}
