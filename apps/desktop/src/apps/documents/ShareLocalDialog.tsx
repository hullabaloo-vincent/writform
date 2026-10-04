import { yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import type { JSONContent } from "@tiptap/react";
import { useState } from "react";
import * as Y from "yjs";

import { backend, isCmdError } from "../../lib/backend";
import { Modal } from "../../platform";
import { documentsApi } from "./api";
import { b64decode } from "./collab";
import { createServerDocument } from "./import/importFile";
import { snapshotDocMaps, type DocMapsSnapshot } from "./docMaps";
import { activeLocalProvider } from "./local";
import { SharePicker } from "./SharePicker";
import { openServerDoc } from "./navigation";
import { useDocuments } from "./store";

/** One-way publish of a local document to the connected server, mirroring
 *  the import seed path: create → replay state chunks → snapshot, with
 *  delete-on-partial-failure. The local copy stays and does NOT live-sync
 *  to the published copy. */
export function ShareLocalDialog({
  meta,
  onClose,
}: {
  meta: { id: string; title: string; format: string };
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishedId, setPublishedId] = useState<number | null>(null);

  const loadContent = async (): Promise<{ content: JSONContent; maps: DocMapsSnapshot }> => {
    // Flush a live editor's debounce so the publish matches what's on screen.
    const prov = activeLocalProvider();
    if (prov && prov.id === meta.id) await prov.flush();
    const raw = await backend.localdocRead(meta.id);
    const file = JSON.parse(raw) as { state_b64?: string };
    const ydoc = new Y.Doc();
    try {
      if (file.state_b64) Y.applyUpdate(ydoc, b64decode(file.state_b64));
      let content = yDocToProsemirrorJSON(ydoc, "default") as JSONContent;
      if (!content.content || content.content.length === 0) {
        content = { type: "doc", content: [{ type: "paragraph" }] };
      }
      // Page settings and book details travel with the text.
      return { content, maps: snapshotDocMaps(ydoc) };
    } finally {
      ydoc.destroy();
    }
  };

  /** Create the server copy; returns its id. Rolls back on partial failure. */
  const publish = async (): Promise<number> => {
    const { content, maps } = await loadContent();
    const doc = await createServerDocument(meta.title, meta.format, content, maps, "Shared from this device");
    // The new server copy belongs in the list right away.
    const docs = useDocuments.getState();
    if (docs.loaded) void docs.load().catch(() => {});
    return doc.id;
  };

  const run = async (after?: (docId: number) => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      const docId = publishedId ?? (await publish());
      setPublishedId(docId);
      if (after) await after(docId);
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} className="wf-doc-share-modal">
      <header className="wf-doc-panel-header">
        <h3>Share “{meta.title}” to the server</h3>
      </header>
      {error && (
        <p className="wf-connect-error" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      {publishedId === null ? (
        <>
          <p className="wf-doc-share-note">
            Publishes a copy to the server you’re connected to. Your local document stays on
            this device, and later local edits do <strong>not</strong> sync to the published
            copy.
          </p>
          <SharePicker
            submitLabel={busy ? "Publishing…" : "Publish + share"}
            onShare={(subject_kind, subject_id, access) =>
              run(async (docId) => {
                await documentsApi.setShare(docId, { subject_kind, subject_id, access });
              })
            }
          />
          <div className="wf-connect-row" style={{ justifyContent: "flex-start" }}>
            <button disabled={busy} onClick={() => void run()}>
              {busy ? "Publishing…" : "Publish without sharing"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="wf-doc-share-note">Published ✓ — the server copy now exists.</p>
          <div className="wf-connect-row" style={{ justifyContent: "flex-start" }}>
            <button
              className="wf-primary"
              onClick={() => {
                const id = publishedId;
                onClose();
                void openServerDoc(id).catch(() => {});
              }}
            >
              Open server copy
            </button>
            <button onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </Modal>
  );
}
