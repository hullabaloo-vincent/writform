import { useState } from "react";

import { isCmdError, isWeb } from "../../lib/backend";
import { Modal } from "../../platform/Modal";
import { useSession } from "../../stores/session";
import { documentsApi } from "./api";
import { FORMAT_LABELS } from "./formats/elements";
import { useLocalDocs } from "./local";
import { openLocalDoc, openServerDoc } from "./navigation";

const FORMAT_HINTS: Record<string, string> = {
  none: "Letters, essays and reports on a page you format yourself",
  manuscript: "A book whose chapters and scenes are typeset for you",
  screenplay: "Scene headings, action, dialogue",
  stageplay: "Acts, scenes, stage directions",
  poetry: "Lines and stanzas set as you break them",
};

/**
 * A new document: what to call it, what kind it is, and where it lives —
 * on this device, or on the server you're connected to. Templates will
 * hang off the same dialog.
 */
export function NewDocumentDialog({
  onClose,
  onCreated,
  folderId,
  localFolderId,
}: {
  onClose: () => void;
  /** Called once the document is open. */
  onCreated?: (note: string | null) => void;
  /** A server folder to put it in. */
  folderId?: number | null;
  /** A folder on this device to put it in (and the reason it starts there). */
  localFolderId?: string | null;
}) {
  const connected = useSession((s) => s.link === "connected");
  const server = useSession((s) => s.session?.addr);
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState("none");
  const [place, setPlace] = useState<"device" | "server">(() => {
    if (isWeb) return "server";
    // Asked for from inside a folder: it goes where that folder is.
    if (localFolderId) return "device";
    if (folderId && connected) return "server";
    const last = localStorage.getItem("wf-newdoc-place");
    return last === "server" && connected ? "server" : last === "device" ? "device" : connected ? "server" : "device";
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const where = place === "server" && connected ? "server" : isWeb ? "server" : "device";

  const create = async () => {
    const name = title.trim() || "Untitled";
    setBusy(true);
    setError(null);
    try {
      if (where === "server") {
        const doc = await documentsApi.create(name, format);
        if (folderId) await documentsApi.moveDocument(doc.id, folderId).catch(() => {});
        await openServerDoc(doc.id);
      } else {
        const id = await useLocalDocs.getState().create(name, format);
        if (localFolderId) await useLocalDocs.getState().moveTo([id], localFolderId).catch(() => {});
        await openLocalDoc(id);
      }
      if (!isWeb) localStorage.setItem("wf-newdoc-place", where);
      onCreated?.(null);
      onClose();
    } catch (e) {
      setError(isCmdError(e) ? e.message : e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} className="wf-newdoc">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void create();
        }}
      >
        <h3>New document</h3>
        <label htmlFor="newdoc-title">Title</label>
        <input id="newdoc-title" value={title} maxLength={200} placeholder="Untitled" autoFocus onChange={(e) => setTitle(e.target.value)} />

        <fieldset className="wf-newdoc-formats">
          <legend>Kind</legend>
          {Object.entries(FORMAT_LABELS).map(([id, label]) => (
            <label key={id} className={`wf-newdoc-format${format === id ? " on" : ""}`}>
              <input type="radio" name="newdoc-format" value={id} checked={format === id} onChange={() => setFormat(id)} />
              <span>
                <strong>{label}</strong>
                <small>{FORMAT_HINTS[id] ?? ""}</small>
              </span>
            </label>
          ))}
        </fieldset>

        {!isWeb && (
          <fieldset className="wf-newdoc-place">
            <legend>Where</legend>
            <label className={where === "device" ? "on" : ""}>
              <input type="radio" name="newdoc-place" checked={where === "device"} onChange={() => setPlace("device")} />
              <span>
                <strong>On this device</strong>
                <small>Yours alone, and you can publish it to a server whenever you like</small>
              </span>
            </label>
            <label className={`${where === "server" ? "on" : ""}${connected ? "" : " off"}`}>
              <input type="radio" name="newdoc-place" checked={where === "server"} disabled={!connected} onChange={() => setPlace("server")} />
              <span>
                <strong>{connected ? `On ${server}` : "On a server"}</strong>
                <small>{connected ? "Write it together live with comments and history" : "Join or host a server to write together"}</small>
              </span>
            </label>
          </fieldset>
        )}

        {error && <p className="wf-connect-error">{error}</p>}
        <div className="wf-connect-row">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="wf-primary" disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
