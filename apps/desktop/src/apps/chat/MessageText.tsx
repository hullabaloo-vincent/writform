import { useMemo } from "react";
import type { ReactNode } from "react";

import type { Channel } from "../../bindings/proto/Channel";
import type { Emote } from "../../bindings/proto/Emote";
import { attachmentUrl } from "../../lib/backend";
import { useSession } from "../../stores/session";
import { useChat } from "./store";

/**
 * Chat message renderer: Discord-like inline markdown plus custom emotes,
 * @user mentions, and #channel references.
 * Supported: **bold**, *italic*, ~~strike~~, `code`, ```fenced blocks```,
 * [label](url), bare http(s) URLs, :emote:, @username, #channel. Output is
 * React nodes only — no HTML injection surface.
 */

const attSrc = (attachmentId: number) => attachmentUrl(attachmentId);

const INLINE_RE = new RegExp(
  [
    "(`[^`\\n]+`)", // 1 inline code
    "(\\*\\*[^*\\n]+\\*\\*)", // 2 bold
    "(\\*[^*\\n]+\\*)", // 3 italic
    "(~~[^~\\n]+~~)", // 4 strike
    "\\[([^\\]\\n]+)\\]\\((https?://[^\\s)]+)\\)", // 5 label, 6 url
    "(https?://[^\\s<>]+)", // 7 bare url
    ":([a-z0-9_]{1,32}):", // 8 emote name
    "(?<=^|[^A-Za-z0-9_-])@([A-Za-z0-9_-]{3,32})", // 9 @mention
    "(?<=^|\\s)#([a-z0-9][a-z0-9_-]{0,31})", // 10 #channel
  ].join("|"),
  "g",
);

interface RenderCtx {
  emotes: Map<string, Emote>;
  channels: Channel[];
  myUsername: string | null;
  selectChannel: (id: number) => void;
}

function renderInline(text: string, ctx: RenderCtx, keyBase: string): ReactNode[] {
  const { emotes } = ctx;
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    const key = `${keyBase}-${n++}`;
    let node: ReactNode = null;
    if (m[1]) node = <code key={key}>{m[1].slice(1, -1)}</code>;
    else if (m[2]) node = <strong key={key}>{m[2].slice(2, -2)}</strong>;
    else if (m[3]) node = <em key={key}>{m[3].slice(1, -1)}</em>;
    else if (m[4]) node = <del key={key}>{m[4].slice(2, -2)}</del>;
    else if (m[5] && m[6]) {
      node = (
        <a key={key} href={m[6]} target="_blank" rel="noreferrer">
          {m[5]}
        </a>
      );
    } else if (m[7]) {
      node = (
        <a key={key} href={m[7]} target="_blank" rel="noreferrer">
          {m[7]}
        </a>
      );
    } else if (m[8]) {
      const emote = emotes.get(m[8]);
      if (!emote) continue; // unknown :name: stays literal text
      node = (
        <img
          key={key}
          className="wf-emote"
          src={attSrc(emote.attachment_id)}
          alt={`:${emote.name}:`}
          title={`:${emote.name}:`}
        />
      );
    } else if (m[9]) {
      const isMe =
        ctx.myUsername !== null && m[9].toLowerCase() === ctx.myUsername.toLowerCase();
      node = (
        <span key={key} className={`wf-mention ${isMe ? "me" : ""}`}>
          @{m[9]}
        </span>
      );
    } else if (m[10]) {
      const chanName = m[10];
      const channel = ctx.channels.find((c) => c.name === chanName);
      if (!channel) continue; // not a real channel — leave as text
      node = (
        <button
          key={key}
          className="wf-channel-ref"
          title={`Go to #${channel.name}`}
          onClick={() => ctx.selectChannel(channel.id)}
        >
          #{channel.name}
        </button>
      );
    }
    if (node === null) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(node);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MessageText({ text }: { text: string }) {
  const emoteList = useChat((s) => s.emotes);
  const channels = useChat((s) => s.channels);
  const selectChannel = useChat((s) => s.selectChannel);
  const myUsername = useSession((s) => s.session?.user.username ?? null);
  const emotes = useMemo(() => {
    const map = new Map<string, Emote>();
    for (const e of emoteList) map.set(e.name, e);
    return map;
  }, [emoteList]);

  const parts = useMemo(() => {
    const ctx: RenderCtx = {
      emotes,
      channels,
      myUsername,
      selectChannel: (id) => void selectChannel(id),
    };
    const out: ReactNode[] = [];
    // Fenced code blocks first; everything between renders inline.
    const fence = /```(?:[a-z0-9]*\n)?([\s\S]*?)```/g;
    let last = 0;
    let n = 0;
    let m: RegExpExecArray | null;
    while ((m = fence.exec(text)) !== null) {
      if (m.index > last) out.push(...renderInline(text.slice(last, m.index), ctx, `s${n}`));
      out.push(
        <pre key={`f${n}`} className="wf-md-block">
          {m[1].replace(/\n$/, "")}
        </pre>,
      );
      last = m.index + m[0].length;
      n++;
    }
    if (last < text.length) out.push(...renderInline(text.slice(last), ctx, `s${n}`));
    return out;
  }, [text, emotes, channels, myUsername, selectChannel]);

  return <>{parts}</>;
}
