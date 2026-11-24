//! Implements the Anthropic provider adapter.
use async_stream::try_stream;
use base64::{engine::general_purpose::STANDARD, Engine};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde_json::{json, Value};

use crate::{
    config::ProviderConfig,
    model::{ContentPart, ModelInvocation, ProjectedContent, ProjectedMessage, Role, Usage},
    Error, Result,
};

use super::{
    attempt::{send_once, Attempt},
    map_sse_error, merge_extra_params, provider_event_error,
    recorder::recorded_headers,
    CallRecorder, FinishReason, ModelEvent, Provider, ProviderStream,
};

const DEFAULT_MAX_OUTPUT_TOKENS: u64 = 65_000;

pub struct AnthropicProvider {
    client: reqwest::Client,
    config: ProviderConfig,
    recorder: Option<CallRecorder>,
}

impl AnthropicProvider {
    pub fn new(client: reqwest::Client, config: ProviderConfig) -> Self {
        Self {
            client,
            config,
            recorder: None,
        }
    }

    pub fn with_recorder(mut self, recorder: Option<CallRecorder>) -> Self {
        self.recorder = recorder;
        self
    }
}

impl Provider for AnthropicProvider {
    fn stream(
        &self,
        invocation: ModelInvocation,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> ProviderStream {
        let client = self.client.clone();
        let config = self.config.clone();
        let recorder = self.recorder.clone();
        Box::pin(try_stream! {
            let ModelInvocation { call_id, request, .. } = invocation;
            let mut messages = anthropic_messages(&request.history)?;
            mark_cache_breakpoint(&mut messages);
            let system = if request.prompt.instructions.is_empty() {
                Value::String(String::new())
            } else {
                json!([{
                    "type": "text",
                    "text": request.prompt.instructions,
                    "cache_control": {"type": "ephemeral"}
                }])
            };
            let max_tokens = request.model.max_output_tokens.or(config.max_output_tokens)
                .unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS);
            let mut body = json!({
                "model": request.model.model_id, "system": system, "messages": messages,
                "max_tokens": max_tokens, "stream": true
            });
            if !request.prompt.tools.is_empty() {
                let tool_count = request.prompt.tools.len();
                body["tools"] = json!(request.prompt.tools.iter().enumerate().map(|(index, tool)| {
                    let mut value = json!({
                        "name": tool.name, "description": tool.description, "input_schema": tool.parameters
                    });
                    if index + 1 == tool_count {
                        value["cache_control"] = json!({"type": "ephemeral"});
                    }
                    value
                }).collect::<Vec<_>>());
            }
            apply_model(&mut body, &request.model)?;
            merge_extra_params(&mut body, &request.model.extra_params)?;
            let request_headers = recorded_headers(
                &config,
                &[("content-type", "application/json"), ("anthropic-version", "2023-06-01")],
            );
            if let Some(recorder) = &recorder {
                recorder.request(request_headers.clone(), &body).await?;
            }
            let attempt = send_once(
                "Anthropic",
                || client.post(&config.request_url)
                    .header("x-api-key", &config.api_key).header("anthropic-version", "2023-06-01")
                    .headers(config.custom_headers.clone())
                    .json(&body),
                &cancellation,
                recorder.as_ref(),
            ).await?;
            let Attempt::Response(response) = attempt else { return };
            yield ModelEvent::Start { model_call_id: call_id };
            let chunk_recorder = recorder.clone();
            let chunks = response.bytes_stream()
                .map(|chunk| chunk.map_err(Error::from))
                .then(move |chunk| {
                    let recorder = chunk_recorder.clone();
                    async move {
                        let chunk = chunk?;
                        if let Some(recorder) = recorder { recorder.response_chunk(&chunk).await?; }
                        Ok::<_, Error>(chunk)
                    }
                });
            let source = chunks.eventsource();
            futures_util::pin_mut!(source);
            let mut block_types = std::collections::BTreeMap::<usize, String>::new();
            let mut thinking_text = std::collections::HashMap::<usize, String>::new();
            let mut thinking_signatures = std::collections::HashMap::<usize, String>::new();
            let mut thinking_blocks = Vec::new();
            let mut finish = None;
            let mut saw_tool = false;
            let mut refused = false;
            let mut terminal = false;
            let mut final_usage = None::<Usage>;
            while let Some(event) = tokio::select! {
                _ = cancellation.cancelled() => { return; }
                event = source.next() => event,
            } {
                let event = event.map_err(|error| map_sse_error("Anthropic", error))?;
                let value: Value = serde_json::from_str(&event.data)?;
                if let Some(error) = provider_event_error("Anthropic", &value) {
                    Err(error)?;
                }
                let data_kind = value.get("type").and_then(Value::as_str);
                let kind = match event.event.as_str() {
                    "" | "message" => data_kind.unwrap_or(event.event.as_str()),
                    kind => kind,
                };
                match kind {
                    "message_start" => if let Some(usage) = value.pointer("/message/usage") {
                        merge_usage(final_usage.get_or_insert_default(), anthropic_usage(usage));
                    },
                    "content_block_start" => {
                        let index = required_u64(&value, "index")? as usize;
                        let block = value.get("content_block").unwrap_or(&Value::Null);
                        let kind = required_string(block, "type")?;
                        block_types.insert(index, kind.into());
                        match kind {
                            "text" => yield ModelEvent::TextStart,
                            "thinking" => {
                                thinking_text.insert(index, String::new());
                                thinking_signatures.insert(index, String::new());
                                yield ModelEvent::ThinkingStart;
                            }
                            "redacted_thinking" => thinking_blocks.push(block.clone()),
                            "tool_use" => {
                                saw_tool = true;
                                yield ModelEvent::ToolCallStart {
                                    index,
                                    call_id: required_string(block, "id")?.into(),
                                    name: required_string(block, "name")?.into(),
                                };
                            }
                            _ => {}
                        }
                    }
                    "content_block_delta" => {
                        let index = required_u64(&value, "index")? as usize;
                        let delta = value.get("delta").unwrap_or(&Value::Null);
                        let delta_kind = required_string(delta, "type")?;
                        if let std::collections::btree_map::Entry::Vacant(entry) = block_types.entry(index) {
                            match delta_kind {
                                "text_delta" => {
                                    entry.insert("text".into());
                                    yield ModelEvent::TextStart;
                                }
                                "thinking_delta" | "signature_delta" => {
                                    entry.insert("thinking".into());
                                    thinking_text.insert(index, String::new());
                                    thinking_signatures.insert(index, String::new());
                                    yield ModelEvent::ThinkingStart;
                                }
                                _ => {}
                            }
                        }
                        match delta_kind {
                            "text_delta" => if let Some(text) = delta.get("text").and_then(Value::as_str) { yield ModelEvent::TextDelta(text.into()); },
                            "thinking_delta" => if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                                thinking_text.entry(index).or_default().push_str(text);
                                yield ModelEvent::ThinkingDelta(text.into());
                            },
                            "signature_delta" => if let Some(signature) = delta.get("signature").and_then(Value::as_str) {
                                thinking_signatures.entry(index).or_default().push_str(signature);
                            },
                            "input_json_delta" => if let Some(text) = delta.get("partial_json").and_then(Value::as_str) { yield ModelEvent::ToolCallArgumentsDelta { index, delta: text.into() }; },
                            _ => {}
                        }
                    }
                    "content_block_stop" => {
                        let index = required_u64(&value, "index")? as usize;
                        if let Some(kind) = block_types.remove(&index) {
                            for event in close_anthropic_block(index, &kind, &mut thinking_text, &mut thinking_signatures, &mut thinking_blocks) {
                                yield event;
                            }
                        }
                    }
                    "message_delta" => {
                        if let Some(usage) = value.get("usage") {
                            merge_usage(final_usage.get_or_insert_default(), anthropic_usage(usage));
                        }
                        let reason = value.pointer("/delta/stop_reason").and_then(Value::as_str);
                        refused |= reason == Some("refusal");
                        finish = match reason {
                            Some("tool_use") => Some(FinishReason::ToolUse),
                            Some("max_tokens" | "model_context_window_exceeded") => Some(FinishReason::Length),
                            Some("end_turn" | "stop_sequence" | "pause_turn" | "refusal") => Some(FinishReason::Stop),
                            None => finish,
                            Some(_) => Some(if saw_tool { FinishReason::ToolUse } else { FinishReason::Stop }),
                        };
                    }
                    "message_stop" => {
                        for (index, kind) in std::mem::take(&mut block_types) {
                            for event in close_anthropic_block(index, &kind, &mut thinking_text, &mut thinking_signatures, &mut thinking_blocks) {
                                yield event;
                            }
                        }
                        terminal = true;
                        if !thinking_blocks.is_empty() {
                            yield ModelEvent::ProviderReplayState(
                                crate::model::ProviderReplayState {
                                    provider_kind: "anthropic".into(),
                                    value: json!({"blocks": std::mem::take(&mut thinking_blocks)}),
                                },
                            );
                        }
                        if let Some(usage) = final_usage {
                            yield ModelEvent::Usage(usage);
                        }
                        yield ModelEvent::Done(final_finish(finish, saw_tool, refused)?);
                    }
                    _ => {}
                }
            }
            if !terminal && finish.is_some() {
                for (index, kind) in std::mem::take(&mut block_types) {
                    for event in close_anthropic_block(index, &kind, &mut thinking_text, &mut thinking_signatures, &mut thinking_blocks) {
                        yield event;
                    }
                }
                if !thinking_blocks.is_empty() {
                    yield ModelEvent::ProviderReplayState(crate::model::ProviderReplayState {
                        provider_kind: "anthropic".into(),
                        value: json!({"blocks": std::mem::take(&mut thinking_blocks)}),
                    });
                }
                if let Some(usage) = final_usage { yield ModelEvent::Usage(usage); }
                terminal = true;
                yield ModelEvent::Done(final_finish(finish, saw_tool, refused)?);
            }
            if !terminal {
                Err(Error::Provider("Anthropic stream ended without message_stop".into()))?;
            }
        })
    }
}

