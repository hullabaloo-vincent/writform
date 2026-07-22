import type { Channel } from "../../bindings/proto/Channel";
import type { Emote } from "../../bindings/proto/Emote";
import type { Group } from "../../bindings/proto/Group";
import type { Invite } from "../../bindings/proto/Invite";
import type { Member } from "../../bindings/proto/Member";
import type { Message } from "../../bindings/proto/Message";
import type { PresenceSnapshot } from "../../bindings/proto/PresenceSnapshot";
import { backend, type CmdError } from "../../lib/backend";

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await backend.apiFetch(method, path, body);
  if (res.status >= 400) {
    const err = (res.body ?? {}) as Partial<CmdError>;
    // A bodyless 405 means the route isn't in the running server's router:
    // this client is newer than the (manually updated) self-hosted server.
    if (res.status === 405 && !err.message) {
      throw {
        code: "server_outdated",
        message: "the server is running an older WritForm version that doesn't support this yet — ask the host to update writform-server",
      } satisfies CmdError;
    }
    throw {
      code: err.code ?? `http_${res.status}`,
      message: err.message ?? `request failed (${res.status})`,
    } satisfies CmdError;
  }
  return res.body as T;
}

export const chatApi = {
  myGroups: () => api<Group[]>("GET", "/api/v1/groups"),
  createGroup: (name: string) => api<Group>("POST", "/api/v1/groups", { name }),
  redeemInvite: (code: string) => api<Group>("POST", "/api/v1/invites/redeem", { code }),
  createInvite: (groupId: number) =>
    api<Invite>("POST", `/api/v1/groups/${groupId}/invites`, {
      expires_in_seconds: 24 * 3600,
      max_uses: null,
    }),
  updateGroup: (
    groupId: number,
    req: { name: string | null; icon_attachment_id: number | null; accent_color: string | null },
  ) => api<Group>("PATCH", `/api/v1/groups/${groupId}`, req),
  channels: (groupId: number) => api<Channel[]>("GET", `/api/v1/groups/${groupId}/channels`),
  createChannel: (groupId: number, name: string) =>
    api<Channel>("POST", `/api/v1/groups/${groupId}/channels`, { name }),
  updateChannel: (channelId: number, name: string) =>
    api<Channel>("PATCH", `/api/v1/channels/${channelId}`, { name }),
  deleteChannel: (channelId: number) => api<null>("DELETE", `/api/v1/channels/${channelId}`),
  members: (groupId: number) => api<Member[]>("GET", `/api/v1/groups/${groupId}/members`),
  react: (messageId: number, emoji: string) =>
    api<null>("POST", `/api/v1/messages/${messageId}/reactions`, { emoji }),
  unreact: (messageId: number, emoji: string) =>
    api<null>("DELETE", `/api/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`),
  presence: (groupId: number) =>
    api<PresenceSnapshot>("GET", `/api/v1/groups/${groupId}/presence`),
  emotes: (groupId: number) => api<Emote[]>("GET", `/api/v1/groups/${groupId}/emotes`),
  createEmote: (groupId: number, name: string, attachmentId: number) =>
    api<Emote>("POST", `/api/v1/groups/${groupId}/emotes`, {
      name,
      attachment_id: attachmentId,
    }),
  deleteEmote: (groupId: number, emoteId: number) =>
    api<null>("DELETE", `/api/v1/groups/${groupId}/emotes/${emoteId}`),
  messages: (channelId: number, before?: number) =>
    api<Message[]>(
      "GET",
      `/api/v1/channels/${channelId}/messages${before ? `?before=${before}` : ""}`,
    ),
  /** Catch-up after a socket outage: only messages newer than `after`. */
  messagesAfter: (channelId: number, after: number) =>
    api<Message[]>("GET", `/api/v1/channels/${channelId}/messages?after=${after}`),
  sendMessage: (
    channelId: number,
    content: string,
    attachmentIds: number[] = [],
    replyToId: number | null = null,
  ) =>
    api<Message>("POST", `/api/v1/channels/${channelId}/messages`, {
      content,
      reply_to_id: replyToId,
      attachment_ids: attachmentIds,
    }),
  editMessage: (messageId: number, content: string) =>
    api<Message>("PATCH", `/api/v1/messages/${messageId}`, { content }),
  kick: (groupId: number, userId: number) =>
    api<null>("DELETE", `/api/v1/groups/${groupId}/members/${userId}`),
  deleteMessage: (messageId: number) => api<null>("DELETE", `/api/v1/messages/${messageId}`),
};
