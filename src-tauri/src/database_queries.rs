use serde::Deserialize;
use serde_json::{Map, Number, Value};
use sqlx::{
    query::Query,
    sqlite::{SqliteArguments, SqliteRow},
    Column, Row, Sqlite, SqlitePool, TypeInfo, ValueRef,
};
use tauri::AppHandle;

use crate::database::{
    close_read_only_pool, configured_data_directory, database_error, open_read_only_database,
    DATABASE_FILENAME,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteDatabaseQueryInput {
    data_directory: Option<String>,
    query: String,
    #[serde(default)]
    values: Vec<Value>,
}

#[tauri::command]
pub async fn execute_database_query(
    app: AppHandle,
    input: ExecuteDatabaseQueryInput,
) -> Result<Vec<Map<String, Value>>, String> {
    let pool = open_read_only_database(&app, input.data_directory).await?;
    execute_database_query_in_pool(pool.as_ref(), &input.query, input.values).await
}

#[tauri::command]
pub async fn close_database_read_pool(
    app: AppHandle,
    data_directory: Option<String>,
) -> Result<bool, String> {
    let path = configured_data_directory(&app, data_directory)
        .map_err(database_error)?
        .join(DATABASE_FILENAME);
    Ok(close_read_only_pool(&path).await)
}

async fn execute_database_query_in_pool(
    pool: &SqlitePool,
    statement: &str,
    values: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, String> {
    let statement = validate_read_statement(statement)?;
    let mut query = sqlx::query(statement);
    for value in values {
        query = bind_json_value(query, value)?;
    }
    let rows = query.fetch_all(pool).await.map_err(database_error)?;
    rows.iter().map(row_to_json).collect()
}

fn validate_read_statement(statement: &str) -> Result<&str, String> {
    let statement = statement.trim();
    if statement.is_empty() {
        return Err("数据库查询不能为空。".to_string());
    }
    if statement.contains(';') {
        return Err("数据库查询只允许单条语句。".to_string());
    }
    let keyword = statement
        .split(|character: char| !character.is_ascii_alphabetic())
        .next()
        .unwrap_or_default();
    if !keyword.eq_ignore_ascii_case("select") && !keyword.eq_ignore_ascii_case("with") {
        return Err("数据库查询只允许 SELECT 或 WITH 读取语句。".to_string());
    }
    Ok(statement)
}

fn bind_json_value<'q>(
    query: Query<'q, Sqlite, SqliteArguments<'q>>,
    value: Value,
) -> Result<Query<'q, Sqlite, SqliteArguments<'q>>, String> {
    match value {
        Value::Null => Ok(query.bind(Option::<String>::None)),
        Value::Bool(value) => Ok(query.bind(value)),
        Value::String(value) => Ok(query.bind(value)),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                Ok(query.bind(value))
            } else if let Some(value) = value.as_u64() {
                let value = i64::try_from(value)
                    .map_err(|_| "数据库查询整数超过 SQLite i64 范围。".to_string())?;
                Ok(query.bind(value))
            } else if let Some(value) = value.as_f64() {
                Ok(query.bind(value))
            } else {
                Err("数据库查询包含无效数字。".to_string())
            }
        }
        Value::Array(_) | Value::Object(_) => Err("数据库查询只接受标量绑定参数。".to_string()),
    }
}