fn final_finish(
    finish: Option<FinishReason>,
    saw_tool: bool,
    refused: bool,
) -> Result<FinishReason> {
    if refused {
        return if saw_tool {
            Err(Error::ProviderRefusal(
                "Anthropic refused the tool turn".into(),
            ))
        } else {
            Ok(FinishReason::Stop)
        };
    }
    Ok(match finish {
        Some(FinishReason::Length) => FinishReason::Length,
        _ if saw_tool => FinishReason::ToolUse,
        reason => reason.unwrap_or(FinishReason::Stop),
    })
}

fn close_anthropic_block(
    index: usize,
    kind: &str,
    thinking_text: &mut std::collections::HashMap<usize, String>,
    thinking_signatures: &mut std::collections::HashMap<usize, String>,
    thinking_blocks: &mut Vec<Value>,
) -> Vec<ModelEvent> {
    match kind {
        "text" => vec![ModelEvent::TextEnd],
        "thinking" => {
            let thinking = thinking_text.remove(&index).unwrap_or_default();
            let signature = thinking_signatures.remove(&index).unwrap_or_default();
            if !signature.is_empty() {
                thinking_blocks.push(json!({
                    "type": "thinking",
                    "thinking": thinking,
                    "signature": signature,
                }));
            }
            vec![ModelEvent::ThinkingEnd]
        }
        "tool_use" => vec![ModelEvent::ToolCallEnd { index }],
        _ => Vec::new(),
    }
}

