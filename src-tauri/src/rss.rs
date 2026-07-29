use dom_smoothie::{Config as ReadabilityConfig, Readability};
use feed_rs::model::{Entry, Feed, Link};
use reqwest::{
    header::{CONTENT_TYPE, ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, LOCATION},
    redirect::Policy,
    StatusCode,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use url::Url;

use crate::sensitive_data::redact_sensitive_text;

const MAX_FEED_BYTES: usize = 2 * 1024 * 1024;
const MAX_ARTICLE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 100;
const MAX_BODY_CHARS: usize = 100_000;
const MAX_REDIRECTS: usize = 5;
const MAX_AUTO_ARTICLES: usize = 12;
const ARTICLE_BATCH_SIZE: usize = 4;
const MIN_FULL_CONTENT_CHARS: usize = 1_200;
const USER_AGENT: &str = concat!("MyNoteBook/", env!("CARGO_PKG_VERSION"), " RSS Reader");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RssFetchInput {
    url: String,
    etag: Option<String>,
    last_modified: Option<String>,
    after_published_at: Option<i64>,
    limit: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRssEntry {
    remote_id: String,
    article_url: Option<String>,
    title: String,
    author: String,
    published_at: i64,
    updated_at: Option<i64>,
    preview: String,
    body_text: String,
    content_source: String,
    article_fetched_at: Option<i64>,
    article_fetch_error: Option<String>,
    categories: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RssArticleFetchInput {
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RssArticleFetchResult {
    title: String,
    author: String,
    body_text: String,
    extracted_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RssFetchResult {
    not_modified: bool,
    effective_url: String,
    feed_title: Option<String>,
    feed_description: Option<String>,
    site_url: Option<String>,
    feed_type: Option<String>,
    etag: Option<String>,
    last_modified: Option<String>,
    entries: Vec<RemoteRssEntry>,
}

#[tauri::command]
pub async fn fetch_rss_feed(input: RssFetchInput) -> Result<RssFetchResult, String> {
    let url = normalize_feed_url(&input.url)?;
    let limit = input.limit.clamp(1, MAX_ENTRIES);
    let response = fetch_document(url, input.etag, input.last_modified).await?;
    if response.not_modified {
        return Ok(RssFetchResult {
            not_modified: true,
            effective_url: response.effective_url.to_string(),
            feed_title: None,
            feed_description: None,
            site_url: None,
            feed_type: None,
            etag: response.etag,
            last_modified: response.last_modified,
            entries: Vec::new(),
        });
    }

    let bytes = response.body;
    let feed =
        tauri::async_runtime::spawn_blocking(move || feed_rs::parser::parse(bytes.as_slice()))
            .await
            .map_err(rss_error)?
            .map_err(rss_error)?;
    let mut result = map_feed(
        feed,
        response.effective_url,
        response.etag,
        response.last_modified,
        MAX_ENTRIES,
    );
    if let Some(after_published_at) = input.after_published_at {
        result
            .entries
            .retain(|entry| entry_is_after_cursor(entry, after_published_at));
        result.entries.sort_by_key(entry_cursor_time);
        result.entries.truncate(limit);
        result
            .entries
            .sort_by_key(|entry| std::cmp::Reverse(entry_cursor_time(entry)));
    } else {
        result.entries.truncate(limit);
    }
    enrich_entries(&mut result.entries).await;
    Ok(result)
}

fn entry_is_after_cursor(entry: &RemoteRssEntry, cursor: i64) -> bool {
    entry_cursor_time(entry) > cursor
}

fn entry_cursor_time(entry: &RemoteRssEntry) -> i64 {
    entry.updated_at.unwrap_or(entry.published_at)
}

#[tauri::command]
pub async fn fetch_rss_article(
    input: RssArticleFetchInput,
) -> Result<RssArticleFetchResult, String> {
    extract_article(normalize_public_url(&input.url, "文章地址")?).await
}

struct FetchDocument {
    not_modified: bool,
    effective_url: Url,
    etag: Option<String>,
    last_modified: Option<String>,
    body: Vec<u8>,
    content_type: Option<String>,
}

async fn fetch_document(
    url: Url,
    etag: Option<String>,
    last_modified: Option<String>,
) -> Result<FetchDocument, String> {
    fetch_public_document(
        url,
        etag,
        last_modified,
        "RSS 地址",
        "application/atom+xml, application/rss+xml, application/feed+json, application/xml, text/xml, application/json;q=0.9, */*;q=0.2",
        MAX_FEED_BYTES,
    )
    .await
}

async fn fetch_public_document(
    mut url: Url,
    mut etag: Option<String>,
    mut last_modified: Option<String>,
    subject: &str,
    accept: &str,
    max_bytes: usize,
) -> Result<FetchDocument, String> {
    for redirect_count in 0..=MAX_REDIRECTS {
        let host = url
            .host_str()
            .ok_or_else(|| format!("{subject}缺少主机名。"))?
            .to_string();
        let addresses = resolve_public_addresses(&url).await?;
        let mut client_builder = reqwest::Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(25))
            .user_agent(USER_AGENT)
            .resolve_to_addrs(&host, &addresses);
        if subject == "文章地址" {
            // A number of publishing CDNs reject non-browser HTTP/2 fingerprints while
            // serving the same public HTML over HTTP/1.1. The feed path keeps normal
            // negotiation; article extraction uses the more broadly compatible path.
            client_builder = client_builder.http1_only();
        }
        let client = client_builder
            .build()
            .map_err(|error| request_error(subject, error))?;
        let mut request = client.get(url.clone()).header("Accept", accept);
        if let Some(value) = etag.as_deref().filter(|value| !value.is_empty()) {
            request = request.header(IF_NONE_MATCH, value);
        }
        if let Some(value) = last_modified.as_deref().filter(|value| !value.is_empty()) {
            request = request.header(IF_MODIFIED_SINCE, value);
        }
        let mut response = request
            .send()
            .await
            .map_err(|error| request_error(subject, error))?;

        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err(format!("{subject}重定向次数过多。"));
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| format!("{subject}重定向缺少有效 Location。"))?;
            let next =
                normalize_public_url(url.join(location).map_err(rss_error)?.as_str(), subject)?;
            if next.host_str() != url.host_str() {
                etag = None;
                last_modified = None;
            }
            url = next;
            continue;
        }

        let response_etag = header_text(response.headers().get(ETAG)).or(etag);
        let response_last_modified =
            header_text(response.headers().get(LAST_MODIFIED)).or(last_modified);
        if response.status() == StatusCode::NOT_MODIFIED {
            return Ok(FetchDocument {
                not_modified: true,
                effective_url: url,
                etag: response_etag,
                last_modified: response_last_modified,
                body: Vec::new(),
                content_type: header_text(response.headers().get(CONTENT_TYPE)),
            });
        }
        if !response.status().is_success() {
            return Err(format!(
                "{}服务器返回 HTTP {}。",
                subject.trim_end_matches("地址"),
                response.status().as_u16()
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes as u64)
        {
            return Err(format!(
                "{}响应超过安全上限。",
                subject.trim_end_matches("地址")
            ));
        }
        let content_type = header_text(response.headers().get(CONTENT_TYPE));
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| request_error(subject, error))?
        {
            if body.len().saturating_add(chunk.len()) > max_bytes {
                return Err(format!(
                    "{}响应超过安全上限。",
                    subject.trim_end_matches("地址")
                ));
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(FetchDocument {
            not_modified: false,
            effective_url: url,
            etag: response_etag,
            last_modified: response_last_modified,
            body,
            content_type,
        });
    }
    Err(format!("{subject}重定向次数过多。"))
}

async fn resolve_public_addresses(url: &Url) -> Result<Vec<SocketAddr>, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "RSS 地址缺少主机名。".to_string())?;
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return Err("RSS 地址不能指向本机。".to_string());
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "RSS 地址缺少有效端口。".to_string())?;
    let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| "无法解析 RSS 主机名。".to_string())?
            .collect::<Vec<_>>()
    };
    if addresses.is_empty() {
        return Err("RSS 主机名没有可用地址。".to_string());
    }
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err("RSS 地址解析到了本机或私有网络，已阻止访问。".to_string());
    }
    Ok(addresses)
}

