use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    time::Duration,
};

use bytes::BytesMut;
use dom_smoothie::{Config, Readability, TextMode};
use futures_util::StreamExt;
use reqwest::{
    header::{ACCEPT, ACCEPT_LANGUAGE, CONTENT_LENGTH, CONTENT_TYPE, LOCATION, USER_AGENT},
    redirect::Policy,
    Response,
};
use tokio::{net::lookup_host, time::timeout};
use url::{Host, Url};

use crate::store::Store;

const MAX_RESPONSE_SIZE: usize = 5 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchedPage {
    pub url: String,
    pub markdown: String,
}

#[derive(Debug, thiserror::Error)]
#[error("web fetch failed: {0}")]
pub struct FetchError(String);

#[derive(Clone, Copy)]
enum NetworkPolicy {
    PublicOnly,
    #[cfg(test)]
    Any,
}

#[derive(Clone)]
pub struct WebFetch {
    network: NetworkPolicy,
    client: FetchClient,
}

#[derive(Clone)]
enum FetchClient {
    Managed(Store),
    Direct,
}

impl WebFetch {
    pub fn built_in() -> Self {
        Self {
            network: NetworkPolicy::PublicOnly,
            client: FetchClient::Direct,
        }
    }

    pub(crate) fn managed(store: Store) -> Self {
        Self {
            network: NetworkPolicy::PublicOnly,
            client: FetchClient::Managed(store),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test() -> Self {
        Self {
            network: NetworkPolicy::Any,
            client: FetchClient::Direct,
        }
    }

    pub async fn fetch(&self, value: &str) -> Result<FetchedPage, FetchError> {
        timeout(FETCH_TIMEOUT, self.fetch_inner(value))
            .await
            .map_err(|_| failure("request timed out"))?
    }

    async fn fetch_inner(&self, value: &str) -> Result<FetchedPage, FetchError> {
        let mut url = parse_url(value)?;
        for redirect in 0..=MAX_REDIRECTS {
            let response = self.request(&url).await?;
            if response.status().is_redirection() {
                if redirect == MAX_REDIRECTS {
                    return Err(failure("too many redirects"));
                }
                let location = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| failure("redirect is missing Location"))?;
                url = parse_url(
                    url.join(location)
                        .map_err(|error| failure(format!("invalid redirect: {error}")))?
                        .as_str(),
                )?;
                continue;
            }
            if !response.status().is_success() {
                return Err(failure(format!("HTTP {}", response.status())));
            }
            return page(response).await;
        }
        unreachable!("redirect loop always returns")
    }

    async fn request(&self, url: &Url) -> Result<Response, FetchError> {
        let host = url
            .host_str()
            .ok_or_else(|| failure("URL is missing a host"))?;
        let port = url
            .port_or_known_default()
            .ok_or_else(|| failure("URL has no usable port"))?;
        let addresses = lookup_host((host, port))
            .await
            .map_err(|error| failure(format!("DNS lookup failed: {error}")))?
            .collect::<Vec<_>>();
        if addresses.is_empty() {
            return Err(failure("DNS lookup returned no addresses"));
        }
        let domain = matches!(url.host(), Some(Host::Domain(_)));
        if matches!(self.network, NetworkPolicy::PublicOnly)
            && addresses
                .iter()
                .any(|address| !safe_resolution(address.ip(), domain))
        {
            return Err(failure("URL resolves to a non-public address"));
        }

        let builder = match &self.client {
            FetchClient::Managed(store) => crate::network::client_builder(store)
                .await
                .map_err(|error| failure(format!("HTTP client failed: {error}")))?,
            FetchClient::Direct => reqwest::Client::builder().use_native_tls(),
        };
        let mut builder = builder
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(10));
        if domain {
            builder = builder.resolve_to_addrs(host, &addresses);
        }
        let client = builder
            .build()
            .map_err(|error| failure(format!("HTTP client failed: {error}")))?;
        client
            .get(url.clone())
            .header(
                USER_AGENT,
                "Mozilla/5.0 (compatible; CursorBYOK/0.1; +https://github.com)",
            )
            .header(
                ACCEPT,
                "text/markdown, text/plain;q=0.9, text/html;q=0.8, application/xhtml+xml;q=0.8, application/json;q=0.7, */*;q=0.1",
            )
            .header(ACCEPT_LANGUAGE, "en-US,en;q=0.9")
            .send()
            .await
            .map_err(|error| failure(format!("request failed: {error}")))
    }
}

