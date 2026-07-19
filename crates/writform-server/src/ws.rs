//! WebSocket hub: authenticated connections, room subscriptions with
//! membership checks, fan-out, and presence.
//!
//! Mutations never arrive here — REST handlers call [`WsHub::broadcast`] and
//! the hub only distributes. Rooms: `user:{id}` (auto), `group:{id}`,
//! `channel:{id}`, `session:{id}`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use axum::extract::ws::{Message as WsMessage, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use writform_proto::ws::{ClientFrame, PongData, ReadyData, ServerFrame};
use writform_proto::{ChannelId, GroupId, UserId};

use crate::db::now_millis;
use crate::perms;
use crate::routes::AppState;

type ConnId = u64;

struct Conn {
    user_id: UserId,
    tx: mpsc::UnboundedSender<ServerFrame>,
    rooms: HashSet<String>,
}

#[derive(Default)]
pub struct WsHub {
    next_id: AtomicU64,
    conns: Mutex<HashMap<ConnId, Conn>>,
}

impl WsHub {
    /// Send an event to every connection subscribed to `room`.
    pub fn broadcast(&self, room: &str, kind: &str, data: serde_json::Value) {
        let frame = ServerFrame::Event {
            room: room.to_string(),
            kind: kind.to_string(),
            data,
        };
        let conns = self.conns.lock().expect("poisoned");
        for conn in conns.values() {
            if conn.rooms.contains(room) {
                let _ = conn.tx.send(frame.clone());
            }
        }
    }

    /// Online user ids among `candidates` (for presence snapshots).
    pub fn online_among(&self, candidates: &[UserId]) -> Vec<UserId> {
        let online: HashSet<UserId> = self
            .conns
            .lock()
            .expect("poisoned")
            .values()
            .map(|c| c.user_id)
            .collect();
        candidates
            .iter()
            .copied()
            .filter(|u| online.contains(u))
            .collect()
    }

    pub fn is_online(&self, user: UserId) -> bool {
        self.conns
            .lock()
            .expect("poisoned")
            .values()
            .any(|c| c.user_id == user)
    }

    fn register(&self, user_id: UserId, tx: mpsc::UnboundedSender<ServerFrame>) -> ConnId {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut rooms = HashSet::new();
        rooms.insert(format!("user:{}", user_id.0));
        self.conns
            .lock()
            .expect("poisoned")
            .insert(id, Conn { user_id, tx, rooms });
        id
    }

    fn unregister(&self, id: ConnId) -> Option<UserId> {
        self.conns
            .lock()
            .expect("poisoned")
            .remove(&id)
            .map(|c| c.user_id)
    }

    fn set_rooms(&self, id: ConnId, add: &[String], remove: &[String]) {
        let mut conns = self.conns.lock().expect("poisoned");
        if let Some(conn) = conns.get_mut(&id) {
            for r in add {
                conn.rooms.insert(r.clone());
            }
            for r in remove {
                conn.rooms.remove(r);
            }
        }
    }
}

pub async fn ws_handler(State(state): State<AppState>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| handle_socket(state, socket))
}