fn normalize_feed_url(value: &str) -> Result<Url, String> {
    normalize_public_url(value, "RSS 地址")
}

fn normalize_public_url(value: &str, subject: &str) -> Result<Url, String> {
    let mut url = Url::parse(value.trim()).map_err(|_| format!("请输入有效的{subject}。"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("{subject}只支持 HTTP 或 HTTPS。"));
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(format!("{subject}不能包含登录凭据，且必须具有主机名。"));
    }
    if url.as_str().len() > 2048 {
        return Err(format!("{subject}不能超过 2048 个字符。"));
    }
    url.set_fragment(None);
    Ok(url)
}

async fn extract_article(url: Url) -> Result<RssArticleFetchResult, String> {
    let response = fetch_public_document(
        url,
        None,
        None,
        "文章地址",
        "text/html, application/xhtml+xml;q=0.9, */*;q=0.1",
        MAX_ARTICLE_BYTES,
    )
    .await?;
    if response.content_type.as_deref().is_some_and(|value| {
        let value = value.to_ascii_lowercase();
        !value.contains("text/html") && !value.contains("application/xhtml+xml")
    }) {
        return Err("文章链接返回的不是 HTML 页面。".to_string());
    }
    let effective_url = response.effective_url.to_string();
    let html = String::from_utf8_lossy(&response.body).into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let config = ReadabilityConfig {
            max_elements_to_parse: 20_000,
            ..Default::default()
        };
        let mut readability = Readability::new(html, Some(&effective_url), Some(config))
            .map_err(|error| error.to_string())?;
        let article = readability.parse().map_err(|error| error.to_string())?;
        let body_text = truncate(&plain_text(article.text_content.as_ref()), MAX_BODY_CHARS);
        if body_text.chars().count() < 200 {
            return Err("文章页可提取的正文过短，已保留 RSS 摘要。".to_string());
        }
        Ok(RssArticleFetchResult {
            title: truncate(&plain_text(&article.title), 500),
            author: truncate(article.byline.as_deref().unwrap_or_default(), 300),
            body_text,
            extracted_at: now_millis(),
        })
    })
    .await
    .map_err(rss_error)?
    .map_err(|error| format!("无法从文章页提取正文：{}", redact_sensitive_text(&error)))
}

