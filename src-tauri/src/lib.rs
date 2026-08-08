use tauri::Manager;

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

mod action_gateway;
mod agent_cancellation;
mod agent_repository;
mod agent_request_watcher;
mod agent_tools;
mod agent_worker_supervisor;
mod ai_models;
mod ai_proxy;
mod automation_runtime;
mod cognitive_sessions;
pub mod core_server;
mod core_supervisor;
mod database;
mod database_mutations;
mod database_queries;
mod dingtalk;
mod document_core;
mod domain_events;
mod email;
mod governance;
mod local_environment;
mod mcp;
pub mod mcp_server_exposure;
mod outbox_dispatcher;
mod reliability;
mod rss;
mod secret_store;
mod sensitive_data;
mod signal_runtime;
mod skills;
mod storage;
mod views;
mod work;
mod workflow_runtime;
mod workflow_timers;

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

            let show =
                tauri::menu::MenuItem::with_id(app, "show", "打开 myNoteBook", true, None::<&str>)?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show, &quit])?;
            tauri::tray::TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().ok_or("缺少应用图标")?)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = app_handle.state::<core_supervisor::HeadlessCoreSupervisorState>();
                if let Err(error) =
                    core_supervisor::ensure_headless_core_inner(&app_handle, state.inner()).await
                {
                    tauri_plugin_log::log::error!("Headless Core 启动或发现失败：{error}");
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .manage(secret_store::AiSecretState::default())
        .manage(core_supervisor::HeadlessCoreSupervisorState::default())
        .manage(dingtalk::DingTalkRuntimeState::default())
        .manage(dingtalk::DingTalkProjectionState::default())
        .manage(agent_worker_supervisor::AgentWorkerSupervisorState::default())
        .manage(agent_request_watcher::AgentRequestWatcherState::default())
        .manage(workflow_timers::DurableTimerProjectionState::default())
        .manage(workflow_runtime::WorkflowScannerProjectionState::default())
        .manage(outbox_dispatcher::OutboxDispatcherProjectionState::default())
        .invoke_handler(tauri::generate_handler![
            storage::get_system_fonts,
            local_environment::get_local_environment_snapshot,
            core_supervisor::ensure_headless_core,
            core_supervisor::get_headless_core_snapshot,
            storage::get_default_data_directory,
            database::prepare_database,
            database_mutations::execute_database_mutation,
            database_queries::execute_database_query,
            database_queries::close_database_read_pool,
            document_core::persist_document,
            document_core::rebuild_document_projections,
            storage::migrate_data_directory,
            storage::store_asset_data_url,
            storage::get_asset_data_url,
            storage::open_asset_file,
            storage::remove_asset_file,
            skills::list_installed_skills,
            skills::import_skill_directory,
            skills::create_skill,
            skills::set_skill_enabled,
            skills::read_skill_file,
            skills::write_skill_file,
            skills::remove_installed_skill,
            skills::open_skills_directory,
            mcp::list_mcp_servers,
            mcp::import_mcp_config,
            mcp::import_mcp_config_text,
            mcp::install_qoder_bridge,
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
            dingtalk::get_dingtalk_connector_snapshot,
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
            agent_request_watcher::configure_agent_background_runtime,
            agent_request_watcher::claim_agent_request,
            agent_request_watcher::settle_agent_request,
            signal_runtime::publish_signal_refresh_event,
            workflow_timers::get_workflow_timer_snapshot,
            workflow_runtime::get_workflow_scanner_snapshot,
            outbox_dispatcher::get_outbox_dispatcher_snapshot,
            work::commit_result_verification,
            work::decide_change_set,
            work::record_authorization,
            work::resolve_authorization,
            views::commit_view_refresh,
            views::set_view_manual_override,
            governance::create_delegation,
            governance::submit_external_work
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
