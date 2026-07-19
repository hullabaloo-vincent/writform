//! Voice channels: audio-only rooms per group. The server tracks who is in
//! which room and relays WebRTC signaling between members; media flows
//! peer-to-peer (DTLS-SRTP mesh), never through the server.
//!
//! Events: `voice.channel.created` / `voice.channel.deleted` and
//! `voice.joined` / `voice.left` fan out to `group:{id}`; `voice.signal`
//! goes to the target user's `user:{id}` room.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::chat::UserRef;
use crate::{GroupId, UnixMillis, UserId};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VoiceChannel {
    #[ts(type = "number")]
    pub id: i64,
    pub group_id: GroupId,
    pub name: String,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VoiceChannelInfo {
    pub channel: VoiceChannel,
    pub participants: Vec<UserRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateVoiceChannelRequest {
    pub name: String,
}

/// Returned from join: everyone already in the room (the joiner initiates a
/// peer connection to each of them).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VoiceJoinResponse {
    pub participants: Vec<UserRef>,
}

/// Opaque WebRTC signaling payload relayed to one member of the same room.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VoiceSignalRequest {
    pub to: UserId,
    pub data: serde_json::Value,
}