async fn enrich_entries(entries: &mut [RemoteRssEntry]) {
    let candidates = entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let is_summary = entry.content_source == "summary";
            let is_short = entry.body_text.chars().count() < MIN_FULL_CONTENT_CHARS;
            (is_summary || is_short)
                .then_some(entry.article_url.as_deref())
                .flatten()
                .and_then(|url| normalize_public_url(url, "文章地址").ok())
                .map(|url| (index, url))
        })
        .take(MAX_AUTO_ARTICLES)
        .collect::<Vec<_>>();

    for batch in candidates.chunks(ARTICLE_BATCH_SIZE) {
        let mut tasks = tokio::task::JoinSet::new();
        for (index, url) in batch.iter().cloned() {
            tasks.spawn(async move { (index, extract_article(url).await) });
        }
        while let Some(result) = tasks.join_next().await {
            let Ok((index, extracted)) = result else {
                continue;
            };
            let entry = &mut entries[index];
            match extracted {
                Ok(article) => {
                    entry.article_fetched_at = Some(article.extracted_at);
                    if article.body_text.chars().count() > entry.body_text.chars().count() {
                        entry.body_text = article.body_text;
                        entry.content_source = "article".to_string();
                        entry.article_fetch_error = None;
                        if entry.author.is_empty() && !article.author.is_empty() {
                            entry.author = article.author;
                        }
                    } else {
                        entry.article_fetch_error =
                            Some("文章页正文未比 RSS 内容更完整，已保留原内容。".to_string());
                    }
                }
                Err(error) => entry.article_fetch_error = Some(truncate(&error, 1_000)),
            }
        }
    }
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        || ip.is_multicast()
        || octets[0] == 0
        || octets[0] >= 240
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19)))
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

