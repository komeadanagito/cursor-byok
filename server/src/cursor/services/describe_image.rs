//! Calls Cursor's unary image description RPC with the current request's session headers.
use crate::{
    api::cursor::proxy::{self, CursorProxy},
    cursor::protocol::connect,
    Error, Result,
};
use axum::{
    body::Body,
    http::{header, HeaderMap, Request},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use prost::Message;

const RPC: &str = "/aiserver.v1.AiService/RunDescribeImage";

#[derive(Clone)]
pub struct CursorImageReader {
    proxy: CursorProxy,
    headers: HeaderMap,
    max_mode: bool,
}

#[derive(Clone, PartialEq, Message)]
struct DescribeRequest {
    #[prost(string, tag = "1")]
    image_data: String,
    #[prost(string, tag = "2")]
    mime_type: String,
    #[prost(string, tag = "3")]
    context_text: String,
    #[prost(string, tag = "4")]
    model_id: String,
    #[prost(bool, tag = "5")]
    max_mode: bool,
}
#[derive(Clone, PartialEq, Message)]
struct DescribeResponse {
    #[prost(bool, tag = "1")]
    applicable: bool,
    #[prost(string, optional, tag = "2")]
    description: Option<String>,
}

impl CursorImageReader {
    pub(crate) fn from_session(
        proxy: CursorProxy,
        incoming: &HeaderMap,
        max_mode: bool,
    ) -> Option<Self> {
        if crate::local_app::request_uses_local_cursor_token(incoming) {
            return None;
        }
        let authorization = incoming.get(header::AUTHORIZATION)?.clone();
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, authorization);
        for (name, value) in incoming {
            if name.as_str().starts_with("x-cursor-") || name == "x-ghost-mode" {
                headers.insert(name, value.clone());
            }
        }
        headers.insert(header::CONTENT_TYPE, "application/proto".parse().unwrap());
        headers.insert("connect-protocol-version", "1".parse().unwrap());
        Some(Self {
            proxy,
            headers,
            max_mode,
        })
    }

    pub(crate) async fn describe(
        &self,
        model_id: &str,
        mime: &str,
        data: &[u8],
        question: &str,
    ) -> Result<Option<String>> {
        let payload = DescribeRequest {
            image_data: STANDARD.encode(data),
            mime_type: mime.into(),
            context_text: question.into(),
            model_id: model_id.into(),
            max_mode: self.max_mode,
        };
        let mut request = Request::post(RPC)
            .body(Body::from(payload.encode_to_vec()))
            .expect("static image RPC path");
        *request.headers_mut() = self.headers.clone();
        let response = proxy::forward_buffered(&self.proxy, request).await?;
        if !response.status.is_success() {
            return Err(Error::Provider(format!(
                "Cursor RunDescribeImage returned HTTP {}",
                response.status
            )));
        }
        let reply: DescribeResponse = connect::decode_unary(&response.body)?;
        if !reply.applicable {
            return Ok(None);
        }
        reply
            .description
            .filter(|text| !text.trim().is_empty())
            .map(Some)
            .ok_or_else(|| {
                Error::Protocol(
                    "Cursor RunDescribeImage returned applicable without a description".into(),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Bytes, routing::post, Router};

    #[tokio::test]
    async fn local_byok_token_is_not_an_official_image_session() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::connect(&format!(
            "sqlite://{}",
            dir.path().join("local.db").display()
        ))
        .await
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            crate::local_app::local_cursor_authorization()
                .parse()
                .unwrap(),
        );
        assert!(CursorImageReader::from_session(
            CursorProxy::cursor(crate::network::NetworkClients::new(store)),
            &headers,
            false
        )
        .is_none());
    }

    #[tokio::test]
    async fn cursor_only_receives_the_image_question_and_session_identity() {
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", socket.local_addr().unwrap());
        let app = Router::new().route(
            "/aiserver.v1.AiService/RunDescribeImage",
            post(|headers: HeaderMap, body: Bytes| async move {
                assert_eq!(headers[header::AUTHORIZATION], "Bearer fixture");
                assert!(headers.get("x-api-key").is_none());
                let req = DescribeRequest::decode(body).unwrap();
                assert_eq!(
                    (
                        req.image_data.as_str(),
                        req.mime_type.as_str(),
                        req.model_id.as_str()
                    ),
                    ("AQID", "image/png", "text-model")
                );
                assert!(req.max_mode);
                let applicable = req.context_text == "Which button?";
                DescribeResponse {
                    applicable,
                    description: applicable.then(|| "Save".into()),
                }
                .encode_to_vec()
            }),
        );
        let server = tokio::spawn(async move { axum::serve(socket, app).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::connect(&format!(
            "sqlite://{}",
            dir.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let proxy = CursorProxy::testing(crate::network::NetworkClients::new(store), url);
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer fixture".parse().unwrap());
        headers.insert("x-api-key", "user-key".parse().unwrap());
        let reader = CursorImageReader::from_session(proxy, &headers, true).unwrap();
        assert_eq!(
            reader
                .describe("text-model", "image/png", &[1, 2, 3], "Which button?")
                .await
                .unwrap()
                .as_deref(),
            Some("Save")
        );
        assert!(reader
            .describe("text-model", "image/png", &[1, 2, 3], "Other")
            .await
            .unwrap()
            .is_none());
        server.abort();
    }
}