fn apply_model(body: &mut Value, model: &crate::model::ModelSpec) -> Result<()> {
    let object = body
        .as_object_mut()
        .ok_or_else(|| Error::Provider("Anthropic request body is not an object".into()))?;
    if model.reasoning.enabled {
        object.insert(
            "thinking".into(),
            json!({"type":"adaptive", "display":"summarized"}),
        );
    }
    if let Some(effort) = &model.reasoning.effort {
        object.insert("output_config".into(), json!({"effort":effort}));
    }
    Ok(())
}

fn merge_usage(total: &mut Usage, update: Usage) {
    merge_usage_field(&mut total.input_tokens, update.input_tokens);
    merge_usage_field(&mut total.output_tokens, update.output_tokens);
    merge_usage_field(&mut total.total_tokens, update.total_tokens);
    merge_usage_field(&mut total.cache_read_tokens, update.cache_read_tokens);
    merge_usage_field(&mut total.cache_write_tokens, update.cache_write_tokens);
    merge_usage_field(&mut total.reasoning_tokens, update.reasoning_tokens);
    // Cache counts and uncached input can be reported in separate SSE events.
    total.context_input_tokens = context_input_tokens(total);
    if let Some(request_tokens) = total
        .context_input_tokens
        .zip(total.output_tokens)
        .and_then(|(input, output)| input.checked_add(output))
    {
        total.total_tokens = Some(request_tokens);
    }
}

