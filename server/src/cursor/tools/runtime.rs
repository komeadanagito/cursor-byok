use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
    time::Instant,
};

use tokio::sync::Mutex;

use crate::{cursor::proto::agent::v1 as pb, model::ToolCall, Error, Result};

use super::edit::EditWrite;

#[derive(Clone, Default)]
pub struct CursorToolRuntime {
    next_id: Arc<AtomicU32>,
    execs: Arc<Mutex<HashMap<u32, PendingExec>>>,
    interactions: Arc<Mutex<HashMap<u32, PendingInteraction>>>,
    completed: Arc<Mutex<HashMap<u32, String>>>,
}

pub(crate) struct PendingExec {
    pub call: ToolCall,
    pub context: ExecContext,
    pub started_at_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub stage: ExecStage,
}

pub(crate) enum ExecStage {
    Direct,
    DynamicMcp(pb::McpToolDefinition),
    EditRead,
    EditWrite(EditWrite),
    Await(AwaitState),
}

pub(crate) struct AwaitState {
    pub deadline: Instant,
    pub output_file_path: String,
    pub task_id: String,
    pub regex: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ExecContext {
    pub conversation_id: String,
    pub root_conversation_id: String,
    pub default_subagent_model: String,
    pub subagent_model: Option<SubagentModel>,
    pub allow_subagents: bool,
    pub subagents_disabled: bool,
    pub terminals_folder: String,
    pub admin_command_denylist: Vec<String>,
    pub mcp_routes: HashMap<(String, String), McpRoute>,
}

#[derive(Clone, Debug)]
pub struct McpRoute {
    pub name: String,
    pub provider_identifier: String,
    pub tool_name: String,
    pub description: String,
}

#[derive(Clone, Debug)]
pub enum SubagentModel {
    Model(String),
    Disabled,
}

impl ExecContext {
    pub fn task_disabled(&self, call: &ToolCall) -> bool {
        if !call.name.eq_ignore_ascii_case("Task") {
            return false;
        }
        self.subagents_disabled || matches!(self.subagent_model, Some(SubagentModel::Disabled))
    }

    pub fn prepare_call(&self, call: &ToolCall) -> Result<ToolCall> {
        if !call.name.eq_ignore_ascii_case("Task") {
            return Ok(call.clone());
        }
        let arguments = call
            .arguments
            .as_object()
            .ok_or_else(|| Error::Protocol("Task arguments must be a JSON object".into()))?;
        let subagent_type = arguments
            .get("subagent_type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("generalPurpose");
        if self.task_disabled(call) {
            return Ok(call.clone());
        }
        let model = match &self.subagent_model {
            Some(SubagentModel::Model(model)) => model.clone(),
            Some(SubagentModel::Disabled) => unreachable!("disabled Task returned above"),
            None => arguments
                .get("model")
                .and_then(serde_json::Value::as_str)
                .filter(|model| *model != "inherit")
                .unwrap_or(&self.default_subagent_model)
                .to_string(),
        };
        if model.is_empty() {
            return Err(Error::Protocol(format!(
                "Task subagent type {subagent_type} has no model"
            )));
        }
        let mut prepared = call.clone();
        prepared
            .arguments
            .as_object_mut()
            .expect("Task arguments were validated")
            .insert("model".into(), serde_json::Value::String(model));
        Ok(prepared)
    }
}

pub(crate) struct PendingInteraction {
    pub call: ToolCall,
    pub started_at_ms: u64,
}

impl CursorToolRuntime {
    pub async fn reserve_exec(&self, call: &ToolCall, context: &ExecContext) -> Result<u32> {
        self.reserve_exec_stage(call, context, ExecStage::Direct, None)
            .await
    }

    pub(crate) async fn reserve_dynamic_mcp(
        &self,
        call: &ToolCall,
        context: &ExecContext,
        definition: &pb::McpToolDefinition,
    ) -> Result<u32> {
        self.reserve_exec_stage(
            call,
            context,
            ExecStage::DynamicMcp(definition.clone()),
            None,
        )
        .await
    }

