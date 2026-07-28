use mail_parser::MessageParser;
use native_tls::TlsConnector;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, State};

use crate::{
    secret_store::{self, AiSecretState},
    sensitive_data::redact_sensitive_text,
};

const MAX_SYNC_MESSAGES: usize = 50;
const MAX_MESSAGE_BYTES: usize = 1_048_576;
const MAX_BODY_CHARS: usize = 200_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailConnectionInput {
    host: String,
    port: u16,
    username: String,
    password: String,
    mailbox: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailSecretInput {
    account_id: String,
    password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailSyncInput {
    account_id: String,
    host: String,
    port: u16,
    username: String,
    mailbox: String,
    limit: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEmailMessage {
    remote_uid: u32,
    message_id: Option<String>,
    subject: String,
    from_name: String,
    from_address: String,
    to_addresses: Vec<String>,
    received_at: i64,
    preview: String,
    body_text: String,
    attachment_count: usize,
    server_is_read: bool,
}

#[tauri::command]
pub async fn test_email_connection(input: EmailConnectionInput) -> Result<(), String> {
    validate_connection(&input.host, input.port, &input.username, &input.mailbox)?;
    if input.password.is_empty() {
        return Err("邮箱密码或应用专用密码不能为空。".to_string());
    }
    tokio::time::timeout(
        Duration::from_secs(30),
        tauri::async_runtime::spawn_blocking(move || test_connection_blocking(input)),
    )
    .await
    .map_err(|_| "邮箱连接超时。".to_string())?
    .map_err(email_error)?
}

#[tauri::command]
pub async fn set_email_account_secret(
    app: AppHandle,
    state: State<'_, AiSecretState>,
    input: EmailSecretInput,
) -> Result<(), String> {
    validate_account_id(&input.account_id)?;
    if input.password.is_empty() {
        return Err("邮箱密码或应用专用密码不能为空。".to_string());
    }
    secret_store::set_secret_value(
        &app,
        &state,
        &email_secret_key(&input.account_id),
        input.password,
    )
    .await
}

#[tauri::command]
pub async fn delete_email_account_secret(
    app: AppHandle,
    state: State<'_, AiSecretState>,
    account_id: String,
) -> Result<(), String> {
    validate_account_id(&account_id)?;
    secret_store::set_secret_value(&app, &state, &email_secret_key(&account_id), String::new())
        .await
}

#[tauri::command]
pub async fn sync_email_account(
    app: AppHandle,
    state: State<'_, AiSecretState>,
    input: EmailSyncInput,
) -> Result<Vec<RemoteEmailMessage>, String> {
    validate_account_id(&input.account_id)?;
    validate_connection(&input.host, input.port, &input.username, &input.mailbox)?;
    let password =
        secret_store::get_secret_value(&app, &state, &email_secret_key(&input.account_id)).await?;
    if password.is_empty() {
        return Err("该邮箱账户缺少安全凭据，请删除后重新连接。".to_string());
    }

    let limit = input.limit.clamp(1, MAX_SYNC_MESSAGES);
    tokio::time::timeout(
        Duration::from_secs(60),
        tauri::async_runtime::spawn_blocking(move || sync_messages(input, password, limit)),
    )
    .await
    .map_err(|_| "邮箱同步超时。".to_string())?
    .map_err(email_error)?
}

fn test_connection_blocking(input: EmailConnectionInput) -> Result<(), String> {
    let tls = TlsConnector::builder().build().map_err(email_error)?;
    let client =
        imap::connect((input.host.as_str(), input.port), &input.host, &tls).map_err(email_error)?;
    let mut session = client
        .login(&input.username, input.password)
        .map_err(|(error, _)| email_error(error))?;
    session.examine(&input.mailbox).map_err(email_error)?;
    session.logout().map_err(email_error)
}

fn sync_messages(
    input: EmailSyncInput,
    password: String,
    limit: usize,
) -> Result<Vec<RemoteEmailMessage>, String> {
    let tls = TlsConnector::builder().build().map_err(email_error)?;
    let client =
        imap::connect((input.host.as_str(), input.port), &input.host, &tls).map_err(email_error)?;
    let mut session = client
        .login(&input.username, password)
        .map_err(|(error, _)| email_error(error))?;
    session.examine(&input.mailbox).map_err(email_error)?;
    let mut all_ids: Vec<u32> = session
        .search("ALL")
        .map_err(email_error)?
        .into_iter()
        .collect();
    if all_ids.is_empty() {
        session.logout().map_err(email_error)?;
        return Ok(Vec::new());
    }
    all_ids.sort_unstable();
    let unseen: HashSet<u32> = session.search("UNSEEN").map_err(email_error)?;
    let mut recent_ids: Vec<u32> = all_ids.into_iter().rev().take(limit).collect();
    recent_ids.sort_unstable();
    let sequence_set = recent_ids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let fetch_items = format!("(UID BODY.PEEK[]<0.{MAX_MESSAGE_BYTES}>)");
    let fetched = session
        .fetch(&sequence_set, &fetch_items)
        .map_err(email_error)?;
    let now = now_millis();
    let mut messages = fetched
        .iter()
        .filter_map(|result| {
            parse_message(result.message, result.uid, result.body()?, &unseen, now)
        })
        .collect::<Vec<_>>();
    messages.sort_by(|left, right| right.received_at.cmp(&left.received_at));
    session.logout().map_err(email_error)?;
    Ok(messages)
}

fn parse_message(
    sequence: u32,
    uid: Option<u32>,
    body: &[u8],
    unseen_sequences: &HashSet<u32>,
    fallback_received_at: i64,
) -> Option<RemoteEmailMessage> {
    let parsed = MessageParser::default().parse(&body)?;
    let sender = parsed.from().and_then(|address| address.first());
    let body_text = truncate_chars(
        parsed.body_text(0).as_deref().unwrap_or_default(),
        MAX_BODY_CHARS,
    );
    let preview = parsed
        .body_preview(320)
        .map(|value| value.into_owned())
        .unwrap_or_else(|| truncate_chars(&body_text, 320));
    let to_addresses = parsed
        .to()
        .map(|addresses| {
            addresses
                .iter()
                .filter_map(|address| address.address().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Some(RemoteEmailMessage {
        remote_uid: uid.unwrap_or(sequence),
        message_id: parsed.message_id().map(str::to_string),
        subject: parsed.subject().unwrap_or("（无主题）").trim().to_string(),
        from_name: sender
            .and_then(|address| address.name())
            .unwrap_or_default()
            .to_string(),
        from_address: sender
            .and_then(|address| address.address())
            .unwrap_or_default()
            .to_string(),
        to_addresses,
        received_at: parsed
            .date()
            .map(|date| date.to_timestamp().saturating_mul(1000))
            .unwrap_or(fallback_received_at),
        preview,
        body_text,
        attachment_count: parsed.attachment_count(),
        server_is_read: !unseen_sequences.contains(&sequence),
    })
}

fn validate_connection(host: &str, port: u16, username: &str, mailbox: &str) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty()
        || host.len() > 253
        || host
            .chars()
            .any(|character| character.is_whitespace() || "/:@".contains(character))
    {
        return Err("IMAP 主机名无效。".to_string());
    }
    if port == 0 {
        return Err("IMAP 端口无效。".to_string());
    }
    if username.trim().is_empty() || username.len() > 320 {
        return Err("IMAP 用户名无效。".to_string());
    }
    if mailbox.trim().is_empty()
        || mailbox.len() > 255
        || mailbox
            .chars()
            .any(|character| matches!(character, '\r' | '\n'))
    {
        return Err("邮箱文件夹名称无效。".to_string());
    }
    Ok(())
}

fn validate_account_id(account_id: &str) -> Result<(), String> {
    if account_id.is_empty()
        || account_id.len() > 160
        || !account_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("邮箱账户 ID 无效。".to_string());
    }
    Ok(())
}

fn email_secret_key(account_id: &str) -> String {
    format!("email:{account_id}")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn email_error(error: impl std::fmt::Display) -> String {
    format!(
        "邮箱连接失败：{}",
        redact_sensitive_text(&error.to_string())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mime_message_without_retaining_html() {
        let raw = b"From: Example <sender@example.com>\r\nTo: me@example.com\r\nSubject: =?UTF-8?B?5rWL6K+V6YKu5Lu2?=\r\nMessage-ID: <message-1@example.com>\r\nDate: Tue, 28 Jul 2026 10:30:00 +0800\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello inbox";
        let message = parse_message(2, Some(42), raw, &HashSet::from([2]), 0).expect("message");
        assert_eq!(message.remote_uid, 42);
        assert_eq!(message.subject, "测试邮件");
        assert_eq!(message.from_address, "sender@example.com");
        assert_eq!(message.body_text, "hello inbox");
        assert!(!message.server_is_read);
    }

    #[test]
    fn rejects_control_characters_and_credentialed_hosts() {
        assert!(validate_connection("user:pass@example.com", 993, "user", "INBOX").is_err());
        assert!(validate_connection("imap.example.com", 993, "user", "INBOX\r\nBAD").is_err());
    }
}
