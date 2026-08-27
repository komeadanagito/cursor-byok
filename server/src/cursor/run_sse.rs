use axum::{
    body::Body,
    http::{header, HeaderValue, Response, StatusCode},
};
use bytes::Bytes;
use std::convert::Infallible;
use tokio::sync::mpsc;
use tokio_stream::StreamExt;
use tokio_util::sync::CancellationToken;

use crate::{
    cursor::{
        connect::{self, END_STREAM_FLAG},
        observability::CursorTraceRecorder,
        CursorSessionRegistry,
    },
    Result,
};

pub async fn stream(registry: &CursorSessionRegistry, request_id: &str) -> Result<Response<Body>> {
    let handle = registry.get_or_create(request_id).await?;
    let receiver = handle.subscribe();
    let trace = handle.trace().cloned();
    if let Some(trace) = &trace {
        trace.response_started(StatusCode::OK.as_u16()).await;
    }
    let body_stream = local_body_stream(receiver, handle.cancellation(), trace);
    let mut response = Response::new(Body::from_stream(body_stream));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
        .headers_mut()
        .insert("connect-protocol-version", HeaderValue::from_static("1"));
    Ok(response)
}

fn local_body_stream(
    mut receiver: mpsc::UnboundedReceiver<Bytes>,
    cancellation: CancellationToken,
    trace: Option<CursorTraceRecorder>,
) -> impl tokio_stream::Stream<Item = std::result::Result<Bytes, Infallible>> {
    async_stream::stream! {
        let mut guard = LocalRunGuard::new(cancellation);
        let mut trace = TraceStreamSink::new(trace, "byok_server");
        while let Some(chunk) = receiver.recv().await {
            let terminal = is_end_stream_frame(&chunk);
            trace.chunk(&chunk);
            if terminal {
                guard.complete();
                trace.finish(end_stream_error(&chunk));
            }
            yield Ok::<Bytes, Infallible>(chunk);
            if terminal {
                return;
            }
        }
        guard.complete();
        trace.finish(None);
    }
}

fn is_end_stream_frame(frame: &Bytes) -> bool {
    frame
        .first()
        .is_some_and(|flags| flags & END_STREAM_FLAG != 0)
}

fn end_stream_error(frame: &Bytes) -> Option<String> {
    connect::decode_frames(frame)
        .ok()?
        .into_iter()
        .find_map(|(flags, payload)| {
            if flags & END_STREAM_FLAG == 0 {
                return None;
            }
            let value = serde_json::from_slice::<serde_json::Value>(&payload).ok()?;
            let error = value.get("error")?;
            let code = error.get("code").and_then(serde_json::Value::as_str);
            let message = error
                .get("message")
                .and_then(serde_json::Value::as_str)
                .filter(|message| !message.is_empty());
            Some(match (code, message) {
                (Some(code), Some(message)) => format!("{code}: {message}"),
                (Some(code), None) => code.to_string(),
                (None, Some(message)) => message.to_string(),
                (None, None) => error.to_string(),
            })
        })
}

struct LocalRunGuard {
    cancellation: CancellationToken,
    completed: bool,
}

impl LocalRunGuard {
    fn new(cancellation: CancellationToken) -> Self {
        Self {
            cancellation,
            completed: false,
        }
    }

    fn complete(&mut self) {
        self.completed = true;
    }
}

impl Drop for LocalRunGuard {
    fn drop(&mut self) {
        if !self.completed {
            self.cancellation.cancel();
        }
    }
}

pub async fn upstream(
    registry: CursorSessionRegistry,
    request_id: String,
    generation: u64,
    response: Response<Body>,
    trace: Option<CursorTraceRecorder>,
) -> Response<Body> {
    let (parts, body) = response.into_parts();
    if let Some(trace) = &trace {
        trace.response_started(parts.status.as_u16()).await;
    }
    let stream = async_stream::stream! {
        let _guard = UpstreamRunGuard {
            registry,
            request_id,
            generation,
        };
        let mut trace = TraceStreamSink::new(trace, "cursor_official");
        let mut body = body.into_data_stream();
        while let Some(chunk) = body.next().await {
            match chunk {
                Ok(chunk) => {
                    trace.chunk(&chunk);
                    yield Ok::<Bytes, axum::Error>(chunk);
                }
                Err(error) => {
                    trace.finish(Some(error.to_string()));
                    yield Err(error);
                    return;
                }
            }
        }
        trace.finish(None);
    };
    Response::from_parts(parts, Body::from_stream(stream))
}