fn map_feed(
    feed: Feed,
    effective_url: Url,
    etag: Option<String>,
    last_modified: Option<String>,
    limit: usize,
) -> RssFetchResult {
    let feed_title = feed
        .title
        .as_ref()
        .map(|title| truncate(&plain_text(&title.content), 500))
        .filter(|title| !title.is_empty());
    let feed_description = feed
        .description
        .as_ref()
        .map(|description| truncate(&plain_text(&description.content), 2_000))
        .filter(|description| !description.is_empty());
    let site_url = preferred_link(&feed.links);
    let now = now_millis();
    let mut entries = feed
        .entries
        .into_iter()
        .take(limit)
        .map(|entry| map_entry(entry, now))
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry_cursor_time(entry)));
    RssFetchResult {
        not_modified: false,
        effective_url: effective_url.to_string(),
        feed_title,
        feed_description,
        site_url,
        feed_type: Some(format!("{:?}", feed.feed_type)),
        etag,
        last_modified,
        entries,
    }
}

fn map_entry(entry: Entry, fallback_timestamp: i64) -> RemoteRssEntry {
    let article_url = preferred_link(&entry.links);
    let title = entry
        .title
        .as_ref()
        .map(|title| truncate(&plain_text(&title.content), 500))
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "（无标题）".to_string());
    let author = truncate(
        &entry
            .authors
            .iter()
            .map(|author| author.name.trim())
            .filter(|name| !name.is_empty())
            .collect::<Vec<_>>()
            .join(", "),
        300,
    );
    let summary_text = entry
        .summary
        .as_ref()
        .map(|summary| plain_text(&summary.content))
        .unwrap_or_default();
    let feed_content = entry
        .content
        .as_ref()
        .and_then(|content| content.body.as_deref())
        .map(plain_text)
        .filter(|body| !body.is_empty());
    let content_source = if feed_content.is_some() {
        "feed"
    } else {
        "summary"
    };
    let body_text = feed_content.unwrap_or_else(|| summary_text.clone());
    let published_at = entry
        .published
        .or(entry.updated)
        .map(|date| date.timestamp_millis())
        .unwrap_or(fallback_timestamp);
    let updated_at = entry.updated.map(|date| date.timestamp_millis());
    let stable_key = stable_entry_key(
        &entry,
        article_url.as_deref(),
        &title,
        published_at,
        &author,
    );
    let preview_source = if summary_text.is_empty() {
        &body_text
    } else {
        &summary_text
    };
    RemoteRssEntry {
        remote_id: sha256_hex(stable_key.as_bytes()),
        article_url,
        title,
        author,
        published_at,
        updated_at,
        preview: truncate(preview_source, 320),
        body_text: truncate(&body_text, MAX_BODY_CHARS),
        content_source: content_source.to_string(),
        article_fetched_at: None,
        article_fetch_error: None,
        categories: entry
            .categories
            .iter()
            .map(|category| truncate(category.term.trim(), 100))
            .filter(|category| !category.is_empty())
            .take(20)
            .collect(),
    }
}

fn preferred_link(links: &[Link]) -> Option<String> {
    links
        .iter()
        .filter(|link| link.rel.as_deref().is_none_or(|rel| rel == "alternate"))
        .chain(links.iter())
        .find_map(|link| {
            Url::parse(&link.href)
                .ok()
                .filter(|url| matches!(url.scheme(), "http" | "https"))
                .map(|url| url.to_string())
        })
}

fn stable_entry_key(
    entry: &Entry,
    article_url: Option<&str>,
    title: &str,
    published_at: i64,
    author: &str,
) -> String {
    if !entry.id.trim().is_empty() && !looks_generated_uuid(&entry.id) {
        return format!("id:{}", entry.id.trim());
    }
    if let Some(url) = article_url {
        return format!("url:{url}");
    }
    format!("fallback:{title}\n{published_at}\n{author}")
}

fn looks_generated_uuid(value: &str) -> bool {
    let value = value.trim();
    value.to_ascii_lowercase().starts_with("urn:uuid:")
        || (value.len() == 36
            && value.chars().enumerate().all(|(index, character)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    character == '-'
                } else {
                    character.is_ascii_hexdigit()
                }
            }))
}

