use serde::Deserialize;
use sqlx::Row;
use tauri::AppHandle;

use crate::database::{database_error, open_database};
use crate::domain_events::{record_with_outbox, NewDomainEvent};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSetDraft {
    pub(crate) id: String,
    pub(crate) task_run_id: String,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitVerificationInput {
    pub(crate) data_directory: Option<String>,
    pub(crate) id: String,
    pub(crate) task_run_id: String,
    pub(crate) verdict: String,
    pub(crate) checks_json: String,
    pub(crate) summary: String,
    pub(crate) proposed_change_set: Option<ChangeSetDraft>,
    pub(crate) correlation_id: String,
    pub(crate) event_id: String,
    pub(crate) outbox_id: String,
    pub(crate) created_at: i64,
    pub(crate) expected_status: String,
    pub(crate) next_status: String,
    pub(crate) completed_at: Option<i64>,
    pub(crate) error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecideChangeSetInput {
    pub(crate) data_directory: Option<String>,
    pub(crate) change_set_id: String,
    pub(crate) decision: String,
    pub(crate) approval_id: String,
    pub(crate) correlation_id: String,
    pub(crate) event_id: String,
    pub(crate) outbox_id: String,
    pub(crate) created_at: i64,
}

#[tauri::command]
pub async fn commit_result_verification(
    app: AppHandle,
    input: CommitVerificationInput,
) -> Result<(), String> {
    let pool = open_database(&app, input.data_directory.clone()).await?;
    commit_result_verification_in_pool(pool.as_ref(), &input).await
}

pub(crate) async fn commit_result_verification_in_pool(
    pool: &sqlx::SqlitePool,
    input: &CommitVerificationInput,
) -> Result<(), String> {
    if !matches!(
        input.verdict.as_str(),
        "passed" | "failed" | "needs_approval" | "unverifiable"
    ) {
        return Err("Verifier verdict 无效。".to_string());
    }
    if !matches!(
        input.expected_status.as_str(),
        "running" | "blocked" | "waiting_approval"
    ) || !matches!(
        input.next_status.as_str(),
        "completed" | "blocked" | "waiting_approval"
    ) {
        return Err("Verifier TaskRun 状态迁移无效。".to_string());
    }
    serde_json::from_str::<serde_json::Value>(&input.checks_json)
        .map_err(|error| format!("Verifier checks JSON 无效：{error}"))?;
    let mut transaction = pool.begin().await.map_err(database_error)?;
    let proposed_change_set_id = input
        .proposed_change_set
        .as_ref()
        .map(|change_set| change_set.id.as_str());
    if let Some(change_set) = &input.proposed_change_set {
        if change_set.task_run_id != input.task_run_id || change_set.title.trim().is_empty() {
            return Err("Verifier ChangeSet 与 TaskRun 不匹配。".to_string());
        }
        sqlx::query(
            "INSERT INTO change_sets (id, task_run_id, agent_task_id, status, title, description, \
             patch_set_task_id, created_at, updated_at) \
             VALUES (?, ?, NULL, 'proposed', ?, ?, NULL, ?, ?)",
        )
        .bind(&change_set.id)
        .bind(&change_set.task_run_id)
        .bind(change_set.title.trim())
        .bind(&change_set.description)
        .bind(change_set.created_at)
        .bind(change_set.created_at)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    }
    sqlx::query(
        "INSERT INTO result_verifications (id, task_run_id, verdict, checks_json, summary, \
         proposed_change_set_id, correlation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&input.id)
    .bind(&input.task_run_id)
    .bind(&input.verdict)
    .bind(&input.checks_json)
    .bind(&input.summary)
    .bind(proposed_change_set_id)
    .bind(&input.correlation_id)
    .bind(input.created_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    let updated = sqlx::query(
        "UPDATE task_runs SET status = ?, completed_at = ?, error = ? WHERE id = ? AND status = ?",
    )
    .bind(&input.next_status)
    .bind(input.completed_at)
    .bind(&input.error)
    .bind(&input.task_run_id)
    .bind(&input.expected_status)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    if updated.rows_affected() != 1 {
        return Err("TaskRun 状态已变化，验证结果未提交。".to_string());
    }
    let event_payload = serde_json::json!({
        "verificationId": input.id,
        "verdict": input.verdict,
        "nextStatus": input.next_status,
        "proposedChangeSetId": proposed_change_set_id
    });
    record_with_outbox(
        &mut transaction,
        NewDomainEvent {
            event_id: &input.event_id,
            outbox_id: &input.outbox_id,
            event_type: "task.verification.recorded",
            aggregate_type: "task_run",
            aggregate_id: &input.task_run_id,
            payload: &event_payload,
            actor_id: "local_user",
            correlation_id: &input.correlation_id,
            causation_id: None,
            occurred_at: input.created_at,
        },
    )
    .await?;
    transaction.commit().await.map_err(database_error)
}

#[tauri::command]
pub async fn decide_change_set(app: AppHandle, input: DecideChangeSetInput) -> Result<(), String> {
    let pool = open_database(&app, input.data_directory.clone()).await?;
    decide_change_set_in_pool(pool.as_ref(), &input).await
}

pub(crate) async fn decide_change_set_in_pool(
    pool: &sqlx::SqlitePool,
    input: &DecideChangeSetInput,
) -> Result<(), String> {
    if input.decision != "approved" && input.decision != "rejected" {
        return Err("ChangeSet 审批决定无效。".to_string());
    }
    let mut transaction = pool.begin().await.map_err(database_error)?;
    let row = sqlx::query("SELECT status FROM change_sets WHERE id = ? LIMIT 1")
        .bind(&input.change_set_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(database_error)?
        .ok_or_else(|| "ChangeSet 不存在。".to_string())?;
    let status: String = row.try_get("status").map_err(database_error)?;
    if status != "draft" && status != "proposed" {
        return Err("ChangeSet 已被处理。".to_string());
    }
    sqlx::query(
        "INSERT INTO approvals (id, entity_type, entity_id, decision, actor_id, details_json, \
         correlation_id, created_at) VALUES (?, 'change_set', ?, ?, 'local_user', '{}', ?, ?)",
    )
    .bind(&input.approval_id)
    .bind(&input.change_set_id)
    .bind(&input.decision)
    .bind(&input.correlation_id)
    .bind(input.created_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query("UPDATE change_sets SET status = ?, updated_at = ? WHERE id = ?")
        .bind(&input.decision)
        .bind(input.created_at)
        .bind(&input.change_set_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    let event_payload =
        serde_json::json!({ "changeSetId": input.change_set_id, "decision": input.decision });
    record_with_outbox(
        &mut transaction,
        NewDomainEvent {
            event_id: &input.event_id,
            outbox_id: &input.outbox_id,
            event_type: "change_set.decided",
            aggregate_type: "change_set",
            aggregate_id: &input.change_set_id,
            payload: &event_payload,
            actor_id: "local_user",
            correlation_id: &input.correlation_id,
            causation_id: None,
            occurred_at: input.created_at,
        },
    )
    .await?;
    transaction.commit().await.map_err(database_error)
}
