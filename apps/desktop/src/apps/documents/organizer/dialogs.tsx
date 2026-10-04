import { ArrowDown, ArrowUp, FileText, Folder, HardDrive, Server } from "lucide-react";
import { useState } from "react";

import type { DocumentFolder } from "../../../bindings/proto/DocumentFolder";
import { isCmdError, isWeb } from "../../../lib/backend";
import { Modal } from "../../../platform";
import { documentsApi } from "../api";
import { SharePicker } from "../SharePicker";
import { combineInto, type ItemRef } from "./actions";
import type { OrgItem } from "./model";

const message = (e: unknown) => (isCmdError(e) ? e.message : String(e));

/** Move one or more of your server documents into a folder (or out). */
export function MoveDialog({
  items,
  folders,
  onDone,
  onClose,
}: {
  items: OrgItem[];
  folders: DocumentFolder[];
  onDone: () => void;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const here = items.length === 1 ? items[0].folderId : undefined;
  const move = async (folderId: number | null) => {
    setBusy(true);
    setError(null);
    try {
      for (const item of items) await documentsApi.moveDocument(item.id as number, folderId);
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose}>
      <header className="wf-doc-panel-header">
        <h3>{items.length === 1 ? `Move “${items[0].title}”` : `Move ${items.length} documents`}</h3>
      </header>
      {error && <p className="wf-connect-error">{error}</p>}
      <ul className="wf-doc-share-list">
        <li>
          <button className="wf-doc-move-target" disabled={busy || here === null} onClick={() => void move(null)}>
            <FileText size={14} /> No folder
          </button>
        </li>
        {folders.map((f) => (
          <li key={f.id}>
            <button className="wf-doc-move-target" disabled={busy || here === f.id} onClick={() => void move(f.id)}>
              <Folder size={14} /> {f.name}
            </button>
          </li>
        ))}
        {folders.length === 0 && <li className="wf-friend-dim">No folders yet — create one from the toolbar.</li>}
      </ul>
    </Modal>
  );
}

/** Name something (a document, a folder, a new folder): one field, an
 *  inline error, Enter to save. */
export function NameDialog({
  title,
  initial,
  label,
  maxLength,
  onSave,
  onClose,
}: {
  title: string;
  initial: string;
  /** The save button. */
  label: string;
  maxLength: number;
  onSave: (name: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal onClose={onClose}>
      <header className="wf-doc-panel-header">
        <h3>{title}</h3>
      </header>
      <form
        className="wf-doc-panel-row"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n || busy) return;
          setBusy(true);
          setError(null);
          onSave(n)
            .then(onClose)
            .catch((err) => setError(message(err)))
            .finally(() => setBusy(false));
        }}
      >
        <input
          autoFocus
          value={name}
          maxLength={maxLength}
          aria-label={title}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="submit" className="wf-primary" disabled={!name.trim() || busy}>
          {label}
        </button>
      </form>
      {error && <p className="wf-connect-error">{error}</p>}
    </Modal>
  );
}

/** Share a document or every document in a folder, straight from the list. */
export function ListShareDialog({
  target,
  onClose,
}: {
  target: { kind: "document" | "folder"; id: number; name: string };
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <Modal onClose={onClose} className="wf-doc-share-modal">
      <header className="wf-doc-panel-header">
        <h3>
          Share {target.kind === "folder" ? "folder" : ""} “{target.name}”
        </h3>
      </header>
      {error && <p className="wf-connect-error">{error}</p>}
      {done && <p className="wf-doc-share-note">{done}</p>}
      <SharePicker
        onShare={async (subject_kind, subject_id, access) => {
          try {
            if (target.kind === "folder") {
              const shares = await documentsApi.shareFolder(target.id, { subject_kind, subject_id, access });
              setDone(`Shared ${shares.length} document${shares.length === 1 ? "" : "s"}.`);
            } else {
              await documentsApi.setShare(target.id, { subject_kind, subject_id, access });
              setDone("Shared.");
            }
            setError(null);
          } catch (e) {
            setError(message(e));
          }
        }}
      />
      {target.kind === "folder" && (
        <p className="wf-doc-share-note">
          Applies to the documents currently in the folder. Documents added later are not shared automatically.
        </p>
      )}
    </Modal>
  );
}

