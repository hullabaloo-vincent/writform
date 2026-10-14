import { AlertTriangle, ImagePlus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { normalizeAttachmentSrc, type CmdError } from "../../lib/backend";
import { toast, toastError } from "../../platform/toast";
import { encodeArt, type CoverArt } from "../cover/art";
import type { CoverPictures } from "./Cover";

type Patch = (p: Record<string, unknown>) => void;

const messageOf = (e: unknown, fallback: string): string => (e as Partial<CmdError> | null)?.message || fallback;

/**
 * Pictures put into a book (its cover, a scene break, chapter art) are
 * kept where the manuscript keeps its pictures and written to one key of
 * the book map. `busy` is the key being filled.
 */
export function useArtStore(pictures: CoverPictures | undefined, patch: Patch): { busy: string | null; choose: (key: string, file: File, also?: Record<string, unknown>) => Promise<void> } {
  const [busy, setBusy] = useState<string | null>(null);
  const choose = async (key: string, file: File, also: Record<string, unknown> = {}) => {
    if (!pictures) return;
    setBusy(key);
    try {
      const { storeArt } = await import("../cover/files");
      const { art, resaved } = await storeArt(file, pictures.upload, pictures.limit);
      patch({ [key]: encodeArt(art), ...also });
      if (resaved) toast("That picture was too heavy to keep as it was, so it was saved as a JPEG.", "info");
    } catch (e) {
      toastError(messageOf(e, "That picture couldn’t be added."));
    } finally {
      setBusy(null);
    }
  };
  return { busy, choose };
}

/** One picture of a book's: what is there, and the buttons to change it. */
export function ArtPicker({
  name,
  hint,
  art,
  notes,
  disabled,
  busy,
  thumb,
  onChoose,
  onRemove,
}: {
  name: string;
  hint: string;
  art: CoverArt | null;
  notes: string[];
  disabled: boolean;
  busy: boolean;
  /** A class for the thumbnail's shape. */
  thumb?: string;
  onChoose: (file: File) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="wf-cover-slot">
      <div className={`wf-cover-thumb${thumb ? ` ${thumb}` : ""}`}>{art ? <img src={normalizeAttachmentSrc(art.src)} alt="" decoding="async" loading="lazy" /> : <ImagePlus size={16} aria-hidden />}</div>
      <div className="wf-cover-slot-text">
        <strong>{name}</strong>
        <span>{art ? `${art.w.toLocaleString("en-US")} × ${art.h.toLocaleString("en-US")} pixels` : hint}</span>
        <div className="wf-cover-slot-actions">
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) onChoose(file);
            }}
          />
          <button type="button" disabled={disabled || busy} onClick={() => input.current?.click()}>
            {busy ? "Adding…" : art ? "Replace…" : "Choose a picture…"}
          </button>
          {art && (
            <button type="button" className="wf-icon" disabled={disabled || busy} title={`Remove the ${name.toLowerCase()}`} aria-label={`Remove the ${name.toLowerCase()}`} onClick={onRemove}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      {notes.map((note) => (
        <p key={note} className="wf-cover-note">
          <AlertTriangle size={12} aria-hidden /> {note}
        </p>
      ))}
    </div>
  );
}

/** What to say of a picture printed `inches` tall: how sharp it will be. */
export function sharpness(art: CoverArt, inches: number): string[] {
  if (!(inches > 0)) return [];
  const ppi = Math.round(art.h / inches);
  return ppi < 300 ? [`At this size it prints at ${ppi} pixels an inch. 300 or more is best for print.`] : [];
}
