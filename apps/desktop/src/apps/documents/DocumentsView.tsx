import {
  ArrowLeft,
  BookCopy,
  CheckSquare,
  Copy,
  Download,
  FilePlus2,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  HardDrive,
  History,
  MoreHorizontal,
  Pencil,
  Search,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { DocumentFolder } from "../../bindings/proto/DocumentFolder";
import { backend, isCmdError, isWeb } from "../../lib/backend";
import { confirmDialog, SkeletonRows, toast } from "../../platform";
import { useSession } from "../../stores/session";
import { documentsApi } from "./api";
import { DocumentEditor } from "./DocumentEditor";
import { FORMAT_LABELS } from "./formats/elements";
import { LocalDocumentEditor } from "./LocalDocumentEditor";
import { useLocalDocs } from "./local";
import { openLocalDoc, openServerDoc } from "./navigation";
import { deleteItems, duplicate, type ItemRef } from "./organizer/actions";
import { ContextMenu, type MenuItem } from "./organizer/ContextMenu";
import { DocCard } from "./organizer/DocCard";
import { CombineDialog, ListShareDialog, MoveDialog, NameDialog } from "./organizer/dialogs";
import {
  compareNames,
  loadSort,
  localItem,
  matchesLocal,
  saveSort,
  serverItem,
  sortItems,
  type OrgItem,
  type SortKey,
} from "./organizer/model";
import { TrashView } from "./organizer/TrashView";
import { ShareLocalDialog } from "./ShareLocalDialog";
import { useDocuments } from "./store";
import { UnsavedBanner } from "./UnsavedBanner";

type View = { kind: "all" } | { kind: "folder"; id: number } | { kind: "trash" };

type Dialog =
  | { kind: "move"; items: OrgItem[] }
  | { kind: "rename"; item: OrgItem }
  | { kind: "renameFolder"; folder: DocumentFolder }
  | { kind: "newFolder" }
  | { kind: "share"; target: { kind: "document" | "folder"; id: number; name: string } }
  | { kind: "shareLocal"; meta: { id: string; title: string; format: string } }
  | { kind: "combine"; sources: OrgItem[]; title: string; folderId: number | null };

const IMPORT_TYPES = ".pdf,.docx,.rtf,.pages,.txt,.md,.markdown";

export function DocumentsView() {
  const items = useDocuments((s) => s.items);
  const folders = useDocuments((s) => s.folders);
  const loaded = useDocuments((s) => s.loaded);
  const activeDocId = useDocuments((s) => s.activeDocId);
  const error = useDocuments((s) => s.error);
  const loadError = useDocuments((s) => s.loadError);
  const serverTrash = useDocuments((s) => s.trash);
  const trashSupported = useDocuments((s) => s.trashSupported);
  const load = useDocuments((s) => s.load);
  const loadFolders = useDocuments((s) => s.loadFolders);
  const clearError = useDocuments((s) => s.clearError);

  const localDocs = useLocalDocs((s) => s.items);
  const localLoaded = useLocalDocs((s) => s.loaded);
  const localTrash = useLocalDocs((s) => s.trash);
  const activeLocalId = useLocalDocs((s) => s.activeLocalId);
  const offline = useSession((s) => s.phase === "offline");

  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState("none");
  const [importing, setImporting] = useState<{ done: number; total: number; name: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [dropping, setDropping] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OrgItem[] | null>(null);
  const [sort, setSortState] = useState<SortKey>(loadSort);
  const [view, setView] = useState<View>({ kind: "all" });
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const anchor = useRef<string | null>(null);

  useEffect(() => {
    if (!offline) {
      if (!loaded) void load().catch(() => {});
      void loadFolders().catch(() => {});
      void useDocuments.getState().loadTrash().catch(() => {});
    }
    if (!localLoaded) void useLocalDocs.getState().load().catch(() => {});
    if (!isWeb) void useLocalDocs.getState().loadTrash().catch(() => {});
  }, [loaded, load, loadFolders, localLoaded, offline]);

  // Debounced server-side search (titles and text).
  useEffect(() => {
    const q = query.trim();
    if (!q || offline) {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      void documentsApi
        .search(q)
        .then((r) => setResults(r.map(serverItem)))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, offline]);

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
          // The listener outlives the list: while a document is open, a
          // dropped file must not import (and navigate away from it).
          if (useDocuments.getState().activeDocId !== null || useLocalDocs.getState().activeLocalId !== null) {
            setDropping(false);
            return;
          }
          if (event.payload.type === "over") setDropping(true);
          else if (event.payload.type === "drop") {
            setDropping(false);
            void importDroppedPaths(event.payload.paths);
          } else setDropping(false);
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

  if (activeLocalId !== null) return <LocalDocumentEditor />;
  if (activeDocId !== null) return <DocumentEditor />;

  const fail = (e: unknown) => useDocuments.setState({ error: isCmdError(e) ? e.message : String(e) });
  const refresh = () => {
    void load().catch(() => {});
    void loadFolders().catch(() => {});
  };
  const setSort = (key: SortKey) => {
    setSortState(key);
    saveSort(key);
  };

  const searching = results !== null || (offline && !!query.trim());
  const serverAll = items.map(serverItem);
  const localAll = isWeb ? [] : localDocs.map(localItem);
  const serverShown = searching ? (results ?? []) : serverAll;
  const localShown = searching ? localAll.filter((i) => matchesLocal(i, query)) : localAll;
  const mine = sortItems(serverShown.filter((i) => i.access === "owner"), sort);
  const shared = sortItems(serverShown.filter((i) => i.access !== "owner"), sort);
  const local = sortItems(localShown, sort);
  const folder = view.kind === "folder" ? folders.find((f) => f.id === view.id) : undefined;
  const inView = searching
    ? mine
    : view.kind === "folder"
      ? mine.filter((i) => i.folderId === view.id)
      : mine.filter((i) => i.folderId === null);
  const sortedFolders = [...folders].sort((a, b) => compareNames(a.name, b.name));
  const trashCount = serverTrash.length + localTrash.length;
  const everything = [...local, ...inView, ...shared];
  const selectedItems = everything.filter((i) => selected.has(i.key));

  const open = (item: OrgItem) =>
    void (item.kind === "server" ? openServerDoc(item.id as number) : openLocalDoc(item.id as string)).catch(fail);
  const openRef = (ref: ItemRef) => void (ref.kind === "server" ? openServerDoc(ref.id) : openLocalDoc(ref.id)).catch(fail);

  const clearSelection = () => {
    setSelected(new Set());
    setSelecting(false);
    anchor.current = null;
  };

  /** ⌘/Ctrl-click toggles; Shift-click selects a range in the shown order. */
  const select = (item: OrgItem, e: { shiftKey: boolean }, list: OrgItem[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && anchor.current) {
        const a = list.findIndex((i) => i.key === anchor.current);
        const b = list.findIndex((i) => i.key === item.key);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) next.add(list[i].key);
          return next;
        }
      }
      if (next.has(item.key)) next.delete(item.key);
      else next.add(item.key);
      anchor.current = item.key;
      return next;
    });
  };

  const create = async () => {
    const t = title.trim();
    if (!t) return;
    try {
      const doc = await documentsApi.create(t, format);
      if (view.kind === "folder") await documentsApi.moveDocument(doc.id, view.id).catch(() => {});
      setCreating(false);
      setTitle("");
      refresh();
      await openServerDoc(doc.id);
    } catch (e) {
      fail(e);
    }
  };

  /** Import files — one or many. Offline they land on this device;
   *  connected, on the server (in the open folder). One file opens. */
  const importFiles = async (files: File[]) => {
    if (!files.length || importing) return;
    const mod = await import("./import/importFile");
    const made: ItemRef[] = [];
    const failed: string[] = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      setImporting({ done: i, total: files.length, name: file.name });
      try {
        if (offline) {
          made.push({ kind: "local", id: await mod.importFileToLocal(file) });
        } else {
          const doc = await mod.importFile(file);
          if (view.kind === "folder") await documentsApi.moveDocument(doc.id, view.id).catch(() => {});
          made.push({ kind: "server", id: doc.id });
        }
      } catch (e) {
        failed.push(`${file.name} (${isCmdError(e) ? e.message : String(e)})`);
      }
    }
    setImporting(null);
    refresh();
    if (offline) void useLocalDocs.getState().load().catch(() => {});
    if (failed.length) fail(`Couldn’t import ${failed.join("; ")}`);
    if (made.length === 1 && files.length === 1) openRef(made[0]);
    else if (made.length) toast(`Imported ${made.length} document${made.length === 1 ? "" : "s"}.`, "success");
  };

  /** Native drop: read each path's bytes back and reuse the importer. */
  const importDroppedPaths = async (paths: string[]) => {
    const files: File[] = [];
    for (const path of paths) {
      try {
        const { name, data_base64 } = await backend.readDroppedFile(path);
        const binary = atob(data_base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        files.push(new File([bytes], name));
      } catch (e) {
        fail(e);
      }
    }
    await importFiles(files);
  };

  const exportAll = async () => {
    setExporting(true);
    try {
      const { exportAllDocuments } = await import("./exportAll");
      // The save path shows its own "Saved … [Show in Finder]" toast.
      await exportAllDocuments(items, folders, isWeb ? [] : localDocs);
      useDocuments.setState({ error: null });
    } catch (e) {
      fail(e);
    } finally {
      setExporting(false);
    }
  };

  /** Deleting: Recently Deleted with Undo — except on servers that predate
   *  it, where deleting is permanent and asks first. */
  const remove = async (targets: OrgItem[]) => {
    const permanent = targets.some((t) => t.kind === "server") && trashSupported === false;
    if (permanent) {
      const ok = await confirmDialog(
        targets.length === 1
          ? `Delete “${targets[0].title}” for everyone? This server deletes documents permanently.`
          : `Delete ${targets.length} documents for everyone? This server deletes documents permanently.`,
        { title: "Delete", confirmLabel: "Delete", danger: true },
      );
      if (!ok) return;
    }
    try {
      if (permanent) {
        for (const t of targets) {
          if (t.kind === "server") await documentsApi.remove(t.id as number);
          else await useLocalDocs.getState().remove(t.id as string);
        }
        refresh();
      } else {
        await deleteItems(targets);
      }
      clearSelection();
    } catch (e) {
      fail(e);
    }
  };

  const showMenu = (x: number, y: number, list: MenuItem[]) => setMenu({ x, y, items: list });

  const docMenu = (item: OrgItem, x: number, y: number) => {
    const owner = item.access === "owner";
    const list: MenuItem[] = [
      { label: "Open", icon: <FileText size={14} />, onClick: () => open(item) },
      {
        label: "Version history",
        icon: <History size={14} />,
        onClick: () => {
          if (item.kind === "server") useDocuments.setState({ pendingPanel: "history" });
          else useLocalDocs.setState({ pendingPanel: "history" });
          open(item);
        },
      },
    ];
    if (owner || item.access === "write") {
      list.push({ label: "Rename…", icon: <Pencil size={14} />, onClick: () => setDialog({ kind: "rename", item }) });
    }
    list.push({
      label: "Duplicate",
      icon: <Copy size={14} />,
      disabled: item.kind === "server" && offline,
      onClick: () =>
        void duplicate(item)
          .then((ref) => {
            if (ref.kind === "local") void useLocalDocs.getState().load();
            toast(`Made a copy of “${item.title}”.`, "success", { action: { label: "Open", run: () => openRef(ref) } });
          })
          .catch(fail),
    });
    if (item.kind === "server" && !isWeb) {
      list.push({ label: "Save a copy to this device", icon: <HardDrive size={14} />, onClick: () => void saveToDevice(item) });
    }
    if (item.kind === "local" && !offline) {
      list.push({
        label: "Share to server…",
        icon: <Share2 size={14} />,
        onClick: () => setDialog({ kind: "shareLocal", meta: { id: item.id as string, title: item.title, format: item.format } }),
      });
    }
    if (item.kind === "server" && owner) {
      list.push(
        { label: "Move to folder…", icon: <FolderInput size={14} />, onClick: () => setDialog({ kind: "move", items: [item] }) },
        {
          label: "Share…",
          icon: <Share2 size={14} />,
          onClick: () => setDialog({ kind: "share", target: { kind: "document", id: item.id as number, name: item.title } }),
        },
      );
    }
    if (owner) {
      list.push({ label: "Delete", icon: <Trash2 size={14} />, danger: true, onClick: () => void remove([item]) });
    }
    showMenu(x, y, list);
  };

  /** Copy a server document onto this device — only ever a copy. */
  const saveToDevice = async (item: OrgItem) => {
    try {
      const detail = await documentsApi.detailQuiet(item.id as number);
      const id = await useLocalDocs.getState().create(item.title, item.format, detail.state_b64);
      toast(`Saved a copy of “${item.title}” to this device.`, "success", {
        action: { label: "Open", run: () => void openLocalDoc(id).catch(fail) },
      });
    } catch (e) {
      fail(e);
    }
  };

  const folderMenu = (f: DocumentFolder, x: number, y: number) =>
    showMenu(x, y, [
      { label: "Open", icon: <Folder size={14} />, onClick: () => setView({ kind: "folder", id: f.id }) },
      { label: "Rename…", icon: <Pencil size={14} />, onClick: () => setDialog({ kind: "renameFolder", folder: f }) },
      {
        label: "Combine into a manuscript…",
        icon: <BookCopy size={14} />,
        disabled: f.document_count < 2,
        onClick: () => {
          const sources = sortItems(serverAll.filter((i) => i.folderId === f.id && i.access === "owner"), "name");
          setDialog({ kind: "combine", sources, title: f.name, folderId: f.id });
        },
      },
      {
        label: "Share all documents…",
        icon: <Share2 size={14} />,
        onClick: () => setDialog({ kind: "share", target: { kind: "folder", id: f.id, name: f.name } }),
      },
      {
        label: "Delete folder",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () =>
          void confirmDialog(`Delete the folder “${f.name}”? Its documents are kept and move out of the folder.`, {
            title: "Delete folder",
            confirmLabel: "Delete folder",
            danger: true,
          }).then((ok) => {
            if (!ok) return;
            documentsApi
              .deleteFolder(f.id)
              .then(() => {
                if (view.kind === "folder" && view.id === f.id) setView({ kind: "all" });
                refresh();
              })
              .catch(fail);
          }),
      },
    ]);

  const cards = (list: OrgItem[]) =>
    list.map((item) => (
      <DocCard
        key={item.key}
        item={item}
        selected={selected.has(item.key)}
        selecting={selecting || selected.size > 0}
        onOpen={() => open(item)}
        onMenu={(x, y) => docMenu(item, x, y)}
        onSelect={(e) => select(item, e, everything)}
      />
    ));

  const busyLabel = importing
    ? importing.total > 1
      ? `Importing ${importing.done + 1} of ${importing.total}…`
      : `Importing ${importing.name}…`
    : null;

  return (
    <div
      className={`wf-documents ${dropping ? "dropping" : ""}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void importFiles([...e.dataTransfer.files]);
      }}
    >
      <header className="wf-documents-header">
        <h2>
          <FileText size={18} /> Documents
        </h2>
        {offline && (
          <span className="wf-doc-local-chip" title="Server documents appear when you connect">
            <HardDrive size={13} /> offline — this device only
          </span>
        )}
        <div className="wf-doc-search">
          <Search size={14} />
          <input
            placeholder={offline ? "Search titles on this device…" : "Search titles and text…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search documents"
          />
          {query && (
            <button title="Clear search" onClick={() => setQuery("")}>
              ×
            </button>
          )}
        </div>
        <select title="Sort by" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort by">
          <option value="modified">Last modified</option>
          <option value="created">Date created</option>
          <option value="name">Name</option>
        </select>
        <span className="wf-statusbar-spacer" />
        <button
          className={selecting ? "active" : ""}
          title="Select documents (or ⌘/Ctrl-click, Shift-click)"
          onClick={() => (selecting ? clearSelection() : setSelecting(true))}
        >
          <CheckSquare size={15} /> Select
        </button>
        {!offline && (
          <button
            title="Export every document as Markdown + JSON"
            onClick={() => void exportAll()}
            disabled={exporting || (items.length === 0 && localDocs.length === 0)}
          >
            <Download size={15} /> {exporting ? "Exporting…" : "Export all"}
          </button>
        )}
        <button
          title={offline ? "Import files as documents on this device" : "Import files as documents"}
          onClick={() => fileRef.current?.click()}
          disabled={importing !== null}
        >
          {busyLabel ?? "Import"}
        </button>
        {!offline && (
          <>
            <button className="wf-icon" title="New folder" onClick={() => setDialog({ kind: "newFolder" })}>
              <FolderPlus size={15} />
            </button>
            <button className="wf-primary" onClick={() => setCreating((c) => !c)}>
              <FilePlus2 size={15} /> New document
            </button>
          </>
        )}
        <input
          ref={fileRef}
          type="file"
          hidden
          multiple
          accept={IMPORT_TYPES}
          onChange={(e) => {
            void importFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </header>

      {error && (
        <p className="wf-connect-error" onClick={clearError}>
          {error}
        </p>
      )}

      {creating && !offline && (
        <form
          className="wf-doc-create"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input autoFocus placeholder="Document title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          <select value={format} onChange={(e) => setFormat(e.target.value)} aria-label="Format">
            {Object.entries(FORMAT_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <button type="submit" className="wf-primary" disabled={!title.trim()}>
            Create {folder ? `in ${folder.name}` : ""}
          </button>
        </form>
      )}

      <UnsavedBanner />

      {(selected.size > 0 || selecting) && (
        <div className="wf-doc-selbar" role="toolbar" aria-label="Selected documents">
          <span>{selected.size === 0 ? "Select documents" : `${selected.size} selected`}</span>
          <span className="wf-statusbar-spacer" />
          <button
            disabled={selectedItems.length < 2 || (offline && selectedItems.every((i) => i.kind === "server"))}
            title="Combine into one book manuscript"
            onClick={() =>
              setDialog({
                kind: "combine",
                sources: selectedItems,
                title: folder?.name ?? "Manuscript",
                folderId: view.kind === "folder" ? view.id : null,
              })
            }
          >
            <BookCopy size={14} /> Combine
          </button>
          <button
            disabled={!selectedItems.length || !selectedItems.every((i) => i.kind === "server" && i.access === "owner")}
            onClick={() => setDialog({ kind: "move", items: selectedItems })}
          >
            <FolderInput size={14} /> Move
          </button>
          <button
            className="wf-danger"
            disabled={!selectedItems.length || !selectedItems.every((i) => i.access === "owner")}
            onClick={() => void remove(selectedItems)}
          >
            <Trash2 size={14} /> Delete
          </button>
          <button className="wf-icon" title="Done selecting" onClick={clearSelection}>
            <X size={15} />
          </button>
        </div>
      )}

      <div className="wf-documents-lists">
        {searching ? (
          <p className="wf-doc-search-note">
            {mine.length + shared.length + local.length === 0
              ? `Nothing matches “${query.trim()}”.`
              : `${mine.length + shared.length + local.length} result${mine.length + shared.length + local.length === 1 ? "" : "s"} for “${query.trim()}”`}
          </p>
        ) : view.kind !== "all" ? (
          <button className="wf-doc-breadcrumb" onClick={() => setView({ kind: "all" })}>
            <ArrowLeft size={14} /> All documents /{" "}
            {view.kind === "trash" ? (
              <>
                <Trash2 size={14} /> Recently Deleted
              </>
            ) : (
              <>
                <Folder size={14} /> {folder?.name}
              </>
            )}
          </button>
        ) : null}

        {view.kind === "trash" && !searching ? (
          <TrashView onError={fail} />
        ) : (
          <>
            {!searching && view.kind === "all" && (sortedFolders.length > 0 || trashCount > 0) && (
              <section className="wf-documents-section">
                <h3>Folders</h3>
                <div className="wf-documents-grid">
                  {sortedFolders.map((f) => (
                    <div key={f.id} className="wf-doc-card wf-folder-card" onContextMenu={(e) => {
                      e.preventDefault();
                      folderMenu(f, e.clientX, e.clientY);
                    }}>
                      <button
                        className="wf-doc-card-open"
                        onClick={() => setView({ kind: "folder", id: f.id })}
                        onKeyDown={(e) => {
                          if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
                            e.preventDefault();
                            const r = e.currentTarget.getBoundingClientRect();
                            folderMenu(f, r.left + 24, r.top + 28);
                          }
                        }}
                      >
                        <span className="wf-doc-card-title">
                          <Folder size={15} /> {f.name}
                        </span>
                        <span className="wf-doc-card-meta">
                          {f.document_count} document{f.document_count === 1 ? "" : "s"}
                        </span>
                      </button>
                      <button
                        className="wf-doc-card-kebab"
                        title="Folder options"
                        aria-haspopup="menu"
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          folderMenu(f, r.left, r.bottom + 4);
                        }}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                    </div>
                  ))}
                  {trashCount > 0 && (
                    <div className="wf-doc-card wf-folder-card wf-trash-card">
                      <button className="wf-doc-card-open" onClick={() => setView({ kind: "trash" })}>
                        <span className="wf-doc-card-title">
                          <Trash2 size={15} /> Recently Deleted
                        </span>
                        <span className="wf-doc-card-meta">
                          {trashCount} document{trashCount === 1 ? "" : "s"}
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              </section>
            )}

            {view.kind === "all" && !isWeb && (local.length > 0 || !searching) && (
              <section className="wf-documents-section">
                <h3>
                  <HardDrive size={14} /> On this device
                </h3>
                <div className="wf-documents-grid">
                  {cards(local)}
                  {!searching && (
                    <div className="wf-doc-card wf-doc-card-new">
                      <button
                        className="wf-doc-card-open"
                        onClick={() =>
                          void useLocalDocs
                            .getState()
                            .create("Untitled", "none")
                            .then((id) => openLocalDoc(id))
                            .catch(fail)
                        }
                      >
                        <span className="wf-doc-card-title">
                          <FilePlus2 size={15} /> New document on this device
                        </span>
                        <span className="wf-doc-card-meta">Stored on this computer only</span>
                      </button>
                    </div>
                  )}
                </div>
              </section>
            )}

            {inView.length > 0 && (
              <section className="wf-documents-section">
                <h3>{view.kind === "folder" ? folder?.name ?? "Folder" : "My documents"}</h3>
                <div className="wf-documents-grid">{cards(inView)}</div>
              </section>
            )}
            {view.kind === "folder" && !searching && inView.length === 0 && loaded && (
              <p className="wf-documents-empty">This folder is empty. Move documents here from their ⋯ menu, or import files while it’s open.</p>
            )}
            {(searching || view.kind === "all") && shared.length > 0 && (
              <section className="wf-documents-section">
                <h3>Shared with me</h3>
                <div className="wf-documents-grid">{cards(shared)}</div>
              </section>
            )}
          </>
        )}

        {!offline && !loaded && loadError && (
          <p className="wf-documents-empty">
            Couldn’t load your documents.{" "}
            <button className="wf-link-button" onClick={refresh}>
              Try again
            </button>
          </p>
        )}
        {!offline && !loaded && !loadError && <SkeletonRows rows={4} />}
        {!offline && loaded && view.kind === "all" && !searching && items.length === 0 && (
          <p className="wf-documents-empty">
            No documents on the server yet. Create one, or drop PDF, Word, RTF, Pages, text or Markdown files here
            to import them.
          </p>
        )}
        {offline && view.kind === "all" && !searching && (
          <p className="wf-documents-empty">You’re working offline — server documents (and sharing) appear when you connect.</p>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {dialog?.kind === "move" && (
        <MoveDialog
          items={dialog.items}
          folders={sortedFolders}
          onDone={() => {
            setDialog(null);
            clearSelection();
            refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog
          title="Rename document"
          initial={dialog.item.title}
          label="Rename"
          maxLength={200}
          onSave={async (name) => {
            const item = dialog.item;
            if (item.kind === "server") {
              await documentsApi.update(item.id as number, { title: name, format: null });
              refresh();
            } else {
              await useLocalDocs.getState().rename(item.id as string, name);
            }
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "renameFolder" && (
        <NameDialog
          title="Rename folder"
          initial={dialog.folder.name}
          label="Rename"
          maxLength={80}
          onSave={async (name) => {
            await documentsApi.renameFolder(dialog.folder.id, name);
            refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "newFolder" && (
        <NameDialog
          title="New folder"
          initial=""
          label="Create"
          maxLength={80}
          onSave={async (name) => {
            await documentsApi.createFolder(name);
            refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "share" && <ListShareDialog target={dialog.target} onClose={() => setDialog(null)} />}
      {dialog?.kind === "shareLocal" && <ShareLocalDialog meta={dialog.meta} onClose={() => setDialog(null)} />}
      {dialog?.kind === "combine" && (
        <CombineDialog
          sources={dialog.sources}
          defaultTitle={dialog.title}
          folderId={dialog.folderId}
          offline={offline}
          onDone={(ref) => {
            setDialog(null);
            clearSelection();
            if (ref.kind === "local") void useLocalDocs.getState().load();
            openRef(ref);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
