import type { Editor } from "@tiptap/react";
import { BookmarkPlus, FileDiff, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";

import { confirmDialog, Modal } from "../../platform";
import { compactDocString } from "./compactJson";
import { applyRestore } from "./restore";
import {
  loadLocalVersion,
  localHistoryTrouble,
  onLocalHistoryChange,
  readLocalHistory,
  saveLocalVersion,
  type LocalVersionMeta,
} from "./history";
import { useLocalDocs } from "./local";
import { RevisionDiff, VersionList, VersionPreview, type VersionRow } from "./VersionHistoryPanel";

/** Document history for a document stored on this device. Same shape as the
 *  server panel minus the parts that need other people: no activity feed, no
 *  author column, and every revision is yours. */
export function LocalHistoryPanel({ docId, editor }: { docId: string; editor: Editor | null }) {
  const format = useLocalDocs((s) => s.items.find((d) => d.id === docId)?.format);
  const [versions, setVersions] = useState<LocalVersionMeta[]>([]);
  const [tab, setTab] = useState<"changes" | "drafts">("changes");
  const [preview, setPreview] = useState<{
    version: LocalVersionMeta;
    json: string;
    previous: string | null;
  } | null>(null);
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

  const row = (v: LocalVersionMeta): VersionRow => ({
    key: v.id,
    name: v.name,
    kind: v.kind,
    created_at: v.created_at,
    changed_blocks: v.changed_blocks,
    added_words: v.added_words,
    removed_words: v.removed_words,
  });

  const open = async (key: string, mode: "draft" | "change") => {
    const index = versions.findIndex((v) => v.id === key);
    if (index < 0) return;
    const version = versions[index];
    // Revisions are stored compressed; load the text (and, for a change, the
    // revision before it) only when one is opened.
    const json = await loadLocalVersion(docId, version.id);
    if (json === null) {
      setError("That revision couldn't be read.");
      return;
    }
    const before = versions[index + 1];
    const previous =
      mode === "change" && before ? await loadLocalVersion(docId, before.id) : null;
    // The whole text for a draft; only what this revision changed otherwise.
    setPreview({ version, json, previous });
  };

  const saveDraft = async () => {
    const name = naming.trim();
    if (!name || !editor) return;
    try {
      await saveLocalVersion(docId, compactDocString(editor.getJSON()), { name, kind: "draft" });
      setNaming("");
    } catch (e) {
      setError(String(e));
    }
  };

  const restore = async () => {
    if (!preview || !editor) return;
    const ok = await confirmDialog(
      "Replace the current text with this saved revision? Your current text is saved in Document history first.",
      { title: "Restore revision", confirmLabel: "Restore" },
    );
    if (!ok) return;
    try {
      // The current text is never lost to a restore.
      await saveLocalVersion(docId, compactDocString(editor.getJSON()), {
        name: "Before restoring",
        kind: "draft",
      });
      await applyRestore(editor, JSON.parse(preview.json));
      await saveLocalVersion(docId, preview.json, {
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
      {localHistoryTrouble(docId) && (
        <p className="wf-connect-error">
          New versions aren’t being saved — this device couldn’t write them. Your text itself is
          safe.
        </p>
      )}
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
            onOpen={(v) => void open(v.key, "draft")}
            empty="No draft milestones yet. Save First draft when the iteration is ready."
          />
        </>
      )}

      {tab === "changes" && (
        <VersionList
          versions={changes.map(row)}
          active={preview?.version.id}
          onOpen={(v) => void open(v.key, "change")}
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
              <VersionPreview json={preview.json} format={format} />
            ) : (
              <RevisionDiff before={preview.previous} after={preview.json} />
            )}
          </div>
        </Modal>
      )}
    </aside>
  );
}
