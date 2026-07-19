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
  channels: (groupId: number) => api<Channel[]>("GET", `/api/v1/groups/${groupId}/channels`),
  createChannel: (groupId: number, name: string) =>
    api<Channel>("POST", `/api/v1/groups/${groupId}/channels`, { name }),
  members: (groupId: number) => api<Member[]>("GET", `/api/v1/groups/${groupId}/members`),
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
  sendMessage: (channelId: number, content: string, attachmentIds: number[] = []) =>
    api<Message>("POST", `/api/v1/channels/${channelId}/messages`, {
      content,
      reply_to_id: null,
      attachment_ids: attachmentIds,
    }),
  kick: (groupId: number, userId: number) =>
    api<null>("DELETE", `/api/v1/groups/${groupId}/members/${userId}`),
};
