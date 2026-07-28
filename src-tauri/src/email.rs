use mail_parser::MessageParser;
use native_tls::{TlsConnector, TlsStream};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    io::{Read, Write},
    net::TcpStream,
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
const CLIENT_NAME: &str = "MyNoteBook";
const CLIENT_VENDOR: &str = "MyNoteBook Project";
const CLIENT_SUPPORT_URL: &str = "https://github.com/arknights8037/MyNoteBook";
const MAX_ID_RESPONSE_BYTES: usize = 262_144;
const PARSEABLE_ID_RESPONSE: &[u8] = b"* OK IMAP ID response received\r\n";

#[derive(Debug)]
struct ImapIdentityTransport<T> {
    inner: T,
    outgoing_prefix: Vec<u8>,
    ignore_outgoing_line: bool,
    expected_id_tag: Option<Vec<u8>>,
    id_response: Vec<u8>,
    pending_read: VecDeque<u8>,
}

impl<T> ImapIdentityTransport<T> {
    fn new(inner: T) -> Self {
        Self {
            inner,
            outgoing_prefix: Vec::new(),
            ignore_outgoing_line: false,
            expected_id_tag: None,
            id_response: Vec::new(),
            pending_read: VecDeque::new(),
        }
    }

    fn observe_write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            if *byte == b'\n' {
                self.outgoing_prefix.clear();
                self.ignore_outgoing_line = false;
                continue;
            }
            if self.ignore_outgoing_line {
                continue;
            }
            if self.outgoing_prefix.len() < 128 {
                self.outgoing_prefix.push(*byte);
            }
            let tokens = self
                .outgoing_prefix
                .split(|candidate| candidate.is_ascii_whitespace())
                .filter(|token| !token.is_empty())
                .collect::<Vec<_>>();
            if byte.is_ascii_whitespace() && tokens.len() >= 2 {
                if tokens[1].eq_ignore_ascii_case(b"ID") {
                    self.expected_id_tag = Some(tokens[0].to_vec());
                }
                self.outgoing_prefix.clear();
                self.ignore_outgoing_line = true;
            }
        }
    }

    fn copy_pending(&mut self, output: &mut [u8]) -> usize {
        let count = output.len().min(self.pending_read.len());
        for destination in output.iter_mut().take(count) {
            *destination = self.pending_read.pop_front().expect("pending byte");
        }
        count
    }
}

impl<T: Read> Read for ImapIdentityTransport<T> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if !self.pending_read.is_empty() {
            return Ok(self.copy_pending(output));
        }
        let Some(tag) = self.expected_id_tag.clone() else {
            return self.inner.read(output);
        };

        loop {
            let mut buffer = [0_u8; 4096];
            let read = self.inner.read(&mut buffer)?;
            if read == 0 {
                return Ok(0);
            }
            self.id_response.extend_from_slice(&buffer[..read]);
            if self.id_response.len() > MAX_ID_RESPONSE_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "IMAP ID response exceeded the safety limit",
                ));
            }
            if let Some((tagged_start, tagged_end)) =
                find_tagged_completion(&self.id_response, &tag)
            {
                self.pending_read.extend(PARSEABLE_ID_RESPONSE);
                self.pending_read
                    .extend(&self.id_response[tagged_start..tagged_end]);
                self.pending_read.extend(&self.id_response[tagged_end..]);
                self.id_response.clear();
                self.expected_id_tag = None;
                return Ok(self.copy_pending(output));
            }
        }
    }
}

impl<T: Write> Write for ImapIdentityTransport<T> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(bytes)?;
        self.observe_write(&bytes[..written]);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

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
    let client = connect_imap(&input.host, input.port)?;
    let mut session = client
        .login(&input.username, input.password)
        .map_err(|(error, _)| email_error(error))?;
    send_client_identity(&mut session)?;
    session.examine(&input.mailbox).map_err(email_error)?;
    session.logout().map_err(email_error)
}

