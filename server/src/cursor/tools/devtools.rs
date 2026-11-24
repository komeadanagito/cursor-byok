//! Publishes the stable tool directory for BYOK's desktop DevTools MCP.

use serde::Deserialize;
use serde_json::Value;
use std::sync::LazyLock;

use crate::cursor::protocol::proto::agent::v1 as pb;

pub(crate) const SERVER: &str = "cursor-devtools";

#[derive(Deserialize)]
struct Tool {
    name: String,
    description: String,
    schema: Value,
}

static TOOLS: LazyLock<Vec<Tool>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../prompt/cursor/devtools.json"))
        .expect("built-in DevTools catalog must be valid JSON")
});

pub(crate) fn has_tool(name: &str) -> bool {
    TOOLS.iter().any(|tool| tool.name == name)
}

pub(crate) fn inject(context: &mut pb::RequestContext) {
    let options = context
        .mcp_meta_tool_options
        .get_or_insert_with(Default::default);
    options
        .mcp_descriptors
        .retain(|server| server.server_identifier != SERVER);
    options.mcp_descriptors.push(pb::McpDescriptor {
        server_name: "Cursor DevTools (desktop)".into(),
        server_identifier: SERVER.into(),
        server_use_instructions: Some(include_str!("../../../prompt/cursor/devtools.md").into()),
        tools: TOOLS
            .iter()
            .map(|tool| pb::McpToolDescriptor {
                tool_name: tool.name.clone(),
                description: Some(tool.description.clone()),
                input_schema_json: Some(tool.schema.to_string()),
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    });
}
