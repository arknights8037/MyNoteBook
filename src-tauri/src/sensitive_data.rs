use regex::Regex;
use std::sync::OnceLock;

const REDACTED: &str = "[REDACTED]";

pub fn redact_sensitive_text(value: &str) -> String {
    let bearer = bearer_pattern().replace_all(value, format!("Bearer {REDACTED}"));
    let assigned = sensitive_assignment_pattern()
        .replace_all(&bearer, |captures: &regex::Captures| {
            format!("{}{}{}", &captures[1], &captures[2], REDACTED)
        });
    let provider_key = provider_key_pattern().replace_all(&assigned, REDACTED);
    url_credentials_pattern()
        .replace_all(&provider_key, |captures: &regex::Captures| {
            format!("{}{}@", &captures[1], REDACTED)
        })
        .into_owned()
}

fn sensitive_assignment_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?i)(authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|capability[_-]?token|client[_-]?secret|password|passwd|cookie|set-cookie|secret)(\s*["']?\s*[:=]\s*["']?)([^"'\s,;}]+)"#,
        )
        .expect("sensitive assignment regex")
    })
}

fn bearer_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{6,}").expect("bearer regex"))
}

fn provider_key_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"\bsk-[A-Za-z0-9_-]{6,}\b").expect("provider key regex"))
}

fn url_credentials_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)(https?://[^/\s:@]+:)[^@\s/]+@").expect("URL credentials regex")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_provider_errors_and_third_party_log_messages() {
        let redacted = redact_sensitive_text(
            r#"401 {"api_key":"sk-provider-secret","authorization":"Bearer abc.def.secret"} https://user:pass@example.com"#,
        );
        assert!(!redacted.contains("sk-provider-secret"));
        assert!(!redacted.contains("abc.def.secret"));
        assert!(!redacted.contains(":pass@"));
        assert!(redacted.contains(REDACTED));
    }
}
