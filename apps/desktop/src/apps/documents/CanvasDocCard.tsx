import type { JSONContent } from "@tiptap/react";
import { FileText, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import * as Y from "yjs";

import { RichDoc } from "../../editor/RichEditor";
import { acquireReplica, b64decode, releaseReplica } from "./collab";
import { openDocumentById } from "./store";

/** Payload stored in a canvas `document` element's `text`. */
export interface DocRefPayload {
  document_id: number;
  mode: "doc" | "selection";
  anchor_b64?: string;
  head_b64?: string;
}

export function parseDocRef(text: string): DocRefPayload | null {
  try {
    const parsed = JSON.parse(text) as Partial<DocRefPayload>;
    if (typeof parsed.document_id !== "number") return null;
    return {
      document_id: parsed.document_id,
      mode: parsed.mode === "selection" ? "selection" : "doc",
      anchor_b64: parsed.anchor_b64,
      head_b64: parsed.head_b64,
    };
  } catch {
    return null;
  }
}

const MAX_BLOCKS = 8;

/**
 * Live excerpt of a referenced document on a canvas board. Opens a shared
 * read-only replica (refcounted per board), renders the whole doc's first
 * blocks or the anchored selection, and updates as co-editors type.
 */
export function CanvasDocCard({ payload }: { payload: string }) {
  const ref = parseDocRef(payload);
  const [state, setState] = useState<{
    title: string;
    doc: JSONContent | null;
    stale: boolean;
    locked: boolean;
  }>({ title: "Document", doc: null, stale: false, locked: false });

  const docId = ref?.document_id;
  useEffect(() => {
    if (docId === undefined) return;
    const { provider, opened } = acquireReplica(docId);
    let live = true;
    let title = "Document";

    const render = () => {
      if (!live) return;
      let json = yDocToProsemirrorJSON(provider.doc, "default") as JSONContent;
      let stale = false;
      const blocks = json.content ?? [];
      if (ref?.mode === "selection" && ref.anchor_b64 && ref.head_b64) {
        const range = resolveBlockRange(provider.doc, ref.anchor_b64, ref.head_b64);
        if (range) {
          json = { ...json, content: blocks.slice(range.start, range.end) };
        } else {
          json = { ...json, content: blocks.slice(0, MAX_BLOCKS) };
          stale = true;
        }
      } else {
        json = { ...json, content: blocks.slice(0, MAX_BLOCKS) };
      }
      setState({ title, doc: json, stale, locked: false });
    };

    opened
      .then((detail) => {
        title = detail.document.title;
        render();
      })
      .catch(() => {
        if (live) setState((s) => ({ ...s, locked: true }));
      });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        render();
      }, 250);
    };
    provider.doc.on("update", onUpdate);
    return () => {
      live = false;
      provider.doc.off("update", onUpdate);
      if (timer) clearTimeout(timer);
      releaseReplica(docId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, ref?.mode, ref?.anchor_b64, ref?.head_b64]);

  if (!ref) {
    return <div className="wf-doc-ref wf-doc-ref-locked">Broken document reference</div>;
  }
  if (state.locked) {
    return (
      <div className="wf-doc-ref wf-doc-ref-locked">
        <Lock size={14} /> A document you don't have access to
      </div>
    );
  }
  return (
    <div className="wf-doc-ref">
      <button
        className="wf-doc-ref-title"
        title="Open document"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => void openDocumentById(ref.document_id).catch(() => {})}
      >
        <FileText size={13} /> {state.title}
        {ref.mode === "selection" && <span className="wf-doc-ref-mode">excerpt</span>}
      </button>
      {state.stale && <span className="wf-doc-ref-stale">referenced text changed</span>}
      <div className="wf-doc-ref-body">
        {state.doc ? <RichDoc doc={state.doc} /> : <span className="wf-friend-dim">Loading…</span>}
      </div>
    </div>
  );
}

/** Resolve block-index anchors against the live doc. */
function resolveBlockRange(
  doc: Y.Doc,
  anchorB64: string,
  headB64: string,
): { start: number; end: number } | null {
  try {
    const relA = Y.decodeRelativePosition(b64decode(anchorB64));
    const relH = Y.decodeRelativePosition(b64decode(headB64));
    const a = Y.createAbsolutePositionFromRelativePosition(relA, doc);
    const h = Y.createAbsolutePositionFromRelativePosition(relH, doc);
    if (!a || !h) return null;
    const start = Math.min(a.index, h.index);
    const end = Math.max(a.index, h.index);
    if (end <= start) return null;
    return { start, end };
  } catch {
    return null;
  }
}
