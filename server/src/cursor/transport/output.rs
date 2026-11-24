//! Replays a complete bounded prefix and disconnects subscribers that fall behind.
use bytes::Bytes;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::cursor::protocol::connect::{self, ConnectCode, ConnectStreamError};

const REPLAY_BUDGET: usize = 64 * 1024 * 1024;

#[derive(Default)]
pub struct OutputHub {
    state: parking_lot::Mutex<OutputState>,
}

#[derive(Default)]
struct OutputState {
    history: Vec<Bytes>,
    history_bytes: usize,
    subscribers: Vec<Subscriber>,
    closed: bool,
}

struct Subscriber {
    sender: mpsc::UnboundedSender<Bytes>,
    queued: Arc<AtomicUsize>,
    overflow: CancellationToken,
}

pub struct OutputSubscription {
    receiver: mpsc::UnboundedReceiver<Bytes>,
    queued: Arc<AtomicUsize>,
    overflow: CancellationToken,
    ended: bool,
}

impl OutputSubscription {
    pub async fn recv(&mut self) -> Option<Bytes> {
        if self.ended {
            return None;
        }
        tokio::select! {
            biased;
            _ = self.overflow.cancelled() => {
                self.ended = true;
                self.receiver.close();
                while self.receiver.try_recv().is_ok() {}
                Some(connect::encode_error_end_stream(&ConnectStreamError {
                    code: ConnectCode::Unavailable,
                    message: "Cursor output replay limit exceeded. Resume from the last checkpoint.".into(),
                    details: Vec::new(),
                }).expect("static transport error encodes"))
            }
            frame = self.receiver.recv() => {
                if let Some(frame) = &frame { self.queued.fetch_sub(frame_cost(frame), Ordering::Relaxed); }
                frame
            }
        }
    }
}

fn frame_cost(frame: &Bytes) -> usize {
    // Even tiny frames use storage in the history and subscriber queues.
    frame.len().saturating_add(64)
}

impl Subscriber {
    fn push(&self, frame: &Bytes) -> bool {
        if self.sender.is_closed() {
            return false;
        }
        let cost = frame_cost(frame);
        let previous = self.queued.fetch_add(cost, Ordering::Relaxed);
        if previous.saturating_add(cost) > REPLAY_BUDGET {
            self.overflow.cancel();
            return false;
        }
        self.sender.send(frame.clone()).is_ok()
    }
}

impl OutputHub {
    pub fn emit(&self, frame: Bytes) -> bool {
        let mut state = self.state.lock();
        if state.closed {
            return false;
        }
        state.history_bytes = state.history_bytes.saturating_add(frame_cost(&frame));
        if state.history_bytes <= REPLAY_BUDGET {
            state.history.push(frame.clone());
        } else if !state.history.is_empty() {
            // A suffix may omit starts or deltas needed to decode later frames.
            state.history = Vec::new();
        }
        state
            .subscribers
            .retain(|subscriber| subscriber.push(&frame));
        true
    }

    pub fn subscribe(&self) -> OutputSubscription {
        let (sender, receiver) = mpsc::unbounded_channel();
        let mut state = self.state.lock();
        let queued = Arc::new(AtomicUsize::new(0));
        let overflow = CancellationToken::new();
        let subscriber = Subscriber {
            sender,
            queued: queued.clone(),
            overflow: overflow.clone(),
        };
        if state.history_bytes > REPLAY_BUDGET {
            overflow.cancel();
        } else {
            for frame in &state.history {
                subscriber.push(frame);
            }
            if !state.closed {
                state.subscribers.push(subscriber);
            }
        }
        OutputSubscription {
            receiver,
            queued,
            overflow,
            ended: false,
        }
    }

    pub fn close(&self) -> bool {
        let mut state = self.state.lock();
        if state.closed {
            return false;
        }
        state.closed = true;
        state.subscribers.clear();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor::protocol::connect::{decode_frames, END_STREAM_FLAG};

    #[tokio::test]
    async fn an_overrun_never_replays_an_incomplete_prefix() {
        let hub = OutputHub::default();
        let slow = hub.subscribe();
        let mut current = hub.subscribe();
        let frame = Bytes::from(vec![0; 1024 * 1024]);
        for _ in 0..65 {
            assert!(hub.emit(frame.clone()));
            assert_eq!(current.recv().await, Some(frame.clone()));
        }
        for mut subscriber in [slow, hub.subscribe()] {
            let error = subscriber.recv().await.unwrap();
            let (flags, payload) = decode_frames(&error).unwrap().pop().unwrap();
            assert_eq!(flags, END_STREAM_FLAG);
            assert!(String::from_utf8_lossy(&payload).contains("Resume from the last checkpoint"));
            assert!(subscriber.recv().await.is_none());
        }
        assert!(hub.close());
        assert!(current.recv().await.is_none());
    }
}