    pub(crate) async fn reserve_edit_read(
        &self,
        call: &ToolCall,
        context: &ExecContext,
    ) -> Result<u32> {
        self.reserve_exec_stage(call, context, ExecStage::EditRead, None)
            .await
    }

    pub(crate) async fn reserve_edit_write(
        &self,
        call: &ToolCall,
        context: &ExecContext,
        write: EditWrite,
        started_at_ms: u64,
    ) -> Result<u32> {
        self.reserve_exec_stage(
            call,
            context,
            ExecStage::EditWrite(write),
            Some(started_at_ms),
        )
        .await
    }

    pub(crate) async fn reserve_await(
        &self,
        call: &ToolCall,
        context: &ExecContext,
    ) -> Result<u32> {
        let task_id = call
            .arguments
            .get("shell_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| Error::Protocol("AwaitShell is missing shell_id".into()))?;
        let block_ms = call
            .arguments
            .get("block_until_ms")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(30_000);
        if block_ms > 7_140_000 {
            return Err(Error::Protocol(
                "AwaitShell block_until_ms exceeds 7140000".into(),
            ));
        }
        let output_file_path = format!(
            "{}/{}.txt",
            context.terminals_folder.trim_end_matches('/'),
            task_id
        );
        self.reserve_exec_stage(
            call,
            context,
            ExecStage::Await(AwaitState {
                deadline: Instant::now() + std::time::Duration::from_millis(block_ms),
                output_file_path,
                task_id: task_id.to_string(),
                regex: call
                    .arguments
                    .get("pattern")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
            }),
            None,
        )
        .await
    }

    pub(crate) async fn reserve_await_again(
        &self,
        call: &ToolCall,
        context: &ExecContext,
        state: AwaitState,
        started_at_ms: u64,
    ) -> Result<u32> {
        self.reserve_exec_stage(call, context, ExecStage::Await(state), Some(started_at_ms))
            .await
    }

    async fn reserve_exec_stage(
        &self,
        call: &ToolCall,
        context: &ExecContext,
        stage: ExecStage,
        started_at_ms: Option<u64>,
    ) -> Result<u32> {
        let id = self.next_id()?;
        self.execs.lock().await.insert(
            id,
            PendingExec {
                call: call.clone(),
                context: context.clone(),
                started_at_ms: started_at_ms.unwrap_or_else(now_ms),
                stdout: String::new(),
                stderr: String::new(),
                stage,
            },
        );
        Ok(id)
    }

    pub async fn reserve_interaction(&self, call: &ToolCall) -> Result<u32> {
        let id = self.next_id()?;
        self.interactions.lock().await.insert(
            id,
            PendingInteraction {
                call: call.clone(),
                started_at_ms: now_ms(),
            },
        );
        Ok(id)
    }

    pub async fn exec_call(&self, id: u32) -> Option<ToolCall> {
        self.execs
            .lock()
            .await
            .get(&id)
            .map(|entry| entry.call.clone())
    }

    pub async fn append_stdout(&self, id: u32, data: &str) -> bool {
        let mut entries = self.execs.lock().await;
        let Some(entry) = entries.get_mut(&id) else {
            return false;
        };
        entry.stdout.push_str(data);
        true
    }

    pub async fn append_stderr(&self, id: u32, data: &str) -> bool {
        let mut entries = self.execs.lock().await;
        let Some(entry) = entries.get_mut(&id) else {
            return false;
        };
        entry.stderr.push_str(data);
        true
    }

    pub(crate) async fn take_exec(&self, id: u32) -> Option<PendingExec> {
        let pending = self.execs.lock().await.remove(&id);
        if let Some(pending) = &pending {
            self.completed
                .lock()
                .await
                .insert(id, pending.call.call_id.clone());
        }
        pending
    }

    pub(crate) async fn take_interaction(&self, id: u32) -> Option<PendingInteraction> {
        let pending = self.interactions.lock().await.remove(&id);
        if let Some(pending) = &pending {
            self.completed
                .lock()
                .await
                .insert(id, pending.call.call_id.clone());
        }
        pending
    }

    pub async fn completed_call(&self, id: u32) -> Option<String> {
        self.completed.lock().await.get(&id).cloned()
    }

    pub async fn clear_completed(&self) {
        self.completed.lock().await.clear();
    }

    pub async fn discard_exec(&self, id: u32) {
        self.execs.lock().await.remove(&id);
    }

    pub async fn discard_interaction(&self, id: u32) {
        self.interactions.lock().await.remove(&id);
    }

    pub async fn drain_running(&self) -> Vec<u32> {
        let mut entries = self.execs.lock().await;
        let mut ids = entries.drain().map(|(id, _)| id).collect::<Vec<_>>();
        ids.sort_unstable();
        self.interactions.lock().await.clear();
        self.completed.lock().await.clear();
        ids
    }

    pub async fn running_exec_ids(&self) -> Vec<u32> {
        let mut ids = self.execs.lock().await.keys().copied().collect::<Vec<_>>();
        ids.sort_unstable();
        ids
    }

    pub async fn running_task_exec_id(&self, call_id: &str) -> Option<u32> {
        self.execs
            .lock()
            .await
            .iter()
            .filter_map(|(id, entry)| {
                (entry.call.call_id == call_id && entry.call.name.eq_ignore_ascii_case("Task"))
                    .then_some(*id)
            })
            .min()
    }

    fn next_id(&self) -> Result<u32> {
        self.next_id
            .fetch_add(1, Ordering::Relaxed)
            .checked_add(1)
            .ok_or_else(|| Error::Protocol("Cursor message id space exhausted".into()))
    }
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(arguments: serde_json::Value) -> ToolCall {
        ToolCall {
            index: 0,
            call_id: "task-1".into(),
            model_call_id: "model-call-1".into(),
            name: "Task".into(),
            arguments_text: arguments.to_string(),
            arguments,
        }
    }

    #[test]
    fn task_model_defaults_to_parent_and_honors_an_explicit_model() {
        let context = ExecContext {
            default_subagent_model: "parent-model".into(),
            ..ExecContext::default()
        };
        let inherited = context
            .prepare_call(&task(serde_json::json!({"prompt":"inspect"})))
            .unwrap();
        let explicit = context
            .prepare_call(&task(serde_json::json!({
                "prompt":"inspect",
                "model":"child-model"
            })))
            .unwrap();

        assert_eq!(inherited.arguments["model"], "parent-model");
        assert_eq!(explicit.arguments["model"], "child-model");
    }

    #[test]
    fn global_subagent_model_applies_to_every_task_type() {
        let context = ExecContext {
            default_subagent_model: "parent-model".into(),
            subagent_model: Some(SubagentModel::Model("child-model".into())),
            ..ExecContext::default()
        };
        let call = task(serde_json::json!({
            "prompt":"inspect",
            "subagent_type":"test-subagent"
        }));

        assert_eq!(
            context.prepare_call(&call).unwrap().arguments["model"],
            "child-model"
        );
    }

    #[test]
    fn disabled_subagents_disable_every_task_type() {
        let context = ExecContext {
            default_subagent_model: "parent-model".into(),
            subagent_model: Some(SubagentModel::Disabled),
            ..ExecContext::default()
        };
        let call = task(serde_json::json!({
            "prompt":"inspect",
            "subagent_type":"test-subagent"
        }));

        assert!(context.task_disabled(&call));
        assert!(context
            .prepare_call(&call)
            .unwrap()
            .arguments
            .get("model")
            .is_none());
    }
}
