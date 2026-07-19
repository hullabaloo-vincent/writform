//! WebSocket envelope types (`/api/v1/ws`).
//!
//! Mutations happen over REST; the socket carries subscriptions and fan-out
//! only ("REST is truth, WS is invalidation").

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{UnixMillis, UserId, WritingSessionId};

/// client → server frames.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "op", content = "d", rename_all = "snake_case")]
#[ts(export)]
pub enum ClientFrame {
    Auth {
        token: String,
        protocol_version: u32,
    },
    Sub {
        rooms: Vec<String>,
    },
    Unsub {
        rooms: Vec<String>,
    },
    Ping {
        #[ts(type = "number")]
        client_time: UnixMillis,
    },
}

/// server → client frames. `room` is present on fan-out events.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "ev", rename_all = "snake_case")]
#[ts(export)]
pub enum ServerFrame {
    Ready {
        d: ReadyData,
    },
    Pong {
        d: PongData,
    },
    /// Generic fan-out event. `kind` is dot-namespaced ("message.created",
    /// "session.started", ...) and `data` is the event payload; typed payload
    /// structs live beside the feature that emits them.
    Event {
        room: String,
        kind: String,
        data: serde_json::Value,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReadyData {
    pub user_id: UserId,
    #[ts(type = "number")]
    pub server_time: UnixMillis,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PongData {
    #[ts(type = "number")]
    pub client_time: UnixMillis,
    #[ts(type = "number")]
    pub server_time: UnixMillis,
}

/// Payload for `prompt.started` events in room `session:{id}`. A session
/// holds multiple prompts; timers are per prompt.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PromptStarted {
    pub session_id: WritingSessionId,
    /// Row id in `session_prompts`.
    #[ts(type = "number")]
    pub prompt_id: i64,
    #[ts(type = "number")]
    pub started_at: UnixMillis,
    /// Absent when the prompt has no timer.
    #[ts(type = "number | null")]
    pub ends_at: Option<UnixMillis>,
}