fn merge_usage_field(total: &mut Option<u64>, update: Option<u64>) {
    if let Some(update) = update {
        *total = Some(total.map_or(update, |current| current.max(update)));
    }
}

fn anthropic_messages(messages: &[ProjectedMessage]) -> Result<Vec<Value>> {
    let mut output = Vec::new();
    for message in messages {
        match &message.content {
            ProjectedContent::Parts(parts) => {
                let content = anthropic_parts(&message.role, parts)?;
                if !content.is_empty() {
                    push_anthropic(&mut output, role_name(&message.role), content);
                }
            }
            ProjectedContent::ToolResult(result) => {
                let content = if result.provider_parts.is_empty() {
                    Value::String(result.content.clone())
                } else {
                    Value::Array(anthropic_parts(&Role::User, &result.provider_parts)?)
                };
                let mut block =
                    json!({"type":"tool_result", "tool_use_id":result.call_id,"content":content});
                if result.is_error {
                    block["is_error"] = Value::Bool(true);
                }
                push_anthropic(&mut output, "user", vec![block]);
            }
            ProjectedContent::Assistant {
                text,
                replay_state,
                calls,
                ..
            } => {
                let mut content = Vec::new();
                if let Some(blocks) = replay_state
                    .as_ref()
                    .filter(|state| state.provider_kind == "anthropic")
                    .and_then(|state| state.value.get("blocks"))
                    .and_then(Value::as_array)
                {
                    content.extend(blocks.iter().cloned());
                }
                if !text.is_empty() {
                    content.push(json!({"type": "text", "text": text}));
                }
                content.extend(calls.iter().map(|call| {
                    json!({
                        "type": "tool_use",
                        "id": call.call_id,
                        "name": call.name,
                        "input": call.arguments,
                    })
                }));
                if !content.is_empty() {
                    push_anthropic(&mut output, "assistant", content);
                }
            }
        }
    }
    Ok(output)
}

fn mark_cache_breakpoint(messages: &mut [Value]) {
    let Some(message) = messages
        .iter_mut()
        .rev()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
    else {
        return;
    };
    let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) else {
        return;
    };
    for block in content.iter_mut().rev() {
        let kind = block.get("type").and_then(Value::as_str);
        if !matches!(kind, Some("text" | "image" | "tool_result")) {
            continue;
        }
        if let Some(block) = block.as_object_mut() {
            block.insert("cache_control".into(), json!({"type": "ephemeral"}));
            return;
        }
    }
}

fn anthropic_parts(role: &Role, parts: &[ContentPart]) -> Result<Vec<Value>> {
    parts
        .iter()
        .filter_map(|part| match part {
            ContentPart::Text { text } if text.is_empty() => None,
            ContentPart::Text { text } => Some(Ok(json!({"type":"text", "text":text}))),
            ContentPart::Image { mime_type, data } if *role == Role::User => Some(Ok(json!({
                "type":"image",
                "source":{
                    "type":"base64",
                    "media_type":mime_type,
                    "data":STANDARD.encode(data),
                },
            }))),
            ContentPart::Image { .. } => Some(Err(Error::Protocol(
                "Anthropic only accepts images in user messages".into(),
            ))),
        })
        .collect()
}

