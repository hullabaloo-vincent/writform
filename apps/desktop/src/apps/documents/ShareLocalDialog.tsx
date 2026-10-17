import { yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import type { JSONContent } from "@tiptap/react";
import { useEffect, useState } from "react";
import * as Y from "yjs";

import type { DocumentListItem } from "../../bindings/proto/DocumentListItem";
import { backend, isCmdError } from "../../lib/backend";
import { Modal } from "../../platform";
import { toast } from "../../platform/toast";
import { useSession } from "../../stores/session";
import { documentsApi } from "./api";
import { b64decode } from "./collab";
import { createServerDocument } from "./import/importFile";
import { snapshotDocMaps, type DocMapsSnapshot } from "./docMaps";
import { activeLocalProvider, useLocalDocs } from "./local";
import { metaLine, serverItem } from "./organizer/model";
import { forgetPublished, notePublished, publishedCopy } from "./published";
import { SharePicker } from "./SharePicker";
import { openLocalDoc, openServerDoc } from "./navigation";
import { useDocuments } from "./store";
import { scopeOf } from "./sync/scope";

/**
 * Publishing a document on this device to the connected server, mirroring
 * the import seed path: create, replay state chunks, snapshot, with
 * delete-on-partial-failure. The copy here stays and does NOT live-sync to
 * the published one.
 *
 * One device document becomes ONE server document: once published, the
 * dialog opens on that one (published.ts), to share with more groups and
 * people, instead of making another copy for each. A document of the same
 * name already on the server is offered first too.
 */
type Phase =
  | { kind: "looking" }
  | { kind: "linked"; docId: number; fresh: boolean }
  | { kind: "same"; matches: DocumentListItem[] }
  | { kind: "publish" };

export function ShareLocalDialog({
  meta,
  onClose,
}: {
  meta: { id: string; title: string; format: string };
  onClose: () => void;
}) {
  const scope = useSession((s) => scopeOf(s));
  const [phase, setPhase] = useState<Phase>({ kind: "looking" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server can't hold this document's formatting (it hasn't been
  // updated): offered a copy without it, the writer said yes.
  const [tooOld, setTooOld] = useState(false);
  const [simplify, setSimplify] = useState(false);

  // Where this document already is on this server, if anywhere.
  useEffect(() => {
    if (!scope) return;
    let stopped = false;
    void (async () => {
      const docs = useDocuments.getState();
      if (!docs.loaded) await docs.load().catch(() => {});
      if (stopped) return;
      const mine = useDocuments.getState().items.filter((i) => i.my_access === "owner");
      const linked = publishedCopy(meta.id, scope);
      if (linked !== null && mine.some((i) => i.document.id === linked)) {
        setPhase({ kind: "linked", docId: linked, fresh: false });
        return;
      }
      if (linked !== null) forgetPublished(meta.id, scope);
      const name = meta.title.trim().toLowerCase();
      const matches = mine.filter((i) => i.document.format === meta.format && i.document.title.trim().toLowerCase() === name);
      setPhase(matches.length ? { kind: "same", matches } : { kind: "publish" });
    })();
    return () => {
      stopped = true;
    };
  }, [meta.id, meta.title, meta.format, scope]);

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

  /** Create the server copy and remember it; returns its id. Rolls back on
   *  partial failure. */
  const publish = async (): Promise<number> => {
    const { content, maps } = await loadContent();
    const doc = await createServerDocument(meta.title, meta.format, content, maps, "Shared from this device", { simplify });
    if (scope) notePublished(meta.id, scope, doc.id);
    // The new server copy belongs in the list right away.
    const docs = useDocuments.getState();
    if (docs.loaded) void docs.load().catch(() => {});
    return doc.id;
  };

  const run = async (after?: (docId: number) => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      const docId = await publish();
      if (after) await after(docId);
      setPhase({ kind: "linked", docId, fresh: true });
    } catch (e) {
      if (isCmdError(e) && e.code === "server_too_old") setTooOld(true);
      else setError(isCmdError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const useExisting = (docId: number) => {
    if (scope) notePublished(meta.id, scope, docId);
    setPhase({ kind: "linked", docId, fresh: false });
  };

  return (
    <Modal onClose={onClose} className="wf-doc-share-modal">
      <header className="wf-doc-panel-header">
        <h3>{phase.kind === "linked" ? `“${meta.title}” on this server` : `Publish “${meta.title}” to the server`}</h3>
      </header>
      {error && (
        <p className="wf-connect-error" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      {phase.kind === "looking" && <p className="wf-doc-share-note">Looking for it on the server…</p>}
      {phase.kind === "same" && (
        <SameName
          matches={phase.matches}
          title={meta.title}
          onUse={useExisting}
          onNew={() => setPhase({ kind: "publish" })}
        />
      )}
      {phase.kind === "linked" && (
        <Linked
          docId={phase.docId}
          fresh={phase.fresh}
          localId={meta.id}
          title={meta.title}
          onClose={onClose}
          onAnother={() => setPhase({ kind: "publish" })}
          onError={(e) => setError(isCmdError(e) ? e.message : String(e))}
        />
      )}
      {phase.kind === "publish" && (
        <>
          {tooOld && !simplify && (
            <div className="wf-doc-share-note" role="alert">
              <p>
                This server is running an older version of subScribe and can’t hold some of this
                document’s formatting: text colour and highlight, fonts and sizes on part of a
                paragraph, indents, borders, checklists, tables, footnotes, a table of contents,
                sections or suggested changes.
              </p>
              <p>
                You can publish a simplified copy now, or update the server and publish the
                document as it is. A simplified copy keeps every word and leaves that formatting
                out: a table becomes its cells’ paragraphs, a note sits in brackets where it’s
                cited and suggested changes are taken as accepted. The one on this
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
          {simplify && <p className="wf-doc-share-note">A simplified copy will be published. Choose who to share it with.</p>}
          <p className="wf-doc-share-note">
            Publishes a copy to the server you’re connected to. Your local document stays on
            this device, and later local edits do <strong>not</strong> sync to the published
            copy. Share the published one with as many groups and people as you like: it stays
            one document.
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
      )}
    </Modal>
  );
}

/** Documents of the same name and kind already on the server: share one of
 *  those instead of putting another there. */
function SameName({
  matches,
  title,
  onUse,
  onNew,
}: {
  matches: DocumentListItem[];
  title: string;
  onUse: (docId: number) => void;
  onNew: () => void;
}) {
  return (
    <>
      <p className="wf-doc-share-note">
        You already have {matches.length === 1 ? "a document" : `${matches.length} documents`} called “{title}” on this
        server. Share {matches.length === 1 ? "it" : "one of them"} instead of putting another copy there.
      </p>
      <ul className="wf-publish-same">
        {matches.map((m) => {
          const item = serverItem(m);
          return (
            <li key={m.document.id}>
              <span>
                <strong>{m.document.title}</strong>
                <small>
                  {metaLine(item)}
                  {item.sharedWith.length > 0 && ` · shared with ${item.sharedWith.join(", ")}`}
                </small>
              </span>
              <button type="button" onClick={() => onUse(m.document.id)}>
                Use this one
              </button>
            </li>
          );
        })}
      </ul>
      <div className="wf-connect-row" style={{ justifyContent: "flex-start" }}>
        <button type="button" onClick={onNew}>
          Put a new copy on the server
        </button>
      </div>
    </>
  );
}

/** The server copy: who it's shared with, sharing it with more, opening
 *  it, and leaving only it. */
function Linked({
  docId,
  fresh,
  localId,
  title,
  onClose,
  onAnother,
  onError,
}: {
  docId: number;
  fresh: boolean;
  localId: string;
  title: string;
  onClose: () => void;
  onAnother: () => void;
  onError: (e: unknown) => void;
}) {
  const [names, setNames] = useState<string[] | null>(null);
  const reload = () =>
    void documentsApi
      .shares(docId)
      .then((shares) => setNames(shares.map((s) => s.subject_name)))
      .catch(() => setNames([]));
  useEffect(reload, [docId]);

  const open = () => {
    onClose();
    void openServerDoc(docId).catch(() => {});
  };
  // Only the server copy left: the one here goes to Recently Deleted.
  const keepOnlyServer = () => {
    void useLocalDocs
      .getState()
      .remove(localId)
      .then(() => {
        toast(`Moved “${title}” on this device to Recently Deleted.`, "info", {
          durationMs: 8000,
          action: {
            label: "Undo",
            run: () =>
              void useLocalDocs
                .getState()
                .restore(localId)
                .then(() => openLocalDoc(localId))
                .catch(() => {}),
          },
        });
        open();
      })
      .catch(onError);
  };

  return (
    <>
      <p className="wf-doc-share-note">
        {fresh ? "Published. " : ""}This is the one copy to share. It is on every device where you sign in to this server,
        and everyone you share it with sees the same document as it changes.
      </p>
      <p className="wf-doc-share-note">
        {names === null ? "…" : names.length ? `Shared with ${names.join(", ")}.` : "Not shared with anyone yet."}
      </p>
      <SharePicker
        submitLabel="Share"
        onShare={(subject_kind, subject_id, access) =>
          documentsApi
            .setShare(docId, { subject_kind, subject_id, access })
            .then(() => {
              reload();
              const docs = useDocuments.getState();
              if (docs.loaded) void docs.load().catch(() => {});
            })
            .catch(onError)
        }
      />
      <div className="wf-connect-row" style={{ justifyContent: "flex-start" }}>
        <button className="wf-primary" onClick={open}>
          Open it
        </button>
        <button onClick={onClose}>Done</button>
      </div>
      <div className="wf-publish-device">
        <p>
          The document on this device is separate from it. What you write here does not reach the server copy.
        </p>
        <button type="button" onClick={keepOnlyServer}>
          Keep only the server copy
        </button>
        <button type="button" className="wf-link-button" onClick={onAnother}>
          Put another copy on the server
        </button>
      </div>
    </>
  );
}
