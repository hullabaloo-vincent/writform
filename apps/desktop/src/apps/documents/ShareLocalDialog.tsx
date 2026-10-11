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
  // The server can't hold this document's formatting (it hasn't been
  // updated): offered a copy without it, the writer said yes.
  const [tooOld, setTooOld] = useState(false);
  const [simplify, setSimplify] = useState(false);

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
    const doc = await createServerDocument(meta.title, meta.format, content, maps, "Shared from this device", { simplify });
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
      if (isCmdError(e) && e.code === "server_too_old") setTooOld(true);
      else setError(isCmdError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} className="wf-doc-share-modal">
      <header className="wf-doc-panel-header">
        <h3>Publish “{meta.title}” to the server</h3>
      </header>
      {error && (
        <p className="wf-connect-error" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      {tooOld && publishedId === null && !simplify && (
        <div className="wf-doc-share-note" role="alert">
          <p>
            This server is running an older version of subScribe and can’t hold some of this
            document’s formatting — text colour and highlight, fonts and sizes on part of a
            paragraph, indents, borders, checklists, tables, footnotes, a table of contents,
            sections or suggested changes.
          </p>
          <p>
            You can publish a simplified copy now (every word is kept — a table becomes its
            cells’ paragraphs, a note sits in brackets where it’s cited, suggested changes are
            taken as accepted — and that formatting is left out), or update the server and
            publish the document as it is. The one on this
            device isn’t changed either way.
          </p>
          <div className="wf-connect-row" style={{ justifyContent: "flex-start" }}>
            <button
              onClick={() => {
                setSimplify(true);
                setTooOld(false);
              }}
            >
              Publish a simplified copy
            </button>
          </div>
        </div>
      )}
      {simplify && publishedId === null && (
        <p className="wf-doc-share-note">A simplified copy will be published. Choose who to share it with.</p>
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
