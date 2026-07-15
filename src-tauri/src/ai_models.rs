use reqwest::{
    header::{HeaderMap, HeaderValue, AUTHORIZATION},
    Client, Url,
};
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

use crate::sensitive_data::redact_sensitive_text;

const MODEL_LIST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchAiModelsInput {
    endpoint: String,
    provider: String,
    api_key: String,
}

#[tauri::command]
pub async fn fetch_ai_models(input: FetchAiModelsInput) -> Result<Value, String> {
    let endpoint = model_list_endpoint(&input.endpoint)?;
    let headers = model_list_headers(&input.provider, &input.api_key)?;
    let client = Client::builder()
        .timeout(MODEL_LIST_TIMEOUT)
        .build()
        .map_err(|error| format!("无法创建模型列表请求：{error}"))?;

    let response = client
        .get(endpoint)
        .headers(headers)
        .send()
        .await
        .map_err(|error| format!("获取模型列表失败：{error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("无法读取模型列表响应：{error}"))?;

    if !status.is_success() {
        return Err(format!(
            "获取模型失败：{status} {}",
            redact_sensitive_text(truncate_error_body(&body))
        ));
    }

    serde_json::from_str(&body).map_err(|error| format!("模型列表响应不是有效 JSON：{error}"))
}

fn model_list_endpoint(endpoint: &str) -> Result<Url, String> {
    let base = endpoint.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("请先填写模型服务 Endpoint。".to_string());
    }

    let url = Url::parse(&format!("{base}/models"))
        .map_err(|_| "模型服务 Endpoint 无效。".to_string())?;
    match url.scheme() {
        "https" | "http" => Ok(url),
        _ => Err("模型服务 Endpoint 只支持 HTTP 或 HTTPS。".to_string()),
    }
}

fn model_list_headers(provider: &str, api_key: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    let api_key = api_key.trim();

    if provider == "anthropic" {
        headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        if !api_key.is_empty() {
            headers.insert(
                "x-api-key",
                HeaderValue::from_str(api_key)
                    .map_err(|_| "API Key 包含无效的请求头字符。".to_string())?,
            );
        }
    } else if !api_key.is_empty() {
        let authorization = HeaderValue::from_str(&format!("Bearer {api_key}"))
            .map_err(|_| "API Key 包含无效的请求头字符。".to_string())?;
        headers.insert(AUTHORIZATION, authorization);
    }

    Ok(headers)
}

fn truncate_error_body(body: &str) -> &str {
    const MAX_ERROR_BODY_CHARS: usize = 1000;
    body.char_indices()
        .nth(MAX_ERROR_BODY_CHARS)
        .map(|(index, _)| &body[..index])
        .unwrap_or(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_models_to_a_normalized_endpoint() {
        let endpoint = model_list_endpoint("https://example.com/v1/").expect("valid endpoint");
        assert_eq!(endpoint.as_str(), "https://example.com/v1/models");
    }

    #[test]
    fn rejects_non_http_endpoints() {
        assert!(model_list_endpoint("file:///models").is_err());
    }

    #[test]
    fn uses_provider_specific_authentication_headers() {
        let openai_headers = model_list_headers("openai", "key").expect("valid headers");
        assert_eq!(openai_headers.get(AUTHORIZATION).unwrap(), "Bearer key");

        let anthropic_headers = model_list_headers("anthropic", "key").expect("valid headers");
        assert_eq!(anthropic_headers.get("x-api-key").unwrap(), "key");
        assert_eq!(
            anthropic_headers.get("anthropic-version").unwrap(),
            "2023-06-01"
        );
    }

    #[test]
    fn truncates_error_bodies_at_a_character_boundary() {
        let body = "中".repeat(1001);
        assert_eq!(truncate_error_body(&body).chars().count(), 1000);
    }

    #[test]
    fn redacts_credentials_from_model_error_bodies() {
        let body = r#"{"api_key":"sk-provider-secret","authorization":"Bearer abc.def.secret"}"#;
        let redacted = redact_sensitive_text(truncate_error_body(body));
        assert!(!redacted.contains("sk-provider-secret"));
        assert!(!redacted.contains("abc.def.secret"));
    }
}
