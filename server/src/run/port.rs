//! Defines the channel boundary between a Run and its adapter.

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::model::RunId;

use super::{CheckpointHistory, RunCommand, RunEvent, RunHandle, RunPhaseControl};

pub struct RunPort {
    pub commands: mpsc::UnboundedReceiver<RunCommand>,
    pub events: mpsc::Sender<RunEvent>,
    pub(crate) phase: RunPhaseControl,
    pub(crate) history: CheckpointHistory,
}

pub struct RunSession {
    pub events: mpsc::Receiver<RunEvent>,
    pub(crate) history: CheckpointHistory,
}

pub fn channel(run_id: RunId, capacity: usize) -> (RunPort, RunSession, RunHandle) {
    let (commands_tx, commands_rx) = mpsc::unbounded_channel();
    let (events_tx, events_rx) = mpsc::channel(capacity);
    let phase = RunPhaseControl::new();
    let cancellation = CancellationToken::new();
    let handle = RunHandle::new(run_id, phase.clone(), commands_tx, cancellation.clone());
    let history = CheckpointHistory::default();
    (
        RunPort {
            commands: commands_rx,
            events: events_tx,
            phase,
            history: history.clone(),
        },
        RunSession {
            events: events_rx,
            history,
        },
        handle,
    )
}