fn plain_text(value: &str) -> String {
    let decoded = if value.contains('<') || value.contains('&') {
        mail_parser::decoders::html::html_to_text(value)
    } else {
        value.to_string()
    };
    let mut output = String::new();
    let mut previous_blank = false;
    for line in decoded.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !previous_blank && !output.is_empty() {
                output.push('\n');
            }
            previous_blank = true;
        } else {
            if !output.is_empty() && !output.ends_with('\n') {
                output.push('\n');
            }
            output.push_str(trimmed);
            previous_blank = false;
        }
    }
    output.trim().to_string()
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn sha256_hex(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn header_text(value: Option<&reqwest::header::HeaderValue>) -> Option<String> {
    value
        .and_then(|value| value.to_str().ok())
        .map(|value| truncate(value.trim(), 512))
        .filter(|value| !value.is_empty())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn request_error(subject: &str, error: reqwest::Error) -> String {
    format!(
        "{}请求失败：{}",
        subject.trim_end_matches("地址"),
        redact_sensitive_text(&error.without_url().to_string())
    )
}

fn rss_error(error: impl std::fmt::Display) -> String {
    format!(
        "RSS 同步失败：{}",
        redact_sensitive_text(&error.to_string())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rss_as_safe_plain_text_with_stable_ids() {
        let fixture = br#"<?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0"><channel><title>Example Feed</title><link>https://example.com</link>
          <description>Updates</description><item><guid>post-1</guid><title>Hello &amp; RSS</title>
          <link>https://example.com/post-1</link><author>Alice</author>
          <description><![CDATA[<p>Hello <strong>reader</strong></p><script>bad()</script>]]></description>
          <pubDate>Tue, 28 Jul 2026 10:30:00 +0800</pubDate><category>News</category></item>
          </channel></rss>"#;
        let feed = feed_rs::parser::parse(fixture.as_slice()).expect("feed");
        let first = map_feed(
            feed.clone(),
            Url::parse("https://example.com/feed.xml").expect("url"),
            None,
            None,
            10,
        );
        let second = map_feed(
            feed,
            Url::parse("https://example.com/feed.xml").expect("url"),
            None,
            None,
            10,
        );
        assert_eq!(first.feed_title.as_deref(), Some("Example Feed"));
        assert_eq!(first.entries[0].title, "Hello & RSS");
        assert_eq!(first.entries[0].body_text, "Hello reader");
        assert!(!first.entries[0].body_text.contains("bad()"));
        assert_eq!(first.entries[0].remote_id, second.entries[0].remote_id);
        assert_eq!(first.entries[0].categories, vec!["News"]);
        assert!(entry_is_after_cursor(
            &first.entries[0],
            first.entries[0].published_at - 1
        ));
        assert!(!entry_is_after_cursor(
            &first.entries[0],
            first.entries[0].published_at
        ));
    }

    #[test]
    fn blocks_local_and_non_http_feed_urls() {
        assert!(normalize_feed_url("file:///etc/passwd").is_err());
        assert!(normalize_feed_url("https://user:pass@example.com/feed").is_err());
        assert!(!is_public_ip("127.0.0.1".parse().expect("ip")));
        assert!(!is_public_ip("10.0.0.1".parse().expect("ip")));
        assert!(!is_public_ip("::1".parse().expect("ip")));
        assert!(is_public_ip("1.1.1.1".parse().expect("ip")));
    }

    #[test]
    fn finds_tagged_http_metadata_safely() {
        assert_eq!(truncate("abcdef", 3), "abc");
        assert!(looks_generated_uuid("550e8400-e29b-41d4-a716-446655440000"));
        assert!(!looks_generated_uuid("article-guid-1"));
    }

    #[tokio::test]
    #[ignore = "requires public network access"]
    async fn real_public_atom_feed_smoke() {
        let result = fetch_rss_feed(RssFetchInput {
            url: "https://github.com/vuejs/core/releases.atom".to_string(),
            etag: None,
            last_modified: None,
            after_published_at: None,
            limit: 5,
        })
        .await
        .expect("public Atom feed");
        assert!(!result.not_modified);
        assert!(!result.entries.is_empty());
        assert!(result.entries.iter().all(|entry| !entry.title.is_empty()));
    }

    #[tokio::test]
    #[ignore = "requires public network access"]
    async fn real_openai_feed_extracts_article_body() {
        let result = fetch_rss_feed(RssFetchInput {
            url: "https://openai.com/news/rss.xml".to_string(),
            etag: None,
            last_modified: None,
            after_published_at: None,
            limit: 3,
        })
        .await
        .expect("OpenAI news feed");
        assert!(!result.entries.is_empty());
        assert!(result.entries.iter().any(|entry| {
            entry.content_source == "article" && entry.body_text.chars().count() > 1_200
        }));
    }
}
