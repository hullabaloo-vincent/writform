import { RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { isWeb } from "../../../lib/backend";
import { useSession } from "../../../stores/session";
import { confirmDialog, toast } from "../../../platform";
import { documentsApi } from "../api";
import { useLocalDocs } from "../local";
import { useDocuments } from "../store";
import { restoreItems } from "./actions";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { DocCard } from "./DocCard";
import { daysLeft, TRASH_DAYS, type OrgItem } from "./model";

type TrashItem = OrgItem & { deletedAt: number };

/**
 * Recently Deleted: documents (from the server and from this device) wait
 * here for 30 days. Restore puts one back where it was; "Delete
 * permanently" and "Empty" ask first.
 */
export function TrashView({ onError }: { onError: (e: unknown) => void }) {
  const serverTrash = useDocuments((s) => s.trash);
  const supported = useDocuments((s) => s.trashSupported);
  const localTrash = useLocalDocs((s) => s.trash);
  const offline = useSession((s) => s.phase === "offline");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  useEffect(() => {
    void useDocuments.getState().loadTrash().catch(() => {});
    if (!isWeb) void useLocalDocs.getState().loadTrash().catch(() => {});
  }, []);

  const items: TrashItem[] = [
    ...serverTrash.map((i) => ({
      key: `s:${i.document.id}`,
      kind: "server" as const,
      id: i.document.id,
      title: i.document.title,
      format: i.document.format,
      updated: i.document.updated_at,
      created: i.document.created_at,
      words: i.word_count,
      excerpt: i.excerpt,
      snippet: null,
      folderId: i.document.folder_id,
      access: "owner" as const,
      owner: null,
      deletedAt: i.deleted_at ?? 0,
    })),
    ...localTrash.map((t) => ({
      key: `l:${t.id}`,
      kind: "local" as const,
      id: t.id,
      title: t.title,
      format: t.format,
      updated: t.deleted_at,
      created: t.deleted_at,
      words: t.words,
      excerpt: t.excerpt,
      snippet: null,
      folderId: null,
      access: "owner" as const,
      owner: null,
      deletedAt: t.deleted_at,
    })),
  ].sort((a, b) => b.deletedAt - a.deletedAt);

  const reload = () => {
    void useDocuments.getState().loadTrash().catch(() => {});
    if (!isWeb) void useLocalDocs.getState().loadTrash().catch(() => {});
  };

  const restore = (item: TrashItem) =>
    restoreItems([item])
      .then(() => {
        reload();
        toast(`Restored “${item.title}”.`, "success");
      })
      .catch(onError);

  const purge = (item: TrashItem) =>
    void confirmDialog(`Delete “${item.title}” permanently? This can’t be undone.`, {
      title: "Delete permanently",
      confirmLabel: "Delete permanently",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      const done = item.kind === "server" ? documentsApi.purge(item.id as number) : useLocalDocs.getState().purge(item.id as string);
      done.then(reload).catch(onError);
    });

  const empty = () =>
    void confirmDialog(
      `Permanently delete ${items.length === 1 ? "the document" : `all ${items.length} documents`} in Recently Deleted? This can’t be undone.`,
      { title: "Empty Recently Deleted", confirmLabel: "Delete all", danger: true },
    ).then((ok) => {
      if (!ok) return;
      const jobs: Promise<unknown>[] = [];
      if (serverTrash.length) jobs.push(documentsApi.emptyTrash());
      if (localTrash.length) jobs.push(useLocalDocs.getState().emptyTrash());
      Promise.all(jobs).then(reload).catch(onError);
    });

  const menuFor = (item: TrashItem, x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        { label: "Restore", icon: <RotateCcw size={14} />, onClick: () => void restore(item) },
        { label: "Delete permanently…", icon: <Trash2 size={14} />, danger: true, onClick: () => purge(item) },
      ],
    });

  return (
    <section className="wf-documents-section wf-trash">
      <div className="wf-trash-head">
        <p className="wf-doc-search-note">
          Deleted documents stay here for {TRASH_DAYS} days, then they’re gone for good.
          {supported === false && !offline && " (This server deletes documents right away, so only documents from this device appear.)"}
        </p>
        {items.length > 0 && (
          <button className="wf-danger" onClick={empty}>
            <Trash2 size={14} /> Empty
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="wf-documents-empty">Nothing in Recently Deleted.</p>
      ) : (
        <div className="wf-documents-grid">
          {items.map((item) => {
            const left = daysLeft(item.deletedAt);
            return (
              <DocCard
                key={item.key}
                item={item}
                selected={false}
                selecting={false}
                extra={left <= 0 ? "Deleted soon" : `${left} day${left === 1 ? "" : "s"} left`}
                onOpen={() => {
                  const el = document.activeElement as HTMLElement | null;
                  const r = el?.getBoundingClientRect();
                  menuFor(item, (r?.left ?? 100) + 24, (r?.top ?? 100) + 28);
                }}
                onMenu={(x, y) => menuFor(item, x, y)}
              />
            );
          })}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </section>
  );
}
