use serde_json::Value;

use crate::database::database_error;

pub struct NewDomainEvent<'a> {
    pub event_id: &'a str,
    pub outbox_id: &'a str,
    pub event_type: &'a str,
    pub aggregate_type: &'a str,
    pub aggregate_id: &'a str,
    pub payload: &'a Value,
    pub actor_id: &'a str,
    pub source: &'a str,
    pub workspace_id: Option<&'a str>,
    pub deduplication_key: &'a str,
    pub security_scope: Option<&'a Value>,
    pub correlation_id: &'a str,
    pub causation_id: Option<&'a str>,
    pub occurred_at: i64,
}

pub async fn record_with_outbox(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: NewDomainEvent<'_>,
) -> Result<(), String> {
    let payload_json = event.payload.to_string();
    let security_scope_json = event
        .security_scope
        .map(Value::to_string)
        .unwrap_or_else(|| "{}".to_string());
    sqlx::query(
        "INSERT INTO domain_events (id, event_type, aggregate_type, aggregate_id, payload_json, \
         actor_id, correlation_id, causation_id, occurred_at, schema_version, source, workspace_id, \
         deduplication_key, security_scope_json) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
    )
    .bind(event.event_id)
    .bind(event.event_type)
    .bind(event.aggregate_type)
    .bind(event.aggregate_id)
    .bind(&payload_json)
    .bind(event.actor_id)
    .bind(event.correlation_id)
    .bind(event.causation_id)
    .bind(event.occurred_at)
    .bind(event.source)
    .bind(event.workspace_id)
    .bind(event.deduplication_key)
    .bind(security_scope_json)
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    sqlx::query(
        "INSERT INTO outbox_messages (id, event_id, topic, payload_json, status, attempt_count, \
         available_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
    )
    .bind(event.outbox_id)
    .bind(event.event_id)
    .bind(event.event_type)
    .bind(payload_json)
    .bind(event.occurred_at)
    .bind(event.occurred_at)
    .bind(event.occurred_at)
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    Ok(())
}
