//! WebSocket manager: one pinned-TLS socket to the active server, auto
//! reconnect with backoff, desired-room resubscription, and frame forwarding
//! to the webview as `ws:event` Tauri events.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tauri::Emitter;
use tokio_tungstenite::tungstenite::Message as WsMsg;
use writform_proto::ws::ClientFrame;

use crate::commands::connect::CmdError;
use crate::net;

#[derive(Default)]
pub struct WsManager {
    /// Rooms the frontend wants; re-subscribed after every (re)connect.
    desired_rooms: Mutex<HashSet<String>>,
    /// Outbound frame sender of the live socket task, if any.
    tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<ClientFrame>>>,
    /// Incremented to invalidate an old socket task on disconnect/reconnect.
    generation: AtomicU64,
}

impl WsManager {
    pub fn disconnect(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        *self.tx.lock().expect("poisoned") = None;
        self.desired_rooms.lock().expect("poisoned").clear();
    }

    fn send(&self, frame: ClientFrame) {
        if let Some(tx) = self.tx.lock().expect("poisoned").as_ref() {
            let _ = tx.send(frame);
        }
    }
}

/// Open (or replace) the socket for the current session.
pub fn start(
    app: tauri::AppHandle,
    manager: Arc<WsManager>,
    addr: String,
    token: String,
    spki_pin: [u8; 32],
) {
    let my_generation = manager.generation.fetch_add(1, Ordering::SeqCst) + 1;

    tauri::async_runtime::spawn(async move {
        let mut backoff_secs = 1u64;
        loop {
            if manager.generation.load(Ordering::SeqCst) != my_generation {
                return; // superseded by a newer connection or disconnect
            }
            match run_socket(&app, &manager, &addr, &token, spki_pin, my_generation).await {
                Ok(()) => return, // clean shutdown
                Err(e) => {
                    tracing::warn!("ws connection lost: {e}; reconnecting in {backoff_secs}s");
                    let _ = app.emit("ws:status", serde_json::json!({"connected": false}));
                    tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
                    backoff_secs = (backoff_secs * 2).min(30);
                }
            }
        }
    });
}

async fn run_socket(
    app: &tauri::AppHandle,
    manager: &Arc<WsManager>,
    addr: &str,
    token: &str,
    spki_pin: [u8; 32],
    my_generation: u64,
) -> Result<(), String> {
    let verifier = net::PinVerifier::pinned(spki_pin);
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    let connector = tokio_tungstenite::Connector::Rustls(Arc::new(config));

    let (mut ws, _) = tokio_tungstenite::connect_async_tls_with_config(
        format!("wss://{addr}/api/v1/ws"),
        None,
        false,
        Some(connector),
    )
    .await
    .map_err(|e| e.to_string())?;

    // Authenticate, then re-subscribe to everything the frontend wants.
    let auth = ClientFrame::Auth {
        token: token.to_string(),
        protocol_version: writform_proto::PROTOCOL_VERSION,
    };
    ws.send(WsMsg::Text(serde_json::to_string(&auth).unwrap().into()))
        .await
        .map_err(|e| e.to_string())?;
    let rooms: Vec<String> = manager
        .desired_rooms
        .lock()
        .expect("poisoned")
        .iter()
        .cloned()
        .collect();
    if !rooms.is_empty() {
        let sub = ClientFrame::Sub { rooms };
        ws.send(WsMsg::Text(serde_json::to_string(&sub).unwrap().into()))
            .await
            .map_err(|e| e.to_string())?;
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ClientFrame>();
    *manager.tx.lock().expect("poisoned") = Some(tx);
    let _ = app.emit("ws:status", serde_json::json!({"connected": true}));

    let mut ping = tokio::time::interval(std::time::Duration::from_secs(30));
    loop {
        if manager.generation.load(Ordering::SeqCst) != my_generation {
            let _ = ws.close(None).await;
            return Ok(());
        }
        tokio::select! {
            frame = rx.recv() => {
                let Some(frame) = frame else { return Ok(()) };
                let text = serde_json::to_string(&frame).unwrap();
                ws.send(WsMsg::Text(text.into())).await.map_err(|e| e.to_string())?;
            }
            msg = ws.next() => {
                match msg {
                    Some(Ok(WsMsg::Text(text))) => {
                        // Forward raw ServerFrame JSON to the webview.
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                            let _ = app.emit("ws:event", value);
                        }
                    }
                    Some(Ok(WsMsg::Ping(_) | WsMsg::Pong(_))) => {}
                    Some(Ok(WsMsg::Close(_))) | None => return Err("socket closed".into()),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e.to_string()),
                }
            }
            _ = ping.tick() => {
                let frame = ClientFrame::Ping { client_time: now_millis() };
                let text = serde_json::to_string(&frame).unwrap();
                ws.send(WsMsg::Text(text.into())).await.map_err(|e| e.to_string())?;
            }
        }
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock before epoch")
        .as_millis() as i64
}

#[tauri::command]
pub fn ws_sub(
    manager: tauri::State<'_, Arc<WsManager>>,
    rooms: Vec<String>,
) -> Result<(), CmdError> {
    {
        let mut desired = manager.desired_rooms.lock().expect("poisoned");
        for room in &rooms {
            desired.insert(room.clone());
        }
    }
    manager.send(ClientFrame::Sub { rooms });
    Ok(())
}

#[tauri::command]
pub fn ws_unsub(
    manager: tauri::State<'_, Arc<WsManager>>,
    rooms: Vec<String>,
) -> Result<(), CmdError> {
    {
        let mut desired = manager.desired_rooms.lock().expect("poisoned");
        for room in &rooms {
            desired.remove(room);
        }
    }
    manager.send(ClientFrame::Unsub { rooms });
    Ok(())
}
