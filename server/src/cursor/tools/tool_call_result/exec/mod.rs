//! Coordinates command execution Tool results.
mod output;
mod render;

use crate::{
    cursor::{protocol::proto::agent::v1 as pb, tools::codec as interaction},
    model::ToolResult,
    Error, Result,
};

use super::{gate, mcp_state, ReadImage, ToolCompletion};
use crate::cursor::tools::{
    edit,
    runtime::{ExecStage, PendingExec},
};

pub(crate) fn from_exec(
    pending: PendingExec,
    wire_result: &pb::exec_client_message::Message,
) -> Result<ToolCompletion> {
    use pb::{exec_client_message::Message, tool_call::Tool};
    let mut gated_shell = matches!(
        wire_result,
        Message::ShellResult(_) | Message::MiniSweAgentBashResult(_)
    )
    .then(|| wire_result.clone());
    if let Some(message) = gated_shell.as_mut() {
        gate::exec_message(message);
    }
    let wire_result = gated_shell.as_ref().unwrap_or(wire_result);
    if let Message::McpStateExecResult(result) = wire_result {
        return mcp_state::complete(pending, result);
    }
    let call = &pending.call;
    let read_image = read_image(wire_result);
    let (mut content, is_error) = output::output(wire_result, call)?;
    if let Some(image) = &read_image {
        content = format!("Read image file: {}", image.path);
    }
    let mut rendered = match &pending.stage {
        ExecStage::DynamicMcp(definition) => {
            interaction::render_dynamic_mcp(call, definition, false)
        }
        _ => interaction::render_tool_call(call, false)?,
    };
    match (rendered.tool.as_mut(), wire_result) {
        (Some(Tool::ShellToolCall(tool)), Message::ShellResult(result))
        | (Some(Tool::ShellToolCall(tool)), Message::MiniSweAgentBashResult(result)) => {
            tool.result = Some(result.clone());
        }
        (Some(Tool::DeleteToolCall(tool)), Message::DeleteResult(result)) => {
            tool.result = Some(result.clone());
        }
        (Some(Tool::GrepToolCall(tool)), Message::GrepResult(result)) => {
            tool.result = Some(result.clone());
        }
        (Some(Tool::GlobToolCall(tool)), Message::GrepResult(result)) => {
            tool.result = Some(render::glob(result)?);
        }
        (Some(Tool::ReadToolCall(tool)), Message::ReadResult(result))
        | (Some(Tool::ReadToolCall(tool)), Message::RedactedReadResult(result)) => {
            tool.result = Some(render::read(result, call)?);
        }
        (Some(Tool::ReadLintsToolCall(tool)), Message::DiagnosticsResult(result)) => {
            tool.result = Some(render::diagnostics(result)?);
        }
        (Some(Tool::McpToolCall(tool)), Message::McpResult(result)) => {
            tool.result = Some(render::mcp(result)?);
        }
        (Some(Tool::ReadMcpResourceToolCall(tool)), Message::ReadMcpResourceExecResult(result)) => {
            tool.result = Some(result.clone());
        }
        (Some(Tool::TaskToolCall(tool)), Message::SubagentResult(result)) => {
            tool.result = Some(render::task(result, call, pending.started_at_ms)?);
        }
        (Some(Tool::EditToolCall(tool)), Message::WriteResult(result)) => {
            tool.result = Some(match (&pending.stage, result.result.as_ref()) {
                (ExecStage::EditWrite(write), Some(pb::write_result::Result::Success(success))) => {
                    edit::success(success.path.clone(), write)
                }
                _ => render::write(result)?,
            });
        }
        _ => {
            return Err(Error::Protocol(format!(
                "unexpected Exec result for tool {}",
                call.name
            )));
        }
    }
    let tool = rendered.tool.ok_or_else(|| {
        Error::Protocol(format!("tool {} has no Cursor representation", call.name))
    })?;
    let mut completion = ToolCompletion::new(
        call,
        pending.started_at_ms,
        ToolResult {
            call_id: call.call_id.clone(),
            content,
            is_error,
            parts: Vec::new(),
            image: None,
        },
        tool,
    )
    .with_read_image(read_image);
    if let Message::McpResult(result) = wire_result {
        if let Some(pb::mcp_result::Result::Success(success)) = &result.result {
            let images = success
                .content
                .iter()
                .filter_map(|item| match &item.content {
                    Some(pb::mcp_tool_result_content_item::Content::Image(image))
                        if !image.data.is_empty() =>
                    {
                        Some(crate::model::ContentPart::Image {
                            mime_type: image.mime_type.clone(),
                            data: image.data.clone(),
                        })
                    }
                    _ => None,
                });
            completion.result.parts.extend(images);
            if !completion.result.parts.is_empty() {
                completion.result.parts.insert(
                    0,
                    crate::model::ContentPart::Text {
                        text: completion.result.content.clone(),
                    },
                );
            }
        }
    }
    Ok(completion)
}

