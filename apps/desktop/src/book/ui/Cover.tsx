import { AlertTriangle } from "lucide-react";
import { useMemo } from "react";

import type { ImageUploader } from "../../lib/upload";
import type { BookCover, CoverArt, CoverSlot } from "../cover/art";
import { coverGeometry, ebookNotes, printNotes, sizeWords, SPINE_TEXT_PAGES, spineDrift, type CoverGeometry } from "../cover/geometry";
import type { Book } from "../model/bookMap";
import { estimatePages } from "../model/trims";
import { ArtPicker, useArtStore } from "./ArtPicker";
import { CoverSvg, useCoverScene } from "./CoverView";
import { pagesKey, usePrintedPages } from "./printedPages";

/** Where a manuscript keeps its pictures, and the most one may weigh there. */
export interface CoverPictures {
  upload: ImageUploader;
  limit: number;
}

type Patch = (p: Record<string, unknown>) => void;

const SLOT_NAMES: Record<CoverSlot, string> = { front: "Front cover", back: "Back cover", spine: "Spine", wrap: "Whole cover" };

/** One piece of artwork: what is there, and the buttons to change it. */
function ArtSlot({ slot, ...rest }: { slot: CoverSlot; hint: string; art: CoverArt | null; notes: string[]; disabled: boolean; busy: boolean; onChoose: (file: File) => void; onRemove: () => void }) {
  return <ArtPicker name={SLOT_NAMES[slot]} thumb={slot} {...rest} />;
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
  const { pages, exact } = usePrintedPages(countPages, estimatePages(words, chapters, book.print, book.design), pagesKey(book, words));
  const printKey = JSON.stringify(book.print);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `printKey` is the print settings, said once
  const g = useMemo(() => coverGeometry(book.print, pages), [printKey, pages]);
  const size = sizeWords(g);
  const cover = book.cover;
  const { scene } = useCoverScene(cover, g);
  const locked = disabled || !pictures;

  const { busy, choose: store } = useArtStore(pictures, patch);
  // (What depends on the spine's width was made for this many pages.)
  const choose = (slot: CoverSlot, file: File) => store(`cover.${slot}`, file, slot === "wrap" || slot === "spine" ? { "cover.pages": g.pages } : {});
  const slot = (which: CoverSlot, hint: string, notes: string[]) => (
    <ArtSlot
      slot={which}
      hint={hint}
      art={cover[which]}
      notes={notes}
      disabled={locked}
      busy={busy === `cover.${which}`}
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
          In the editor you add the title, the author and the back’s words, choose their fonts and colors, and place the pictures. It also saves a template at this exact size, and the finished cover as a PDF for the printer.
        </p>
      </section>
    </div>
  );
}
