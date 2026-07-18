use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use tauri::AppHandle;

use crate::database::{database_error, open_database};
use crate::domain_events::{record_with_outbox, NewDomainEvent};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDelegationInput {
    data_directory: Option<String>,
    id: String,
    task_run_id: String,
    delegate_type: String,
    external_actor_id: String,
    context_bundle_id: Option<String>,
    capability_token_hash: String,
    allowed_operations: Vec<String>,
    expires_at: i64,
    correlation_id: String,
    causation_id: Option<String>,
    event_id: String,
    outbox_id: String,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitExternalWorkInput {
    data_directory: Option<String>,
    delegation_id: String,
    capability_token_hash: String,
    idempotency_key: String,
    request_hash: String,
    submission_json: String,
    event_id: String,
    outbox_id: String,
    submitted_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSubmissionResult {
    entity_id: String,
    replayed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimOutboxInput {
    data_directory: Option<String>,
    worker_id: String,
    now: i64,
    lease_ms: i64,
    limit: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedOutboxMessage {
    id: String,
    event_id: String,
    topic: String,
    payload: Value,
    attempt_count: i64,
    lease_until: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleOutboxInput {
    data_directory: Option<String>,
    id: String,
    worker_id: String,
    published: bool,
    error: Option<String>,
    now: i64,
    retry_at: Option<i64>,
}

#[tauri::command]
pub async fn create_delegation(app: AppHandle, input: CreateDelegationInput) -> Result<(), String> {
    let pool = open_database(&app, input.data_directory.clone()).await?;
    create_delegation_in_pool(pool.as_ref(), &input).await
}

async fn create_delegation_in_pool(
    pool: &sqlx::SqlitePool,
    input: &CreateDelegationInput,
) -> Result<(), String> {
    validate_hash(&input.capability_token_hash, "Capability token hash")?;
    if !matches!(input.delegate_type.as_str(), "mcp" | "cli") {
        return Err("Delegation 类型无效。".to_string());
    }
    if input.external_actor_id.trim().is_empty()
        || input.correlation_id.trim().is_empty()
        || input.expires_at <= input.created_at
    {
        return Err("Delegation actor、关联 ID 或有效期无效。".to_string());
    }
    let allowed = normalize_operations(&input.allowed_operations)?;
    let allowed_json = serde_json::to_string(&allowed).map_err(|error| error.to_string())?;
    let mut transaction = pool.begin().await.map_err(database_error)?;
    sqlx::query(
        "INSERT INTO delegations (id, task_run_id, delegate_type, external_actor_id, status, \
         context_bundle_id, capability_token_hash, allowed_operations_json, expires_at, \
         correlation_id, causation_id, created_at, updated_at) \
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&input.id)
    .bind(&input.task_run_id)
    .bind(&input.delegate_type)
    .bind(input.external_actor_id.trim())
    .bind(&input.context_bundle_id)
    .bind(&input.capability_token_hash)
    .bind(&allowed_json)
    .bind(input.expires_at)
    .bind(&input.correlation_id)
    .bind(&input.causation_id)
    .bind(input.created_at)
    .bind(input.created_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    let event_payload = serde_json::json!({
        "delegationId": input.id,
        "taskRunId": input.task_run_id,
        "delegateType": input.delegate_type,
        "allowedOperations": allowed,
        "expiresAt": input.expires_at
    });
    record_with_outbox(
        &mut transaction,
        NewDomainEvent {
            event_id: &input.event_id,
            outbox_id: &input.outbox_id,
            event_type: "delegation.created",
            aggregate_type: "delegation",
            aggregate_id: &input.id,
            payload: &event_payload,
            actor_id: "local_user",
            correlation_id: &input.correlation_id,
            causation_id: input.causation_id.as_deref(),
            occurred_at: input.created_at,
        },
    )
    .await?;
    transaction.commit().await.map_err(database_error)
}

#[tauri::command]
pub async fn submit_external_work(
    app: AppHandle,
    input: SubmitExternalWorkInput,
) -> Result<ExternalSubmissionResult, String> {
    let pool = open_database(&app, input.data_directory.clone()).await?;
    submit_external_work_in_pool(pool.as_ref(), &input).await
}

async fn submit_external_work_in_pool(
    pool: &sqlx::SqlitePool,
    input: &SubmitExternalWorkInput,
) -> Result<ExternalSubmissionResult, String> {
    validate_hash(&input.capability_token_hash, "Capability token hash")?;
    validate_hash(&input.request_hash, "Request hash")?;
    if input.idempotency_key.trim().is_empty() || input.idempotency_key.len() > 160 {
        return Err("Idempotency key 无效。".to_string());
    }
    let submission: Value = serde_json::from_str(&input.submission_json)
        .map_err(|error| format!("外部提交 JSON 无效：{error}"))?;
    let submission_type = submission
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "外部提交缺少 type。".to_string())?;
    let entity_id = required_string(&submission, "entityId")?;
    let mut transaction = pool.begin().await.map_err(database_error)?;
    let row = sqlx::query(
        "SELECT task_run_id, external_actor_id, status, capability_token_hash, \
         allowed_operations_json, expires_at, correlation_id FROM delegations WHERE id = ? LIMIT 1",
    )
    .bind(&input.delegation_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| "Delegation 不存在。".to_string())?;
    let status: String = row.try_get("status").map_err(database_error)?;
    let expires_at: i64 = row.try_get("expires_at").map_err(database_error)?;
    let stored_hash: String = row
        .try_get("capability_token_hash")
        .map_err(database_error)?;
    if !constant_time_eq(&stored_hash, &input.capability_token_hash) {
        return Err("Delegation capability token 无效。".to_string());
    }
    if expires_at <= input.submitted_at
        || matches!(
            status.as_str(),
            "completed" | "failed" | "cancelled" | "expired"
        )
    {
        return Err("Delegation 已过期或关闭。".to_string());
    }
    let allowed_json: String = row
        .try_get("allowed_operations_json")
        .map_err(database_error)?;
    let allowed: Vec<String> =
        serde_json::from_str(&allowed_json).map_err(|error| error.to_string())?;
    let required_operation = match submission_type {
        "artifact" => "submit_artifact",
        "evidence" => "submit_evidence",
        "result" => "submit_result",
        "change_set" => "propose_change_set",
        _ => return Err("外部提交类型无效。".to_string()),
    };
    if !allowed.iter().any(|value| value == required_operation) {
        return Err("Delegation 未授权该提交操作。".to_string());
    }
    // Acquire SQLite's write lock before checking the idempotency record. This prevents two
    // concurrent deferred transactions from both observing a missing key and applying twice.
    sqlx::query("UPDATE delegations SET updated_at = updated_at WHERE id = ?")
        .bind(&input.delegation_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    let scope = format!("external:{}", input.delegation_id);
    if let Some(idempotent) = sqlx::query(
        "SELECT request_hash, response_json FROM idempotency_records WHERE scope = ? AND idempotency_key = ?",
    )
    .bind(&scope)
    .bind(&input.idempotency_key)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    {
        let request_hash: String = idempotent.try_get("request_hash").map_err(database_error)?;
        if request_hash != input.request_hash {
            return Err("同一 Idempotency key 对应不同请求。".to_string());
        }
        let response_json: String = idempotent.try_get("response_json").map_err(database_error)?;
        let mut response: ExternalSubmissionResult =
            serde_json::from_str(&response_json).map_err(|error| error.to_string())?;
        response.replayed = true;
        return Ok(response);
    }
    let task_run_id: String = row.try_get("task_run_id").map_err(database_error)?;
    persist_submission(
        &mut transaction,
        submission_type,
        &entity_id,
        &task_run_id,
        &submission,
        input.submitted_at,
    )
    .await?;
    sqlx::query(
        "INSERT INTO external_submissions (id, delegation_id, submission_type, entity_id, \
         request_hash, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(format!("external-submission-{}", input.event_id))
    .bind(&input.delegation_id)
    .bind(submission_type)
    .bind(&entity_id)
    .bind(&input.request_hash)
    .bind(&input.idempotency_key)
    .bind(input.submitted_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query("UPDATE delegations SET status = 'submitted', updated_at = ? WHERE id = ?")
        .bind(input.submitted_at)
        .bind(&input.delegation_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    let actor_id: String = row.try_get("external_actor_id").map_err(database_error)?;
    let correlation_id: String = row.try_get("correlation_id").map_err(database_error)?;
    let event_type = format!("external.{submission_type}.submitted");
    record_with_outbox(
        &mut transaction,
        NewDomainEvent {
            event_id: &input.event_id,
            outbox_id: &input.outbox_id,
            event_type: &event_type,
            aggregate_type: "delegation",
            aggregate_id: &input.delegation_id,
            payload: &submission,
            actor_id: &actor_id,
            correlation_id: &correlation_id,
            causation_id: None,
            occurred_at: input.submitted_at,
        },
    )
    .await?;
    let response = ExternalSubmissionResult {
        entity_id: entity_id.clone(),
        replayed: false,
    };
    let response_json = serde_json::to_string(&response).map_err(|error| error.to_string())?;
    sqlx::query(
        "INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response_json, \
         entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(scope)
    .bind(&input.idempotency_key)
    .bind(&input.request_hash)
    .bind(response_json)
    .bind(submission_type)
    .bind(&entity_id)
    .bind(input.submitted_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    Ok(response)
}

#[tauri::command]
pub async fn claim_outbox_messages(
    app: AppHandle,
    input: ClaimOutboxInput,
) -> Result<Vec<ClaimedOutboxMessage>, String> {
    if input.worker_id.trim().is_empty() {
        return Err("Outbox worker ID 不能为空。".to_string());
    }
    let pool = open_database(&app, input.data_directory).await?;
    claim_outbox_from_pool(
        pool.as_ref(),
        &input.worker_id,
        input.now,
        input.lease_ms,
        input.limit,
    )
    .await
}

async fn claim_outbox_from_pool(
    pool: &sqlx::SqlitePool,
    worker_id: &str,
    now: i64,
    lease_ms: i64,
    limit: i64,
) -> Result<Vec<ClaimedOutboxMessage>, String> {
    let limit = limit.clamp(1, 100);
    let lease_until = now + lease_ms.clamp(1_000, 300_000);
    let mut transaction = pool.begin().await.map_err(database_error)?;
    let claimed_rows = sqlx::query(
        "WITH candidates AS (\
           SELECT id FROM outbox_messages WHERE available_at <= ? AND \
             ((status IN ('pending', 'failed')) OR (status = 'processing' AND lease_until <= ?)) \
           ORDER BY created_at ASC LIMIT ?\
         ) \
         UPDATE outbox_messages SET status = 'processing', attempt_count = attempt_count + 1, \
           lease_until = ?, lease_owner = ? \
         WHERE id IN (SELECT id FROM candidates) AND \
           ((status IN ('pending', 'failed')) OR (status = 'processing' AND lease_until <= ?)) \
         RETURNING id, event_id, topic, payload_json, attempt_count, created_at",
    )
    .bind(now)
    .bind(now)
    .bind(limit)
    .bind(lease_until)
    .bind(worker_id)
    .bind(now)
    .fetch_all(&mut *transaction)
    .await
    .map_err(database_error)?;
    let mut claimed_rows = claimed_rows
        .into_iter()
        .map(|row| {
            let created_at: i64 = row.try_get("created_at").map_err(database_error)?;
            Ok((created_at, row))
        })
        .collect::<Result<Vec<_>, String>>()?;
    claimed_rows.sort_by_key(|(created_at, _)| *created_at);
    let mut messages = Vec::with_capacity(claimed_rows.len());
    for (_, claimed) in claimed_rows {
        let id: String = claimed.try_get("id").map_err(database_error)?;
        let payload_json: String = claimed.try_get("payload_json").map_err(database_error)?;
        messages.push(ClaimedOutboxMessage {
            id,
            event_id: claimed.try_get("event_id").map_err(database_error)?,
            topic: claimed.try_get("topic").map_err(database_error)?,
            payload: serde_json::from_str(&payload_json).map_err(|error| error.to_string())?,
            attempt_count: claimed.try_get("attempt_count").map_err(database_error)?,
            lease_until,
        });
    }
    transaction.commit().await.map_err(database_error)?;
    Ok(messages)
}

#[tauri::command]
pub async fn settle_outbox_message(app: AppHandle, input: SettleOutboxInput) -> Result<(), String> {
    let pool = open_database(&app, input.data_directory).await?;
    settle_outbox_in_pool(
        pool.as_ref(),
        &input.id,
        &input.worker_id,
        input.published,
        input.error.as_deref(),
        input.now,
        input.retry_at,
    )
    .await
}

async fn settle_outbox_in_pool(
    pool: &sqlx::SqlitePool,
    id: &str,
    worker_id: &str,
    published: bool,
    error: Option<&str>,
    now: i64,
    retry_at: Option<i64>,
) -> Result<(), String> {
    let (status, available_at, published_at) = if published {
        ("published", now, Some(now))
    } else {
        ("failed", retry_at.unwrap_or(now + 30_000), None)
    };
    let updated = sqlx::query(
        "UPDATE outbox_messages SET status = ?, available_at = ?, lease_until = NULL, \
         lease_owner = NULL, last_error = ?, published_at = ? \
         WHERE id = ? AND status = 'processing' AND lease_owner = ?",
    )
    .bind(status)
    .bind(available_at)
    .bind(error)
    .bind(published_at)
    .bind(id)
    .bind(worker_id)
    .execute(pool)
    .await
    .map_err(database_error)?;
    if updated.rows_affected() != 1 {
        return Err("Outbox lease 不属于当前 worker 或消息已处理。".to_string());
    }
    Ok(())
}

async fn persist_submission(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    submission_type: &str,
    entity_id: &str,
    task_run_id: &str,
    submission: &Value,
    created_at: i64,
) -> Result<(), String> {
    match submission_type {
        "artifact" => {
            let content = submission.get("content").filter(|value| !value.is_null());
            let uri = optional_string(submission, "uri");
            if content.is_none() && uri.is_none() {
                return Err("Artifact 必须包含 uri 或 content。".to_string());
            }
            sqlx::query(
                "INSERT INTO work_artifacts (id, task_run_id, artifact_type, name, uri, \
                 content_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(entity_id)
            .bind(task_run_id)
            .bind(required_string(submission, "artifactType")?)
            .bind(required_string(submission, "name")?)
            .bind(uri)
            .bind(content.map(|value| value.to_string()))
            .bind(optional_string(submission, "contentHash"))
            .bind(created_at)
            .execute(&mut **transaction)
            .await
            .map_err(database_error)?;
        }
        "evidence" => {
            let status =
                optional_string(submission, "status").unwrap_or_else(|| "unverified".to_string());
            if !matches!(status.as_str(), "unverified" | "valid" | "invalid") {
                return Err("Evidence 状态无效。".to_string());
            }
            sqlx::query(
                "INSERT INTO work_evidence (id, task_run_id, evidence_type, status, document_id, \
                 block_id, source_revision, artifact_id, claim, details_json, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(entity_id)
            .bind(task_run_id)
            .bind(required_string(submission, "evidenceType")?)
            .bind(status)
            .bind(optional_string(submission, "documentId"))
            .bind(optional_string(submission, "blockId"))
            .bind(submission.get("sourceRevision").and_then(Value::as_i64))
            .bind(optional_string(submission, "artifactId"))
            .bind(required_string(submission, "claim")?)
            .bind(
                submission
                    .get("details")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}))
                    .to_string(),
            )
            .bind(created_at)
            .execute(&mut **transaction)
            .await
            .map_err(database_error)?;
        }
        "result" => {
            let output = submission.get("output").cloned().unwrap_or(Value::Null);
            let updated = sqlx::query(
                "UPDATE task_runs SET output_json = ?, status = 'blocked' WHERE id = ? AND \
                 status IN ('queued', 'running', 'waiting_input', 'blocked')",
            )
            .bind(output.to_string())
            .bind(task_run_id)
            .execute(&mut **transaction)
            .await
            .map_err(database_error)?;
            if updated.rows_affected() != 1 {
                return Err("TaskRun 当前状态不接受外部结果。".to_string());
            }
        }
        "change_set" => {
            sqlx::query(
                "INSERT INTO change_sets (id, task_run_id, status, title, description, created_at, updated_at) \
                 VALUES (?, ?, 'proposed', ?, ?, ?, ?)",
            )
            .bind(entity_id)
            .bind(task_run_id)
            .bind(required_string(submission, "title")?)
            .bind(optional_string(submission, "description").unwrap_or_default())
            .bind(created_at)
            .bind(created_at)
            .execute(&mut **transaction)
            .await
            .map_err(database_error)?;
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn normalize_operations(values: &[String]) -> Result<Vec<String>, String> {
    const ALLOWED: &[&str] = &[
        "read_context",
        "read_task",
        "submit_artifact",
        "submit_evidence",
        "submit_result",
        "propose_change_set",
    ];
    let mut result = Vec::new();
    for value in values {
        if !ALLOWED.contains(&value.as_str()) {
            return Err(format!("未知 Delegation operation：{value}"));
        }
        if !result.contains(value) {
            result.push(value.clone());
        }
    }
    if result.is_empty() {
        return Err("Delegation 至少需要一个 operation。".to_string());
    }
    Ok(result)
}

pub(crate) fn validate_hash(value: &str, label: &str) -> Result<(), String> {
    if value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("{label} 无效。"))
    }
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn required_string(value: &Value, key: &str) -> Result<String, String> {
    optional_string(value, key).ok_or_else(|| format!("外部提交缺少 {key}。"))
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;

    #[test]
    fn delegation_operations_are_explicit_and_deduplicated() {
        let operations = normalize_operations(&[
            "read_task".to_string(),
            "submit_result".to_string(),
            "read_task".to_string(),
        ])
        .unwrap();
        assert_eq!(operations, vec!["read_task", "submit_result"]);
        assert!(normalize_operations(&["write_document".to_string()]).is_err());
    }

    #[test]
    fn external_hashes_require_sha_256_hex() {
        assert!(validate_hash(&"a".repeat(64), "hash").is_ok());
        assert!(validate_hash("secret", "hash").is_err());
        assert!(constant_time_eq(&"a".repeat(64), &"a".repeat(64)));
        assert!(!constant_time_eq(&"a".repeat(64), &"b".repeat(64)));
    }

    #[tokio::test]
    async fn expired_outbox_lease_is_reclaimed_without_stealing_an_active_lease() {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-outbox-lease-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let pool = crate::database::get_pool_for_path(&path, true)
            .await
            .expect("open database");
        sqlx::query(
            "CREATE TABLE outbox_messages (id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, \
             topic TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, \
             attempt_count INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, \
             lease_until INTEGER, lease_owner TEXT, last_error TEXT, published_at INTEGER, \
             created_at INTEGER NOT NULL)",
        )
        .execute(pool.as_ref())
        .await
        .expect("outbox table");
        for (id, status, attempts, lease_until, owner, created_at) in [
            ("pending", "pending", 0, None, None, 1),
            (
                "expired",
                "processing",
                1,
                Some(9_000),
                Some("dead-worker"),
                2,
            ),
            (
                "active",
                "processing",
                1,
                Some(11_000),
                Some("live-worker"),
                3,
            ),
        ] {
            sqlx::query(
                "INSERT INTO outbox_messages (id, event_id, topic, payload_json, status, \
                 attempt_count, available_at, lease_until, lease_owner, created_at) \
                 VALUES (?, ?, 'test', '{}', ?, ?, 1, ?, ?, ?)",
            )
            .bind(id)
            .bind(format!("event-{id}"))
            .bind(status)
            .bind(attempts)
            .bind(lease_until)
            .bind(owner)
            .bind(created_at)
            .execute(pool.as_ref())
            .await
            .expect("outbox row");
        }

        let claimed = claim_outbox_from_pool(pool.as_ref(), "new-worker", 10_000, 2_000, 10)
            .await
            .expect("claim messages");
        assert_eq!(
            claimed
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            vec!["pending", "expired"]
        );
        assert_eq!(claimed[0].attempt_count, 1);
        assert_eq!(claimed[1].attempt_count, 2);
        let active_owner: String =
            sqlx::query_scalar("SELECT lease_owner FROM outbox_messages WHERE id = 'active'")
                .fetch_one(pool.as_ref())
                .await
                .expect("active owner");
        assert_eq!(active_owner, "live-worker");
        assert!(settle_outbox_in_pool(
            pool.as_ref(),
            "expired",
            "wrong-worker",
            true,
            None,
            10_100,
            None,
        )
        .await
        .is_err());
        settle_outbox_in_pool(
            pool.as_ref(),
            "expired",
            "new-worker",
            true,
            None,
            10_100,
            None,
        )
        .await
        .expect("settle reclaimed lease");

        drop(pool);
        crate::database::close_pool(&path)
            .await
            .expect("close database");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn real_cli_process_submits_idempotent_result_change_set_and_reaches_approval() {
        let directory = std::env::temp_dir().join(format!(
            "my-notebook-cli-smoke-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        crate::database::prepare_database_path(&directory, &crate::database::DATABASE_MIGRATOR)
            .await
            .expect("prepare smoke database");
        let database_path = directory.join(crate::database::DATABASE_FILENAME);
        let pool = crate::database::get_pool_for_path(&database_path, false)
            .await
            .expect("open smoke database");
        sqlx::query(
            "INSERT INTO task_runs (id, status, frozen_input_json, acceptance_criteria_json, \
             correlation_id, queued_at, started_at) \
             VALUES ('cli-smoke-run', 'running', '{\"task\":\"isolated\"}', \
             '{\"requiresApproval\":true}', 'cli-smoke-correlation', 1, 2)",
        )
        .execute(pool.as_ref())
        .await
        .expect("task run");

        let capability_hash = "a".repeat(64);
        let delegation = CreateDelegationInput {
            data_directory: None,
            id: "cli-smoke-delegation".to_string(),
            task_run_id: "cli-smoke-run".to_string(),
            delegate_type: "cli".to_string(),
            external_actor_id: "node-cli-fixture".to_string(),
            context_bundle_id: None,
            capability_token_hash: capability_hash.clone(),
            allowed_operations: vec![
                "read_context".to_string(),
                "read_task".to_string(),
                "submit_artifact".to_string(),
                "submit_evidence".to_string(),
                "submit_result".to_string(),
                "propose_change_set".to_string(),
            ],
            expires_at: 10_000,
            correlation_id: "cli-smoke-correlation".to_string(),
            causation_id: None,
            event_id: "cli-smoke-delegation-event".to_string(),
            outbox_id: "cli-smoke-delegation-outbox".to_string(),
            created_at: 10,
        };
        create_delegation_in_pool(pool.as_ref(), &delegation)
            .await
            .expect("create delegation");

        let input_path = directory.join("delegation.json");
        std::fs::write(
            &input_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 1,
                "delegation": {
                    "id": delegation.id,
                    "taskRunId": delegation.task_run_id,
                    "allowedOperations": delegation.allowed_operations,
                },
                "capabilityToken": "fixture-token",
                "taskRun": { "id": "cli-smoke-run", "status": "running" },
                "contextBundle": {
                    "version": 1,
                    "snapshotHash": "cli-smoke-context-hash",
                    "sources": [{ "type": "isolated-smoke", "content": "G0" }]
                },
                "submissionContract": {
                    "idempotencyKey": "stable key required",
                    "allowedTypes": ["result", "change_set"]
                }
            }))
            .expect("serialize envelope"),
        )
        .expect("write envelope");
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("test-fixtures")
            .join("cli-agent.mjs");

        for (submission_type, key, request_hash, timestamp) in [
            ("result", "cli-smoke-result", "b".repeat(64), 20_i64),
            ("change_set", "cli-smoke-change-set", "c".repeat(64), 30_i64),
        ] {
            let output_path = directory.join(format!("{submission_type}.json"));
            let status = tokio::process::Command::new("node")
                .arg(&fixture)
                .arg(&input_path)
                .arg(&output_path)
                .arg(submission_type)
                .status()
                .await
                .expect("run CLI fixture");
            assert!(status.success());
            let envelope: Value =
                serde_json::from_slice(&std::fs::read(&output_path).expect("read CLI submission"))
                    .expect("parse CLI submission");
            assert_eq!(envelope["version"], 1);
            let input = SubmitExternalWorkInput {
                data_directory: None,
                delegation_id: "cli-smoke-delegation".to_string(),
                capability_token_hash: capability_hash.clone(),
                idempotency_key: envelope["idempotencyKey"]
                    .as_str()
                    .expect("idempotency key")
                    .to_string(),
                request_hash,
                submission_json: envelope["submission"].to_string(),
                event_id: format!("{key}-event"),
                outbox_id: format!("{key}-outbox"),
                submitted_at: timestamp,
            };
            let first = submit_external_work_in_pool(pool.as_ref(), &input)
                .await
                .expect("submit CLI work");
            assert!(!first.replayed);
            let replay = submit_external_work_in_pool(pool.as_ref(), &input)
                .await
                .expect("replay CLI work");
            assert!(replay.replayed);
        }

        for (submission, key, request_hash, timestamp) in [
            (
                serde_json::json!({
                    "type": "artifact",
                    "entityId": "cli-smoke-artifact",
                    "artifactType": "report",
                    "name": "Isolated CLI report",
                    "content": { "summary": "isolated" }
                }),
                "cli-smoke-artifact",
                "d".repeat(64),
                31_i64,
            ),
            (
                serde_json::json!({
                    "type": "evidence",
                    "entityId": "cli-smoke-evidence",
                    "evidenceType": "process-output",
                    "status": "valid",
                    "artifactId": "cli-smoke-artifact",
                    "claim": "The real CLI child process produced the isolated result.",
                    "details": { "isolated": true }
                }),
                "cli-smoke-evidence",
                "e".repeat(64),
                32_i64,
            ),
        ] {
            submit_external_work_in_pool(
                pool.as_ref(),
                &SubmitExternalWorkInput {
                    data_directory: None,
                    delegation_id: "cli-smoke-delegation".to_string(),
                    capability_token_hash: capability_hash.clone(),
                    idempotency_key: key.to_string(),
                    request_hash,
                    submission_json: submission.to_string(),
                    event_id: format!("{key}-event"),
                    outbox_id: format!("{key}-outbox"),
                    submitted_at: timestamp,
                },
            )
            .await
            .expect("submit CLI artifact or evidence");
        }

        let confirmation_envelope_json = serde_json::json!({
            "version": 1,
            "task": { "id": "cli-smoke-run" },
            "externalResult": { "summary": "isolated" },
            "checks": [{ "id": "cli-output", "passed": true }]
        })
        .to_string();
        let confirmation_hash = format!(
            "{:x}",
            sha2::Sha256::digest(confirmation_envelope_json.as_bytes())
        );
        crate::work::commit_result_verification_in_pool(
            pool.as_ref(),
            &crate::work::CommitVerificationInput {
                data_directory: None,
                id: "cli-smoke-verification".to_string(),
                task_run_id: "cli-smoke-run".to_string(),
                verdict: "needs_approval".to_string(),
                checks_json: "[{\"id\":\"cli-output\",\"passed\":true}]".to_string(),
                confirmation_envelope_json,
                confirmation_hash,
                summary: "CLI result validated; proposed change still requires approval."
                    .to_string(),
                proposed_change_set: None,
                correlation_id: "cli-smoke-correlation".to_string(),
                event_id: "cli-smoke-verification-event".to_string(),
                outbox_id: "cli-smoke-verification-outbox".to_string(),
                created_at: 40,
                expected_status: "blocked".to_string(),
                next_status: "waiting_approval".to_string(),
                completed_at: None,
                error: None,
            },
        )
        .await
        .expect("verify CLI result");
        crate::work::decide_change_set_in_pool(
            pool.as_ref(),
            &crate::work::DecideChangeSetInput {
                data_directory: None,
                change_set_id: "cli-smoke-change-set".to_string(),
                decision: "approved".to_string(),
                approval_id: "cli-smoke-approval".to_string(),
                correlation_id: "cli-smoke-correlation".to_string(),
                event_id: "cli-smoke-approval-event".to_string(),
                outbox_id: "cli-smoke-approval-outbox".to_string(),
                created_at: 50,
            },
        )
        .await
        .expect("approve CLI change set");

        let task_status: String =
            sqlx::query_scalar("SELECT status FROM task_runs WHERE id = 'cli-smoke-run'")
                .fetch_one(pool.as_ref())
                .await
                .expect("task status");
        assert_eq!(task_status, "waiting_approval");
        let change_status: String =
            sqlx::query_scalar("SELECT status FROM change_sets WHERE id = 'cli-smoke-change-set'")
                .fetch_one(pool.as_ref())
                .await
                .expect("change status");
        assert_eq!(change_status, "approved");
        let event_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM domain_events")
            .fetch_one(pool.as_ref())
            .await
            .expect("event count");
        let outbox_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox_messages")
            .fetch_one(pool.as_ref())
            .await
            .expect("outbox count");
        let artifact_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM work_artifacts WHERE task_run_id = 'cli-smoke-run'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("artifact count");
        let evidence_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM work_evidence WHERE task_run_id = 'cli-smoke-run'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("evidence count");
        assert_eq!(artifact_count, 1);
        assert_eq!(evidence_count, 1);
        assert_eq!(event_count, 7);
        assert_eq!(outbox_count, 7);

        drop(pool);
        crate::database::close_pool(&database_path)
            .await
            .expect("close smoke database");
        let _ = std::fs::remove_dir_all(directory);
    }
}
