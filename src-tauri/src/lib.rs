use tauri_plugin_sql::{Migration, MigrationKind};

mod agent_repository;
mod agent_tools;
mod database;
mod secret_store;
mod storage;

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_documents_and_assets_tables",
            sql: include_str!("../migrations/0001_create_documents_and_assets.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add_document_kind_to_documents",
            sql: include_str!("../migrations/0002_add_document_kind.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add_assets_tags_and_document_metadata",
            sql: include_str!("../migrations/0003_add_assets_tags_and_document_metadata.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "add_agent_audit_and_document_search",
            sql: include_str!("../migrations/0004_add_agent_audit_and_document_search.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add_agent_tool_calls",
            sql: include_str!("../migrations/0005_add_agent_tool_calls.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "add_document_blocks",
            sql: include_str!("../migrations/0006_add_document_blocks.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "add_agent_document_creation",
            sql: include_str!("../migrations/0007_add_agent_document_creation.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(secret_store::AiSecretState::default())
        .invoke_handler(tauri::generate_handler![
            storage::get_system_fonts,
            storage::get_default_data_directory,
            database::prepare_database,
            storage::migrate_data_directory,
            storage::store_asset_data_url,
            storage::get_asset_data_url,
            storage::resolve_asset_path,
            storage::write_text_file,
            agent_repository::save_agent_patch_set,
            agent_repository::apply_agent_patch_set,
            agent_repository::apply_agent_document_creation,
            agent_repository::reject_agent_patch_set,
            agent_repository::rollback_agent_transaction,
            secret_store::get_ai_api_key,
            secret_store::set_ai_api_key,
            agent_tools::execute_rig_tool
        ])
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(database::DATABASE_URL, migrations())
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
