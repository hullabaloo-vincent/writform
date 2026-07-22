import {
  ArrowLeft,
  Download,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  History,
  MoreHorizontal,
  Search,
  Share2,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { DocumentFolder } from "../../bindings/proto/DocumentFolder";
import type { DocumentListItem } from "../../bindings/proto/DocumentListItem";
import { backend, isCmdError } from "../../lib/backend";
import { confirmDialog, Modal, SkeletonRows } from "../../platform";
import { Avatar } from "../../platform/Avatar";
import { documentsApi } from "./api";
import { DocumentEditor } from "./DocumentEditor";
import { FORMAT_LABELS } from "./formats/elements";
import { useDocuments } from "./store";

type SortKey = "modified" | "created" | "name";

interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function DocumentsView() {
  const items = useDocuments((s) => s.items);
  const folders = useDocuments((s) => s.folders);
  const loaded = useDocuments((s) => s.loaded);
  const activeDocId = useDocuments((s) => s.activeDocId);
  const error = useDocuments((s) => s.error);
  const load = useDocuments((s) => s.load);
  const loadFolders = useDocuments((s) => s.loadFolders);
  const openDocument = useDocuments((s) => s.openDocument);
  const clearError = useDocuments((s) => s.clearError);

  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState("none");
  const [importing, setImporting] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [dropping, setDropping] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocumentListItem[] | null>(null);
  const [sort, setSort] = useState<SortKey>("modified");
  const [folderId, setFolderId] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [moveDoc, setMoveDoc] = useState<DocumentListItem | null>(null);
  const [shareTarget, setShareTarget] = useState<
    { kind: "document"; id: number; name: string } | { kind: "folder"; id: number; name: string } | null
  >(null);
  const [renaming, setRenaming] = useState<DocumentFolder | null>(null);

  useEffect(() => {
    if (!loaded) void load().catch(() => {});
    void loadFolders().catch(() => {});
  }, [loaded, load, loadFolders]);

  // Debounced server-side search (title + content).
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      void documentsApi
        .search(q)
        .then((r) => setResults(r))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  // Native drag & drop. Tauri swallows OS file drags before the webview sees
  // them, so the HTML5 `onDrop` below never fires in the packaged app — the
  // paths arrive here instead, and the bytes come back through the core.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "over") {
            setDropping(true);
          } else if (event.payload.type === "drop") {
            setDropping(false);
            void importDroppedPaths(event.payload.paths);
          } else {
            setDropping(false);
          }
        })
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        }),
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (activeDocId !== null) return <DocumentEditor />;

  const searching = results !== null;
  const source = searching ? results : items;
  const sorted = [...source].sort((a, b) => {
    if (sort === "name") return a.document.title.localeCompare(b.document.title);
    if (sort === "created") return b.document.created_at - a.document.created_at;
    return b.document.updated_at - a.document.updated_at;
  });
  const mine = sorted.filter((i) => i.my_access === "owner");
  const shared = sorted.filter((i) => i.my_access !== "owner");
  const currentFolder = folderId !== null ? folders.find((f) => f.id === folderId) : undefined;
  // Folder filtering applies to owned docs when browsing (not searching).
  const visibleMine =
    searching || folderId === null ? mine.filter((i) => searching || i.document.folder_id === null) : mine.filter((i) => i.document.folder_id === folderId);

  const fail = (e: unknown) =>
    useDocuments.setState({ error: isCmdError(e) ? e.message : String(e) });

  const refresh = () => {
    void load().catch(() => {});
    void loadFolders().catch(() => {});
  };

  const create = async () => {
    const t = title.trim();
    if (!t) return;
    try {
      const doc = await documentsApi.create(t, format);
      if (folderId !== null) await documentsApi.moveDocument(doc.id, folderId).catch(() => {});
      setCreating(false);
      setTitle("");
      refresh();
      await openDocument(doc.id);
    } catch (e) {
      fail(e);
    }
  };

  const importOne = async (file: File) => {
    setImporting(file.name);
    try {
      const { importFile } = await import("./import/importFile");
      const doc = await importFile(file);
      refresh();
      await openDocument(doc.id);
    } catch (e) {
      fail(e);
    } finally {
      setImporting(null);
    }
  };

  const onImportFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    await importOne(files[0]);
  };

  /** Native drop: read the path's bytes back and reuse the normal importer. */
  const importDroppedPaths = async (paths: string[]) => {
    const path = paths[0];
    if (!path) return;
    const name = path.split(/[/\\]/).pop() ?? "document";
    setImporting(name);
    try {
      const { name: fileName, data_base64 } = await backend.readDroppedFile(path);
      const binary = atob(data_base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const { importFile } = await import("./import/importFile");
      const doc = await importFile(new File([bytes], fileName));
      refresh();
      await openDocument(doc.id);
    } catch (e) {
      fail(e);
    } finally {
      setImporting(null);
    }
  };

  const exportAll = async () => {
    setExporting(true);
    try {
      const { exportAllDocuments } = await import("./exportAll");
      const where = await exportAllDocuments(items, folders);
      useDocuments.setState({ error: null });
      await confirmDialog(`Export complete: ${where}`, {
        title: "Documents exported",
        confirmLabel: "OK",
      });
    } catch (e) {
      fail(e);
    } finally {
      setExporting(false);
    }
  };

  const openWithHistory = (id: number) => {
    useDocuments.setState({ pendingPanel: "history" });
    void openDocument(id).catch(() => {});
  };

  const docMenu = (e: React.MouseEvent, item: DocumentListItem) => {
    e.preventDefault();
    e.stopPropagation();
    const isOwner = item.my_access === "owner";
    const items: MenuItem[] = [
      { label: "Open", icon: <FileText size={14} />, onClick: () => void openDocument(item.document.id).catch(() => {}) },
      {
        label: "Version history",
        icon: <History size={14} />,
        onClick: () => openWithHistory(item.document.id),
      },
    ];
    if (isOwner) {
      items.push(
        {
          label: "Move to folder…",
          icon: <Folder size={14} />,
          onClick: () => setMoveDoc(item),
        },
        {
          label: "Share…",
          icon: <Share2 size={14} />,
          onClick: () =>
            setShareTarget({ kind: "document", id: item.document.id, name: item.document.title }),
        },
        {
          label: "Delete",
          icon: <Trash2 size={14} />,
          danger: true,
          onClick: () =>
            void confirmDialog(
              `Delete "${item.document.title}" for everyone? Version history is deleted too.`,
              { title: "Delete document", confirmLabel: "Delete", danger: true },
            ).then((ok) => {
              if (!ok) return;
              documentsApi.remove(item.document.id).then(refresh).catch(fail);
            }),
        },
      );
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const folderMenu = (e: React.MouseEvent, folder: DocumentFolder) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Rename…", icon: <Folder size={14} />, onClick: () => setRenaming(folder) },
        {
          label: "Share all documents…",
          icon: <Share2 size={14} />,
          onClick: () => setShareTarget({ kind: "folder", id: folder.id, name: folder.name }),
        },
        {
          label: "Delete folder",
          icon: <Trash2 size={14} />,
          danger: true,
          onClick: () =>
            void confirmDialog(
              `Delete the folder "${folder.name}"? Its documents are kept and move out of the folder.`,
              { title: "Delete folder", confirmLabel: "Delete folder", danger: true },
            ).then((ok) => {
              if (!ok) return;
              documentsApi
                .deleteFolder(folder.id)
                .then(() => {
                  if (folderId === folder.id) setFolderId(null);
                  refresh();
                })
                .catch(fail);
            }),
        },
      ],
    });
  };

  return (
    <div
      className={`wf-documents ${dropping ? "dropping" : ""}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void onImportFiles(e.dataTransfer.files);
      }}
    >
      <header className="wf-documents-header">
        <h2>
          <FileText size={18} /> Documents
        </h2>
        <div className="wf-doc-search">
          <Search size={14} />
          <input
            placeholder="Search titles and content…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button title="Clear search" onClick={() => setQuery("")}>
              ×
            </button>
          )}
        </div>
        <select
          title="Sort by"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
        >
          <option value="modified">Last modified</option>
          <option value="created">Date created</option>
          <option value="name">Name</option>
        </select>
        <span className="wf-statusbar-spacer" />
        <input
          ref={fileRef}
          type="file"
          hidden
          accept=".pdf,.docx,.rtf,.pages,.txt,.md,.markdown"
          onChange={(e) => {
            void onImportFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          title="Export every document as Markdown + JSON"
          onClick={() => void exportAll()}
          disabled={exporting || items.length === 0}
        >
          <Download size={15} /> {exporting ? "Exporting…" : "Export all"}
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={importing !== null}>
          {importing ? `Importing ${importing}…` : "Import"}
        </button>
        <button
          className="wf-icon"
          title="New folder"
          onClick={() => {
            const name = `New folder ${folders.length + 1}`;
            documentsApi
              .createFolder(name)
              .then((f) => {
                setRenaming(f);
                refresh();
              })
              .catch(fail);
          }}
        >
          <FolderPlus size={15} />
        </button>
        <button className="wf-primary" onClick={() => setCreating((c) => !c)}>
          <FilePlus2 size={15} /> New document
        </button>
      </header>

      {error && (
        <p className="wf-connect-error" onClick={clearError}>
          {error}
        </p>
      )}

      {creating && (
        <form
          className="wf-doc-create"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            autoFocus
            placeholder="Document title"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            {Object.entries(FORMAT_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <button type="submit" className="wf-primary" disabled={!title.trim()}>
            Create {currentFolder ? `in ${currentFolder.name}` : ""}
          </button>
        </form>
      )}

      <div className="wf-documents-lists">
        {searching ? (
          <p className="wf-doc-search-note">
            {sorted.length === 0
              ? `Nothing matches “${query.trim()}”.`
              : `${sorted.length} result${sorted.length === 1 ? "" : "s"} for “${query.trim()}”`}
          </p>
        ) : folderId !== null ? (
          <button className="wf-doc-breadcrumb" onClick={() => setFolderId(null)}>
            <ArrowLeft size={14} /> All documents / <Folder size={14} /> {currentFolder?.name}
          </button>
        ) : null}

        {!searching && folderId === null && folders.length > 0 && (
          <section className="wf-documents-section">
            <h3>Folders</h3>
            <div className="wf-documents-grid">
              {folders.map((f) => (
                <button
                  key={f.id}
                  className="wf-doc-card wf-folder-card"
                  onClick={() => setFolderId(f.id)}
                  onContextMenu={(e) => folderMenu(e, f)}
                >
                  <span className="wf-doc-card-title">
                    <Folder size={15} /> {f.name}
                  </span>
                  <span className="wf-doc-card-meta">
                    {f.document_count} document{f.document_count === 1 ? "" : "s"}
                  </span>
                  <span
                    className="wf-doc-card-kebab"
                    role="button"
                    tabIndex={0}
                    title="Folder options"
                    onClick={(e) => folderMenu(e, f)}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal size={15} />
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <Section
          title={
            searching
              ? "My documents"
              : folderId !== null
                ? currentFolder?.name ?? "Folder"
                : "My documents"
          }
          items={visibleMine}
          onOpen={openDocument}
          onMenu={docMenu}
        />
        {(searching || folderId === null) && (
          <Section title="Shared with me" items={shared} onOpen={openDocument} onMenu={docMenu} />
        )}
        {!loaded && <SkeletonRows rows={4} />}
        {loaded && items.length === 0 && !searching && (
          <p className="wf-documents-empty">
            No documents yet. Create one, or drop a PDF, DOCX, RTF, Pages, TXT, or Markdown
            file here to import it.
          </p>
        )}
      </div>

      {menu && (
        <div
          className="wf-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {menu.items.map((item, i) => (
            <button
              key={i}
              className={item.danger ? "wf-danger" : ""}
              onClick={() => {
                setMenu(null);
                item.onClick();
              }}
            >
              {item.icon} {item.label}
            </button>
          ))}
        </div>
      )}

      {moveDoc && (
        <MoveDialog
          item={moveDoc}
          folders={folders}
          onDone={() => {
            setMoveDoc(null);
            refresh();
          }}
          onClose={() => setMoveDoc(null)}
          onError={fail}
        />
      )}
      {renaming && (
        <RenameFolderDialog
          folder={renaming}
          onDone={() => {
            setRenaming(null);
            refresh();
          }}
          onClose={() => setRenaming(null)}
          onError={fail}
        />
      )}
      {shareTarget && (
        <ListShareDialog target={shareTarget} onClose={() => setShareTarget(null)} />
      )}
    </div>
  );
}

function Section({
  title,
  items,
  onOpen,
  onMenu,
}: {
  title: string;
  items: DocumentListItem[];
  onOpen: (id: number) => Promise<void>;
  onMenu: (e: React.MouseEvent, item: DocumentListItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="wf-documents-section">
      <h3>{title}</h3>
      <div className="wf-documents-grid">
        {items.map((item) => (
          <button
            key={item.document.id}
            className="wf-doc-card"
            onClick={() => void onOpen(item.document.id).catch(() => {})}
            onContextMenu={(e) => onMenu(e, item)}
          >
            <span className="wf-doc-card-title">{item.document.title}</span>
            <span className="wf-doc-card-meta">
              <span className="wf-doc-card-format">
                {FORMAT_LABELS[item.document.format] ?? item.document.format}
              </span>
              {item.my_access !== "owner" && (
                <span className="wf-doc-card-access">
                  {item.my_access === "write" ? "can edit" : "read only"}
                </span>
              )}
            </span>
            <span className="wf-doc-card-owner">
              <Avatar
                name={item.document.owner.display_name ?? item.document.owner.username}
                attachmentId={item.document.owner.avatar_attachment_id}
                accentColor={item.document.owner.accent_color}
                size={16}
              />
              {item.document.owner.display_name ?? item.document.owner.username}
              <span className="wf-doc-card-date">
                {new Date(item.document.updated_at).toLocaleDateString()}
              </span>
            </span>
            <span
              className="wf-doc-card-kebab"
              role="button"
              tabIndex={0}
              title="Document options"
              onClick={(e) => onMenu(e, item)}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <MoreHorizontal size={15} />
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function MoveDialog({
  item,
  folders,
  onDone,
  onClose,
  onError,
}: {
  item: DocumentListItem;
  folders: DocumentFolder[];
  onDone: () => void;
  onClose: () => void;
  onError: (e: unknown) => void;
}) {
  const move = (folderId: number | null) => {
    documentsApi.moveDocument(item.document.id, folderId).then(onDone).catch(onError);
  };
  return (
    <Modal onClose={onClose}>
      <header className="wf-doc-panel-header">
        <h3>Move “{item.document.title}”</h3>
      </header>
      <ul className="wf-doc-share-list">
        <li>
          <button
            className="wf-doc-move-target"
            disabled={item.document.folder_id === null}
            onClick={() => move(null)}
          >
            <FileText size={14} /> No folder
          </button>
        </li>
        {folders.map((f) => (
          <li key={f.id}>
            <button
              className="wf-doc-move-target"
              disabled={item.document.folder_id === f.id}
              onClick={() => move(f.id)}
            >
              <Folder size={14} /> {f.name}
            </button>
          </li>
        ))}
        {folders.length === 0 && (
          <li className="wf-friend-dim">No folders yet — create one from the toolbar.</li>
        )}
      </ul>
    </Modal>
  );
}

function RenameFolderDialog({
  folder,
  onDone,
  onClose,
  onError,
}: {
  folder: DocumentFolder;
  onDone: () => void;
  onClose: () => void;
  onError: (e: unknown) => void;
}) {
  const [name, setName] = useState(folder.name);
  return (
    <Modal onClose={onClose}>
      <header className="wf-doc-panel-header">
        <h3>Rename folder</h3>
      </header>
      <form
        className="wf-doc-panel-row"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          documentsApi.renameFolder(folder.id, n).then(onDone).catch(onError);
        }}
      >
        <input
          autoFocus
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="submit" className="wf-primary" disabled={!name.trim()}>
          Rename
        </button>
      </form>
    </Modal>
  );
}

/** Share a document or every document in a folder, straight from the list. */
function ListShareDialog({
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
      {error && (
        <p className="wf-connect-error" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      {done && <p className="wf-doc-share-note">{done}</p>}
      <SharePicker
        onShare={async (subject_kind, subject_id, access) => {
          try {
            if (target.kind === "folder") {
              const shares = await documentsApi.shareFolder(target.id, {
                subject_kind,
                subject_id,
                access,
              });
              setDone(`Shared ${shares.length} document${shares.length === 1 ? "" : "s"}.`);
            } else {
              await documentsApi.setShare(target.id, { subject_kind, subject_id, access });
              setDone("Shared.");
            }
            setError(null);
          } catch (e) {
            setError(isCmdError(e) ? e.message : String(e));
          }
        }}
      />
      {target.kind === "folder" && (
        <p className="wf-doc-share-note">
          Applies to the documents currently in the folder. Documents added later are not
          shared automatically.
        </p>
      )}
    </Modal>
  );
}

/** Friend/group picker + access level used by the list share dialog. */
function SharePicker({
  onShare,
}: {
  onShare: (subjectKind: string, subjectId: number, access: string) => Promise<void>;
}) {
  const [friends, setFriends] = useState<{ id: number; label: string }[]>([]);
  const [groups, setGroups] = useState<{ id: number; label: string }[]>([]);
  const [subject, setSubject] = useState("");
  const [access, setAccess] = useState("read");

  useEffect(() => {
    void import("../friends/FriendsView").then(({ friendsApi }) =>
      friendsApi
        .friends()
        .then((fs) =>
          setFriends(
            fs.map((f) => ({ id: f.user.id, label: f.user.display_name ?? f.user.username })),
          ),
        )
        .catch(() => {}),
    );
    void import("../chat/store").then(({ useChat }) =>
      setGroups(useChat.getState().groups.map((g) => ({ id: g.id, label: g.name }))),
    );
  }, []);

  return (
    <form
      className="wf-doc-panel-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (!subject) return;
        const [kind, id] = subject.split(":");
        void onShare(kind, Number(id), access);
      }}
    >
      <select value={subject} onChange={(e) => setSubject(e.target.value)}>
        <option value="" disabled>
          Share with…
        </option>
        {friends.length > 0 && (
          <optgroup label="Friends">
            {friends.map((f) => (
              <option key={`user:${f.id}`} value={`user:${f.id}`}>
                {f.label}
              </option>
            ))}
          </optgroup>
        )}
        {groups.length > 0 && (
          <optgroup label="Groups">
            {groups.map((g) => (
              <option key={`group:${g.id}`} value={`group:${g.id}`}>
                {g.label}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <select value={access} onChange={(e) => setAccess(e.target.value)}>
        <option value="read">can read</option>
        <option value="write">can edit</option>
      </select>
      <button type="submit" className="wf-primary" disabled={!subject}>
        Share
      </button>
    </form>
  );
}