fn read_image(message: &pb::exec_client_message::Message) -> Option<ReadImage> {
    use pb::{exec_client_message::Message, read_result::Result, read_success::Output};
    let result = match message {
        Message::ReadResult(result) | Message::RedactedReadResult(result) => result,
        _ => return None,
    };
    let Result::Success(success) = result.result.as_ref()? else {
        return None;
    };
    let Output::Data(data) = success.output.as_ref()? else {
        return None;
    };
    Some(ReadImage {
        mime_type: image_mime_type(data)?.into(),
        data: data.clone(),
        path: success.path.clone(),
    })
}

fn image_mime_type(data: &[u8]) -> Option<&'static str> {
    let reader = image::ImageReader::new(std::io::Cursor::new(data))
        .with_guessed_format()
        .ok()?;
    let format = reader.format()?;
    let (width, height) = reader.into_dimensions().ok()?;
    if width == 0 || height == 0 {
        return None;
    }
    match format {
        image::ImageFormat::Png => Some("image/png"),
        image::ImageFormat::Jpeg => Some("image/jpeg"),
        image::ImageFormat::Gif => Some("image/gif"),
        image::ImageFormat::WebP => Some("image/webp"),
        _ => None,
    }
}

pub(crate) fn edit_failure(pending: PendingExec, error: String) -> Result<ToolCompletion> {
    let call = &pending.call;
    let mut rendered = interaction::render_tool_call(call, false)?;
    let Some(pb::tool_call::Tool::EditToolCall(mut tool)) = rendered.tool.take() else {
        return Err(Error::Protocol(format!(
            "{} is not an edit tool",
            call.name
        )));
    };
    tool.result = Some(edit::failure(edit::path(call)?, error.clone()));
    Ok(ToolCompletion::new(
        call,
        pending.started_at_ms,
        ToolResult {
            call_id: call.call_id.clone(),
            content: error,
            is_error: true,
            parts: Vec::new(),
            image: None,
        },
        pb::tool_call::Tool::EditToolCall(tool),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ContentPart, ToolCall};
    #[test]
    fn mcp_screenshots_survive_the_tool_card_display_limit() {
        let data = vec![32; 40_000];
        let message = pb::exec_client_message::Message::McpResult(pb::McpResult {
            result: Some(pb::mcp_result::Result::Success(pb::McpSuccess {
                content: [data.clone(), vec![1, 2, 3]]
                    .into_iter()
                    .map(|data| pb::McpToolResultContentItem {
                        content: Some(pb::mcp_tool_result_content_item::Content::Image(
                            pb::McpImageContent {
                                data,
                                mime_type: "image/png".into(),
                            },
                        )),
                    })
                    .collect(),
                ..Default::default()
            })),
        });
        let pending = PendingExec {
            call: ToolCall {
                index: 0,
                call_id: "screen".into(),
                model_call_id: "main".into(),
                name: "screen".into(),
                arguments: serde_json::json!({}),
                arguments_text: "{}".into(),
                argument_error: None,
            },
            stage: ExecStage::DynamicMcp(Default::default()),
            context: Default::default(),
            started_at_ms: 0,
            stdout: String::new(),
            stderr: String::new(),
        };
        let completion = from_exec(pending, &message).unwrap();
        let images: Vec<_> = completion
            .result()
            .parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Image { data, .. } => Some(data.as_slice()),
                _ => None,
            })
            .collect();
        assert_eq!(images, [data.as_slice(), &[1, 2, 3]]);
    }
}