impl Default for WebFetch {
    fn default() -> Self {
        Self::built_in()
    }
}

async fn page(response: Response) -> Result<FetchedPage, FetchError> {
    let url = response.url().to_string();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_RESPONSE_SIZE)
    {
        return Err(failure("response exceeds 5 MiB"));
    }
    let body = limited_body(response).await?;
    let text = decode(&body, &content_type)?;
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let markdown = match media_type.as_str() {
        "text/html" | "application/xhtml+xml" => {
            let source_url = url.clone();
            tokio::task::spawn_blocking(move || readable_markdown(&text, &source_url))
                .await
                .map_err(|error| failure(format!("content task failed: {error}")))??
        }
        "text/markdown" | "text/x-markdown" | "text/plain" => text,
        "application/json" => format!("```json\n{text}\n```"),
        "application/xml" | "text/xml" => format!("```xml\n{text}\n```"),
        value if value.starts_with("text/") => text,
        _ => return Err(failure(format!("unsupported content type: {media_type}"))),
    };
    if markdown.trim().is_empty() {
        return Err(failure("response contains no readable content"));
    }
    Ok(FetchedPage { url, markdown })
}

async fn limited_body(response: Response) -> Result<BytesMut, FetchError> {
    let mut body = BytesMut::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| failure(format!("response failed: {error}")))?;
        if body.len() + chunk.len() > MAX_RESPONSE_SIZE {
            return Err(failure("response exceeds 5 MiB"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn readable_markdown(html: &str, url: &str) -> Result<String, FetchError> {
    let mut readability = Readability::new(
        html,
        Some(url),
        Some(Config {
            max_elements_to_parse: 50_000,
            text_mode: TextMode::Markdown,
            ..Default::default()
        }),
    )
    .map_err(|error| failure(format!("HTML parse failed: {error}")))?;
    let article = readability
        .parse()
        .map_err(|error| failure(format!("article extraction failed: {error}")))?;
    let body = article.text_content.trim().to_string();
    let title = article.title.trim();
    let heading = format!("# {title}");
    Ok(if title.is_empty() || body.starts_with(&heading) {
        body
    } else {
        format!("# {title}\n\n{body}")
    })
}

fn decode(bytes: &[u8], content_type: &str) -> Result<String, FetchError> {
    let charset = content_type.split(';').skip(1).find_map(|parameter| {
        let (name, value) = parameter.trim().split_once('=')?;
        name.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| value.trim().trim_matches(['\'', '"']))
    });
    let encoding = match charset {
        Some(label) => encoding_rs::Encoding::for_label(label.as_bytes())
            .ok_or_else(|| failure(format!("unsupported charset: {label}")))?,
        None => encoding_rs::UTF_8,
    };
    let (text, _, malformed) = encoding.decode(bytes);
    if malformed {
        return Err(failure("response contains malformed text"));
    }
    Ok(text.into_owned())
}

fn parse_url(value: &str) -> Result<Url, FetchError> {
    let url = Url::parse(value).map_err(|error| failure(format!("invalid URL: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(failure("URL must use http or https"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(failure("URL credentials are not allowed"));
    }
    if url.host_str().is_none() {
        return Err(failure("URL is missing a host"));
    }
    Ok(url)
}

fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => public_v6(ip),
    }
}

fn safe_resolution(ip: IpAddr, domain: bool) -> bool {
    is_public(ip) || (domain && is_benchmark_proxy_range(ip))
}

fn is_benchmark_proxy_range(ip: IpAddr) -> bool {
    let IpAddr::V4(ip) = ip else {
        return false;
    };
    u32::from(ip) >> 17 == u32::from(Ipv4Addr::new(198, 18, 0, 0)) >> 17
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let value = u32::from(ip);
    ![
        (0x0000_0000, 8),
        (0x0a00_0000, 8),
        (0x6440_0000, 10),
        (0x7f00_0000, 8),
        (0xa9fe_0000, 16),
        (0xac10_0000, 12),
        (0xc000_0000, 24),
        (0xc000_0200, 24),
        (0xc0a8_0000, 16),
        (0xc612_0000, 15),
        (0xc633_6400, 24),
        (0xcb00_7100, 24),
        (0xe000_0000, 3),
    ]
    .into_iter()
    .any(|(network, prefix)| value >> (32 - prefix) == network >> (32 - prefix))
}

fn public_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    segments[0] & 0xe000 == 0x2000 && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
}

fn failure(message: impl Into<String>) -> FetchError {
    FetchError(message.into())
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use axum::{
        http::{header, StatusCode},
        response::IntoResponse,
        routing::get,
        Router,
    };
    use tokio::net::TcpListener;
    use url::Url;

    use super::{decode, is_public, safe_resolution, WebFetch, MAX_RESPONSE_SIZE};

    #[tokio::test]
    async fn fetches_redirect_and_extracts_only_readable_markdown() {
        let base = fixture().await;
        let page = WebFetch::for_test()
            .fetch(&format!("{base}/redirect"))
            .await
            .unwrap();

        assert!(page.url.ends_with("/article"));
        assert!(page.markdown.contains("# Useful article"));
        assert!(page.markdown.contains("Readable paragraph"));
        assert!(!page.markdown.contains("Site navigation"));
        assert!(!page.markdown.contains("window.secret"));
    }

    #[tokio::test]
    async fn preserves_plain_text() {
        let base = fixture().await;
        let page = WebFetch::for_test()
            .fetch(&format!("{base}/plain"))
            .await
            .unwrap();

        assert_eq!(page.markdown, "plain response");
    }

    #[tokio::test]
    async fn rejects_oversized_and_binary_responses() {
        let base = fixture().await;
        let oversized = WebFetch::for_test()
            .fetch(&format!("{base}/oversized"))
            .await
            .unwrap_err();
        let binary = WebFetch::for_test()
            .fetch(&format!("{base}/binary"))
            .await
            .unwrap_err();

        assert!(oversized.to_string().contains("5 MiB"));
        assert!(binary.to_string().contains("unsupported content type"));
    }

    #[tokio::test]
    #[ignore = "live public fetch smoke test"]
    async fn fetches_live_public_article() {
        let page = WebFetch::built_in()
            .fetch("https://www.rust-lang.org/learn")
            .await
            .unwrap();

        assert_eq!(
            Url::parse(&page.url).unwrap().host_str(),
            Some("rust-lang.org")
        );
        assert!(page.markdown.contains("Learn Rust"));
    }

    #[test]
    fn only_globally_routable_addresses_are_public() {
        assert!(is_public(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
        assert!(!is_public(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(!is_public(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(is_public(IpAddr::V6(
            "2606:4700:4700::1111".parse::<Ipv6Addr>().unwrap()
        )));
        assert!(!is_public(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(!is_public(IpAddr::V6(
            "2001:db8::1".parse::<Ipv6Addr>().unwrap()
        )));
        let proxy_ip = IpAddr::V4(Ipv4Addr::new(198, 18, 1, 1));
        assert!(safe_resolution(proxy_ip, true));
        assert!(!safe_resolution(proxy_ip, false));
    }

    #[test]
    fn decodes_case_insensitive_declared_charset() {
        assert_eq!(
            decode(&[0xe9], "text/plain; Charset=windows-1252").unwrap(),
            "é"
        );
    }

    async fn fixture() -> String {
        async fn redirect() -> impl IntoResponse {
            (StatusCode::FOUND, [(header::LOCATION, "/article")])
        }
        async fn article() -> impl IntoResponse {
            (
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                r#"<!doctype html><html><head><title>Useful article</title></head><body>
                <nav>Site navigation</nav><article><h1>Useful article</h1>
                <p>Readable paragraph with enough useful words to be selected as the main article content for this deterministic test fixture.</p>
                <p>A second meaningful paragraph makes article extraction stable and representative of a real web page.</p>
                </article><script>window.secret = true</script></body></html>"#,
            )
        }
        async fn oversized() -> impl IntoResponse {
            (
                [(header::CONTENT_TYPE, "text/plain")],
                "x".repeat(MAX_RESPONSE_SIZE + 1),
            )
        }
        let app = Router::new()
            .route("/redirect", get(redirect))
            .route("/article", get(article))
            .route("/plain", get(|| async { "plain response" }))
            .route("/oversized", get(oversized))
            .route(
                "/binary",
                get(|| async { ([(header::CONTENT_TYPE, "image/png")], [0_u8; 4]) }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}")
    }
}
