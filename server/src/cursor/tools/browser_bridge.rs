//! Relays MCP calls to the explicitly paired browser extension on this desktop.

use std::{collections::HashMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, Mutex};
use uuid::Uuid;

static PAIR: Mutex<Option<Arc<Pair>>> = Mutex::const_new(None);

struct Pair {
    token: String,
    send: mpsc::Sender<BrowserRequest>,
    queue: Mutex<mpsc::Receiver<BrowserRequest>>,
    pending: Mutex<HashMap<String, oneshot::Sender<BrowserReply>>>,
}

#[derive(Serialize)]
pub(crate) struct BrowserRequest {
    id: String,
    method: String,
    arguments: Value,
    expires_ms: u64,
}

#[derive(Deserialize)]
pub(crate) struct BrowserReply {
    pub(crate) id: String,
    pub(crate) result: Option<Value>,
    pub(crate) error: Option<String>,
}

pub(crate) async fn pair_browser() -> String {
    let token = Uuid::new_v4().simple().to_string();
    let (send, queue) = mpsc::channel(16);
    let mut current = PAIR.lock().await;
    if let Some(previous) = current.take() {
        previous.pending.lock().await.clear();
    }
    *current = Some(Arc::new(Pair {
        token: token.clone(),
        send,
        queue: Mutex::new(queue),
        pending: Mutex::new(HashMap::new()),
    }));
    token
}

async fn authenticated(token: &str) -> Option<Arc<Pair>> {
    PAIR.lock()
        .await
        .as_ref()
        .filter(|pair| pair.token == token)
        .cloned()
}

pub(crate) async fn next(token: &str) -> Option<Option<BrowserRequest>> {
    let pair = authenticated(token).await?;
    let mut queue = pair.queue.try_lock().ok()?;
    let request = tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(request) = queue.recv().await {
            if pair.pending.lock().await.contains_key(&request.id) {
                return Some(request);
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    Some(request)
}

pub(crate) async fn reply(token: &str, reply: BrowserReply) -> bool {
    let Some(pair) = authenticated(token).await else {
        return false;
    };
    let pending = pair.pending.lock().await.remove(&reply.id);
    pending.is_some_and(|sender| sender.send(reply).is_ok())
}

pub(crate) async fn call(method: String, arguments: Value) -> std::result::Result<Value, String> {
    let pair = PAIR
        .lock()
        .await
        .clone()
        .ok_or("Pair the Chrome extension in BYOK Settings, then share the development tab.")?;
    let id = Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    let ttl = Duration::from_secs(45);
    pair.pending.lock().await.insert(id.clone(), tx);
    let request = BrowserRequest {
        id: id.clone(),
        method,
        arguments,
        expires_ms: super::runtime::now_ms() + ttl.as_millis() as u64,
    };
    if let Err(error) = pair.send.try_send(request) {
        pair.pending.lock().await.remove(&id);
        return Err(format!("Chrome bridge queue: {error}"));
    }
    let result = tokio::time::timeout(ttl, rx).await;
    pair.pending.lock().await.remove(&id);
    let reply = result
        .map_err(|_| {
            "Chrome bridge timed out; check that the extension is connected and the tab is shared."
        })?
        .map_err(|_| "Chrome pairing changed before the tool completed.")?;
    match (reply.result, reply.error) {
        (Some(result), None) => Ok(result),
        (None, Some(error)) => Err(error),
        _ => Err("Invalid Chrome bridge reply".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn pairing_rotates_the_secret_and_completes_a_tool_once() {
        let old = pair_browser().await;
        let current = pair_browser().await;
        assert!(authenticated(&old).await.is_none());
        let result = tokio::spawn(call("browser_read".into(), json!({"action":"snapshot"})));
        let request = next(&current).await.unwrap().unwrap();
        assert_eq!(request.method, "browser_read");
        assert!(
            !reply(
                &old,
                BrowserReply {
                    id: request.id.clone(),
                    result: Some(json!({"wrong":true})),
                    error: None
                }
            )
            .await
        );
        assert!(
            reply(
                &current,
                BrowserReply {
                    id: request.id.clone(),
                    result: Some(json!({"title":"Desk"})),
                    error: None
                }
            )
            .await
        );
        assert!(
            !reply(
                &current,
                BrowserReply {
                    id: request.id,
                    result: Some(json!({})),
                    error: None
                }
            )
            .await
        );
        assert_eq!(result.await.unwrap().unwrap(), json!({"title":"Desk"}));
    }
}