async fn handle_socket(state: AppState, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();

    // First frame must be auth.
    let user_id = match authenticate_first_frame(&state, &mut stream).await {
        Ok(user_id) => user_id,
        Err(err_frame) => {
            let _ = sink
                .send(WsMessage::Text(
                    serde_json::to_string(&err_frame).unwrap().into(),
                ))
                .await;
            return;
        }
    };

    let (tx, mut rx) = mpsc::unbounded_channel::<ServerFrame>();
    let conn_id = state.ws.register(user_id, tx);

    let _ = sink
        .send(WsMessage::Text(
            serde_json::to_string(&ServerFrame::Ready {
                d: ReadyData {
                    user_id,
                    server_time: now_millis(),
                },
            })
            .unwrap()
            .into(),
        ))
        .await;

    // Presence: user came online with their first connection.
    let was_online_elsewhere = {
        let conns = state.ws.conns.lock().expect("poisoned");
        conns.values().filter(|c| c.user_id == user_id).count() > 1
    };
    if !was_online_elsewhere {
        broadcast_presence(&state, user_id, true).await;
    }

    // Writer task: forward hub frames to the socket.
    let writer = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let text = serde_json::to_string(&frame).unwrap();
            if sink.send(WsMessage::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    // Reader loop: subscriptions + pings.
    while let Some(Ok(msg)) = stream.next().await {
        let WsMessage::Text(text) = msg else { continue };
        let Ok(frame) = serde_json::from_str::<ClientFrame>(&text) else {
            send_error(&state, conn_id, "bad_frame", "unparseable frame");
            continue;
        };
        match frame {
            ClientFrame::Auth { .. } => {} // already authenticated
            ClientFrame::Ping { client_time } => {
                send_frame(
                    &state,
                    conn_id,
                    ServerFrame::Pong {
                        d: PongData {
                            client_time,
                            server_time: now_millis(),
                        },
                    },
                );
            }
            ClientFrame::Sub { rooms } => {
                let mut allowed = Vec::new();
                for room in rooms {
                    match room_allowed(&state, &room, user_id).await {
                        Ok(true) => allowed.push(room),
                        Ok(false) => send_error(&state, conn_id, "forbidden_room", &room),
                        Err(_) => send_error(&state, conn_id, "bad_room", &room),
                    }
                }
                state.ws.set_rooms(conn_id, &allowed, &[]);
            }
            ClientFrame::Unsub { rooms } => {
                state.ws.set_rooms(conn_id, &[], &rooms);
            }
        }
    }

    // Disconnected.
    state.ws.unregister(conn_id);
    writer.abort();
    if !state.ws.is_online(user_id) {
        broadcast_presence(&state, user_id, false).await;
    }
}

async fn authenticate_first_frame(
    state: &AppState,
    stream: &mut (impl StreamExt<Item = Result<WsMessage, axum::Error>> + Unpin),
) -> Result<UserId, ServerFrame> {
    let deny = |code: &str, message: &str| ServerFrame::Error {
        code: code.into(),
        message: message.into(),
    };
    let frame = tokio::time::timeout(std::time::Duration::from_secs(10), stream.next())
        .await
        .map_err(|_| deny("auth_timeout", "no auth frame received"))?
        .and_then(|r| r.ok())
        .ok_or_else(|| deny("closed", "connection closed"))?;
    let WsMessage::Text(text) = frame else {
        return Err(deny("bad_frame", "expected text auth frame"));
    };
    let Ok(ClientFrame::Auth {
        token,
        protocol_version,
    }) = serde_json::from_str::<ClientFrame>(&text)
    else {
        return Err(deny("bad_frame", "first frame must be auth"));
    };
    if protocol_version != writform_proto::PROTOCOL_VERSION {
        return Err(deny(
            "protocol_mismatch",
            "client protocol version not supported",
        ));
    }

    let token_hash = writform_crypto::token::token_hash(&token);
    let row: Option<(i64, i64)> =
        sqlx::query_as("SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?")
            .bind(&token_hash)
            .fetch_optional(&state.pool)
            .await
            .map_err(|_| deny("internal", "database error"))?;
    match row {
        Some((user_id, expires_at)) if expires_at >= now_millis() => Ok(UserId(user_id)),
        _ => Err(deny("invalid_token", "unknown or expired token")),
    }
}

async fn room_allowed(state: &AppState, room: &str, user: UserId) -> Result<bool, ()> {
    let (kind, id) = room.split_once(':').ok_or(())?;
    let id: i64 = id.parse().map_err(|_| ())?;
    match kind {
        "user" => Ok(id == user.0),
        "group" => Ok(perms::member_role(&state.pool, GroupId(id), user)
            .await
            .map_err(|_| ())?
            .is_some()),
        "channel" => Ok(
            perms::require_channel_access(&state.pool, ChannelId(id), user)
                .await
                .is_ok(),
        ),
        // Boards belong to a group; access = group membership.
        "canvas" => {
            let row: Option<(i64,)> =
                sqlx::query_as("SELECT group_id FROM canvas_boards WHERE id = ?")
                    .bind(id)
                    .fetch_optional(&state.pool)
                    .await
                    .map_err(|_| ())?;
            match row {
                Some((group_id,)) => Ok(perms::member_role(&state.pool, GroupId(group_id), user)
                    .await
                    .map_err(|_| ())?
                    .is_some()),
                None => Err(()),
            }
        }
        // Sessions live in a channel; access = channel access (Phase 3).
        "session" => {
            let row: Option<(i64,)> =
                sqlx::query_as("SELECT channel_id FROM writing_sessions WHERE id = ?")
                    .bind(id)
                    .fetch_optional(&state.pool)
                    .await
                    .map_err(|_| ())?;
            match row {
                Some((channel_id,)) => {
                    Ok(
                        perms::require_channel_access(&state.pool, ChannelId(channel_id), user)
                            .await
                            .is_ok(),
                    )
                }
                None => Err(()),
            }
        }
        _ => Err(()),
    }
}

fn send_frame(state: &AppState, conn_id: ConnId, frame: ServerFrame) {
    let conns = state.ws.conns.lock().expect("poisoned");
    if let Some(conn) = conns.get(&conn_id) {
        let _ = conn.tx.send(frame);
    }
}

fn send_error(state: &AppState, conn_id: ConnId, code: &str, message: &str) {
    send_frame(
        state,
        conn_id,
        ServerFrame::Error {
            code: code.into(),
            message: message.into(),
        },
    );
}

async fn broadcast_presence(state: &AppState, user: UserId, online: bool) {
    let Ok(groups) = perms::user_groups(&state.pool, user).await else {
        return;
    };
    let data = serde_json::json!({ "user_id": user, "online": online });
    for group in groups {
        state.ws.broadcast(
            &format!("group:{}", group.0),
            "presence.update",
            data.clone(),
        );
    }
}
