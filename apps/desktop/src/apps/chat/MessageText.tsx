import { useMemo } from "react";
import type { ReactNode } from "react";

import type { Emote } from "../../bindings/proto/Emote";
import { useChat } from "./store";

/**
 * Chat message renderer: Discord-like inline markdown plus custom emotes.
 * Supported: **bold**, *italic*, ~~strike~~, `code`, ```fenced blocks```,
 * [label](url), bare http(s) URLs, :emote:. Output is React nodes only —
 * no HTML injection surface.
 */

const attSrc = (attachmentId: number) => `writform-att://attachment/${attachmentId}`;

const INLINE_RE = new RegExp(
  [
    "(`[^`\\n]+`)", // 1 inline code
    "(\\*\\*[^*\\n]+\\*\\*)", // 2 bold
    "(\\*[^*\\n]+\\*)", // 3 italic
    "(~~[^~\\n]+~~)", // 4 strike
    "\\[([^\\]\\n]+)\\]\\((https?://[^\\s)]+)\\)", // 5 label, 6 url
    "(https?://[^\\s<>]+)", // 7 bare url
    ":([a-z0-9_]{1,32}):", // 8 emote name
  ].join("|"),
  "g",
);

function renderInline(
  text: string,
  emotes: Map<string, Emote>,
  keyBase: string,
): ReactNode[] {
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
  const emotes = useMemo(() => {
    const map = new Map<string, Emote>();
    for (const e of emoteList) map.set(e.name, e);
    return map;
  }, [emoteList]);

  const parts = useMemo(() => {
    const out: ReactNode[] = [];
    // Fenced code blocks first; everything between renders inline.
    const fence = /```(?:[a-z0-9]*\n)?([\s\S]*?)```/g;
    let last = 0;
    let n = 0;
    let m: RegExpExecArray | null;
    while ((m = fence.exec(text)) !== null) {
      if (m.index > last) out.push(...renderInline(text.slice(last, m.index), emotes, `s${n}`));
      out.push(
        <pre key={`f${n}`} className="wf-md-block">
          {m[1].replace(/\n$/, "")}
        </pre>,
      );
      last = m.index + m[0].length;
      n++;
    }
    if (last < text.length) out.push(...renderInline(text.slice(last), emotes, `s${n}`));
    return out;
  }, [text, emotes]);

  return <>{parts}</>;
}
