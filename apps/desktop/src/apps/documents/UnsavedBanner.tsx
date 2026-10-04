import { yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import type { JSONContent } from "@tiptap/core";
import { useEffect, useState } from "react";
import * as Y from "yjs";

import { isWeb } from "../../lib/backend";
import { confirmDialog, Modal, toast } from "../../platform";
import { b64encode } from "./collab";
import {
  onStuckLocalDocsChange,
  stuckLocalDocs,
  useLocalDocs,
  type LocalDocProvider,
} from "./local";
import { openLocalDoc } from "./navigation";
import { retryEntry, troubledEntries } from "./sync/drain";
import { outbox, type OutboxEntry } from "./sync/outbox";

/**
 * "Some changes haven't been saved." — the organizer's one place for edits
 * that couldn't reach their home: server edits the server refused (kept in
 * the outbox, often with a full rescue copy) and on-device documents whose
 * file couldn't be written (kept open in memory, still retrying).
 */
export function UnsavedBanner() {
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const [stuck, setStuck] = useState<LocalDocProvider[]>(() => stuckLocalDocs());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const reload = () =>
      void troubledEntries()
        .then((list) => alive && setEntries(list))
        .catch(() => {});
    reload();
    const offOutbox = outbox.subscribe(reload);
    const offStuck = onStuckLocalDocsChange(() => setStuck(stuckLocalDocs()));
    return () => {
      alive = false;
      offOutbox();
      offStuck();
    };
  }, []);

  const count = entries.length + stuck.length;
  if (count === 0) return null;

  return (
    <>
      <div className="wf-unsaved-banner" role="alert">
        <span>
          {count === 1
            ? "A document has changes that haven't been saved."
            : `${count} documents have changes that haven't been saved.`}
        </span>
        <button onClick={() => setOpen(true)}>Review</button>
      </div>
      {open && (
        <Modal onClose={() => setOpen(false)} className="wf-unsaved-modal">
          <h3>Unsaved changes</h3>
          <div className="wf-unsaved-list">
            {entries.map((entry) => (
              <OutboxItem key={entry.key} entry={entry} />
            ))}
            {stuck.map((p) => (
              <StuckItem key={p.id} provider={p} />
            ))}
          </div>
          <div className="wf-connect-row" style={{ justifyContent: "flex-end" }}>
            <button onClick={() => setOpen(false)}>Done</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function rescueJson(entry: OutboxEntry): JSONContent | null {
  if (!entry.rescue) return null;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, entry.rescue);
    return yDocToProsemirrorJSON(doc, "default") as JSONContent;
  } catch {
    return null;
  } finally {
    doc.destroy();
  }
}

function OutboxItem({ entry }: { entry: OutboxEntry }) {
  const [busy, setBusy] = useState(false);
  const run = (task: () => Promise<unknown>) => {
    setBusy(true);
    void task()
      .catch((e) => toast(String(e), "error"))
      .finally(() => setBusy(false));
  };
  return (
    <div className="wf-unsaved-item">
      <strong>{entry.title || "Untitled"}</strong>
      <small>{entry.error?.message ?? "Waiting to send."}</small>
      <span className="wf-unsaved-actions">
        <button disabled={busy} onClick={() => run(() => retryEntry(entry))}>
          Try Again
        </button>
        {entry.rescue && !isWeb && (
          <button
            className="wf-primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await useLocalDocs
                  .getState()
                  .create(`${entry.title || "Untitled"} (unsaved copy)`, "none", b64encode(entry.rescue!));
                await outbox.remove(entry.key);
                toast("Saved a copy to this device.", "success");
              })
            }
          >
            Save a Copy to This Device
          </button>
        )}
        {entry.rescue && isWeb && (
          <button
            className="wf-primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const json = rescueJson(entry);
                if (!json) throw new Error("The saved copy couldn't be read.");
                const { exportDocument } = await import("./export");
                await exportDocument(json, `${entry.title || "Untitled"} (unsaved copy)`, "none", "docx");
              })
            }
          >
            Download a Copy
          </button>
        )}
        <button
          className="wf-danger"
          disabled={busy}
          onClick={() =>
            void confirmDialog(
              `Throw away the unsaved changes to “${entry.title || "Untitled"}”? This can't be undone.`,
              { title: "Discard changes", confirmLabel: "Discard", danger: true },
            ).then((ok) => {
              if (ok) run(() => outbox.remove(entry.key));
            })
          }
        >
          Discard
        </button>
      </span>
    </div>
  );
}

function StuckItem({ provider }: { provider: LocalDocProvider }) {
  const title = useLocalDocs((s) => s.items.find((d) => d.id === provider.id)?.title) ?? "Untitled";
  const status = provider.getStatus();
  return (
    <div className="wf-unsaved-item">
      <strong>{title}</strong>
      <small>
        {status.kind === "error" ? status.message : "Saving to this device…"} It stays open in the
        background until it saves.
      </small>
      <span className="wf-unsaved-actions">
        <button onClick={() => void provider.retry()}>Try Again</button>
        <button className="wf-primary" onClick={() => void openLocalDoc(provider.id)}>
          Open
        </button>
        <button
          onClick={() =>
            void import("./export")
              .then(({ exportDocument }) =>
                exportDocument(
                  yDocToProsemirrorJSON(provider.doc, "default") as JSONContent,
                  title,
                  "none",
                  "docx",
                ),
              )
              .catch((e) => toast(String(e), "error"))
          }
        >
          Export a Copy
        </button>
      </span>
    </div>
  );
}
