import type { JSONContent } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { BookmarkPlus, Clock3, FileDiff, RotateCcw, X } from "lucide-react";
import { useState } from "react";

import type { DocumentActivity } from "../../bindings/proto/DocumentActivity";
import type { DocumentVersionMeta } from "../../bindings/proto/DocumentVersionMeta";
import { RichDoc } from "../../editor/RichEditor";
import { isCmdError } from "../../lib/backend";
import { confirmDialog, Modal } from "../../platform";
import { documentsApi } from "./api";
import { useDocuments } from "./store";

type HistoryTab = "drafts" | "changes" | "activity";
interface Preview {
  meta: DocumentVersionMeta;
  json: string;
  previous: string | null;
  mode: "draft" | "change";
}

export function VersionHistoryPanel({ editor }: { editor: Editor | null }) {
  const versions = useDocuments((s) => s.versions);
  const activities = useDocuments((s) => s.activities);
  const myAccess = useDocuments((s) => s.myAccess);
  const docId = useDocuments((s) => s.activeDocId);
  const refreshVersions = useDocuments((s) => s.refreshVersions);
  const refreshActivity = useDocuments((s) => s.refreshActivity);
  const canWrite = myAccess === "owner" || myAccess === "write";
  const drafts = versions.filter((v) => v.kind === "draft");
  const changes = versions.filter((v) => v.kind !== "draft");

  const [tab, setTab] = useState<HistoryTab>("changes");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [naming, setNaming] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (docId === null) return null;

  const openPreview = async (meta: DocumentVersionMeta, mode: Preview["mode"]) => {
    try {
      const full = await documentsApi.version(docId, meta.id);
      let previous: string | null = null;
      if (mode === "change") {
        const index = versions.findIndex((v) => v.id === meta.id);
        const older = index >= 0 ? versions[index + 1] : undefined;
        if (older) previous = (await documentsApi.version(docId, older.id)).doc_json;
      }
      setPreview({ meta, json: full.doc_json, previous, mode });
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
    }
  };

  const restore = async () => {
    if (!preview || !editor || !canWrite) return;
    const ok = await confirmDialog(
      "Replace the current text with this saved draft? Everyone editing will see the change.",
      { title: "Restore draft", confirmLabel: "Restore" },
    );
    if (!ok) return;
    try {
      editor.commands.setContent(JSON.parse(preview.json));
      const label = `Restored ${preview.meta.name ?? "saved revision"}`;
      await documentsApi.snapshot(docId, preview.json, label.slice(0, 120), "named");
      await Promise.all([refreshVersions(), refreshActivity()]);
      setPreview(null);
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
    }
  };

  const saveDraft = async () => {
    const name = naming.trim();
    if (!name || !editor) return;
    try {
      await documentsApi.snapshot(docId, JSON.stringify(editor.getJSON()), name, "draft");
      setNaming("");
      await Promise.all([refreshVersions(), refreshActivity()]);
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
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
        <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>
          <Clock3 size={14} /> Activity
        </button>
      </nav>
      {error && <p className="wf-connect-error" onClick={() => setError(null)}>{error}</p>}

      {tab === "drafts" && (
        <>
          {canWrite && (
            <form className="wf-doc-panel-row" onSubmit={(e) => { e.preventDefault(); void saveDraft(); }}>
              <input
                placeholder={drafts.length === 0 ? "First draft" : "Second draft, polish pass…"}
                value={naming}
                maxLength={120}
                onChange={(e) => setNaming(e.target.value)}
              />
              <button className="wf-icon" type="submit" title="Save current text as a draft" disabled={!naming.trim()}>
                <BookmarkPlus size={15} />
              </button>
            </form>
          )}
          <VersionList versions={drafts} active={preview?.meta.id} onOpen={(v) => void openPreview(v, "draft")} empty="No draft milestones yet. Save First draft when the iteration is ready." />
        </>
      )}

      {tab === "changes" && (
        <VersionList versions={changes} active={preview?.meta.id} onOpen={(v) => void openPreview(v, "change")} empty="No changes recorded yet — they appear as you write." />
      )}

      {tab === "activity" && <ActivityList items={activities} />}

      {preview && (
        <Modal onClose={() => setPreview(null)} className="wf-doc-version-modal">
          <header className="wf-doc-panel-header">
            <div>
              <h3>{preview.meta.name ?? new Date(preview.meta.created_at).toLocaleString()}</h3>
              {preview.mode === "change" && <span className="wf-doc-version-meta">Only changes from the previous save are shown</span>}
            </div>
            <span className="wf-statusbar-spacer" />
            {canWrite && <button onClick={() => void restore()}><RotateCcw size={15} /> Restore</button>}
            <button className="wf-icon" title="Close" onClick={() => setPreview(null)}><X size={15} /></button>
          </header>
          <div className="wf-doc-version-preview">
            {preview.mode === "draft" ? <RichDoc doc={JSON.parse(preview.json)} /> : <RevisionDiff before={preview.previous} after={preview.json} />}
          </div>
        </Modal>
      )}
    </aside>
  );
}

function VersionList({ versions, active, onOpen, empty }: { versions: DocumentVersionMeta[]; active?: number; onOpen: (version: DocumentVersionMeta) => void; empty: string }) {
  return (
    <ul className="wf-doc-versions">
      {versions.map((v) => (
        <li key={v.id}>
          <button className={`wf-doc-version ${active === v.id ? "active" : ""}`} onClick={() => onOpen(v)}>
            <span className="wf-doc-version-name">{v.name ?? new Date(v.created_at).toLocaleString()}</span>
            <span className="wf-doc-version-meta">
              {v.kind === "draft" ? <span className="wf-doc-version-badge">draft</span> : <span>{v.changed_blocks} blocks · +{v.added_words} / -{v.removed_words} words</span>}
              {v.created_by.display_name ?? v.created_by.username} · {new Date(v.created_at).toLocaleString()}
            </span>
          </button>
        </li>
      ))}
      {versions.length === 0 && <li className="wf-friend-dim">{empty}</li>}
    </ul>
  );
}

function ActivityList({ items }: { items: DocumentActivity[] }) {
  return (
    <ol className="wf-doc-activity">
      {items.map((item) => {
        const actor = item.actor.display_name ?? item.actor.username;
        const subject = item.subject_name ? ` ${item.subject_name}` : "";
        const text = item.kind === "opened" ? `${actor} opened this document`
          : item.kind === "shared" ? `${actor} shared it with${subject}`
          : item.kind === "share_updated" ? `${actor} changed access for${subject} to ${item.detail ?? ""}`
          : item.kind === "unshared" ? `${actor} removed access for${subject}`
          : item.kind === "draft_saved" ? `${actor} saved ${item.subject_name ?? "a draft"}`
          : `${actor} ${item.kind.replace(/_/g, " ")}`;
        return <li key={item.id}><span>{text}</span><time>{new Date(item.created_at).toLocaleString()}</time></li>;
      })}
      {items.length === 0 && <li className="wf-friend-dim">No activity recorded yet.</li>}
    </ol>
  );
}

interface FlatBlock { type: string; element: string; text: string }
function flatten(raw: string | null): FlatBlock[] {
  if (!raw) return [];
  const doc = JSON.parse(raw) as JSONContent;
  const read = (node: JSONContent): string => `${node.text ?? ""}${(node.content ?? []).map(read).join("")}`;
  return (doc.content ?? []).map((node) => ({ type: node.type ?? "paragraph", element: String(node.attrs?.element ?? ""), text: read(node) }));
}

interface AlignedBlock { oldBlock?: FlatBlock; newBlock?: FlatBlock; index: number }

function blockKey(block: FlatBlock): string {
  return JSON.stringify([block.type, block.element, block.text]);
}

function positionsFor(blocks: FlatBlock[]): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  blocks.forEach((block, index) => {
    const key = blockKey(block);
    const matches = positions.get(key) ?? [];
    matches.push(index);
    positions.set(key, matches);
  });
  return positions;
}

