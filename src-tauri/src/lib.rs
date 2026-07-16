use tauri_plugin_sql::{Migration, MigrationKind};

mod agent_cancellation;
mod agent_repository;
mod agent_tools;
mod ai_models;
mod ai_proxy;
mod database;
mod document_core;
mod domain_events;
mod governance;
mod mcp;
mod secret_store;
mod sensitive_data;
mod skills;
mod storage;
mod views;
mod work;

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
        Migration {
            version: 8,
            description: "add_automations",
            sql: include_str!("../migrations/0008_add_automations.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "add_p0_trusted_runtime",
            sql: include_str!("../migrations/0009_add_p0_trusted_runtime.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "add_p1_knowledge_work_views",
            sql: include_str!("../migrations/0010_add_p1_knowledge_work_views.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "add_p2_external_governance_generated_views",
            sql: include_str!("../migrations/0011_add_p2_external_governance_generated_views.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "add_agent_group_creation",
            sql: include_str!("../migrations/0012_add_agent_group_creation.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "harden_database_operations",
            sql: include_str!("../migrations/0013_harden_database_operations.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "add_cognitive_core",
            sql: include_str!("../migrations/0014_add_cognitive_core.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "add_agent_communication",
            sql: include_str!("../migrations/0015_add_agent_communication.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 16,
            description: "add_agent_request_result",
            sql: include_str!("../migrations/0016_add_agent_request_result.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 17,
            description: "allow_multi_document_agent_transactions",
            sql: include_str!("../migrations/0017_allow_multi_document_agent_transactions.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 18,
            description: "add_agent_request_revision",
            sql: include_str!("../migrations/0018_add_agent_request_revision.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 19,
            description: "add_agent_workspace_state",
            sql: include_str!("../migrations/0019_add_agent_workspace_state.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 20,
            description: "add_mind_maps",
            sql: include_str!("../migrations/0020_add_mind_maps.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 21,
            description: "add_workspace_views",
            sql: include_str!("../migrations/0021_add_workspace_views.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 22,
            description: "add_mind_map_tree_position",
            sql: include_str!("../migrations/0022_add_mind_map_tree_position.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 23,
            description: "add_workspace_view_tree_position",
            sql: include_str!("../migrations/0023_add_workspace_view_tree_position.sql"),
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
            document_core::persist_document,
            document_core::rebuild_document_projections,
            storage::migrate_data_directory,
            storage::store_asset_data_url,
            storage::get_asset_data_url,
            storage::resolve_asset_path,
            storage::remove_asset_file,
            storage::write_text_file,
            skills::list_installed_skills,
            skills::import_skill_directory,
            skills::create_skill,
            skills::set_skill_enabled,
            skills::read_skill_file,
            skills::write_skill_file,
            skills::remove_installed_skill,
            skills::get_skills_directory,
            mcp::list_mcp_servers,
            mcp::import_mcp_config,
            mcp::import_mcp_config_text,
            mcp::set_mcp_server_enabled,
            mcp::set_mcp_server_trusted,
            mcp::remove_mcp_server,
            mcp::list_mcp_tools,
            mcp::call_mcp_tool,
            mcp::list_mcp_resources,
            mcp::read_mcp_resource,
            agent_repository::save_agent_patch_set,
            agent_repository::save_agent_context_bundle,
            agent_repository::apply_agent_patch_set,
            agent_repository::apply_agent_document_creation,
            agent_repository::apply_agent_group_creation,
            agent_repository::reject_agent_patch_set,
            agent_repository::cleanup_orphan_agent_tasks,
            agent_repository::rollback_agent_transaction,
            secret_store::get_ai_api_key,
            secret_store::set_ai_api_key,
            ai_models::fetch_ai_models,
            ai_proxy::proxy_ai_request,
            agent_cancellation::cancel_agent_tool_call,
            agent_tools::execute_rig_tool,
            work::commit_result_verification,
            work::decide_change_set,
            views::commit_view_refresh,
            views::set_view_manual_override,
            governance::create_delegation,
            governance::submit_external_work,
            governance::claim_outbox_messages,
            governance::settle_outbox_message
        ])
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .format(|out, message, record| {
                    let safe_message = sensitive_data::redact_sensitive_text(&message.to_string());
                    out.finish(format_args!(
                        "[{}][{}] {}",
                        record.target(),
                        record.level(),
                        safe_message
                    ));
                })
                .build(),
        )
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