fn sync_messages(
    input: EmailSyncInput,
    password: String,
    limit: usize,
) -> Result<Vec<RemoteEmailMessage>, String> {
    let client = connect_imap(&input.host, input.port)?;
    let mut session = client
        .login(&input.username, password)
        .map_err(|(error, _)| email_error(error))?;
    send_client_identity(&mut session)?;
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

#[cfg(test)]
pub(crate) fn real_sync_smoke(
    account_id: String,
    host: String,
    port: u16,
    username: String,
    mailbox: String,
    password: String,
) -> Result<usize, String> {
    let input = EmailSyncInput {
        account_id,
        host,
        port,
        username,
        mailbox,
        limit: 5,
    };
    validate_connection(&input.host, input.port, &input.username, &input.mailbox)?;
    sync_messages(input, password, 5).map(|messages| messages.len())
}

fn connect_imap(
    host: &str,
    port: u16,
) -> Result<imap::Client<ImapIdentityTransport<TlsStream<TcpStream>>>, String> {
    let tcp = TcpStream::connect((host, port)).map_err(email_error)?;
    let connector = TlsConnector::builder().build().map_err(email_error)?;
    let tls = connector.connect(host, tcp).map_err(email_error)?;
    let mut client = imap::Client::new(ImapIdentityTransport::new(tls));
    client.read_greeting().map_err(email_error)?;
    Ok(client)
}

fn send_client_identity<T: Read + Write>(session: &mut imap::Session<T>) -> Result<(), String> {
    let capabilities = session.capabilities().map_err(email_error)?;
    if capabilities.has_str("ID") {
        session
            .run_command_and_check_ok(client_identity_command())
            .map_err(email_error)?;
    }
    Ok(())
}

fn client_identity_command() -> String {
    format!(
        "ID (\"name\" {} \"version\" {} \"vendor\" {} \"support-url\" {})",
        quote_id_value(CLIENT_NAME),
        quote_id_value(env!("CARGO_PKG_VERSION")),
        quote_id_value(CLIENT_VENDOR),
        quote_id_value(CLIENT_SUPPORT_URL),
    )
}

fn quote_id_value(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .chars()
            .filter(|character| !character.is_control())
            .take(255)
            .collect::<String>()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    )
}

fn find_tagged_completion(response: &[u8], tag: &[u8]) -> Option<(usize, usize)> {
    let mut line_start = 0;
    while line_start < response.len() {
        let relative_end = response[line_start..]
            .windows(2)
            .position(|window| window == b"\r\n")?;
        let line_end = line_start + relative_end;
        let line = &response[line_start..line_end];
        if line.starts_with(tag)
            && line.get(tag.len()) == Some(&b' ')
            && line[tag.len() + 1..]
                .split(|byte| byte.is_ascii_whitespace())
                .next()
                .is_some_and(|status| {
                    status.eq_ignore_ascii_case(b"OK")
                        || status.eq_ignore_ascii_case(b"NO")
                        || status.eq_ignore_ascii_case(b"BAD")
                })
        {
            return Some((line_start, line_end + 2));
        }
        line_start = line_end + 2;
    }
    None
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
    let redacted = redact_sensitive_text(&error.to_string());
    if redacted.to_ascii_lowercase().contains("unsafe login") {
        return "邮箱服务器返回 Unsafe Login。客户端已支持 RFC 2971 IMAP ID；请确认已在邮箱后台开启 IMAP 并使用授权码，若仍失败请联系邮箱服务商。".to_string();
    }
    format!("邮箱连接失败：{redacted}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[derive(Debug)]
    struct MockStream {
        read: Cursor<Vec<u8>>,
        written: Vec<u8>,
    }

    impl Read for MockStream {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let position = self.read.position() as usize;
            let source = self.read.get_ref();
            if position >= source.len() {
                return Ok(0);
            }
            let line_length = source[position..]
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|offset| offset + 1)
                .unwrap_or(source.len() - position);
            let count = buffer.len().min(line_length);
            buffer[..count].copy_from_slice(&source[position..position + count]);
            self.read.set_position((position + count) as u64);
            Ok(count)
        }
    }

    impl Write for MockStream {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.written.extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

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

    #[test]
    fn builds_rfc_2971_client_identity_without_command_delimiters() {
        let command = client_identity_command();
        assert_eq!(
            command,
            concat!(
                "ID (\"name\" \"MyNoteBook\" \"version\" \"0.1.0\" ",
                "\"vendor\" \"MyNoteBook Project\" ",
                "\"support-url\" \"https://github.com/arknights8037/MyNoteBook\")"
            )
        );
        assert!(!command.contains(['\r', '\n']));
        assert_eq!(
            quote_id_value("client \\\"name\"\n"),
            "\"client \\\\\\\"name\\\"\""
        );
    }

    #[test]
    fn sends_identity_after_login_when_server_advertises_id() {
        let responses = concat!(
            "a1 OK Logged in\r\n",
            "* CAPABILITY IMAP4rev1 ID\r\n",
            "a2 OK CAPABILITY completed\r\n",
            "* ID (\"name\" \"NetEase\")\r\n",
            "a3 OK ID completed\r\n",
        );
        let stream = MockStream {
            read: Cursor::new(responses.as_bytes().to_vec()),
            written: Vec::new(),
        };
        let client = imap::Client::new(ImapIdentityTransport::new(stream));
        let mut session = client.login("user", "password").expect("login");

        send_client_identity(&mut session).expect("client identity");
    }
}
