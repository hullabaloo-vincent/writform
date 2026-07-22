import type { LinkPreview } from "../bindings/proto/LinkPreview";
import { backend, type CmdError } from "./backend";

/**
 * Server-fetched page metadata (`GET /api/v1/link-preview`), shared by canvas
 * link cards and chat message previews. One fetch per URL per session.
 */

const cache = new Map<string, Promise<LinkPreview>>();

export function fetchLinkPreview(url: string): Promise<LinkPreview> {
  let p = cache.get(url);
  if (!p) {
    p = backend
      .apiFetch("GET", `/api/v1/link-preview?url=${encodeURIComponent(url)}`)
      .then((res) => {
        if (res.status >= 400) {
          const err = (res.body ?? {}) as Partial<CmdError>;
          throw {
            code: err.code ?? `http_${res.status}`,
            message: err.message ?? `request failed (${res.status})`,
          } satisfies CmdError;
        }
        return res.body as LinkPreview;
      });
    cache.set(url, p);
    // A failed fetch shouldn't poison the URL for the whole session.
    p.catch(() => cache.delete(url));
  }
  return p;
}

/** First http(s) URL in a message, if any — drives the chat preview card. */
export function firstUrl(text: string): string | null {
  const m = /https?:\/\/[^\s<>"')\]]+/.exec(text);
  return m ? m[0] : null;
}
