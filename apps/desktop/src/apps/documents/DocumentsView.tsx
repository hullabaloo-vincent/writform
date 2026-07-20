import { FilePlus2, FileText, Import } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { DocumentListItem } from "../../bindings/proto/DocumentListItem";
import { isCmdError } from "../../lib/backend";
import { Avatar } from "../../platform/Avatar";
import { DocumentEditor } from "./DocumentEditor";
import { FORMAT_LABELS } from "./formats/elements";
import { useDocuments } from "./store";

export function DocumentsView() {
  const items = useDocuments((s) => s.items);
  const loaded = useDocuments((s) => s.loaded);
  const activeDocId = useDocuments((s) => s.activeDocId);
  const error = useDocuments((s) => s.error);
  const load = useDocuments((s) => s.load);
  const openDocument = useDocuments((s) => s.openDocument);
  const clearError = useDocuments((s) => s.clearError);

  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState("none");
  const [importing, setImporting] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loaded) void load().catch(() => {});
  }, [loaded, load]);

  if (activeDocId !== null) return <DocumentEditor />;

  const mine = items.filter((i) => i.my_access === "owner");
  const shared = items.filter((i) => i.my_access !== "owner");

  const create = async () => {
    const t = title.trim();
    if (!t) return;
    const { documentsApi } = await import("./api");
    try {
      const doc = await documentsApi.create(t, format);
      setCreating(false);
      setTitle("");
      await load();
      await openDocument(doc.id);
    } catch (e) {
      useDocuments.setState({ error: isCmdError(e) ? e.message : String(e) });
    }
  };

  const onImportFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    setImporting(file.name);
    try {
      const { importFile } = await import("./import/importFile");
      const doc = await importFile(file);
      await load();
      await openDocument(doc.id);
    } catch (e) {
      useDocuments.setState({ error: isCmdError(e) ? e.message : String(e) });
    } finally {
      setImporting(null);
    }
  };

  return (
    <div
      className="wf-documents"
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
        <button onClick={() => fileRef.current?.click()} disabled={importing !== null}>
          <Import size={15} /> {importing ? `Importing ${importing}…` : "Import"}
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
            Create
          </button>
        </form>
      )}

      <div className="wf-documents-lists">
        <Section title="My documents" items={mine} onOpen={openDocument} />
        <Section title="Shared with me" items={shared} onOpen={openDocument} />
        {loaded && items.length === 0 && (
          <p className="wf-documents-empty">
            No documents yet. Create one, or drop a PDF, DOCX, RTF, Pages, TXT, or Markdown
            file here to import it.
          </p>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  items,
  onOpen,
}: {
  title: string;
  items: DocumentListItem[];
  onOpen: (id: number) => Promise<void>;
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
          </button>
        ))}
      </div>
    </section>
  );
}
