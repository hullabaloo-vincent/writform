//! Writing sessions: a session is a container in a channel holding multiple
//! prompts; each prompt is independently started/timed/stopped by its
//! creator. Recording = every prompt + everyone's final writing + the side
//! chat history (no keystroke timeline, no voice).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::chat::UserRef;
use crate::{ChannelId, UnixMillis, UserId, WritingSessionId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SessionState {
    Active,
    Ended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PromptState {
    Draft,
    Running,
    Ended,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WritingSession {
    pub id: WritingSessionId,
    /// The group channel this session was created in.
    pub channel_id: ChannelId,
    pub creator: UserRef,
    pub title: String,
    pub state: SessionState,
    /// Side-chat channel (kind = session), auto-created with the session.
    pub chat_channel_id: ChannelId,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
    #[ts(type = "number | null")]
    pub ended_at: Option<UnixMillis>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SessionPrompt {
    #[ts(type = "number")]
    pub id: i64,
    pub session_id: WritingSessionId,
    pub creator_id: UserId,
    #[ts(type = "number")]
    pub position: i64,
    /// TipTap JSON document.
    pub prompt_doc: serde_json::Value,
    #[ts(type = "number | null")]
    pub timer_seconds: Option<i64>,
    pub state: PromptState,
    #[ts(type = "number | null")]
    pub started_at: Option<UnixMillis>,
    #[ts(type = "number | null")]
    pub ends_at: Option<UnixMillis>,
    #[ts(type = "number | null")]
    pub ended_at: Option<UnixMillis>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Submission {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub prompt_id: i64,
    pub author: UserRef,
    /// TipTap JSON document.
    pub doc: serde_json::Value,
    #[ts(type = "number")]
    pub updated_at: UnixMillis,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SessionDetail {
    pub session: WritingSession,
    pub prompts: Vec<SessionPrompt>,
    /// All submissions for ended prompts; only the caller's own for
    /// running/draft prompts (no peeking mid-write).
    pub submissions: Vec<Submission>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateSessionRequest {
    pub channel_id: ChannelId,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreatePromptRequest {
    pub prompt_doc: serde_json::Value,
    #[ts(type = "number | null")]
    pub timer_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SaveSubmissionRequest {
    pub doc: serde_json::Value,
}
