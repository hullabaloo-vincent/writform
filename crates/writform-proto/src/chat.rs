//! Groups, channels, messages, invites, emotes — the chat stack.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{AttachmentId, ChannelId, GroupId, MessageId, UnixMillis, UserId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum GroupRole {
    Admin,
    Member,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Group {
    pub id: GroupId,
    pub name: String,
    pub owner_id: UserId,
    pub my_role: GroupRole,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateGroupRequest {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Invite {
    pub code: String,
    #[ts(type = "number | null")]
    pub expires_at: Option<UnixMillis>,
    #[ts(type = "number | null")]
    pub max_uses: Option<i64>,
    #[ts(type = "number")]
    pub use_count: i64,
    pub revoked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateInviteRequest {
    /// Seconds until expiry; None = never expires.
    #[ts(type = "number | null")]
    pub expires_in_seconds: Option<i64>,
    #[ts(type = "number | null")]
    pub max_uses: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RedeemInviteRequest {
    pub code: String,
}

/// Lightweight user reference embedded in messages/member lists.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UserRef {
    pub id: UserId,
    pub username: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Member {
    pub user: UserRef,
    pub role: GroupRole,
    #[ts(type = "number")]
    pub joined_at: UnixMillis,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SetRoleRequest {
    pub role: GroupRole,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ChannelKind {
    Text,
    Session,
    Dm,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Channel {
    pub id: ChannelId,
    pub group_id: Option<GroupId>,
    pub kind: ChannelKind,
    pub name: Option<String>,
    #[ts(type = "number")]
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateChannelRequest {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AttachmentMeta {
    pub id: AttachmentId,
    pub mime: String,
    #[ts(type = "number")]
    pub byte_size: i64,
    pub original_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Message {
    pub id: MessageId,
    pub channel_id: ChannelId,
    pub author: UserRef,
    /// "text" | "shared_note" | "system" | "plugin:<id>:<type>"
    pub kind: String,
    pub content: Option<String>,
    pub reply_to_id: Option<MessageId>,
    pub attachments: Vec<AttachmentMeta>,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
    #[ts(type = "number | null")]
    pub edited_at: Option<UnixMillis>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SendMessageRequest {
    pub content: String,
    pub reply_to_id: Option<MessageId>,
    #[serde(default)]
    pub attachment_ids: Vec<AttachmentId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EditMessageRequest {
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Emote {
    #[ts(type = "number")]
    pub id: i64,
    pub group_id: GroupId,
    pub name: String,
    pub attachment_id: AttachmentId,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateEmoteRequest {
    pub name: String,
    pub attachment_id: AttachmentId,
}

/// Online user ids for a group (REST snapshot; deltas arrive via
/// `presence.update` WS events).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PresenceSnapshot {
    pub online: Vec<UserId>,
}
