pub mod att_protocol;
pub mod commands;
pub mod net;
pub mod plugins;
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
        .manage(ConnectionManager::default())
        .manage(Arc::new(WsManager::default()))
        .register_asynchronous_uri_scheme_protocol("writform-att", att_protocol::handle)
        .setup(|app| {
            let manager = app.state::<ConnectionManager>();
            match app.path().app_config_dir() {
                Ok(dir) => manager.load(dir),
                Err(e) => tracing::error!("no app config dir: {e}"),
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
            commands::api::api_fetch,
            commands::api::upload_attachment,
            wsclient::ws_sub,
            wsclient::ws_unsub,
            vault::vault_list,
            vault::vault_read,
            vault::vault_write,
            vault::vault_delete,
            vault::vault_backlinks,
            plugins::plugins_list,
            plugins::plugin_read_entry,
            plugins::plugin_set_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
