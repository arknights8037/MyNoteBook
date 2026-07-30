use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};

#[cfg(target_os = "windows")]
#[repr(C)]
struct AccentPolicy {
    state: u32,
    flags: u32,
    color: u32,
    animation_id: u32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct WindowCompositionAttributeData {
    attribute: u32,
    data: *mut core::ffi::c_void,
    size: usize,
}

#[cfg(target_os = "windows")]
unsafe fn apply_fixed_light_acrylic(hwnd: *mut core::ffi::c_void) {
    type SetWindowCompositionAttributeFn = unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut WindowCompositionAttributeData,
    ) -> i32;
    const DWMWA_SYSTEMBACKDROP_TYPE: u32 = 38;
    const DWMSBT_NONE: u32 = 1;
    const WCA_ACCENT_POLICY: u32 = 19;
    const ACCENT_ENABLE_ACRYLICBLURBEHIND: u32 = 4;
    // GradientColor is encoded as AABBGGRR. Keep the native tint deliberately
    // light: Windows supplies the real desktop blur while CSS owns the visible
    // navigation tint and text contrast.
    const BASE_ACRYLIC_TINT: u32 = 0x20F3F3F3;

    let user32 = LoadLibraryA(c"user32.dll".as_ptr() as *const u8);
    if user32.is_null() {
        return;
    }
    let Some(procedure) = GetProcAddress(
        user32,
        c"SetWindowCompositionAttribute".as_ptr() as *const u8,
    ) else {
        return;
    };
    let set_window_composition_attribute: SetWindowCompositionAttributeFn =
        core::mem::transmute(procedure);

    let backdrop = DWMSBT_NONE;
    let _ = DwmSetWindowAttribute(
        hwnd,
        DWMWA_SYSTEMBACKDROP_TYPE,
        &backdrop as *const _ as *const core::ffi::c_void,
        core::mem::size_of_val(&backdrop) as u32,
    );

    let mut policy = AccentPolicy {
        state: ACCENT_ENABLE_ACRYLICBLURBEHIND,
        flags: 0,
        color: BASE_ACRYLIC_TINT,
        animation_id: 0,
    };
    let mut data = WindowCompositionAttributeData {
        attribute: WCA_ACCENT_POLICY,
        data: &mut policy as *mut _ as *mut core::ffi::c_void,
        size: core::mem::size_of_val(&policy),
    };
    let _ = set_window_composition_attribute(hwnd, &mut data);
}

mod agent_cancellation;
mod agent_repository;
mod agent_request_watcher;
mod agent_tools;
mod agent_worker_supervisor;
mod ai_models;
mod ai_proxy;
mod cognitive_sessions;
mod database;
mod dingtalk;
mod document_core;
mod domain_events;
mod email;
mod governance;
mod mcp;
pub mod mcp_server_exposure;
mod rss;
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
        Migration {
            version: 24,
            description: "add_agent_request_mode",
            sql: include_str!("../migrations/0024_add_agent_request_mode.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 25,
            description: "add_confirmation_envelope",
            sql: include_str!("../migrations/0025_add_confirmation_envelope.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 26,
            description: "add_workspace_view_pinning",
            sql: include_str!("../migrations/0026_add_workspace_view_pinning.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 27,
            description: "add_agent_request_decision",
            sql: include_str!("../migrations/0027_add_agent_request_decision.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 28,
            description: "add_agent_a2a_routing",
            sql: include_str!("../migrations/0028_add_agent_a2a_routing.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 29,
            description: "add_dashboard_workspace_view",
            sql: include_str!("../migrations/0029_add_dashboard_workspace_view.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 30,
            description: "add_email_inbox",
            sql: include_str!("../migrations/0030_add_email_inbox.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 31,
            description: "add_rss_inbox",
            sql: include_str!("../migrations/0031_add_rss_inbox.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 32,
            description: "add_rss_article_extraction",
            sql: include_str!("../migrations/0032_add_rss_article_extraction.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 33,
            description: "add_inbox_source_cursors",
            sql: include_str!("../migrations/0033_add_inbox_source_cursors.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 34,
            description: "add_dingtalk_inbox",
            sql: include_str!("../migrations/0034_add_dingtalk_inbox.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 35,
            description: "add_information_home",
            sql: include_str!("../migrations/0035_add_information_home.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 36,
            description: "add_runtime_port_contracts",
            sql: include_str!("../migrations/0036_add_runtime_port_contracts.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                let hwnd = window.hwnd()?.0;
                let corner_preference = DWMWCP_ROUND;
                unsafe {
                    apply_fixed_light_acrylic(hwnd);
                    DwmSetWindowAttribute(
                        hwnd,
                        DWMWA_WINDOW_CORNER_PREFERENCE as u32,
                        &corner_preference as *const _ as *const core::ffi::c_void,
                        core::mem::size_of_val(&corner_preference) as u32,
                    );
                }
            }

            Ok(())
        })
        .manage(secret_store::AiSecretState::default())
        .manage(dingtalk::DingTalkRuntimeState::default())
        .manage(agent_worker_supervisor::AgentWorkerSupervisorState::default())
        .manage(agent_request_watcher::AgentRequestWatcherState::default())
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
            mcp_server_exposure::get_mcp_server_exposure,
            mcp_server_exposure::set_mcp_server_tool_exposure,
            agent_repository::save_agent_patch_set,
            agent_repository::save_agent_context_bundle,
            agent_repository::apply_agent_patch_set,
            agent_repository::apply_agent_document_creation,
            agent_repository::apply_agent_group_creation,
            agent_repository::reject_agent_patch_set,
            agent_repository::cleanup_orphan_agent_tasks,
            agent_repository::rollback_agent_transaction,
            cognitive_sessions::create_cognitive_session,
            cognitive_sessions::get_cognitive_session,
            cognitive_sessions::list_cognitive_sessions,
            cognitive_sessions::update_cognitive_session,
            secret_store::get_ai_api_key,
            secret_store::set_ai_api_key,
            email::test_email_connection,
            email::set_email_account_secret,
            email::delete_email_account_secret,
            email::sync_email_account,
            dingtalk::test_dingtalk_connection,
            dingtalk::set_dingtalk_connector_secret,
            dingtalk::delete_dingtalk_connector_secret,
            dingtalk::start_dingtalk_connector,
            dingtalk::stop_dingtalk_connector,
            dingtalk::resume_dingtalk_connectors,
            rss::fetch_rss_feed,
            rss::fetch_rss_article,
            ai_models::fetch_ai_models,
            ai_proxy::proxy_ai_request,
            agent_cancellation::cancel_agent_tool_call,
            agent_tools::execute_rig_tool,
            agent_worker_supervisor::start_agent_worker,
            agent_worker_supervisor::get_agent_worker_snapshot,
            agent_worker_supervisor::get_agent_runtime_terminal,
            agent_worker_supervisor::acknowledge_agent_runtime_terminal,
            agent_worker_supervisor::start_agent_runtime_run,
            agent_worker_supervisor::start_agent_sidecar_orchestration,
            agent_worker_supervisor::cancel_agent_runtime_run,
            agent_worker_supervisor::steer_agent_runtime_run,
            agent_worker_supervisor::shutdown_agent_worker,
            agent_request_watcher::start_agent_request_watcher,
            agent_request_watcher::claim_agent_request,
            agent_request_watcher::settle_agent_request,
            work::commit_result_verification,
            work::decide_change_set,
            work::record_authorization,
            work::resolve_authorization,
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
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                .build(),
        )
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
