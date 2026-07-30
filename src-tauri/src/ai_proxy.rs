use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Client, Url,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};
use tauri::ipc::Channel;

const AI_REQUEST_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_REQUEST_BODY_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyAiRequestInput {
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) method: Option<String>,
    #[serde(default)]
    pub(crate) headers: HashMap<String, String>,
    pub(crate) body: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum ProxyAiEvent {
    Started {
        status: u16,
        headers: HashMap<String, String>,
    },
    Chunk {
        body: String,
    },
    Finished,
}

pub(crate) struct StreamingAiResponse {
    pub(crate) status: u16,
    pub(crate) headers: HashMap<String, String>,
    response: reqwest::Response,
}

impl StreamingAiResponse {
    pub(crate) async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, String> {
        self.response
            .chunk()
            .await
            .map(|chunk| chunk.map(|value| value.to_vec()))
            .map_err(|error| format!("无法读取 AI 响应流：{error}"))
    }
}

#[tauri::command]
pub async fn proxy_ai_request(
    input: ProxyAiRequestInput,
    on_event: Channel<ProxyAiEvent>,
) -> Result<(), String> {
    let mut response = start_ai_request(input).await?;
    on_event
        .send(ProxyAiEvent::Started {
            status: response.status,
            headers: response.headers.clone(),
        })
        .map_err(|error| format!("无法发送 AI 响应头：{error}"))?;

    while let Some(chunk) = response.next_chunk().await? {
        on_event
            .send(ProxyAiEvent::Chunk {
                body: BASE64_STANDARD.encode(chunk),
            })
            .map_err(|error| format!("无法发送 AI 响应流：{error}"))?;
    }
    on_event
        .send(ProxyAiEvent::Finished)
        .map_err(|error| format!("无法结束 AI 响应流：{error}"))?;

    Ok(())
}

pub(crate) async fn start_ai_request(
    input: ProxyAiRequestInput,
) -> Result<StreamingAiResponse, String> {
    let url = ai_request_url(&input.url)?;
    let headers = request_headers(input.headers)?;
    let method = input.method.unwrap_or_else(|| "GET".to_string());
    let method = method
        .parse()
        .map_err(|_| "AI 请求方法无效。".to_string())?;
    let body = input.body.unwrap_or_default();
    if body.len() > MAX_REQUEST_BODY_BYTES {
        return Err("AI 请求内容超过 2 MB 限制。".to_string());
    }

    let client = Client::builder()
        .timeout(AI_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("无法创建 AI 请求：{error}"))?;
    let response = client
        .request(method, url)
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(|error| format!("AI 请求失败：{error}"))?;
    Ok(StreamingAiResponse {
        status: response.status().as_u16(),
        headers: response_headers(response.headers()),
        response,
    })
}

fn ai_request_url(url: &str) -> Result<Url, String> {
    let url = Url::parse(url.trim()).map_err(|_| "AI 请求地址无效。".to_string())?;
    match url.scheme() {
        "https" | "http" if url.username().is_empty() && url.password().is_none() => Ok(url),
        "https" | "http" => Err("AI 请求地址不能包含用户名或密码。".to_string()),
        _ => Err("AI 请求地址只支持 HTTP 或 HTTPS。".to_string()),
    }
}

fn request_headers(values: HashMap<String, String>) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    for (name, value) in values {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "AI 请求包含无效的请求头名称。".to_string())?;
        if is_hop_by_hop_header(&name) {
            continue;
        }
        let value = HeaderValue::from_str(&value)
            .map_err(|_| "AI 请求包含无效的请求头内容。".to_string())?;
        headers.insert(name, value);
    }
    Ok(headers)
}

fn is_hop_by_hop_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "content-length"
            | "host"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn response_headers(headers: &HeaderMap) -> HashMap<String, String> {
    headers
        .iter()
        .filter(|(name, _)| !is_hop_by_hop_header(name))
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::post, Router};

    #[test]
    fn rejects_non_http_or_credentialed_urls() {
        assert!(ai_request_url("file:///models").is_err());
        assert!(ai_request_url("https://key@example.com/v1").is_err());
    }

    #[test]
    fn removes_hop_by_hop_headers_without_removing_authorization() {
        let headers = request_headers(HashMap::from([
            ("connection".to_string(), "close".to_string()),
            ("authorization".to_string(), "Bearer key".to_string()),
        ]))
        .expect("valid headers");

        assert!(headers.get("connection").is_none());
        assert_eq!(headers.get("authorization").unwrap(), "Bearer key");
    }

    #[tokio::test]
    async fn streams_provider_responses_through_the_shared_rust_proxy() {
        let router = Router::new().route(
            "/v1/chat",
            post(|| async { ([("x-runtime", "rust-proxy")], "hello worker") }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind provider fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        let mut response = start_ai_request(ProxyAiRequestInput {
            url: format!("http://{address}/v1/chat"),
            method: Some("POST".to_string()),
            headers: HashMap::from([("content-type".to_string(), "application/json".to_string())]),
            body: Some("{}".to_string()),
        })
        .await
        .expect("start provider request");
        assert_eq!(response.status, 200);
        assert_eq!(
            response.headers.get("x-runtime").map(String::as_str),
            Some("rust-proxy")
        );
        let mut body = Vec::new();
        while let Some(chunk) = response.next_chunk().await.expect("response chunk") {
            body.extend(chunk);
        }
        assert_eq!(String::from_utf8(body).unwrap(), "hello worker");
        server.abort();
    }
}