function nextPosition(positions: Map<string, number[]>, block: FlatBlock, from: number): number | undefined {
  return positions.get(blockKey(block))?.find((position) => position >= from);
}

function alignChanges(oldBlocks: FlatBlock[], newBlocks: FlatBlock[]): AlignedBlock[] {
  const oldPositions = positionsFor(oldBlocks);
  const newPositions = positionsFor(newBlocks);
  const changes: AlignedBlock[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldBlocks.length && newIndex < newBlocks.length) {
    if (blockKey(oldBlocks[oldIndex]) === blockKey(newBlocks[newIndex])) {
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    const insertedUntil = nextPosition(newPositions, oldBlocks[oldIndex], newIndex + 1);
    const deletedUntil = nextPosition(oldPositions, newBlocks[newIndex], oldIndex + 1);
    const preferInsert = insertedUntil !== undefined
      && (deletedUntil === undefined || insertedUntil - newIndex <= deletedUntil - oldIndex);

    if (preferInsert) {
      while (newIndex < insertedUntil) {
        changes.push({ newBlock: newBlocks[newIndex], index: newIndex });
        newIndex += 1;
      }
    } else if (deletedUntil !== undefined) {
      while (oldIndex < deletedUntil) {
        changes.push({ oldBlock: oldBlocks[oldIndex], index: oldIndex });
        oldIndex += 1;
      }
    } else {
      changes.push({ oldBlock: oldBlocks[oldIndex], newBlock: newBlocks[newIndex], index: newIndex });
      oldIndex += 1;
      newIndex += 1;
    }
  }
  while (oldIndex < oldBlocks.length) {
    changes.push({ oldBlock: oldBlocks[oldIndex], index: oldIndex });
    oldIndex += 1;
  }
  while (newIndex < newBlocks.length) {
    changes.push({ newBlock: newBlocks[newIndex], index: newIndex });
    newIndex += 1;
  }
  return changes;
}

function RevisionDiff({ before, after }: { before: string | null; after: string }) {
  const oldBlocks = flatten(before);
  const newBlocks = flatten(after);
  const rows = alignChanges(oldBlocks, newBlocks).map(({ oldBlock, newBlock, index }, rowIndex) => (
      <article className="wf-doc-diff-block" key={`${index}-${rowIndex}`}>
        <span className="wf-doc-diff-label">{newBlock?.element || newBlock?.type || oldBlock?.element || oldBlock?.type || "block"} #{index + 1}</span>
        {oldBlock?.text && <p className="wf-doc-diff-removed"><del>{oldBlock.text}</del></p>}
        {newBlock?.text && <p className="wf-doc-diff-added"><ins>{newBlock.text}</ins></p>}
      </article>
  ));
  return <div className="wf-doc-diff">{rows.length ? rows : <p className="wf-friend-dim">No textual changes in this save.</p>}</div>;
}