/**
 * Combine documents into one book manuscript: put them in order, name it,
 * choose whether each starts with its title as a chapter heading, and where
 * it lives. The originals stay as they are.
 */
export function CombineDialog({
  sources,
  defaultTitle,
  folderId,
  offline,
  onDone,
  onClose,
}: {
  sources: OrgItem[];
  defaultTitle: string;
  folderId: number | null;
  offline: boolean;
  onDone: (ref: ItemRef) => void;
  onClose: () => void;
}) {
  const [order, setOrder] = useState(sources);
  const [title, setTitle] = useState(defaultTitle);
  const [headings, setHeadings] = useState(true);
  const canServer = !offline;
  const canLocal = !isWeb;
  const [dest, setDest] = useState<"server" | "local">(
    canServer && (sources.some((s) => s.kind === "server") || !canLocal) ? "server" : "local",
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const swap = (i: number, j: number) => {
    if (j < 0 || j >= order.length) return;
    const next = order.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  };

  const run = async () => {
    setError(null);
    try {
      const ref = await combineInto(order, { title: title.trim() || "Manuscript", titleHeadings: headings, dest, folderId: dest === "server" ? folderId : null }, setBusy);
      onDone(ref);
    } catch (e) {
      setError(message(e));
      setBusy(null);
    }
  };

  return (
    <Modal onClose={() => !busy && onClose()} className="wf-combine-modal">
      <header className="wf-doc-panel-header">
        <h3>Combine into one manuscript</h3>
      </header>
      <p className="wf-combine-note">In this order — each becomes a chapter (or keeps its own headings). The originals don’t change.</p>
      <ol className="wf-combine-list">
        {order.map((s, i) => (
          <li key={s.key}>
            <span className="wf-combine-n">{i + 1}</span>
            <span className="wf-combine-title">
              {s.kind === "local" && <HardDrive size={13} />} {s.title || "Untitled"}
            </span>
            <button className="wf-icon" title="Move up" disabled={!!busy || i === 0} onClick={() => swap(i, i - 1)}>
              <ArrowUp size={14} />
            </button>
            <button className="wf-icon" title="Move down" disabled={!!busy || i === order.length - 1} onClick={() => swap(i, i + 1)}>
              <ArrowDown size={14} />
            </button>
          </li>
        ))}
      </ol>
      <label className="wf-combine-field">
        <span>Title</span>
        <input value={title} maxLength={200} disabled={!!busy} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="wf-inspector-check">
        <input type="checkbox" checked={headings} disabled={!!busy} onChange={(e) => setHeadings(e.target.checked)} />
        <span>Start each with its title as a chapter heading</span>
      </label>
      {canServer && canLocal && (
        <div className="wf-inspector-seg wf-combine-dest" role="radiogroup" aria-label="Where it’s saved">
          <button className={dest === "server" ? "active" : ""} disabled={!!busy} onClick={() => setDest("server")}>
            <Server size={13} /> On the server
          </button>
          <button className={dest === "local" ? "active" : ""} disabled={!!busy} onClick={() => setDest("local")}>
            <HardDrive size={13} /> On this device
          </button>
        </div>
      )}
      {error && <p className="wf-connect-error">{error}</p>}
      {busy && <p className="wf-export-progress">{busy}</p>}
      <div className="wf-connect-row wf-export-actions">
        <button onClick={onClose} disabled={!!busy}>
          Cancel
        </button>
        <button className="wf-primary" disabled={!!busy || order.length < 2 || (!canServer && dest === "server")} onClick={() => void run()}>
          {busy ? "Combining…" : "Combine"}
        </button>
      </div>
    </Modal>
  );
}
