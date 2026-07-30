use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RetryPolicy {
    pub(crate) max_attempts: i64,
    pub(crate) base_delay_ms: i64,
    pub(crate) max_delay_ms: i64,
}

impl RetryPolicy {
    pub(crate) const fn new(max_attempts: i64, base_delay_ms: i64, max_delay_ms: i64) -> Self {
        Self {
            max_attempts,
            base_delay_ms,
            max_delay_ms,
        }
    }

    pub(crate) fn delay_ms(self, attempt_count: i64) -> i64 {
        let exponent = (attempt_count.saturating_sub(1) as u32).min(20);
        self.base_delay_ms
            .saturating_mul(2_i64.saturating_pow(exponent))
            .min(self.max_delay_ms)
            .max(0)
    }

    pub(crate) fn exhausted(self, attempt_count: i64) -> bool {
        attempt_count >= self.max_attempts
    }
}

pub(crate) const A2A_RETRY_POLICY: RetryPolicy = RetryPolicy::new(3, 5_000, 5 * 60 * 1_000);
pub(crate) const AUTOMATION_RETRY_POLICY: RetryPolicy = RetryPolicy::new(3, 5_000, 5 * 60 * 1_000);
pub(crate) const TIMER_RETRY_POLICY: RetryPolicy = RetryPolicy::new(5, 5_000, 5 * 60 * 1_000);
#[allow(dead_code)] // Activated by the Rust-owned Phase 5 Outbox dispatcher.
pub(crate) const OUTBOX_RETRY_POLICY: RetryPolicy = RetryPolicy::new(8, 5_000, 15 * 60 * 1_000);

pub(crate) fn clamp_lease_ms(value: i64, minimum: i64, maximum: i64) -> i64 {
    value.clamp(minimum, maximum)
}

pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_policy_is_bounded_and_reports_exhaustion() {
        let policy = RetryPolicy::new(4, 100, 500);
        assert_eq!(policy.delay_ms(1), 100);
        assert_eq!(policy.delay_ms(2), 200);
        assert_eq!(policy.delay_ms(3), 400);
        assert_eq!(policy.delay_ms(4), 500);
        assert!(!policy.exhausted(3));
        assert!(policy.exhausted(4));
    }
}
