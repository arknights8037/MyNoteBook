use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};

use crate::{
    database,
    domain_events::{record_with_outbox, NewDomainEvent},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkflowBinding {
    pub(crate) work_item_id: String,
    pub(crate) workflow_id: String,
    pub(crate) event_id: String,
    pub(crate) correlation_id: String,
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub(crate) struct SuspendRequest<'a> {
    pub(crate) condition_kind: &'a str,
    pub(crate) deduplication_key: &'a str,
    pub(crate) payload: &'a Value,
    pub(crate) due_at: Option<i64>,
}

pub(crate) async fn ensure_automation_workflow(
    connection: &SqlitePool,
    automation_run_id: &str,
    automation_id: &str,
    trigger_source: &str,
    source_type: &str,
    now: i64,
) -> Result<WorkflowBinding, String> {
    if let Some(binding) = load_automation_binding(connection, automation_run_id).await? {
        return Ok(binding);
    }
    let source = if source_type == "rss" {
        "rss"
    } else if trigger_source == "schedule" {
        "timer"
    } else {
        "manual"
    };
    let event_id = format!("workflow-source-automation-{automation_run_id}");
    let outbox_id = format!("workflow-source-automation-{automation_run_id}-outbox");
    let work_item_id = format!("work-item-automation-{automation_run_id}");
    let workflow_id = format!("workflow-automation-{automation_run_id}");
    let correlation_id = automation_run_id.to_string();
    let payload = json!({
        "automationRunId": automation_run_id,
        "automationId": automation_id,
        "triggerSource": trigger_source,
        "sourceType": source_type
    });
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    let event_exists =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM domain_events WHERE id = ?")
            .bind(&event_id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(database::database_error)?
            == 1;
    if !event_exists {
        record_with_outbox(
            &mut transaction,
            NewDomainEvent {
                event_id: &event_id,
                outbox_id: &outbox_id,
                event_type: "workflow.source.accepted",
                aggregate_type: "automation_run",
                aggregate_id: automation_run_id,
                payload: &payload,
                actor_id: if source == "manual" {
                    "local_user"
                } else {
                    "rust-workflow-scheduler"
                },
                source: "rust_workflow",
                workspace_id: Some("default"),
                deduplication_key: &format!("automation-run:{automation_run_id}"),
                security_scope: Some(&json!({ "knowledge": "read", "rss": source == "rss" })),
                correlation_id: &correlation_id,
                causation_id: None,
                occurred_at: now,
            },
        )
        .await?;
    }
    insert_work_item_and_workflow(
        &mut transaction,
        &work_item_id,
        &workflow_id,
        &event_id,
        source,
        &payload,
        &correlation_id,
        None,
        now,
    )
    .await?;
    sqlx::query(
        "UPDATE automation_runs SET workflow_work_item_id = ?, workflow_id = ? WHERE id = ?",
    )
    .bind(&work_item_id)
    .bind(&workflow_id)
    .bind(automation_run_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    transaction
        .commit()
        .await
        .map_err(database::database_error)?;
    Ok(WorkflowBinding {
        work_item_id,
        workflow_id,
        event_id,
        correlation_id,
    })
}

pub(crate) async fn ensure_signal_workflow(
    connection: &SqlitePool,
    signal_run_id: &str,
    event_id: &str,
    payload: &Value,
    now: i64,
) -> Result<WorkflowBinding, String> {
    if let Some(binding) = load_signal_binding(connection, signal_run_id).await? {
        return Ok(binding);
    }
    let event =
        sqlx::query("SELECT correlation_id, causation_id FROM domain_events WHERE id = ? LIMIT 1")
            .bind(event_id)
            .fetch_optional(connection)
            .await
            .map_err(database::database_error)?
            .ok_or_else(|| "信号 Workflow 的来源事件不存在。".to_string())?;
    let correlation_id: String = event
        .try_get("correlation_id")
        .map_err(database::database_error)?;
    let causation_id = event
        .try_get::<Option<String>, _>("causation_id")
        .unwrap_or(None);
    let source = if payload.get("scope").and_then(Value::as_str) == Some("rss") {
        "rss"
    } else if payload.get("triggerSource").and_then(Value::as_str) == Some("manual") {
        "manual"
    } else {
        "related_update"
    };
    let work_item_id = format!("work-item-signal-{event_id}");
    let workflow_id = format!("workflow-signal-{event_id}");
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    insert_work_item_and_workflow(
        &mut transaction,
        &work_item_id,
        &workflow_id,
        event_id,
        source,
        payload,
        &correlation_id,
        causation_id.as_deref(),
        now,
    )
    .await?;
    sqlx::query(
        "UPDATE signal_agent_runs SET workflow_work_item_id = ?, workflow_id = ? WHERE id = ?",
    )
    .bind(&work_item_id)
    .bind(&workflow_id)
    .bind(signal_run_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    transaction
        .commit()
        .await
        .map_err(database::database_error)?;
    Ok(WorkflowBinding {
        work_item_id,
        workflow_id,
        event_id: event_id.to_string(),
        correlation_id,
    })
}

async fn insert_work_item_and_workflow(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    work_item_id: &str,
    workflow_id: &str,
    event_id: &str,
    source: &str,
    payload: &Value,
    correlation_id: &str,
    causation_id: Option<&str>,
    now: i64,
) -> Result<(), String> {
    sqlx::query(
        "INSERT OR IGNORE INTO workflow_work_items \
         (id, event_id, source_type, classification, status, payload_json, correlation_id, \
          causation_id, deduplication_key, created_at, updated_at) \
         VALUES (?, ?, ?, 'agent_required', 'queued', ?, ?, ?, ?, ?, ?)",
    )
    .bind(work_item_id)
    .bind(event_id)
    .bind(source)
    .bind(payload.to_string())
    .bind(correlation_id)
    .bind(causation_id)
    .bind(format!("work-item:{event_id}"))
    .bind(now)
    .bind(now)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    sqlx::query(
        "INSERT OR IGNORE INTO workflow_instances \
         (id, work_item_id, workflow_type, state, correlation_id, causation_id, created_at, updated_at) \
         VALUES (?, ?, 'agent', 'READY', ?, ?, ?, ?)",
    )
    .bind(workflow_id)
    .bind(work_item_id)
    .bind(correlation_id)
    .bind(causation_id)
    .bind(now)
    .bind(now)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    Ok(())
}

pub(crate) async fn start_run(
    connection: &SqlitePool,
    binding: &WorkflowBinding,
    run_id: &str,
    attempt_number: i64,
    now: i64,
) -> Result<(), String> {
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    sqlx::query(
        "INSERT INTO workflow_run_attempts \
         (id, workflow_id, run_id, attempt_number, status, causation_event_id, started_at) \
         VALUES (?, ?, ?, ?, 'running', ?, ?)",
    )
    .bind(format!("workflow-attempt-{run_id}"))
    .bind(&binding.workflow_id)
    .bind(run_id)
    .bind(attempt_number)
    .bind(&binding.event_id)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    let updated = sqlx::query(
        "UPDATE workflow_instances SET state = 'RUNNING', current_run_id = ?, \
         current_wait_condition_id = NULL, error = NULL, updated_at = ?, completed_at = NULL \
         WHERE id = ? AND state IN ('READY', 'RETRY_SCHEDULED')",
    )
    .bind(run_id)
    .bind(now)
    .bind(&binding.workflow_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    if updated.rows_affected() != 1 {
        return Err("Workflow 已不再允许启动新的 Run。".to_string());
    }
    sqlx::query("UPDATE workflow_work_items SET status = 'active', updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(&binding.work_item_id)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
    transaction.commit().await.map_err(database::database_error)
}

pub(crate) async fn mark_retry_scheduled(
    connection: &SqlitePool,
    workflow_id: &str,
    run_id: Option<&str>,
    error: &str,
    now: i64,
) -> Result<(), String> {
    finish_attempt(connection, workflow_id, run_id, "failed", Some(error), now).await?;
    sqlx::query(
        "UPDATE workflow_instances SET state = 'RETRY_SCHEDULED', current_run_id = NULL, \
         error = ?, updated_at = ?, completed_at = NULL WHERE id = ? AND state = 'RUNNING'",
    )
    .bind(truncate(error))
    .bind(now)
    .bind(workflow_id)
    .execute(connection)
    .await
    .map_err(database::database_error)?;
    sqlx::query(
        "UPDATE workflow_work_items SET status = 'queued', updated_at = ? \
         WHERE id = (SELECT work_item_id FROM workflow_instances WHERE id = ?)",
    )
    .bind(now)
    .bind(workflow_id)
    .execute(connection)
    .await
    .map_err(database::database_error)?;
    Ok(())
}

pub(crate) async fn mark_completed(
    connection: &SqlitePool,
    workflow_id: &str,
    run_id: &str,
    output: &Value,
    now: i64,
) -> Result<(), String> {
    finish_attempt(
        connection,
        workflow_id,
        Some(run_id),
        "completed",
        None,
        now,
    )
    .await?;
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    sqlx::query(
        "UPDATE workflow_instances SET state = 'COMPLETED', current_run_id = NULL, \
         output_json = ?, error = NULL, updated_at = ?, completed_at = ? \
         WHERE id = ? AND state = 'RUNNING'",
    )
    .bind(output.to_string())
    .bind(now)
    .bind(now)
    .bind(workflow_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    sqlx::query(
        "UPDATE workflow_work_items SET status = 'completed', updated_at = ?, completed_at = ? \
         WHERE id = (SELECT work_item_id FROM workflow_instances WHERE id = ?)",
    )
    .bind(now)
    .bind(now)
    .bind(workflow_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    transaction.commit().await.map_err(database::database_error)
}

pub(crate) async fn mark_waiting_approval(
    connection: &SqlitePool,
    workflow_id: &str,
    run_id: &str,
    payload: &Value,
    now: i64,
) -> Result<(), String> {
    finish_attempt(
        connection,
        workflow_id,
        Some(run_id),
        "completed",
        None,
        now,
    )
    .await?;
    let wait_id = format!("workflow-wait-approval-{workflow_id}-{run_id}");
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    let correlation_id: String =
        sqlx::query_scalar("SELECT correlation_id FROM workflow_instances WHERE id = ?")
            .bind(workflow_id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(database::database_error)?;
    sqlx::query(
        "INSERT OR IGNORE INTO workflow_wait_conditions \
         (id, workflow_id, deduplication_key, condition_kind, status, correlation_id, \
          causation_id, payload_json, created_at, updated_at) \
         VALUES (?, ?, ?, 'approval', 'pending', ?, ?, ?, ?, ?)",
    )
    .bind(&wait_id)
    .bind(workflow_id)
    .bind(format!("mutation-approval:{run_id}"))
    .bind(correlation_id)
    .bind(run_id)
    .bind(payload.to_string())
    .bind(now)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    sqlx::query(
        "UPDATE workflow_instances SET state = 'WAITING_APPROVAL', current_run_id = NULL, \
         current_wait_condition_id = ?, output_json = ?, updated_at = ? WHERE id = ? AND state = 'RUNNING'",
    )
    .bind(&wait_id)
    .bind(payload.to_string())
    .bind(now)
    .bind(workflow_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    sqlx::query(
        "UPDATE workflow_work_items SET status = 'waiting', updated_at = ? \
         WHERE id = (SELECT work_item_id FROM workflow_instances WHERE id = ?)",
    )
    .bind(now)
    .bind(workflow_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    transaction.commit().await.map_err(database::database_error)
}

#[allow(dead_code)]
pub(crate) async fn suspend_run(
    connection: &SqlitePool,
    binding: &WorkflowBinding,
    run_id: &str,
    request: SuspendRequest<'_>,
    now: i64,
) -> Result<String, String> {
    let state = match request.condition_kind {
        "event" => "WAITING_EVENT",
        "timer" => "WAITING_TIMER",
        "human" => "WAITING_HUMAN",
        "approval" => "WAITING_APPROVAL",
        _ => return Err("SuspendRequest 等待类型无效。".to_string()),
    };
    if request.deduplication_key.trim().is_empty() {
        return Err("SuspendRequest 去重键不能为空。".to_string());
    }
    if request.condition_kind == "timer" && request.due_at.is_none() {
        return Err("Timer SuspendRequest 缺少 dueAt。".to_string());
    }
    finish_attempt(
        connection,
        &binding.workflow_id,
        Some(run_id),
        "completed",
        None,
        now,
    )
    .await?;
    let wait_id = format!(
        "workflow-wait-suspend-{}-{}",
        binding.workflow_id, request.deduplication_key
    );
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    sqlx::query(
        "INSERT OR IGNORE INTO workflow_wait_conditions \
         (id, workflow_id, deduplication_key, condition_kind, status, correlation_id, \
          causation_id, payload_json, created_at, updated_at) \
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
    )
    .bind(&wait_id)
    .bind(&binding.workflow_id)
    .bind(request.deduplication_key)
    .bind(request.condition_kind)
    .bind(&binding.correlation_id)
    .bind(&binding.event_id)
    .bind(request.payload.to_string())
    .bind(now)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    if let Some(due_at) = request.due_at {
        if due_at < 0 {
            return Err("Timer SuspendRequest 的 dueAt 无效。".to_string());
        }
        sqlx::query(
            "INSERT OR IGNORE INTO workflow_timers \
             (id, workflow_id, wait_condition_id, due_at, available_at, status, attempt_count, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, 'scheduled', 0, ?, ?)",
        )
        .bind(format!("workflow-timer-suspend-{wait_id}"))
        .bind(&binding.workflow_id)
        .bind(&wait_id)
        .bind(due_at)
        .bind(due_at)
        .bind(now)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
    }
    let updated = sqlx::query(
        "UPDATE workflow_instances SET state = ?, current_run_id = NULL, \
         current_wait_condition_id = ?, updated_at = ? WHERE id = ? AND state = 'RUNNING'",
    )
    .bind(state)
    .bind(&wait_id)
    .bind(now)
    .bind(&binding.workflow_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    if updated.rows_affected() != 1 {
        return Err("Workflow 已不再允许挂起当前 Run。".to_string());
    }
    sqlx::query("UPDATE workflow_work_items SET status = 'waiting', updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(&binding.work_item_id)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
    transaction
        .commit()
        .await
        .map_err(database::database_error)?;
    Ok(wait_id)
}

pub(crate) async fn consume_event_waits(connection: &SqlitePool, now: i64) -> Result<u64, String> {
    let waits = sqlx::query(
        "SELECT condition.id, condition.workflow_id, condition.payload_json, \
                condition.correlation_id, condition.created_at \
         FROM workflow_wait_conditions condition \
         INNER JOIN workflow_instances workflow ON workflow.id = condition.workflow_id \
         WHERE condition.condition_kind = 'event' AND condition.status = 'pending' \
           AND workflow.state = 'WAITING_EVENT' ORDER BY condition.created_at ASC LIMIT 50",
    )
    .fetch_all(connection)
    .await
    .map_err(database::database_error)?;
    let mut resumed = 0;
    for wait in waits {
        let payload = parse_json_column(&wait, "payload_json")?;
        let Some(event_type) = payload.get("eventType").and_then(Value::as_str) else {
            continue;
        };
        let correlation_id: String = wait
            .try_get("correlation_id")
            .map_err(database::database_error)?;
        let created_at: i64 = wait
            .try_get("created_at")
            .map_err(database::database_error)?;
        let event = sqlx::query(
            "SELECT id, event_type, source, occurred_at, actor_id, workspace_id, correlation_id, \
                    causation_id, deduplication_key, payload_json, security_scope_json \
             FROM domain_events WHERE event_type = ? AND correlation_id = ? AND occurred_at >= ? \
             ORDER BY occurred_at ASC LIMIT 1",
        )
        .bind(event_type)
        .bind(&correlation_id)
        .bind(created_at)
        .fetch_optional(connection)
        .await
        .map_err(database::database_error)?;
        let Some(event) = event else {
            continue;
        };
        let event_id: String = event.try_get("id").map_err(database::database_error)?;
        let resume_payload = json!({
            "version": 1,
            "eventId": event_id,
            "eventType": event.try_get::<String, _>("event_type").unwrap_or_default(),
            "source": event.try_get::<String, _>("source").unwrap_or_default(),
            "occurredAt": event.try_get::<i64, _>("occurred_at").unwrap_or(now),
            "actorId": event.try_get::<String, _>("actor_id").unwrap_or_default(),
            "workspaceId": event.try_get::<Option<String>, _>("workspace_id").unwrap_or(None),
            "correlationId": correlation_id,
            "causationId": event.try_get::<Option<String>, _>("causation_id").unwrap_or(None),
            "deduplicationKey": event.try_get::<Option<String>, _>("deduplication_key").unwrap_or(None),
            "payload": parse_json_column(&event, "payload_json")?,
            "securityScope": parse_json_column(&event, "security_scope_json")?
        });
        let wait_id: String = wait.try_get("id").map_err(database::database_error)?;
        let workflow_id: String = wait
            .try_get("workflow_id")
            .map_err(database::database_error)?;
        let mut transaction = connection.begin().await.map_err(database::database_error)?;
        let satisfied = sqlx::query(
            "UPDATE workflow_wait_conditions SET status = 'satisfied', resume_payload_json = ?, \
             satisfied_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        )
        .bind(resume_payload.to_string())
        .bind(now)
        .bind(now)
        .bind(&wait_id)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
        if satisfied.rows_affected() == 1 {
            resume_workflow_in_transaction(
                &mut transaction,
                &workflow_id,
                &wait_id,
                &event_id,
                now,
            )
            .await?;
            resumed += 1;
        }
        transaction
            .commit()
            .await
            .map_err(database::database_error)?;
    }
    Ok(resumed)
}

pub(crate) async fn resume_satisfied_waits(
    connection: &SqlitePool,
    now: i64,
) -> Result<u64, String> {
    let waits = sqlx::query(
        "SELECT condition.id, condition.workflow_id, condition.resume_payload_json \
         FROM workflow_wait_conditions condition \
         INNER JOIN workflow_instances workflow ON workflow.id = condition.workflow_id \
         WHERE condition.status = 'satisfied' \
           AND workflow.current_wait_condition_id = condition.id \
           AND workflow.state IN ('WAITING_TIMER', 'WAITING_HUMAN', 'WAITING_APPROVAL') \
         ORDER BY condition.satisfied_at ASC LIMIT 50",
    )
    .fetch_all(connection)
    .await
    .map_err(database::database_error)?;
    let mut resumed = 0;
    for wait in waits {
        let wait_id: String = wait.try_get("id").map_err(database::database_error)?;
        let workflow_id: String = wait
            .try_get("workflow_id")
            .map_err(database::database_error)?;
        let causation_id = wait
            .try_get::<Option<String>, _>("resume_payload_json")
            .ok()
            .flatten()
            .and_then(|value| serde_json::from_str::<Value>(&value).ok())
            .and_then(|value| {
                value
                    .get("eventId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
        let mut transaction = connection.begin().await.map_err(database::database_error)?;
        resumed += resume_workflow_in_transaction(
            &mut transaction,
            &workflow_id,
            &wait_id,
            causation_id.as_deref().unwrap_or(&wait_id),
            now,
        )
        .await?;
        transaction
            .commit()
            .await
            .map_err(database::database_error)?;
    }
    Ok(resumed)
}

async fn resume_workflow_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    workflow_id: &str,
    wait_id: &str,
    causation_id: &str,
    now: i64,
) -> Result<u64, String> {
    let updated = sqlx::query(
        "UPDATE workflow_instances SET state = 'READY', current_wait_condition_id = NULL, \
         causation_id = ?, updated_at = ? WHERE id = ? AND current_wait_condition_id = ? \
         AND state IN ('WAITING_EVENT', 'WAITING_TIMER', 'WAITING_HUMAN', 'WAITING_APPROVAL')",
    )
    .bind(causation_id)
    .bind(now)
    .bind(workflow_id)
    .bind(wait_id)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    if updated.rows_affected() == 1 {
        sqlx::query(
            "UPDATE workflow_work_items SET status = 'queued', causation_id = ?, updated_at = ? \
             WHERE id = (SELECT work_item_id FROM workflow_instances WHERE id = ?)",
        )
        .bind(causation_id)
        .bind(now)
        .bind(workflow_id)
        .execute(&mut **transaction)
        .await
        .map_err(database::database_error)?;
    }
    Ok(updated.rows_affected())
}

pub(crate) async fn mark_failed(
    connection: &SqlitePool,
    workflow_id: &str,
    run_id: Option<&str>,
    error: &str,
    now: i64,
) -> Result<(), String> {
    finish_attempt(connection, workflow_id, run_id, "failed", Some(error), now).await?;
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    sqlx::query(
        "UPDATE workflow_instances SET state = 'FAILED', current_run_id = NULL, error = ?, \
         updated_at = ?, completed_at = ? WHERE id = ? AND state NOT IN ('COMPLETED', 'CANCELLED')",
    )
    .bind(truncate(error))
    .bind(now)
    .bind(now)
    .bind(workflow_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    sqlx::query(
        "UPDATE workflow_work_items SET status = 'failed', updated_at = ?, completed_at = ? \
         WHERE id = (SELECT work_item_id FROM workflow_instances WHERE id = ?)",
    )
    .bind(now)
    .bind(now)
    .bind(workflow_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    transaction.commit().await.map_err(database::database_error)
}

async fn finish_attempt(
    connection: &SqlitePool,
    workflow_id: &str,
    run_id: Option<&str>,
    status: &str,
    error: Option<&str>,
    now: i64,
) -> Result<(), String> {
    let Some(run_id) = run_id else {
        return Ok(());
    };
    sqlx::query(
        "UPDATE workflow_run_attempts SET status = ?, error = ?, completed_at = ? \
         WHERE workflow_id = ? AND run_id = ? AND status = 'running'",
    )
    .bind(status)
    .bind(error.map(truncate))
    .bind(now)
    .bind(workflow_id)
    .bind(run_id)
    .execute(connection)
    .await
    .map_err(database::database_error)?;
    Ok(())
}

async fn load_automation_binding(
    connection: &SqlitePool,
    automation_run_id: &str,
) -> Result<Option<WorkflowBinding>, String> {
    load_binding(
        connection,
        "SELECT run.workflow_work_item_id AS work_item_id, run.workflow_id, item.event_id, item.correlation_id \
         FROM automation_runs run INNER JOIN workflow_work_items item ON item.id = run.workflow_work_item_id \
         WHERE run.id = ? AND run.workflow_id IS NOT NULL",
        automation_run_id,
    )
    .await
}

async fn load_signal_binding(
    connection: &SqlitePool,
    signal_run_id: &str,
) -> Result<Option<WorkflowBinding>, String> {
    load_binding(
        connection,
        "SELECT run.workflow_work_item_id AS work_item_id, run.workflow_id, item.event_id, item.correlation_id \
         FROM signal_agent_runs run INNER JOIN workflow_work_items item ON item.id = run.workflow_work_item_id \
         WHERE run.id = ? AND run.workflow_id IS NOT NULL",
        signal_run_id,
    )
    .await
}

async fn load_binding(
    connection: &SqlitePool,
    query: &str,
    id: &str,
) -> Result<Option<WorkflowBinding>, String> {
    let row = sqlx::query(query)
        .bind(id)
        .fetch_optional(connection)
        .await
        .map_err(database::database_error)?;
    row.map(|row| {
        Ok(WorkflowBinding {
            work_item_id: row
                .try_get("work_item_id")
                .map_err(database::database_error)?,
            workflow_id: row
                .try_get("workflow_id")
                .map_err(database::database_error)?,
            event_id: row.try_get("event_id").map_err(database::database_error)?,
            correlation_id: row
                .try_get("correlation_id")
                .map_err(database::database_error)?,
        })
    })
    .transpose()
}

fn truncate(value: &str) -> String {
    value.chars().take(2_000).collect()
}

fn parse_json_column(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<Value, String> {
    let value: String = row.try_get(column).map_err(database::database_error)?;
    serde_json::from_str(&value).map_err(database::database_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reliability::now_millis;

    async fn test_pool(label: &str) -> (std::path::PathBuf, std::sync::Arc<SqlitePool>) {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-workflow-{label}-{}-{}.db",
            std::process::id(),
            now_millis()
        ));
        let pool = database::get_pool_for_path(&path, true)
            .await
            .expect("open database");
        database::DATABASE_MIGRATOR
            .run(pool.as_ref())
            .await
            .expect("migrate");
        (path, pool)
    }

    async fn cleanup(path: &std::path::Path, pool: std::sync::Arc<SqlitePool>) {
        drop(pool);
        database::close_pool(path).await.expect("close database");
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    async fn insert_automation_run(
        pool: &SqlitePool,
        automation_id: &str,
        run_id: &str,
        trigger_source: &str,
        source_type: &str,
    ) {
        sqlx::query(
            "INSERT INTO automation_tasks \
             (id, name, instruction, trigger_type, trigger_config_json, document_id, enabled, \
              created_at, updated_at, source_type, source_config_json) \
             VALUES (?, ?, 'test', 'manual', '{}', NULL, 1, 1, 1, ?, '{}')",
        )
        .bind(automation_id)
        .bind(automation_id)
        .bind(source_type)
        .execute(pool)
        .await
        .expect("insert automation");
        sqlx::query(
            "INSERT INTO automation_runs \
             (id, automation_id, trigger_source, status, input_json, queued_at, correlation_id) \
             VALUES (?, ?, ?, 'running', '{}', 1, ?)",
        )
        .bind(run_id)
        .bind(automation_id)
        .bind(trigger_source)
        .bind(run_id)
        .execute(pool)
        .await
        .expect("insert run");
    }

    #[tokio::test]
    async fn manual_timer_and_rss_sources_share_recoverable_workflow_identity() {
        let (path, pool) = test_pool("sources").await;
        for (automation_id, run_id, trigger_source, source_type, expected_source) in [
            ("auto-manual", "run-manual", "manual", "document", "manual"),
            ("auto-timer", "run-timer", "schedule", "document", "timer"),
            ("auto-rss", "run-rss", "schedule", "rss", "rss"),
        ] {
            insert_automation_run(
                pool.as_ref(),
                automation_id,
                run_id,
                trigger_source,
                source_type,
            )
            .await;
            let binding = ensure_automation_workflow(
                pool.as_ref(),
                run_id,
                automation_id,
                trigger_source,
                source_type,
                10,
            )
            .await
            .expect("ensure workflow");
            let duplicate = ensure_automation_workflow(
                pool.as_ref(),
                run_id,
                automation_id,
                trigger_source,
                source_type,
                20,
            )
            .await
            .expect("deduplicate workflow");
            assert_eq!(binding, duplicate);
            let stored_source: String =
                sqlx::query_scalar("SELECT source_type FROM workflow_work_items WHERE id = ?")
                    .bind(&binding.work_item_id)
                    .fetch_one(pool.as_ref())
                    .await
                    .expect("source type");
            assert_eq!(stored_source, expected_source);
        }
        let counts: (i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM workflow_work_items), \
                    (SELECT COUNT(*) FROM workflow_instances), \
                    (SELECT COUNT(*) FROM domain_events WHERE event_type = 'workflow.source.accepted')",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("workflow counts");
        assert_eq!(counts, (3, 3, 3));
        cleanup(&path, pool).await;
    }

    #[tokio::test]
    async fn retry_ends_the_old_run_and_starts_a_new_run_id() {
        let (path, pool) = test_pool("retry").await;
        insert_automation_run(
            pool.as_ref(),
            "auto-retry",
            "automation-run-retry",
            "schedule",
            "document",
        )
        .await;
        let binding = ensure_automation_workflow(
            pool.as_ref(),
            "automation-run-retry",
            "auto-retry",
            "schedule",
            "document",
            10,
        )
        .await
        .expect("ensure workflow");
        start_run(pool.as_ref(), &binding, "runtime-run-1", 1, 20)
            .await
            .expect("start first run");
        mark_retry_scheduled(
            pool.as_ref(),
            &binding.workflow_id,
            Some("runtime-run-1"),
            "retry",
            30,
        )
        .await
        .expect("schedule retry");
        start_run(pool.as_ref(), &binding, "runtime-run-2", 2, 40)
            .await
            .expect("start second run");
        mark_completed(
            pool.as_ref(),
            &binding.workflow_id,
            "runtime-run-2",
            &json!({ "summary": "done" }),
            50,
        )
        .await
        .expect("complete workflow");
        let state: String = sqlx::query_scalar("SELECT state FROM workflow_instances WHERE id = ?")
            .bind(&binding.workflow_id)
            .fetch_one(pool.as_ref())
            .await
            .expect("workflow state");
        let attempts: Vec<(String, String)> = sqlx::query_as(
            "SELECT run_id, status FROM workflow_run_attempts WHERE workflow_id = ? ORDER BY attempt_number",
        )
        .bind(&binding.workflow_id)
        .fetch_all(pool.as_ref())
        .await
        .expect("attempts");
        assert_eq!(state, "COMPLETED");
        assert_eq!(
            attempts,
            vec![
                ("runtime-run-1".to_string(), "failed".to_string()),
                ("runtime-run-2".to_string(), "completed".to_string())
            ]
        );
        cleanup(&path, pool).await;
    }

    #[tokio::test]
    async fn event_suspend_ends_the_run_and_correlated_event_makes_workflow_ready() {
        let (path, pool) = test_pool("event-resume").await;
        insert_automation_run(
            pool.as_ref(),
            "auto-event",
            "automation-run-event",
            "manual",
            "document",
        )
        .await;
        let binding = ensure_automation_workflow(
            pool.as_ref(),
            "automation-run-event",
            "auto-event",
            "manual",
            "document",
            10,
        )
        .await
        .expect("ensure workflow");
        start_run(pool.as_ref(), &binding, "runtime-event-1", 1, 20)
            .await
            .expect("start run");
        let wait_id = suspend_run(
            pool.as_ref(),
            &binding,
            "runtime-event-1",
            SuspendRequest {
                condition_kind: "event",
                deduplication_key: "wait-for-review",
                payload: &json!({ "eventType": "review.received" }),
                due_at: None,
            },
            30,
        )
        .await
        .expect("suspend run");
        let mut transaction = pool.begin().await.expect("event transaction");
        record_with_outbox(
            &mut transaction,
            NewDomainEvent {
                event_id: "review-event-1",
                outbox_id: "review-event-1-outbox",
                event_type: "review.received",
                aggregate_type: "review",
                aggregate_id: "review-1",
                payload: &json!({ "decision": "continue" }),
                actor_id: "local_user",
                source: "test",
                workspace_id: Some("default"),
                deduplication_key: "review-event-1",
                security_scope: None,
                correlation_id: &binding.correlation_id,
                causation_id: Some(&binding.event_id),
                occurred_at: 40,
            },
        )
        .await
        .expect("record event");
        transaction.commit().await.expect("commit event");
        assert_eq!(consume_event_waits(pool.as_ref(), 50).await.unwrap(), 1);
        let stored: (String, Option<String>, String, String) = sqlx::query_as(
            "SELECT workflow.state, workflow.current_wait_condition_id, condition.status, item.status \
             FROM workflow_instances workflow \
             INNER JOIN workflow_wait_conditions condition ON condition.id = ? \
             INNER JOIN workflow_work_items item ON item.id = workflow.work_item_id \
             WHERE workflow.id = ?",
        )
        .bind(&wait_id)
        .bind(&binding.workflow_id)
        .fetch_one(pool.as_ref())
        .await
        .expect("resumed workflow");
        assert_eq!(
            stored,
            ("READY".into(), None, "satisfied".into(), "queued".into())
        );
        start_run(pool.as_ref(), &binding, "runtime-event-2", 2, 60)
            .await
            .expect("start continuation run");
        cleanup(&path, pool).await;
    }
}