fn push_anthropic(output: &mut Vec<Value>, role: &str, mut content: Vec<Value>) {
    if let Some(last) = output
        .last_mut()
        .filter(|last| last.get("role").and_then(Value::as_str) == Some(role))
    {
        if let Some(existing) = last.get_mut("content").and_then(Value::as_array_mut) {
            existing.append(&mut content);
            return;
        }
    }
    output.push(json!({"role":role, "content":content}));
}

fn role_name(role: &Role) -> &'static str {
    match role {
        Role::System => "user",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "user",
    }
}

fn required_string<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Provider(format!("Anthropic event is missing {name}")))
}

fn required_u64(value: &Value, name: &str) -> Result<u64> {
    value
        .get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| Error::Provider(format!("Anthropic event is missing {name}")))
}

pub(crate) fn anthropic_usage(value: &Value) -> Usage {
    let input_tokens = value.get("input_tokens").and_then(Value::as_u64);
    let cache_read_tokens = value.get("cache_read_input_tokens").and_then(Value::as_u64);
    let cache_write_tokens = value
        .get("cache_creation_input_tokens")
        .and_then(Value::as_u64);
    let mut usage = Usage {
        input_tokens,
        output_tokens: value.get("output_tokens").and_then(Value::as_u64),
        total_tokens: value.get("total_tokens").and_then(Value::as_u64),
        cache_read_tokens,
        cache_write_tokens,
        ..Usage::default()
    };
    usage.context_input_tokens = context_input_tokens(&usage);
    usage
}

