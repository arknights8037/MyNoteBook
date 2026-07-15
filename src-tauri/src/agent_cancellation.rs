use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use serde::Deserialize;

static TOOL_CANCELLATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn cancellations() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    TOOL_CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) struct ToolCancellationGuard {
    call_id: String,
    cancelled: Arc<AtomicBool>,
}

impl ToolCancellationGuard {
    pub(crate) fn register(call_id: String) -> Result<Self, String> {
        if call_id.trim().is_empty() || call_id.len() > 160 {
            return Err("Agent 工具调用 ID 无效。".to_string());
        }
        let mut entries = cancellations()
            .lock()
            .map_err(|_| "Agent 工具取消注册表不可用。".to_string())?;
        let cancelled = entries
            .entry(call_id.clone())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone();
        Ok(Self { call_id, cancelled })
    }

    pub(crate) async fn cancelled(&self) {
        while !self.cancelled.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

impl Drop for ToolCancellationGuard {
    fn drop(&mut self) {
        if let Ok(mut entries) = cancellations().lock() {
            entries.remove(&self.call_id);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelAgentToolCallInput {
    pub(crate) call_id: String,
}

#[tauri::command]
pub(crate) fn cancel_agent_tool_call(input: CancelAgentToolCallInput) -> Result<(), String> {
    if input.call_id.trim().is_empty() || input.call_id.len() > 160 {
        return Err("Agent 工具调用 ID 无效。".to_string());
    }
    let mut entries = cancellations()
        .lock()
        .map_err(|_| "Agent 工具取消注册表不可用。".to_string())?;
    let call_id = input.call_id;
    let cancelled = entries
        .entry(call_id.clone())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone();
    cancelled.store(true, Ordering::Release);
    drop(entries);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        if let Ok(mut entries) = cancellations().lock() {
            if entries
                .get(&call_id)
                .is_some_and(|current| Arc::ptr_eq(current, &cancelled))
            {
                entries.remove(&call_id);
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{cancel_agent_tool_call, CancelAgentToolCallInput, ToolCancellationGuard};
    use std::time::Duration;

    #[tokio::test]
    async fn cancellation_can_arrive_before_registration() {
        cancel_agent_tool_call(CancelAgentToolCallInput {
            call_id: "call-before-register".to_string(),
        })
        .unwrap();
        let guard = ToolCancellationGuard::register("call-before-register".to_string()).unwrap();
        tokio::time::timeout(Duration::from_millis(50), guard.cancelled())
            .await
            .expect("pre-registered cancellation should be observed");
    }
}
