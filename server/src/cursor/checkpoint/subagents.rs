//! Settles background subagent runs from their completion notifications.
use std::sync::Arc;

use parking_lot::Mutex;

use crate::cursor::protocol::proto::agent::v1 as pb;

use super::CheckpointBuilder;

/// Finished subagents reported to one Run.
///
/// A notification that joins an active Run arrives on another request, while
/// the checkpoint worker owns the builder, so both sides share this list. It is
/// kept rather than drained because a notification may precede the checkpoint
/// that records its Task call as backgrounded.
#[derive(Clone, Default)]
pub(crate) struct SubagentCompletions(Arc<Mutex<Vec<pb::BackgroundTaskCompletion>>>);

impl SubagentCompletions {
    pub fn extend(&self, completions: impl IntoIterator<Item = pb::BackgroundTaskCompletion>) {
        self.0.lock().extend(completions);
    }
}

impl CheckpointBuilder {
    pub(crate) fn subagent_completions(&self) -> SubagentCompletions {
        self.subagent_completions.clone()
    }

    pub(super) fn settle_finished_subagents(&mut self) {
        for completion in self.subagent_completions.0.lock().iter() {
            let Some(run) = completion
                .tool_call_id
                .as_ref()
                .and_then(|id| self.base.subagent_runs_by_parent_tool_call_id.get_mut(id))
            else {
                continue;
            };
            // Only a live run can finish: a retried notification must not move
            // the completion time of a run that already settled.
            if run.subagent_id != completion.subagent_id
                || !matches!(
                    run.status(),
                    pb::SubagentRunStatus::Running | pb::SubagentRunStatus::Backgrounded
                )
            {
                continue;
            }
            run.status = match completion.status() {
                pb::BackgroundTaskStatus::Success => pb::SubagentRunStatus::Success,
                pb::BackgroundTaskStatus::Error => pb::SubagentRunStatus::Error,
                pb::BackgroundTaskStatus::Aborted => pb::SubagentRunStatus::Aborted,
                pb::BackgroundTaskStatus::Unspecified => continue,
            } as i32;
            run.completed_timestamp_ms = Some(crate::cursor::tools::runtime::now_ms());
            run.completion_reason = Some(completion.reason);
            if completion.detail.is_some() {
                run.detail = completion.detail.clone();
            }
            if completion.output_path.is_some() {
                run.output_path = completion.output_path.clone();
            }
        }
    }
}
