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
    #[serde(default)]
    pub icon_attachment_id: Option<AttachmentId>,
    #[serde(default)]
    pub accent_color: Option<String>,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
}

/// `PATCH /api/v1/groups/{id}` (admin only). Icon/color are full replacement
/// (send the current value to keep it); name only changes when Some.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateGroupRequest {
    pub name: Option<String>,
    pub icon_attachment_id: Option<AttachmentId>,
    pub accent_color: Option<String>,
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
    #[serde(default)]
    pub avatar_attachment_id: Option<AttachmentId>,
    #[serde(default)]
    pub accent_color: Option<String>,
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
pub struct UpdateChannelRequest {
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
    /// Emoji reactions, grouped by emoji. Empty for most messages.
    #[serde(default)]
    pub reactions: Vec<MessageReaction>,
    #[ts(type = "number")]
    pub created_at: UnixMillis,
    #[ts(type = "number | null")]
    pub edited_at: Option<UnixMillis>,
}

/// One emoji's reaction tally on a message.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MessageReaction {
    pub emoji: String,
    #[ts(type = "number")]
    pub count: i64,
    /// Whether the requesting user is among the reactors.
    pub me: bool,
    /// Display names of reactors, for the hover tooltip (capped server-side).
    pub users: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReactRequest {
    pub emoji: String,
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
    /// Members with sockets and status "online" (hidden users never appear).
    pub online: Vec<UserId>,
    /// Members with sockets and status "busy".
    #[serde(default)]
    pub busy: Vec<UserId>,
}
