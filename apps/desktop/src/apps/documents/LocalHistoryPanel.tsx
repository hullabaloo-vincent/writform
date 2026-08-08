import type { Editor } from "@tiptap/react";
import { BookmarkPlus, FileDiff, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";

import { RichDoc } from "../../editor/RichEditor";
import { confirmDialog, Modal } from "../../platform";
import {
  onLocalHistoryChange,
  readLocalHistory,
  saveLocalVersion,
  type LocalVersion,
} from "./history";
import { RevisionDiff, VersionList, type VersionRow } from "./VersionHistoryPanel";

/** Document history for a document stored on this device. Same shape as the
 *  server panel minus the parts that need other people: no activity feed, no
 *  author column, and every revision is yours. */
export function LocalHistoryPanel({ docId, editor }: { docId: string; editor: Editor | null }) {
  const [versions, setVersions] = useState<LocalVersion[]>([]);
  const [tab, setTab] = useState<"changes" | "drafts">("changes");
  const [preview, setPreview] = useState<{ version: LocalVersion; previous: string | null } | null>(
    null,
  );
  const [naming, setNaming] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void readLocalHistory(docId)
        .then((list) => {
          if (alive) setVersions(list);
        })
        .catch(() => {});
    load();
    const off = onLocalHistoryChange((id) => {
      if (id === docId) load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [docId]);

  const drafts = versions.filter((v) => v.kind === "draft");
  const changes = versions.filter((v) => v.kind !== "draft");

  const row = (v: LocalVersion): VersionRow => ({
    key: v.id,
    name: v.name,
    kind: v.kind,
    created_at: v.created_at,
    changed_blocks: v.changed_blocks,
    added_words: v.added_words,
    removed_words: v.removed_words,
  });

  const open = (key: string, mode: "draft" | "change") => {
    const index = versions.findIndex((v) => v.id === key);
    if (index < 0) return;
    setPreview({
      version: versions[index],
      // The whole text for a draft; only what this revision changed otherwise.
      previous: mode === "change" ? (versions[index + 1]?.doc_json ?? null) : null,
    });
  };

  const saveDraft = async () => {
    const name = naming.trim();
    if (!name || !editor) return;
    try {
      await saveLocalVersion(docId, JSON.stringify(editor.getJSON()), { name, kind: "draft" });
      setNaming("");
    } catch (e) {
      setError(String(e));
    }
  };

  const restore = async () => {
    if (!preview || !editor) return;
    const ok = await confirmDialog("Replace the current text with this saved revision?", {
      title: "Restore revision",
      confirmLabel: "Restore",
    });
    if (!ok) return;
    try {
      editor.commands.setContent(JSON.parse(preview.version.doc_json));
      await saveLocalVersion(docId, preview.version.doc_json, {
        name: `Restored ${preview.version.name ?? new Date(preview.version.created_at).toLocaleString()}`.slice(0, 120),
        kind: "draft",
      });
      setPreview(null);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <aside className="wf-doc-panel wf-doc-history-panel">
      <header className="wf-doc-panel-header">
        <h3>Document history</h3>
      </header>
      <nav className="wf-doc-history-tabs" aria-label="Document history sections">
        <button className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
          <FileDiff size={14} /> Changes
        </button>
        <button className={tab === "drafts" ? "active" : ""} onClick={() => setTab("drafts")}>
          <BookmarkPlus size={14} /> Drafts
        </button>
      </nav>
      {error && (
        <p className="wf-connect-error" onClick={() => setError(null)}>
          {error}
        </p>
      )}

      {tab === "drafts" && (
        <>
          <form
            className="wf-doc-panel-row"
            onSubmit={(e) => {
              e.preventDefault();
              void saveDraft();
            }}
          >
            <input
              placeholder={drafts.length === 0 ? "First draft" : "Second draft, polish pass…"}
              value={naming}
              maxLength={120}
              onChange={(e) => setNaming(e.target.value)}
            />
            <button
              className="wf-icon"
              type="submit"
              title="Save current text as a draft"
              disabled={!naming.trim()}
            >
              <BookmarkPlus size={15} />
            </button>
          </form>
          <VersionList
            versions={drafts.map(row)}
            active={preview?.version.id}
            onOpen={(v) => open(v.key, "draft")}
            empty="No draft milestones yet. Save First draft when the iteration is ready."
          />
        </>
      )}

      {tab === "changes" && (
        <VersionList
          versions={changes.map(row)}
          active={preview?.version.id}
          onOpen={(v) => open(v.key, "change")}
          empty="No changes recorded yet — one is saved each time you pause."
        />
      )}

      {preview && (
        <Modal onClose={() => setPreview(null)} className="wf-doc-version-modal">
          <header className="wf-doc-panel-header">
            <div>
              <h3>{preview.version.name ?? new Date(preview.version.created_at).toLocaleString()}</h3>
              {preview.previous !== null && (
                <span className="wf-doc-version-meta">
                  Only changes from the previous save are shown
                </span>
              )}
            </div>
            <span className="wf-statusbar-spacer" />
            <button onClick={() => void restore()}>
              <RotateCcw size={15} /> Restore
            </button>
            <button className="wf-icon" title="Close" onClick={() => setPreview(null)}>
              <X size={15} />
            </button>
          </header>
          <div className="wf-doc-version-preview">
            {preview.previous === null ? (
              <RichDoc doc={JSON.parse(preview.version.doc_json)} />
            ) : (
              <RevisionDiff before={preview.previous} after={preview.version.doc_json} />
            )}
          </div>
        </Modal>
      )}
    </aside>
  );
}
