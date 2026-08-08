use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};

use crate::{
    database,
    domain_events::{record_with_outbox, NewDomainEvent},
    reliability::ACTION_GATEWAY_RETRY_POLICY,
};

#[allow(dead_code)]
pub(crate) struct NewExternalAction<'a> {
    pub(crate) action_id: &'a str,
    pub(crate) workflow_id: &'a str,
    pub(crate) work_item_id: &'a str,
    pub(crate) run_id: Option<&'a str>,
    pub(crate) action_type: &'a str,
    pub(crate) target: &'a Value,
    pub(crate) input: &'a Value,
    pub(crate) idempotency_key: &'a str,
    pub(crate) correlation_id: &'a str,
    pub(crate) causation_id: Option<&'a str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ExternalActionProjection {
    pub(crate) action_id: String,
    pub(crate) approval_id: String,
    pub(crate) status: String,
    pub(crate) fencing_token: i64,
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub(crate) struct ClaimedExternalAction {
    pub(crate) action_id: String,
    pub(crate) action_type: String,
    pub(crate) target: Value,
    pub(crate) input: Value,
    pub(crate) idempotency_key: String,
    pub(crate) fencing_token: i64,
    pub(crate) lease_owner: String,
    pub(crate) attempt_count: i64,
}

#[allow(dead_code)]
pub(crate) async fn propose_external_action(
    connection: &SqlitePool,
    action: NewExternalAction<'_>,
    now: i64,
) -> Result<ExternalActionProjection, String> {
    require_non_empty(action.action_id, "Action ID")?;
    require_non_empty(action.workflow_id, "Workflow ID")?;
    require_non_empty(action.work_item_id, "Work Item ID")?;
    require_non_empty(action.action_type, "Action 类型")?;
    require_non_empty(action.idempotency_key, "幂等键")?;
    require_non_empty(action.correlation_id, "Correlation ID")?;
    let target_json = action.target.to_string();
    let input_json = action.input.to_string();
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    if let Some(existing) = sqlx::query(
        "SELECT id, workflow_id, work_item_id, action_type, target_json, input_json, \
                approval_id, status, fencing_token FROM external_action_requests \
         WHERE idempotency_key = ? LIMIT 1",
    )
    .bind(action.idempotency_key)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database::database_error)?
    {
        let matches = existing.try_get::<String, _>("workflow_id").ok().as_deref()
            == Some(action.workflow_id)
            && existing
                .try_get::<String, _>("work_item_id")
                .ok()
                .as_deref()
                == Some(action.work_item_id)
            && existing.try_get::<String, _>("action_type").ok().as_deref()
                == Some(action.action_type)
            && existing.try_get::<String, _>("target_json").ok().as_deref()
                == Some(target_json.as_str())
            && existing.try_get::<String, _>("input_json").ok().as_deref()
                == Some(input_json.as_str());
        if !matches {
            return Err("相同幂等键已用于不同的外部动作。".to_string());
        }
        let result = ExternalActionProjection {
            action_id: existing.try_get("id").map_err(database::database_error)?,
            approval_id: existing
                .try_get("approval_id")
                .map_err(database::database_error)?,
            status: existing
                .try_get("status")
                .map_err(database::database_error)?,
            fencing_token: existing
                .try_get("fencing_token")
                .map_err(database::database_error)?,
        };
        transaction
            .commit()
            .await
            .map_err(database::database_error)?;
        return Ok(result);
    }
    let owns_work_item = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM workflow_instances WHERE id = ? AND work_item_id = ?",
    )
    .bind(action.workflow_id)
    .bind(action.work_item_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    if owns_work_item != 1 {
        return Err("外部动作的 Workflow 与 Work Item 不匹配。".to_string());
    }
    let approval_id = format!("external-action-approval-{}", action.action_id);
    let wait_condition_id = format!("workflow-wait-external-action-{}", action.action_id);
    let action_payload = json!({
        "version": 1,
        "actionId": action.action_id,
        "actionType": action.action_type,
        "target": action.target,
        "input": action.input,
        "idempotencyKey": action.idempotency_key
    });
    sqlx::query(
        "INSERT INTO workflow_wait_conditions \
         (id, workflow_id, deduplication_key, condition_kind, status, correlation_id, \
          causation_id, payload_json, created_at, updated_at) \
         VALUES (?, ?, ?, 'approval', 'pending', ?, ?, ?, ?, ?)",
    )
    .bind(&wait_condition_id)
    .bind(action.workflow_id)
    .bind(format!(
        "external-action-approval:{}",
        action.idempotency_key
    ))
    .bind(action.correlation_id)
    .bind(action.causation_id)
    .bind(action_payload.to_string())
    .bind(now)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    sqlx::query(
        "INSERT INTO external_action_requests \
         (id, workflow_id, work_item_id, run_id, action_type, target_json, input_json, \
          idempotency_key, fencing_token, approval_id, wait_condition_id, status, \
          correlation_id, causation_id, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'pending_approval', ?, ?, ?, ?)",
    )
    .bind(action.action_id)
    .bind(action.workflow_id)
    .bind(action.work_item_id)
    .bind(action.run_id)
    .bind(action.action_type)
    .bind(&target_json)
    .bind(&input_json)
    .bind(action.idempotency_key)
    .bind(&approval_id)
    .bind(&wait_condition_id)
    .bind(action.correlation_id)
    .bind(action.causation_id)
    .bind(now)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    sqlx::query(
        "INSERT INTO external_action_approvals \
         (id, action_id, decision, details_json, created_at, updated_at) \
         VALUES (?, ?, 'pending', '{}', ?, ?)",
    )
    .bind(&approval_id)
    .bind(action.action_id)
    .bind(now)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    sqlx::query(
        "UPDATE workflow_instances SET state = 'WAITING_APPROVAL', current_wait_condition_id = ?, \
         updated_at = ? WHERE id = ? AND state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')",
    )
    .bind(&wait_condition_id)
    .bind(now)
    .bind(action.workflow_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    sqlx::query("UPDATE workflow_work_items SET status = 'waiting', updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(action.work_item_id)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
    transaction
        .commit()
        .await
        .map_err(database::database_error)?;
    Ok(ExternalActionProjection {
        action_id: action.action_id.to_string(),
        approval_id,
        status: "pending_approval".to_string(),
        fencing_token: 0,
    })
}

#[allow(dead_code)]
pub(crate) async fn decide_external_action(
    connection: &SqlitePool,
    action_id: &str,
    approve: bool,
    actor_id: &str,
    details: &Value,
    now: i64,
) -> Result<ExternalActionProjection, String> {
    require_non_empty(actor_id, "审批人")?;
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    let row = sqlx::query(
        "SELECT workflow_id, work_item_id, run_id, action_type, target_json, input_json, \
                idempotency_key, approval_id, wait_condition_id, correlation_id, causation_id, status \
         FROM external_action_requests WHERE id = ? LIMIT 1",
    )
    .bind(action_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database::database_error)?
    .ok_or_else(|| "外部动作不存在。".to_string())?;
    let status: String = row.try_get("status").map_err(database::database_error)?;
    if status != "pending_approval" {
        return Err("外部动作已不在待审批状态。".to_string());
    }
    let decision = if approve { "approved" } else { "rejected" };
    let terminal_status = if approve { "approved" } else { "rejected" };
    let approval_id: String = row
        .try_get("approval_id")
        .map_err(database::database_error)?;
    let wait_condition_id: String = row
        .try_get("wait_condition_id")
        .map_err(database::database_error)?;
    sqlx::query(
        "UPDATE external_action_approvals SET decision = ?, actor_id = ?, details_json = ?, \
         decided_at = ?, updated_at = ? WHERE id = ? AND decision = 'pending'",
    )
    .bind(decision)
    .bind(actor_id)
    .bind(details.to_string())
    .bind(now)
    .bind(now)
    .bind(&approval_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    sqlx::query(
        "UPDATE external_action_requests SET status = ?, updated_at = ?, \
         completed_at = CASE WHEN ? = 'rejected' THEN ? ELSE NULL END \
         WHERE id = ? AND status = 'pending_approval'",
    )
    .bind(terminal_status)
    .bind(now)
    .bind(terminal_status)
    .bind(now)
    .bind(action_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    let resume_payload = json!({
        "actionId": action_id,
        "approvalId": approval_id,
        "decision": decision,
        "actorId": actor_id,
        "details": details
    });
    sqlx::query(
        "UPDATE workflow_wait_conditions SET status = 'satisfied', resume_payload_json = ?, \
         satisfied_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
    )
    .bind(resume_payload.to_string())
    .bind(now)
    .bind(now)
    .bind(&wait_condition_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    let workflow_id: String = row
        .try_get("workflow_id")
        .map_err(database::database_error)?;
    let work_item_id: String = row
        .try_get("work_item_id")
        .map_err(database::database_error)?;
    if approve {
        let target: Value = parse_json(&row, "target_json")?;
        let input: Value = parse_json(&row, "input_json")?;
        let action_type: String = row
            .try_get("action_type")
            .map_err(database::database_error)?;
        let idempotency_key: String = row
            .try_get("idempotency_key")
            .map_err(database::database_error)?;
        let correlation_id: String = row
            .try_get("correlation_id")
            .map_err(database::database_error)?;
        let causation_id = row
            .try_get::<Option<String>, _>("causation_id")
            .unwrap_or(None);
        let event_id = format!("external-action-requested-{action_id}");
        let outbox_id = format!("external-action-requested-{action_id}-outbox");
        let payload = json!({
            "version": 1,
            "actionId": action_id,
            "workflowId": workflow_id,
            "workItemId": work_item_id,
            "runId": row.try_get::<Option<String>, _>("run_id").unwrap_or(None),
            "actionType": action_type,
            "target": target,
            "input": input,
            "idempotencyKey": idempotency_key,
            "approvalId": approval_id,
            "status": "approved"
        });
        record_with_outbox(
            &mut transaction,
            NewDomainEvent {
                event_id: &event_id,
                outbox_id: &outbox_id,
                event_type: "external_action.requested",
                aggregate_type: "external_action",
                aggregate_id: action_id,
                payload: &payload,
                actor_id,
                source: "rust_action_gateway",
                workspace_id: Some("default"),
                deduplication_key: &format!("external-action:{idempotency_key}:requested"),
                security_scope: Some(&json!({ "externalAction": action_type })),
                correlation_id: &correlation_id,
                causation_id: causation_id.as_deref(),
                occurred_at: now,
            },
        )
        .await?;
        sqlx::query(
            "UPDATE workflow_instances SET state = 'READY', current_wait_condition_id = NULL, \
             causation_id = ?, updated_at = ? WHERE id = ? AND state = 'WAITING_APPROVAL'",
        )
        .bind(&event_id)
        .bind(now)
        .bind(&workflow_id)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
        sqlx::query(
            "UPDATE workflow_work_items SET status = 'queued', updated_at = ? WHERE id = ?",
        )
        .bind(now)
        .bind(&work_item_id)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
    } else {
        sqlx::query(
            "UPDATE workflow_instances SET state = 'CANCELLED', current_wait_condition_id = NULL, \
             error = '外部动作被拒绝', updated_at = ?, completed_at = ? WHERE id = ?",
        )
        .bind(now)
        .bind(now)
        .bind(&workflow_id)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
        sqlx::query(
            "UPDATE workflow_work_items SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ?",
        )
        .bind(now)
        .bind(now)
        .bind(&work_item_id)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
    }
    transaction
        .commit()
        .await
        .map_err(database::database_error)?;
    Ok(ExternalActionProjection {
        action_id: action_id.to_string(),
        approval_id,
        status: terminal_status.to_string(),
        fencing_token: 0,
    })
}

#[allow(dead_code)]
pub(crate) async fn claim_approved_action(
    connection: &SqlitePool,
    lease_owner: &str,
    now: i64,
    lease_ms: i64,
) -> Result<Option<ClaimedExternalAction>, String> {
    require_non_empty(lease_owner, "Action worker ID")?;
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    let row = sqlx::query(
        "SELECT id, workflow_id, work_item_id, action_type, target_json, input_json, \
                idempotency_key, attempt_count, fencing_token \
         FROM external_action_requests WHERE status = 'approved' \
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?) \
         ORDER BY created_at ASC LIMIT 1",
    )
    .bind(now)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    let Some(row) = row else {
        transaction
            .commit()
            .await
            .map_err(database::database_error)?;
        return Ok(None);
    };
    let action_id: String = row.try_get("id").map_err(database::database_error)?;
    let attempt_count = row.try_get::<i64, _>("attempt_count").unwrap_or(0) + 1;
    let fencing_token = row.try_get::<i64, _>("fencing_token").unwrap_or(0) + 1;
    let updated = sqlx::query(
        "UPDATE external_action_requests SET status = 'executing', attempt_count = ?, \
         fencing_token = ?, lease_owner = ?, lease_expires_at = ?, next_attempt_at = NULL, \
         error = NULL, updated_at = ? WHERE id = ? AND status = 'approved'",
    )
    .bind(attempt_count)
    .bind(fencing_token)
    .bind(lease_owner)
    .bind(now.saturating_add(lease_ms.clamp(1_000, 5 * 60_000)))
    .bind(now)
    .bind(&action_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    sqlx::query(
        "UPDATE workflow_instances SET state = 'RUNNING', error = NULL, updated_at = ? \
         WHERE id = ? AND state IN ('READY', 'RETRY_SCHEDULED')",
    )
    .bind(now)
    .bind(
        row.try_get::<String, _>("workflow_id")
            .map_err(database::database_error)?,
    )
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    sqlx::query("UPDATE workflow_work_items SET status = 'active', updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(
            row.try_get::<String, _>("work_item_id")
                .map_err(database::database_error)?,
        )
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
    if updated.rows_affected() != 1 {
        transaction
            .rollback()
            .await
            .map_err(database::database_error)?;
        return Ok(None);
    }
    sqlx::query(
        "INSERT INTO external_action_attempts \
         (id, action_id, attempt_number, fencing_token, lease_owner, status, started_at) \
         VALUES (?, ?, ?, ?, ?, 'executing', ?)",
    )
    .bind(format!(
        "external-action-attempt-{action_id}-{attempt_count}"
    ))
    .bind(&action_id)
    .bind(attempt_count)
    .bind(fencing_token)
    .bind(lease_owner)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    transaction
        .commit()
        .await
        .map_err(database::database_error)?;
    Ok(Some(ClaimedExternalAction {
        action_id,
        action_type: row
            .try_get("action_type")
            .map_err(database::database_error)?,
        target: parse_json(&row, "target_json")?,
        input: parse_json(&row, "input_json")?,
        idempotency_key: row
            .try_get("idempotency_key")
            .map_err(database::database_error)?,
        fencing_token,
        lease_owner: lease_owner.to_string(),
        attempt_count,
    }))
}

#[allow(dead_code)]
pub(crate) async fn settle_claimed_action(
    connection: &SqlitePool,
    claim: &ClaimedExternalAction,
    success: bool,
    provider_reference: Option<&str>,
    output: Option<&Value>,
    error: Option<&str>,
    retryable: bool,
    now: i64,
) -> Result<bool, String> {
    let current = sqlx::query(
        "SELECT workflow_id, work_item_id, correlation_id, causation_id, status, \
                fencing_token, lease_owner FROM external_action_requests WHERE id = ? LIMIT 1",
    )
    .bind(&claim.action_id)
    .fetch_optional(connection)
    .await
    .map_err(database::database_error)?
    .ok_or_else(|| "外部动作不存在。".to_string())?;
    if current.try_get::<String, _>("status").ok().as_deref() != Some("executing")
        || current.try_get::<i64, _>("fencing_token").unwrap_or(-1) != claim.fencing_token
        || current
            .try_get::<Option<String>, _>("lease_owner")
            .unwrap_or(None)
            .as_deref()
            != Some(claim.lease_owner.as_str())
    {
        return Ok(false);
    }
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    if success {
        let output = output.cloned().unwrap_or_else(|| json!({}));
        sqlx::query(
            "UPDATE external_action_requests SET status = 'completed', provider_reference = ?, \
             output_json = ?, error = NULL, lease_owner = NULL, lease_expires_at = NULL, \
             completed_at = ?, updated_at = ? WHERE id = ? AND status = 'executing' \
             AND fencing_token = ? AND lease_owner = ?",
        )
        .bind(provider_reference)
        .bind(output.to_string())
        .bind(now)
        .bind(now)
        .bind(&claim.action_id)
        .bind(claim.fencing_token)
        .bind(&claim.lease_owner)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
        sqlx::query(
            "UPDATE external_action_attempts SET status = 'completed', provider_reference = ?, \
             output_json = ?, completed_at = ? WHERE action_id = ? AND fencing_token = ? AND status = 'executing'",
        )
        .bind(provider_reference)
        .bind(output.to_string())
        .bind(now)
        .bind(&claim.action_id)
        .bind(claim.fencing_token)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
        let workflow_id: String = current
            .try_get("workflow_id")
            .map_err(database::database_error)?;
        let work_item_id: String = current
            .try_get("work_item_id")
            .map_err(database::database_error)?;
        sqlx::query(
            "UPDATE workflow_instances SET state = 'COMPLETED', output_json = ?, error = NULL, \
             updated_at = ?, completed_at = ? WHERE id = ?",
        )
        .bind(output.to_string())
        .bind(now)
        .bind(now)
        .bind(&workflow_id)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
        sqlx::query(
            "UPDATE workflow_work_items SET status = 'completed', updated_at = ?, completed_at = ? WHERE id = ?",
        )
        .bind(now)
        .bind(now)
        .bind(&work_item_id)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
        record_action_result_event(
            &mut transaction,
            &current,
            claim,
            "completed",
            provider_reference,
            &output,
            None,
            now,
        )
        .await?;
    } else {
        let error = truncate(error.unwrap_or("外部动作执行失败。"));
        sqlx::query(
            "UPDATE external_action_attempts SET status = 'failed', error = ?, completed_at = ? \
             WHERE action_id = ? AND fencing_token = ? AND status = 'executing'",
        )
        .bind(&error)
        .bind(now)
        .bind(&claim.action_id)
        .bind(claim.fencing_token)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
        if retryable && !ACTION_GATEWAY_RETRY_POLICY.exhausted(claim.attempt_count) {
            sqlx::query(
                "UPDATE external_action_requests SET status = 'approved', next_attempt_at = ?, \
                 lease_owner = NULL, lease_expires_at = NULL, error = ?, updated_at = ? \
                 WHERE id = ? AND status = 'executing' AND fencing_token = ? AND lease_owner = ?",
            )
            .bind(now.saturating_add(ACTION_GATEWAY_RETRY_POLICY.delay_ms(claim.attempt_count)))
            .bind(&error)
            .bind(now)
            .bind(&claim.action_id)
            .bind(claim.fencing_token)
            .bind(&claim.lease_owner)
            .execute(&mut *transaction)
            .await
            .map_err(database::database_error)?;
            sqlx::query(
                "UPDATE workflow_instances SET state = 'RETRY_SCHEDULED', error = ?, updated_at = ? \
                 WHERE id = ? AND state = 'RUNNING'",
            )
            .bind(&error)
            .bind(now)
            .bind(
                current
                    .try_get::<String, _>("workflow_id")
                    .map_err(database::database_error)?,
            )
            .execute(&mut *transaction)
            .await
            .map_err(database::database_error)?;
            sqlx::query(
                "UPDATE workflow_work_items SET status = 'queued', updated_at = ? WHERE id = ?",
            )
            .bind(now)
            .bind(
                current
                    .try_get::<String, _>("work_item_id")
                    .map_err(database::database_error)?,
            )
            .execute(&mut *transaction)
            .await
            .map_err(database::database_error)?;
        } else {
            let status = if retryable { "dead_lettered" } else { "failed" };
            sqlx::query(
                "UPDATE external_action_requests SET status = ?, lease_owner = NULL, lease_expires_at = NULL, \
                 next_attempt_at = NULL, error = ?, completed_at = ?, dead_lettered_at = ?, updated_at = ? \
                 WHERE id = ? AND status = 'executing' AND fencing_token = ? AND lease_owner = ?",
            )
            .bind(status)
            .bind(&error)
            .bind(now)
            .bind(if retryable { Some(now) } else { None })
            .bind(now)
            .bind(&claim.action_id)
            .bind(claim.fencing_token)
            .bind(&claim.lease_owner)
            .execute(&mut *transaction)
            .await
            .map_err(database::database_error)?;
            let workflow_id: String = current
                .try_get("workflow_id")
                .map_err(database::database_error)?;
            let work_item_id: String = current
                .try_get("work_item_id")
                .map_err(database::database_error)?;
            sqlx::query(
                "UPDATE workflow_instances SET state = 'FAILED', error = ?, updated_at = ?, completed_at = ? WHERE id = ?",
            )
            .bind(&error)
            .bind(now)
            .bind(now)
            .bind(&workflow_id)
            .execute(&mut *transaction)
            .await
            .map_err(database::database_error)?;
            sqlx::query(
                "UPDATE workflow_work_items SET status = 'failed', updated_at = ?, completed_at = ? WHERE id = ?",
            )
            .bind(now)
            .bind(now)
            .bind(&work_item_id)
            .execute(&mut *transaction)
            .await
            .map_err(database::database_error)?;
        }
    }
    transaction
        .commit()
        .await
        .map_err(database::database_error)?;
    Ok(true)
}

#[allow(dead_code)]
pub(crate) async fn recover_expired_actions(
    connection: &SqlitePool,
    now: i64,
) -> Result<u64, String> {
    let rows = sqlx::query(
        "SELECT id, workflow_id, work_item_id, attempt_count, fencing_token FROM external_action_requests \
         WHERE status = 'executing' AND lease_expires_at <= ?",
    )
    .bind(now)
    .fetch_all(connection)
    .await
    .map_err(database::database_error)?;
    let mut recovered = 0;
    for row in rows {
        let action_id: String = row.try_get("id").map_err(database::database_error)?;
        let attempts = row.try_get::<i64, _>("attempt_count").unwrap_or(0);
        let fence = row.try_get::<i64, _>("fencing_token").unwrap_or(0);
        let exhausted = ACTION_GATEWAY_RETRY_POLICY.exhausted(attempts);
        let status = if exhausted {
            "dead_lettered"
        } else {
            "approved"
        };
        let result = sqlx::query(
            "UPDATE external_action_requests SET status = ?, next_attempt_at = ?, lease_owner = NULL, \
             lease_expires_at = NULL, error = 'Action Gateway 启动恢复时回收过期 lease。', \
             dead_lettered_at = ?, completed_at = ?, updated_at = ? \
             WHERE id = ? AND status = 'executing' AND fencing_token = ? AND lease_expires_at <= ?",
        )
        .bind(status)
        .bind(if exhausted { None } else { Some(now) })
        .bind(if exhausted { Some(now) } else { None })
        .bind(if exhausted { Some(now) } else { None })
        .bind(now)
        .bind(&action_id)
        .bind(fence)
        .bind(now)
        .execute(connection)
        .await
        .map_err(database::database_error)?;
        if result.rows_affected() == 1 {
            sqlx::query(
                "UPDATE external_action_attempts SET status = 'interrupted', \
                 error = 'Action Gateway 启动恢复时回收过期 lease。', completed_at = ? \
                 WHERE action_id = ? AND fencing_token = ? AND status = 'executing'",
            )
            .bind(now)
            .bind(&action_id)
            .bind(fence)
            .execute(connection)
            .await
            .map_err(database::database_error)?;
            let workflow_id: String = row
                .try_get("workflow_id")
                .map_err(database::database_error)?;
            let work_item_id: String = row
                .try_get("work_item_id")
                .map_err(database::database_error)?;
            if exhausted {
                sqlx::query(
                    "UPDATE workflow_instances SET state = 'FAILED', \
                     error = 'Action Gateway 启动恢复时发现动作已耗尽重试。', \
                     updated_at = ?, completed_at = ? WHERE id = ?",
                )
                .bind(now)
                .bind(now)
                .bind(&workflow_id)
                .execute(connection)
                .await
                .map_err(database::database_error)?;
                sqlx::query(
                    "UPDATE workflow_work_items SET status = 'failed', updated_at = ?, \
                     completed_at = ? WHERE id = ?",
                )
                .bind(now)
                .bind(now)
                .bind(&work_item_id)
                .execute(connection)
                .await
                .map_err(database::database_error)?;
            } else {
                sqlx::query(
                    "UPDATE workflow_instances SET state = 'RETRY_SCHEDULED', \
                     error = 'Action Gateway 启动恢复时回收过期 lease。', updated_at = ? WHERE id = ?",
                )
                .bind(now)
                .bind(&workflow_id)
                .execute(connection)
                .await
                .map_err(database::database_error)?;
                sqlx::query(
                    "UPDATE workflow_work_items SET status = 'queued', updated_at = ? WHERE id = ?",
                )
                .bind(now)
                .bind(&work_item_id)
                .execute(connection)
                .await
                .map_err(database::database_error)?;
            }
            recovered += 1;
        }
    }
    Ok(recovered)
}

async fn record_action_result_event(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    current: &sqlx::sqlite::SqliteRow,
    claim: &ClaimedExternalAction,
    outcome: &str,
    provider_reference: Option<&str>,
    output: &Value,
    error: Option<&str>,
    now: i64,
) -> Result<(), String> {
    let correlation_id: String = current
        .try_get("correlation_id")
        .map_err(database::database_error)?;
    let requested_event_id = format!("external-action-requested-{}", claim.action_id);
    let event_id = format!("external-action-{outcome}-{}", claim.action_id);
    let outbox_id = format!("external-action-{outcome}-{}-outbox", claim.action_id);
    let payload = json!({
        "version": 1,
        "actionId": claim.action_id,
        "idempotencyKey": claim.idempotency_key,
        "fencingToken": claim.fencing_token.to_string(),
        "outcome": outcome,
        "providerReference": provider_reference,
        "output": output,
        "error": error,
        "completedAt": now
    });
    record_with_outbox(
        transaction,
        NewDomainEvent {
            event_id: &event_id,
            outbox_id: &outbox_id,
            event_type: "external_action.completed",
            aggregate_type: "external_action",
            aggregate_id: &claim.action_id,
            payload: &payload,
            actor_id: "rust-action-gateway",
            source: "rust_action_gateway",
            workspace_id: Some("default"),
            deduplication_key: &format!("external-action:{}:{outcome}", claim.idempotency_key),
            security_scope: None,
            correlation_id: &correlation_id,
            causation_id: Some(&requested_event_id),
            occurred_at: now,
        },
    )
    .await
}

fn parse_json(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<Value, String> {
    let value: String = row.try_get(column).map_err(database::database_error)?;
    serde_json::from_str(&value).map_err(database::database_error)
}

fn require_non_empty(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{label} 不能为空。"))
    } else {
        Ok(())
    }
}

fn truncate(value: &str) -> String {
    value.chars().take(2_000).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{reliability::now_millis, workflow_runtime};

    async fn test_pool(label: &str) -> (std::path::PathBuf, std::sync::Arc<SqlitePool>) {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-action-gateway-{label}-{}-{}.db",
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

    async fn workflow_fixture(pool: &SqlitePool) -> workflow_runtime::WorkflowBinding {
        sqlx::query(
            "INSERT INTO automation_tasks \
             (id, name, instruction, trigger_type, trigger_config_json, enabled, created_at, updated_at, source_type, source_config_json) \
             VALUES ('action-auto', 'Action', 'test', 'manual', '{}', 1, 1, 1, 'document', '{}')",
        )
        .execute(pool)
        .await
        .expect("insert automation");
        sqlx::query(
            "INSERT INTO automation_runs \
             (id, automation_id, trigger_source, status, input_json, queued_at, correlation_id) \
             VALUES ('action-run', 'action-auto', 'manual', 'running', '{}', 1, 'action-run')",
        )
        .execute(pool)
        .await
        .expect("insert automation run");
        workflow_runtime::ensure_automation_workflow(
            pool,
            "action-run",
            "action-auto",
            "manual",
            "document",
            10,
        )
        .await
        .expect("workflow")
    }

    fn action<'a>(binding: &'a workflow_runtime::WorkflowBinding) -> NewExternalAction<'a> {
        NewExternalAction {
            action_id: "external-action-1",
            workflow_id: &binding.workflow_id,
            work_item_id: &binding.work_item_id,
            run_id: Some("runtime-run-1"),
            action_type: "connector.dispatch",
            target: &Value::Null,
            input: &Value::Null,
            idempotency_key: "connector-dispatch-1",
            correlation_id: &binding.correlation_id,
            causation_id: Some(&binding.event_id),
        }
    }

    #[tokio::test]
    async fn approval_idempotency_and_fencing_guard_external_actions() {
        let (path, pool) = test_pool("approval").await;
        let binding = workflow_fixture(pool.as_ref()).await;
        let proposed = propose_external_action(pool.as_ref(), action(&binding), 20)
            .await
            .expect("propose action");
        let duplicate = propose_external_action(pool.as_ref(), action(&binding), 21)
            .await
            .expect("deduplicate action");
        assert_eq!(proposed, duplicate);
        assert_eq!(proposed.status, "pending_approval");
        assert!(claim_approved_action(pool.as_ref(), "worker-1", 22, 1_000)
            .await
            .expect("claim before approval")
            .is_none());
        let approved = decide_external_action(
            pool.as_ref(),
            &proposed.action_id,
            true,
            "local_user",
            &json!({ "reason": "approved in test" }),
            30,
        )
        .await
        .expect("approve action");
        assert_eq!(approved.status, "approved");
        let claim = claim_approved_action(pool.as_ref(), "worker-1", 40, 1_000)
            .await
            .expect("claim action")
            .expect("approved action");
        assert_eq!(claim.action_type, "connector.dispatch");
        assert_eq!(claim.target, Value::Null);
        assert_eq!(claim.input, Value::Null);
        let mut stale = claim.clone();
        stale.fencing_token -= 1;
        assert!(!settle_claimed_action(
            pool.as_ref(),
            &stale,
            true,
            Some("provider-stale"),
            Some(&json!({})),
            None,
            false,
            50,
        )
        .await
        .expect("reject stale fence"));
        assert!(settle_claimed_action(
            pool.as_ref(),
            &claim,
            true,
            Some("provider-1"),
            Some(&json!({ "delivered": true })),
            None,
            false,
            60,
        )
        .await
        .expect("settle action"));
        let stored: (String, String, String) = sqlx::query_as(
            "SELECT action.status, workflow.state, item.status \
             FROM external_action_requests action \
             INNER JOIN workflow_instances workflow ON workflow.id = action.workflow_id \
             INNER JOIN workflow_work_items item ON item.id = action.work_item_id \
             WHERE action.id = ?",
        )
        .bind(&proposed.action_id)
        .fetch_one(pool.as_ref())
        .await
        .expect("stored action");
        assert_eq!(
            stored,
            ("completed".into(), "COMPLETED".into(), "completed".into())
        );
        let requested_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM domain_events WHERE event_type = 'external_action.requested'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("requested event");
        assert_eq!(requested_events, 1);
        cleanup(&path, pool).await;
    }

    #[tokio::test]
    async fn expired_action_lease_is_recovered_with_a_new_fencing_token() {
        let (path, pool) = test_pool("recovery").await;
        let binding = workflow_fixture(pool.as_ref()).await;
        let proposed = propose_external_action(pool.as_ref(), action(&binding), 20)
            .await
            .expect("propose action");
        decide_external_action(
            pool.as_ref(),
            &proposed.action_id,
            true,
            "local_user",
            &json!({}),
            30,
        )
        .await
        .expect("approve action");
        let old_claim = claim_approved_action(pool.as_ref(), "worker-old", 40, 1_000)
            .await
            .expect("claim action")
            .expect("approved action");
        assert_eq!(
            recover_expired_actions(pool.as_ref(), 1_041).await.unwrap(),
            1
        );
        let state: (String, String) = sqlx::query_as(
            "SELECT action.status, workflow.state FROM external_action_requests action \
             INNER JOIN workflow_instances workflow ON workflow.id = action.workflow_id \
             WHERE action.id = ?",
        )
        .bind(&proposed.action_id)
        .fetch_one(pool.as_ref())
        .await
        .expect("recovered state");
        assert_eq!(state, ("approved".into(), "RETRY_SCHEDULED".into()));
        assert!(!settle_claimed_action(
            pool.as_ref(),
            &old_claim,
            true,
            None,
            Some(&json!({})),
            None,
            false,
            1_042,
        )
        .await
        .expect("old claim is fenced"));
        let new_claim = claim_approved_action(pool.as_ref(), "worker-new", 1_042, 1_000)
            .await
            .expect("reclaim action")
            .expect("requeued action");
        assert!(new_claim.fencing_token > old_claim.fencing_token);
        cleanup(&path, pool).await;
    }
}
