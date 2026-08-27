use tokio::sync::oneshot;

use crate::model::{CanonicalMessage, RuntimeEvent, ToolResult};

#[derive(Debug)]
pub struct MessageInsertion {
    pub messages: Vec<CanonicalMessage>,
    pub delivered: oneshot::Sender<()>,
}

#[derive(Debug)]
pub enum ClientCommand {
    ToolResult(ToolResult),
    RuntimeMessage(CanonicalMessage),
    RuntimeEvent(RuntimeEvent),
    InsertMessages(MessageInsertion),
    ClientClosed { error: String },
    Cancel,
}
