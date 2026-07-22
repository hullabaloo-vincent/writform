pub mod att_protocol;
pub mod commands;
pub mod host;
pub mod localdocs;
mod media;
pub mod net;
pub mod plugins;
pub mod profile;
pub mod servers;
pub mod vault;
pub mod wsclient;

use std::sync::Arc;

use tauri::Manager;

use crate::servers::ConnectionManager;
use crate::wsclient::WsManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The aws-lc-rs provider carries the hybrid X25519MLKEM768 key exchange;
    // install before any TLS client is built.
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("install rustls crypto provider");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ConnectionManager::default())
        .manage(host::HostManager::default())
        .manage(Arc::new(WsManager::default()))
        .register_asynchronous_uri_scheme_protocol("writform-att", att_protocol::handle)
        .setup(|app| {
            let manager = app.state::<ConnectionManager>();
            match app.path().app_config_dir() {
                Ok(dir) => manager.load(dir),
                Err(e) => tracing::error!("no app config dir: {e}"),
            }
            match (app.path().app_config_dir(), app.path().app_data_dir()) {
                (Ok(config_dir), Ok(data_dir)) => {
                    app.state::<host::HostManager>().init(config_dir, data_dir);
                    host::auto_start(app.handle());
                }
                (config, data) => {
                    tracing::error!("hosting unavailable: config={config:?} data={data:?}")
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connect::probe_server,
            commands::connect::trust_server,
            commands::connect::list_servers,
            commands::connect::remove_server,
            commands::connect::login,
            commands::connect::register,
            commands::connect::logout,
            commands::connect::current_session,
            host::host_status,
            host::host_start,
            host::host_stop,
            host::host_reachability,
            commands::api::api_fetch,
            commands::api::upload_attachment,
            commands::api::save_export,
            commands::api::read_dropped_file,
            media::microphone_status,
            media::request_microphone_access,
            media::camera_status,
            media::request_camera_access,
            commands::connect::reset_password,
            wsclient::ws_sub,
            wsclient::ws_unsub,
            vault::vault_list,
            vault::vault_read,
            vault::vault_write,
            vault::vault_delete,
            vault::vault_rename,
            vault::vault_backlinks,
            vault::vault_search,
            vault::vault_path,
            profile::profile_get,
            profile::profile_save,
            profile::profile_update_fields,
            profile::profile_delete,
            localdocs::localdoc_list,
            localdocs::localdoc_read,
            localdocs::localdoc_write,
            localdocs::localdoc_delete,
            plugins::plugins_list,
            plugins::plugin_read_entry,
            plugins::plugin_set_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