fn row_to_json(row: &SqliteRow) -> Result<Map<String, Value>, String> {
    let mut result = Map::with_capacity(row.columns().len());
    for (index, column) in row.columns().iter().enumerate() {
        let raw = row.try_get_raw(index).map_err(database_error)?;
        let value = if raw.is_null() {
            Value::Null
        } else {
            match raw.type_info().name() {
                "INTEGER" => Value::from(row.try_get::<i64, _>(index).map_err(database_error)?),
                "REAL" => {
                    let value = row.try_get::<f64, _>(index).map_err(database_error)?;
                    Value::Number(
                        Number::from_f64(value)
                            .ok_or_else(|| "数据库查询返回了无法序列化的浮点数。".to_string())?,
                    )
                }
                "TEXT" => Value::String(row.try_get::<String, _>(index).map_err(database_error)?),
                "BLOB" => Value::Array(
                    row.try_get::<Vec<u8>, _>(index)
                        .map_err(database_error)?
                        .into_iter()
                        .map(Value::from)
                        .collect(),
                ),
                value_type => {
                    return Err(format!(
                        "数据库查询返回了不支持的 SQLite 类型：{value_type}。"
                    ));
                }
            }
        };
        result.insert(column.name().to_string(), value);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database;
    use serde_json::json;

    fn test_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "my-notebook-{name}-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }

    async fn cleanup(path: &std::path::Path) {
        database::close_pool(path).await.expect("close pools");
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn read_only_query_returns_dynamic_json_rows_with_bound_values() {
        let path = test_path("readonly-query");
        let writer = database::get_pool_for_path(&path, true)
            .await
            .expect("writer pool");
        sqlx::query(
            "CREATE TABLE sample (id TEXT PRIMARY KEY, count INTEGER, score REAL, note TEXT, data BLOB)",
        )
        .execute(writer.as_ref())
        .await
        .expect("create table");
        sqlx::query(
            "INSERT INTO sample (id, count, score, note, data) VALUES ('one', 2, 1.5, NULL, X'0102')",
        )
        .execute(writer.as_ref())
        .await
        .expect("insert row");

        let reader = database::get_read_only_pool_for_path(&path)
            .await
            .expect("reader pool");
        let rows = execute_database_query_in_pool(
            reader.as_ref(),
            "SELECT id, count, score, note, data FROM sample WHERE id = ? AND count = ?",
            vec![json!("one"), json!(2)],
        )
        .await
        .expect("select row");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("id"), Some(&json!("one")));
        assert_eq!(rows[0].get("count"), Some(&json!(2)));
        assert_eq!(rows[0].get("score"), Some(&json!(1.5)));
        assert_eq!(rows[0].get("note"), Some(&Value::Null));
        assert_eq!(rows[0].get("data"), Some(&json!([1, 2])));

        drop(writer);
        drop(reader);
        cleanup(&path).await;
    }

    #[tokio::test]
    async fn delete_returning_is_rejected_by_the_read_only_connection_and_changes_nothing() {
        let path = test_path("readonly-rejects-delete");
        let writer = database::get_pool_for_path(&path, true)
            .await
            .expect("writer pool");
        sqlx::query("CREATE TABLE sample (id TEXT PRIMARY KEY)")
            .execute(writer.as_ref())
            .await
            .expect("create table");
        sqlx::query("INSERT INTO sample (id) VALUES ('keep')")
            .execute(writer.as_ref())
            .await
            .expect("insert row");
        let reader = database::get_read_only_pool_for_path(&path)
            .await
            .expect("reader pool");

        let result = sqlx::query("DELETE FROM sample WHERE id = ? RETURNING id")
            .bind("keep")
            .fetch_all(reader.as_ref())
            .await;
        let error = result
            .err()
            .expect("read-only pool must reject DELETE RETURNING")
            .to_string();
        assert!(error.to_ascii_lowercase().contains("readonly"));
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sample WHERE id = 'keep'")
            .fetch_one(writer.as_ref())
            .await
            .expect("row remains");
        assert_eq!(remaining, 1);

        drop(writer);
        drop(reader);
        cleanup(&path).await;
    }

    #[tokio::test]
    async fn webview_query_boundary_rejects_pragma_attach_and_multiple_statements() {
        let path = test_path("readonly-query-validation");
        let writer = database::get_pool_for_path(&path, true)
            .await
            .expect("writer pool");
        sqlx::query("CREATE TABLE sample (id TEXT PRIMARY KEY)")
            .execute(writer.as_ref())
            .await
            .expect("create table");
        let reader = database::get_read_only_pool_for_path(&path)
            .await
            .expect("reader pool");

        for statement in [
            "PRAGMA query_only = OFF",
            "ATTACH DATABASE 'other.db' AS other",
            "SELECT 1; PRAGMA query_only = OFF",
        ] {
            execute_database_query_in_pool(reader.as_ref(), statement, vec![])
                .await
                .expect_err("unsafe statement must be rejected before SQLite execution");
        }

        drop(writer);
        drop(reader);
        cleanup(&path).await;
    }

    #[tokio::test]
    async fn closing_a_database_path_closes_writer_and_read_only_pools() {
        let path = test_path("close-both-pools");
        let writer = database::get_pool_for_path(&path, true)
            .await
            .expect("writer pool");
        sqlx::query("CREATE TABLE sample (id TEXT PRIMARY KEY)")
            .execute(writer.as_ref())
            .await
            .expect("create table");
        let reader = database::get_read_only_pool_for_path(&path)
            .await
            .expect("reader pool");
        database::close_pool(&path).await.expect("close both pools");
        assert!(writer.is_closed());
        assert!(reader.is_closed());
        drop(writer);
        drop(reader);
        cleanup(&path).await;
    }
}