fn context_input_tokens(usage: &Usage) -> Option<u64> {
    usage.input_tokens.map(|input| {
        input
            .saturating_add(usage.cache_read_tokens.unwrap_or_default())
            .saturating_add(usage.cache_write_tokens.unwrap_or_default())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn wire_prefix_survives_a_tool_round_and_refused_tools_are_never_authorized() {
        use crate::model::{
            ModelRequest, ModelSpec, PromptSpec, ToolCallContent, ToolResultContent,
        };
        use axum::{routing::post, Json, Router};
        use tokio_util::sync::CancellationToken;
        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        let app = Router::new().route("/v1/messages", post(move |Json(body): Json<Value>| {
            let tx = tx.clone();
            async move {
                tx.send(body).await.unwrap();
                let events = [
                    json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"pending","name":"Read","input":{}}}),
                    json!({"type":"content_block_stop","index":0}),
                    json!({"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":4}}),
                    json!({"type":"message_stop"}),
                ];
                ([("content-type","text/event-stream")], events.iter().map(|event| format!("data: {event}\n\n")).collect::<String>())
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1/messages", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let provider = AnthropicProvider::new(
            reqwest::Client::builder().no_proxy().build().unwrap(),
            ProviderConfig {
                kind: crate::config::ProviderKind::Anthropic,
                request_url: url,
                api_key: "test".into(),
                custom_headers: Default::default(),
                max_output_tokens: Some(512),
                request_timeout: std::time::Duration::from_secs(2),
                allowed_body_fields: None,
            },
        );
        let mut invocation = ModelInvocation {
            call_id: "call".into(),
            run_id: "run".into(),
            conversation_id: "thread".into(),
            provider_call_index: 0,
            request: ModelRequest {
                model: ModelSpec::new("fixture"),
                prompt: PromptSpec {
                    instructions: "system".into(),
                    tools: vec![crate::model::ToolDefinition {
                        name: "Read".into(),
                        description: "Read test fixtures".into(),
                        parameters: json!({"type":"object"}),
                    }],
                },
                history: vec![ProjectedMessage {
                    message_id: "u".into(),
                    role: Role::User,
                    content: ProjectedContent::Parts(vec![ContentPart::Text {
                        text: "read two fixtures".into(),
                    }]),
                }],
            },
        };
        let cancellation = CancellationToken::new();
        let first = provider
            .stream(invocation.clone(), cancellation.clone())
            .collect::<Vec<_>>()
            .await;
        let calls = ["ok", "failed"]
            .iter()
            .enumerate()
            .map(|(index, id)| ToolCallContent {
                index,
                call_id: (*id).into(),
                name: "Read".into(),
                arguments: json!({"path":"file"}),
            })
            .collect();
        invocation.request.history.push(ProjectedMessage {
            message_id: "a".into(),
            role: Role::Assistant,
            content: ProjectedContent::Assistant {
                text: String::new(),
                thinking: String::new(),
                replay_state: None,
                calls,
            },
        });
        for id in ["ok", "failed"] {
            invocation.request.history.push(ProjectedMessage {
                message_id: id.into(),
                role: Role::Tool,
                content: ProjectedContent::ToolResult(ToolResultContent {
                    call_id: id.into(),
                    name: "Read".into(),
                    content: id.into(),
                    is_error: id == "failed",
                    image: None,
                    provider_parts: Vec::new(),
                }),
            });
        }
        let (tx_events, _rx_events) = tokio::sync::mpsc::channel(16);
        let failure = crate::run::consume_model_cycle(
            provider.stream(invocation, cancellation.clone()),
            &tx_events,
            &cancellation,
        )
        .await;
        let mut before = rx.recv().await.unwrap();
        let after = rx.recv().await.unwrap();
        before["messages"][0]["content"][0]
            .as_object_mut()
            .unwrap()
            .remove("cache_control");
        assert_eq!(before["messages"][0], after["messages"][0]);
        assert_eq!(before["system"], after["system"]);
        assert_eq!(before["tools"], after["tools"]);
        assert_eq!(after["messages"][2]["content"][0]["tool_use_id"], "ok");
        assert_eq!(after["messages"][2]["content"][1]["tool_use_id"], "failed");
        assert_eq!(after["messages"][2]["content"][1]["is_error"], true);
        assert!(!first
            .iter()
            .any(|e| matches!(e, Ok(ModelEvent::Done(FinishReason::ToolUse)))));
        let failure = failure.expect_err("An Anthropic refusal must not authorize buffered tools");
        assert!(!failure.retryable);
        assert_eq!(failure.usage.unwrap().output_tokens, Some(4));
        server.abort();
    }

    #[test]
    fn cached_tokens_are_included_once_in_anthropic_context_input() {
        let usage = anthropic_usage(&serde_json::json!({
            "input_tokens": 10,
            "output_tokens": 5,
            "cache_read_input_tokens": 20,
            "cache_creation_input_tokens": 30
        }));

        assert_eq!(usage.input_tokens, Some(10));
        assert_eq!(usage.context_input_tokens, Some(60));
        assert_eq!(usage.output_tokens, Some(5));
    }

    #[test]
    fn split_usage_events_count_cache_reads_and_writes_in_the_request_total() {
        let mut usage = Usage::default();
        merge_usage(
            &mut usage,
            anthropic_usage(&json!({"input_tokens": 100, "output_tokens": 0})),
        );
        merge_usage(
            &mut usage,
            anthropic_usage(
                &json!({"cache_read_input_tokens": 9500, "cache_creation_input_tokens": 400, "output_tokens": 17}),
            ),
        );
        assert_eq!(usage.context_input_tokens, Some(10_000));
        assert_eq!(usage.total_tokens, Some(10_017));
    }

    #[test]
    fn streamed_anthropic_usage_includes_cached_input_in_total() {
        let mut usage = Usage::default();
        merge_usage(
            &mut usage,
            anthropic_usage(&serde_json::json!({
                "input_tokens": 414,
                "output_tokens": 0,
                "cache_read_input_tokens": 100_352,
                "cache_creation_input_tokens": 0
            })),
        );
        merge_usage(
            &mut usage,
            anthropic_usage(&serde_json::json!({"output_tokens": 191})),
        );

        assert_eq!(usage.input_tokens, Some(414));
        assert_eq!(usage.cache_read_tokens, Some(100_352));
        assert_eq!(usage.cache_write_tokens, Some(0));
        assert_eq!(usage.context_input_tokens, Some(100_766));
        assert_eq!(usage.output_tokens, Some(191));
        assert_eq!(usage.total_tokens, Some(100_957));
    }
}
