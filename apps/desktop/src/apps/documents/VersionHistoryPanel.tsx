import type { Editor } from "@tiptap/react";
import { BookmarkPlus, RotateCcw, X } from "lucide-react";
import { useState } from "react";

import type { DocumentVersionMeta } from "../../bindings/proto/DocumentVersionMeta";
import { RichDoc } from "../../editor/RichEditor";
import { isCmdError } from "../../lib/backend";
import { confirmDialog } from "../../platform";
import { documentsApi } from "./api";
import { useDocuments } from "./store";

export function VersionHistoryPanel({ editor }: { editor: Editor | null }) {
  const versions = useDocuments((s) => s.versions);
  const myAccess = useDocuments((s) => s.myAccess);
  const docId = useDocuments((s) => s.activeDocId);
  const refreshVersions = useDocuments((s) => s.refreshVersions);
  const canWrite = myAccess === "owner" || myAccess === "write";

  const [preview, setPreview] = useState<{ meta: DocumentVersionMeta; json: string } | null>(
    null,
  );
  const [naming, setNaming] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (docId === null) return null;

  const openPreview = async (meta: DocumentVersionMeta) => {
    try {
      const full = await documentsApi.version(docId, meta.id);
      setPreview({ meta, json: full.doc_json });
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
    }
  };

  const restore = async () => {
    if (!preview || !editor || !canWrite) return;
    const ok = await confirmDialog(
      "Replace the current text with this version? Everyone editing sees the change (and can undo it).",
      { title: "Restore version", confirmLabel: "Restore" },
    );
    if (!ok) return;
    try {
      // One transaction through the collaborative doc — history stays linear
      // and co-editors converge on the restored content.
      editor.commands.setContent(JSON.parse(preview.json));
      const label = `Restored from ${new Date(preview.meta.created_at).toLocaleString()}`;
      await documentsApi.snapshot(docId, preview.json, label.slice(0, 120));
      await refreshVersions();
      setPreview(null);
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
    }
  };

  const nameVersion = async () => {
    const name = naming.trim();
    if (!name || !editor) return;
    try {
      await documentsApi.snapshot(docId, JSON.stringify(editor.getJSON()), name);
      setNaming("");
      await refreshVersions();
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
    }
  };

  return (
    <aside className="wf-doc-panel">
      <header className="wf-doc-panel-header">
        <h3>Version history</h3>
      </header>
      {error && (
        <p className="wf-connect-error" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      {canWrite && (
        <form
          className="wf-doc-panel-row"
          onSubmit={(e) => {
            e.preventDefault();
            void nameVersion();
          }}
        >
          <input
            placeholder="Name this version…"
            value={naming}
            maxLength={120}
            onChange={(e) => setNaming(e.target.value)}
          />
          <button type="submit" title="Save named version" disabled={!naming.trim()}>
            <BookmarkPlus size={15} />
          </button>
        </form>
      )}
      <ul className="wf-doc-versions">
        {versions.map((v) => (
          <li key={v.id}>
            <button
              className={`wf-doc-version ${preview?.meta.id === v.id ? "active" : ""}`}
              onClick={() => void openPreview(v)}
            >
              <span className="wf-doc-version-name">
                {v.name ?? new Date(v.created_at).toLocaleString()}
              </span>
              <span className="wf-doc-version-meta">
                {v.kind === "named" && <span className="wf-doc-version-badge">named</span>}
                {v.created_by.display_name ?? v.created_by.username}
                {v.name ? ` · ${new Date(v.created_at).toLocaleString()}` : ""}
              </span>
            </button>
          </li>
        ))}
        {versions.length === 0 && (
          <li className="wf-friend-dim">No versions yet — they appear as you write.</li>
        )}
      </ul>

      {preview && (
        <div className="wf-modal-backdrop" onClick={() => setPreview(null)}>
          <div className="wf-modal wf-doc-version-modal" onClick={(e) => e.stopPropagation()}>
            <header className="wf-doc-panel-header">
              <h3>{preview.meta.name ?? new Date(preview.meta.created_at).toLocaleString()}</h3>
              <span className="wf-statusbar-spacer" />
              {canWrite && (
                <button onClick={() => void restore()}>
                  <RotateCcw size={15} /> Restore
                </button>
              )}
              <button onClick={() => setPreview(null)}>
                <X size={15} />
              </button>
            </header>
            <div className="wf-doc-version-preview">
              <RichDoc doc={JSON.parse(preview.json)} />
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
