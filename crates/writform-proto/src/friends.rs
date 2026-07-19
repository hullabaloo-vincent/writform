//! Friends and direct messages.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::chat::UserRef;
use crate::{ChannelId, UnixMillis};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FriendRequest {
    #[ts(type = "number")]
    pub id: i64,
    pub from: UserRef,
    pub to: UserRef,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SendFriendRequest {
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Friend {
    pub user: UserRef,
    #[ts(type = "number")]
    pub since: UnixMillis,
    /// Live at request time; deltas arrive as `presence.update` on `user:{me}`.
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FriendRequests {
    pub incoming: Vec<FriendRequest>,
    pub outgoing: Vec<FriendRequest>,
}

/// A DM conversation: the channel plus who it's with.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DmChannel {
    pub channel_id: ChannelId,
    pub peer: UserRef,
}
