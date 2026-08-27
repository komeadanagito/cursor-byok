use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};

use tokio::sync::Mutex;

pub mod codec;
mod dispatch;
pub(crate) mod edit;
pub(crate) mod result;
pub mod runtime;
mod schedule;
pub(crate) mod stream;
#[cfg(test)]
mod tests;

use crate::{
    model::{CanonicalMessage, MessageContent, Role, ToolCall},
    store::Store,
    web::{WebFetch, WebSearch},
    Error, Result,
};

use self::result::{ToolCompletion, ToolResultSender};
use self::schedule::{DeferredEdit, EditSchedule};
use super::{interaction, proto::agent::v1 as pb};
use runtime::{CursorToolRuntime, ExecContext};

#[derive(Clone)]
pub struct ToolDispatcher {
    runtime: CursorToolRuntime,
    results: ToolResultSender,
    search: WebSearch,
    fetch: WebFetch,
    store: Option<Store>,
    edit_schedule: Arc<Mutex<EditSchedule>>,
}

pub struct DispatchedTool {
    pub messages: Vec<pb::AgentServerMessage>,
    pub completion: Option<ToolCompletion>,
}

pub struct ToolBatchState<'a> {
    pub completed: &'a HashSet<String>,
    pub started: &'a HashSet<String>,
    pub response_text: &'a str,
    pub response_thinking: &'a str,
}

pub enum ClientToolEvent {
    Completed(Box<ToolCompletion>),
    Pending,
}

impl ToolDispatcher {
    pub fn new(runtime: CursorToolRuntime) -> Self {
        let (results, _) = result::tool_result_channel();
        Self {
            runtime,
            results,
            search: WebSearch::built_in(),
            fetch: WebFetch::built_in(),
            store: None,
            edit_schedule: Arc::new(Mutex::new(EditSchedule::default())),
        }
    }

    pub fn with_results(
        runtime: CursorToolRuntime,
        results: ToolResultSender,
        store: Store,
    ) -> Self {
        Self {
            runtime,
            results,
            search: WebSearch::managed(store.clone()),
            fetch: WebFetch::managed(store.clone()),
            store: Some(store),
            edit_schedule: Arc::new(Mutex::new(EditSchedule::default())),
        }
    }

    pub async fn start_batch(
        &self,
        calls: &[ToolCall],
        state: ToolBatchState<'_>,
        messages: &[CanonicalMessage],
        dynamic_mcp: &BTreeMap<String, pb::McpToolDefinition>,
        context: &ExecContext,
    ) -> Result<Vec<DispatchedTool>> {
        let first_tool_index = current_turn_step_count(messages)
            + usize::from(!state.response_thinking.is_empty())
            + usize::from(!state.response_text.is_empty())
            + 1;
        let mut dispatched = Vec::new();
        for (position, call) in calls.iter().enumerate() {
            if state.completed.contains(&call.call_id) {
                continue;
            }
            let message_index = first_tool_index + position;
            let publish_started = !state.started.contains(&call.call_id);
            let edit_path = if dynamic_mcp.contains_key(&call.name) {
                None
            } else {
                edit::execution_path(call)?
            };
            if let Some(path) = edit_path {
                let next = self.edit_schedule.lock().await.start_or_defer(
                    path,
                    DeferredEdit {
                        call: call.clone(),
                        message_index,
                        publish_started,
                        context: context.clone(),
                    },
                );
                let Some(next) = next else {
                    continue;
                };
                dispatched.push(
                    self.start(
                        &next.call,
                        next.message_index,
                        next.publish_started,
                        dynamic_mcp,
                        &next.context,
                    )
                    .await?,
                );
                continue;
            }
            dispatched.push(
                self.start(call, message_index, publish_started, dynamic_mcp, context)
                    .await?,
            );
        }
        Ok(dispatched)
    }

    pub(crate) async fn continue_after(&self, call_id: &str) -> Result<Option<DispatchedTool>> {
        let next = self.edit_schedule.lock().await.complete(call_id)?;
        let Some(next) = next else {
            return Ok(None);
        };
        self.start(
            &next.call,
            next.message_index,
            next.publish_started,
            &BTreeMap::new(),
            &next.context,
        )
        .await
        .map(Some)
    }

    async fn start(
        &self,
        call: &ToolCall,
        message_index: usize,
        publish_started: bool,
        dynamic_mcp: &BTreeMap<String, pb::McpToolDefinition>,
        context: &ExecContext,
    ) -> Result<DispatchedTool> {
        let call = context.prepare_call(call)?;
        let mut messages = if publish_started {
            vec![interaction::tool_started(
                &call,
                dynamic_mcp.get(&call.name),
            )?]
        } else {
            Vec::new()
        };
        let started = dispatch::start(
            &self.runtime,
            &self.results,
            &call,
            message_index,
            dynamic_mcp,
            context,
            self.store.as_ref(),
        )
        .await?;
        messages.extend(started.messages);
        Ok(DispatchedTool {
            messages,
            completion: started.completion,
        })
    }

    pub async fn interaction_response(
        &self,
        response: &pb::InteractionResponse,
    ) -> Result<ClientToolEvent> {
        let pending = match self.runtime.take_interaction(response.id).await {
            Some(pending) => pending,
            None if self.runtime.completed_call(response.id).await.is_some() => {
                return Err(Error::Protocol(format!(
                    "duplicate terminal InteractionResponse id: {}",
                    response.id
                )));
            }
            None => {
                return Err(Error::Protocol(format!(
                    "unknown InteractionResponse id: {}",
                    response.id
                )));
            }
        };
        Ok(
            match dispatch::resume_interaction(
                &self.results,
                &self.search,
                &self.fetch,
                pending,
                response,
            )
            .await?
            {
                dispatch::InteractionContinuation::Completed(completion) => {
                    ClientToolEvent::Completed(completion)
                }
                dispatch::InteractionContinuation::Pending => ClientToolEvent::Pending,
            },
        )
    }
}

fn current_turn_step_count(messages: &[CanonicalMessage]) -> usize {
    let turn_start = messages
        .iter()
        .rposition(|message| message.role == Role::User)
        .map_or(0, |position| position + 1);
    messages[turn_start..]
        .iter()
        .map(|message| match &message.content {
            MessageContent::Assistant {
                text,
                thinking,
                tool_calls,
                ..
            } => {
                usize::from(!thinking.is_empty()) + usize::from(!text.is_empty()) + tool_calls.len()
            }
            _ => 0,
        })
        .sum()
}
