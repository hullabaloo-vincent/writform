pub mod att_protocol;
pub mod commands;
pub mod fonts;
pub mod host;
pub mod localboards;
pub mod localdocs;
mod media;
pub mod net;
pub mod plugins;
mod print;
pub mod profile;
pub mod servers;
#[cfg(desktop)]
pub mod sysfonts;
pub mod vault;
pub mod wsclient;

use std::sync::Arc;

use tauri::Manager;

use crate::servers::ConnectionManager;
use crate::wsclient::WsManager;

/// Underline misspellings as you type, as every Mac writing app does.
///
/// A WKWebView honours `spellcheck="true"` only while its app has
/// "Check Spelling While Typing" on, which WebKit keeps in the app's own
/// defaults and leaves off until someone finds it in a context menu. This
/// registers it as the *default* — a choice the user has made either way
/// (it's the same key that menu item writes) still wins.
#[cfg(target_os = "macos")]
fn spellcheck_by_default() {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    let key = NSString::from_str("WebContinuousSpellCheckingEnabled");
    // SAFETY: Foundation messages with their documented argument types;
    // every object here is autoreleased or owned by `key`.
    unsafe {
        let defaults: *mut AnyObject = msg_send![class!(NSUserDefaults), standardUserDefaults];
        let yes: *mut AnyObject = msg_send![class!(NSNumber), numberWithBool: true];
        let registered: *mut AnyObject =
            msg_send![class!(NSDictionary), dictionaryWithObject: yes, forKey: &*key];
        let _: () = msg_send![defaults, registerDefaults: registered];
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The aws-lc-rs provider carries the hybrid X25519MLKEM768 key exchange;
    // install before any TLS client is built.
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("install rustls crypto provider");

    // Before any webview exists: it reads this once, when it starts.
    #[cfg(target_os = "macos")]
    spellcheck_by_default();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());

    // Desktop: self-update, relaunch, and remembering window size/position
    // across launches (tauri.conf.json's 1280×800 stays the first-run
    // default). None of these concepts exist on iOS/Android.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        // The fonts installed on this computer (scanned on first use).
        .manage(sysfonts::SysFonts::default());

    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_haptics::init());

    builder
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
            commands::connect::resume_target,
            commands::connect::resume_server,
            commands::connect::disconnect,
            host::host_status,
            host::host_start,
            host::host_stop,
            host::host_reachability,
            commands::api::api_fetch,
            commands::api::upload_attachment,
            commands::api::save_file,
            commands::api::read_dropped_file,
            print::print_pdf,
            fonts::font_fetch,
            fonts::font_cache_info,
            fonts::font_cache_clear,
            #[cfg(desktop)]
            sysfonts::sysfont_list,
            #[cfg(desktop)]
            sysfonts::sysfont_bytes,
            media::microphone_status,
            media::request_microphone_access,
            media::camera_status,
            media::request_camera_access,
            commands::connect::reset_password,
            wsclient::ws_sub,
            wsclient::ws_unsub,
            wsclient::ws_typing,
            vault::vault_list,
            vault::vault_read,
            vault::vault_write,
            vault::vault_delete,
            vault::vault_restore,
            vault::vault_write_new,
            vault::vault_rename,
            vault::vault_backlinks,
            vault::vault_search,
            vault::vault_path,
            profile::profile_get,
            profile::profile_save,
            profile::profile_update_fields,
            profile::profile_delete,
            profile::profile_set_image,
            profile::profile_clear_image,
            localdocs::localdoc_list,
            localdocs::localdoc_read,
            localdocs::localdoc_write,
            localdocs::localdoc_delete,
            localdocs::localdoc_trash,
            localdocs::localdoc_trash_list,
            localdocs::localdoc_restore,
            localdocs::localdoc_purge,
            localdocs::localdoc_trash_empty,
            localdocs::localdoc_history_read,
            localdocs::localdoc_history_retire,
            localdocs::localdoc_hist_index_read,
            localdocs::localdoc_hist_index_write,
            localdocs::localdoc_hist_blob_write,
            localdocs::localdoc_hist_blob_read,
            localdocs::localdoc_hist_blob_delete,
            localdocs::localdoc_feedback_read,
            localdocs::localdoc_feedback_write,
            localdocs::localdoc_media_write,
            localdocs::localdoc_media_copy,
            localdocs::localdoc_search,
            localdocs::localdoc_text_write,
            localdocs::localdoc_folders_read,
            localdocs::localdoc_folders_write,
            localboards::localboard_list,
            localboards::localboard_read,
            localboards::localboard_write,
            localboards::localboard_delete,
            localboards::localboard_trash_list,
            localboards::localboard_trash_read,
            localboards::localboard_restore,
            localboards::localboard_purge,
            localboards::localboard_search,
            localboards::localmedia_write,
            localboards::localmedia_prune,
            plugins::plugins_list,
            plugins::plugin_read_entry,
            plugins::plugin_set_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