enum TraceStreamEvent {
    Chunk(Bytes),
    Finish(Option<String>),
}

struct TraceStreamSink {
    sender: Option<mpsc::UnboundedSender<TraceStreamEvent>>,
}

impl TraceStreamSink {
    fn new(trace: Option<CursorTraceRecorder>, source: &'static str) -> Self {
        let Some(trace) = trace else {
            return Self { sender: None };
        };
        let (sender, mut receiver) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(event) = receiver.recv().await {
                match event {
                    TraceStreamEvent::Chunk(chunk) => {
                        trace.response_chunk(source, &chunk).await;
                    }
                    TraceStreamEvent::Finish(error) => {
                        trace.finish(error.as_deref()).await;
                        return;
                    }
                }
            }
            trace.finish(None).await;
        });
        Self {
            sender: Some(sender),
        }
    }

    fn chunk(&self, chunk: &Bytes) {
        if let Some(sender) = &self.sender {
            let _ = sender.send(TraceStreamEvent::Chunk(chunk.clone()));
        }
    }

    fn finish(&mut self, error: Option<String>) {
        if let Some(sender) = self.sender.take() {
            let _ = sender.send(TraceStreamEvent::Finish(error));
        }
    }
}

impl Drop for TraceStreamSink {
    fn drop(&mut self) {
        if self.sender.is_some() {
            self.finish(Some(
                "response stream dropped before completion".to_string(),
            ));
        }
    }
}

struct UpstreamRunGuard {
    registry: CursorSessionRegistry,
    request_id: String,
    generation: u64,
}

impl Drop for UpstreamRunGuard {
    fn drop(&mut self) {
        self.registry
            .finish_upstream(self.request_id.clone(), self.generation);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor::{connect, proto::agent::v1 as pb};

    #[tokio::test]
    async fn local_stream_cancels_when_the_client_disconnects() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let cancellation = CancellationToken::new();
        sender
            .send(connect::encode_message(&pb::AgentServerMessage::default()).unwrap())
            .unwrap();
        let mut stream = Box::pin(local_body_stream(receiver, cancellation.clone(), None));

        stream.next().await.unwrap().unwrap();

        drop(sender);
        drop(stream);
        assert!(cancellation.is_cancelled());
    }

    #[tokio::test]
    async fn terminal_frame_does_not_cancel_a_completed_local_run() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let cancellation = CancellationToken::new();
        sender.send(connect::encode_end_stream()).unwrap();
        let mut stream = Box::pin(local_body_stream(receiver, cancellation.clone(), None));

        let terminal = stream.next().await.unwrap().unwrap();
        assert!(is_end_stream_frame(&terminal));
        drop(stream);
        assert!(!cancellation.is_cancelled());
    }

    #[test]
    fn connect_error_end_stream_exposes_the_trace_error() {
        let frame = connect::encode_error_end_stream(&connect::ConnectStreamError {
            code: connect::ConnectCode::InvalidArgument,
            message: "unsupported runtime action".into(),
            details: Vec::new(),
        })
        .unwrap();

        assert_eq!(
            end_stream_error(&frame).as_deref(),
            Some("invalid_argument: unsupported runtime action")
        );
        assert_eq!(end_stream_error(&connect::encode_end_stream()), None);
    }

    #[tokio::test]
    async fn connect_error_end_stream_marks_the_local_trace_as_error() {
        let store = crate::store::Store::connect("sqlite::memory:")
            .await
            .unwrap();
        store.set_detailed_logging(true).await.unwrap();
        let trace = CursorTraceRecorder::begin(
            store.clone(),
            "error-trace",
            Some("conversation"),
            "local_byok",
            Some("model"),
        )
        .await
        .unwrap();
        let (sender, receiver) = mpsc::unbounded_channel();
        let cancellation = CancellationToken::new();
        sender
            .send(
                connect::encode_error_end_stream(&connect::ConnectStreamError {
                    code: connect::ConnectCode::InvalidArgument,
                    message: "unsupported runtime action".into(),
                    details: Vec::new(),
                })
                .unwrap(),
            )
            .unwrap();
        let mut stream = Box::pin(local_body_stream(receiver, cancellation, Some(trace)));

        stream.next().await.unwrap().unwrap();

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
        let trace = loop {
            let trace = store.cursor_trace("error-trace").await.unwrap().unwrap();
            if trace.status != "running" {
                break trace;
            }
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        };
        assert_eq!(trace.status, "error");
        assert_eq!(
            trace.error_message.as_deref(),
            Some("invalid_argument: unsupported runtime action")
        );
    }
}
