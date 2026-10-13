import { AlertTriangle, ImagePlus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { normalizeAttachmentSrc, type CmdError } from "../../lib/backend";
import type { ImageUploader } from "../../lib/upload";
import { toast, toastError } from "../../platform/toast";
import { encodeArt, type BookCover, type CoverArt, type CoverSlot } from "../cover/art";
import { coverGeometry, ebookNotes, printNotes, sizeWords, SPINE_TEXT_PAGES, spineDrift, type CoverGeometry } from "../cover/geometry";
import type { Book } from "../model/bookMap";
import { estimatePages } from "../model/trims";
import { CoverSvg, useCoverScene } from "./CoverView";

/** Where a manuscript keeps its pictures, and the most one may weigh there. */
export interface CoverPictures {
  upload: ImageUploader;
  limit: number;
}

type Patch = (p: Record<string, unknown>) => void;

const messageOf = (e: unknown, fallback: string): string => (e as Partial<CmdError> | null)?.message || fallback;

/**
 * How many pages the cover is sized for: the layout engine's count, once it
 * has set the book (`count`), and an estimate until then. `key` is whatever
 * the count depends on: when it changes the pages are counted again, and
 * the last count stands meanwhile (not the estimate: the sheet's width
 * would jump there and back).
 */
export function usePrintedPages(count: (() => Promise<number | null>) | undefined, estimate: number, key: string): { pages: number; exact: boolean } {
  const [counted, setCounted] = useState<{ key: string; pages: number } | null>(null);
  useEffect(() => {
    if (!count) return;
    let live = true;
    const timer = setTimeout(() => {
      void count().then((pages) => {
        if (live && pages) setCounted({ key, pages });
      });
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [count, key]);
  return counted ? { pages: counted.pages, exact: counted.key === key } : { pages: estimate, exact: false };
}

/** What the page count depends on, near enough to know when to count again. */
export const pagesKey = (book: Book, words: number): string => JSON.stringify([book.print, book.design, Math.round(words / 150)]);

const SLOT_NAMES: Record<CoverSlot, string> = { front: "Front cover", back: "Back cover", spine: "Spine", wrap: "Whole cover" };

/** One piece of artwork: what is there, and the buttons to change it. */
function ArtSlot({
  slot,
  hint,
  art,
  notes,
  disabled,
  busy,
  onChoose,
  onRemove,
}: {
  slot: CoverSlot;
  hint: string;
  art: CoverArt | null;
  notes: string[];
  disabled: boolean;
  busy: boolean;
  onChoose: (file: File) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const name = SLOT_NAMES[slot];
  return (
    <div className="wf-cover-slot">
      <div className={`wf-cover-thumb ${slot}`}>{art ? <img src={normalizeAttachmentSrc(art.src)} alt="" decoding="async" loading="lazy" /> : <ImagePlus size={16} aria-hidden />}</div>
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

/** The spine isn't as wide as it was when the artwork was put in. */
function DriftNote({ cover, g }: { cover: BookCover; g: CoverGeometry }) {
  const drift = spineDrift(cover, g);
  if (!drift) return null;
  const by = Math.abs(drift.by).toFixed(3);
  return (
    <p className="wf-cover-note">
      <AlertTriangle size={12} aria-hidden /> This artwork was put in when the book had {drift.was} pages. It has {drift.now} now, so the spine is {by} in {drift.by > 0 ? "wider" : "narrower"}. Check it against a new template.
    </p>
  );
}

/**
 * The Book panel's Cover tab: the cover's pictures, kept with the
 * manuscript, and the cover as it stands. The front cover (the ebook's
 * cover too), and the paperback's: a back and a spine to go with that
 * front, or the whole cover in one piece. Words, colours and where a
 * picture sits are the cover editor's (`onOpen`).
 */
export function CoverTab({
  book,
  disabled,
  patch,
  words,
  chapters,
  pictures,
  countPages,
  onOpen,
}: {
  book: Book;
  disabled: boolean;
  patch: Patch;
  words: number;
  chapters: number;
  pictures?: CoverPictures;
  countPages?: () => Promise<number | null>;
  /** Open the cover editor (and what is saved from it). */
  onOpen?: () => void;
}) {
  const [busy, setBusy] = useState<CoverSlot | null>(null);
  const { pages, exact } = usePrintedPages(countPages, estimatePages(words, chapters, book.print, book.design), pagesKey(book, words));
  const printKey = JSON.stringify(book.print);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `printKey` is the print settings, said once
  const g = useMemo(() => coverGeometry(book.print, pages), [printKey, pages]);
  const size = sizeWords(g);
  const cover = book.cover;
  const { scene } = useCoverScene(cover, g);
  const locked = disabled || !pictures;

  const choose = async (slot: CoverSlot, file: File) => {
    if (!pictures) return;
    setBusy(slot);
    try {
      const { storeArt } = await import("../cover/files");
      const { art, resaved } = await storeArt(file, pictures.upload, pictures.limit);
      patch({
        [`cover.${slot}`]: encodeArt(art),
        // (What depends on the spine's width was made for this many pages.)
        ...(slot === "wrap" || slot === "spine" ? { "cover.pages": g.pages } : {}),
      });
      if (resaved) toast("That picture was too heavy to keep as it was, so it was saved as a JPEG.", "info");
    } catch (e) {
      toastError(messageOf(e, "That picture couldn’t be added."));
    } finally {
      setBusy(null);
    }
  };
  const slot = (which: CoverSlot, hint: string, notes: string[]) => (
    <ArtSlot
      slot={which}
      hint={hint}
      art={cover[which]}
      notes={notes}
      disabled={locked}
      busy={busy === which}
      onChoose={(file) => void choose(which, file)}
      onRemove={() => patch({ [`cover.${which}`]: null })}
    />
  );
  // (Under a whole cover the three pieces aren't printed: nothing to say of how they would.)
  const printing = (which: CoverSlot) => (cover[which] && (which === "wrap" || !cover.wrap) ? printNotes(which, cover[which]!, g, cover.looks[which]) : []);

  return (
    <div className="wf-inspector-body">
      <section>
        <h4>Front cover</h4>
        {slot("front", "A JPEG or a PNG", cover.front ? [...ebookNotes(cover.front), ...printing("front")] : [])}
        <p className="wf-inspector-dim">The ebook’s cover, and the front of the paperback. Kept with the manuscript, so every export uses it.</p>
      </section>

      <section>
        <h4>Paperback cover</h4>
        <p className="wf-inspector-dim">
          A paperback’s cover is one sheet: back, spine and front. For {exact ? "" : "about "}
          {g.pages.toLocaleString("en-US")} pages on {g.paper} paper it is {size.inches} ({size.pixels}), with a spine of {size.spine}.
          {exact ? "" : " The pages are still being counted."}
        </p>
        {slot("back", `${g.trim.w} × ${g.trim.h} in and the edge that is trimmed off`, printing("back"))}
        {slot("spine", g.spineText ? `${size.spine} wide` : `${size.spine} wide. Too narrow for words under ${SPINE_TEXT_PAGES} pages.`, printing("spine"))}
        {slot("wrap", "All three in one picture, as a designer sends it", printing("wrap"))}
        {cover.wrap && (cover.back || cover.spine) && <p className="wf-inspector-dim">The whole cover is what prints. The back and the spine above are not used while it is here.</p>}
        <DriftNote cover={cover} g={g} />
      </section>

      <section>
        <h4>The cover as it stands</h4>
        <CoverSvg g={g} scene={scene} guides={false} className="small" />
        <div className="wf-cover-actions">
          <button type="button" className="wf-primary" onClick={onOpen} disabled={!onOpen}>
            Open the cover editor…
          </button>
        </div>
        <p className="wf-inspector-dim">
          In the editor you add the title, the author and the back’s words, choose their fonts and colours, and place the pictures. It also saves a template at this exact size, and the finished cover as a PDF for the printer.
        </p>
      </section>
    </div>
  );
}
