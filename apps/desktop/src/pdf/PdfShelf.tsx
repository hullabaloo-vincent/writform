import { FileText, X } from "lucide-react";
import { useEffect } from "react";

import { whenLabel } from "../platform/recentsModel";
import { toast } from "../platform/toast";
import { canKeepPdfs, sizeLabel, usePdfShelf } from "./shelf";

/**
 * The PDFs kept on this device, as a section of Documents: each opens in
 * the PDF editor where it was left. Nothing is shown while there are none.
 */
export function PdfShelf({ onOpen, onError }: { onOpen: (id: string) => void; onError: (e: unknown) => void }) {
  const items = usePdfShelf((s) => s.items);
  const loaded = usePdfShelf((s) => s.loaded);
  useEffect(() => {
    if (canKeepPdfs() && !loaded) void usePdfShelf.getState().load().catch(() => {});
  }, [loaded]);
  if (!canKeepPdfs() || items.length === 0) return null;
  const now = Date.now();
  const takeOff = (id: string, name: string) => {
    void usePdfShelf
      .getState()
      .remove(id)
      .then(() =>
        toast(`“${name}” was taken off this device. It can be put back for thirty days.`, "info", {
          action: { label: "Put it back", run: () => void usePdfShelf.getState().restore(id).catch(onError) },
        }),
      )
      .catch(onError);
  };
  return (
    <section className="wf-documents-section">
      <h3>PDFs on this device</h3>
      <div className="wf-documents-grid">
        {items.map((item) => (
          <div key={item.id} className="wf-doc-card wf-pdf-card">
            <button className="wf-doc-card-open" onClick={() => onOpen(item.id)}>
              <span className="wf-doc-card-title">
                <FileText size={14} />
                {item.name}
              </span>
              <span className="wf-doc-card-meta">
                <span>
                  PDF · {sizeLabel(item.bytes)} · {whenLabel(item.modified_at, now)}
                </span>
              </span>
            </button>
            <button className="wf-pdf-card-off" title="Take it off this device" aria-label={`Take ${item.name} off this device`} onClick={() => takeOff(item.id, item.name)}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
