import { useRef } from "react";

import { Flyout, FlyoutItem } from "../../editor/ui/Flyout";
import type { CmdError } from "../../lib/backend";
import { toast, toastError } from "../../platform/toast";
import { encodeArt, parseArt } from "../cover/art";
import { trimSize, type Book } from "../model/bookMap";
import { ArtPicker, sharpness, useArtStore } from "./ArtPicker";
import type { CoverPictures } from "./Cover";

type Patch = (p: Record<string, unknown>) => void;

/** One chapter as the list of chapter art shows it: where its heading is,
 *  its name, and what it says of its own art (its `art` and `artFacing`:
 *  "none", a picture, or null for the book's). */
export interface ChapterArtRow {
  pos: number;
  name: string;
  art: string | null;
  facing: string | null;
}

/** What the editor gives the list: its chapters, a way to set one's art,
 *  and the newest format level it may write (a chapter's own art is 4). */
export interface ChapterArtSource {
  rows: ChapterArtRow[];
  set: (pos: number, which: "art" | "artFacing", value: string | null) => void;
  level: number;
}

const said = (value: string | null): string => (value === "none" ? "None" : value && parseArt(value) ? "Its own" : "The book’s");

/**
 * Book ▸ Design ▸ Chapter art: a picture behind each chapter's first page
 * (with the text over it, dark or light) and one on the page facing it.
 * The book's own for every chapter, and below them each chapter's choice.
 */
export function ChapterArtSection({ book, disabled, patch, pictures, chapters }: { book: Book; disabled: boolean; patch: Patch; pictures?: CoverPictures; chapters?: ChapterArtSource }) {
  const d = book.design;
  const { busy, choose } = useArtStore(pictures, patch);
  const page = trimSize(book.print);
  // A full page with its bleed, at 300 pixels an inch.
  const tall = Math.round((page.h + 0.25) * 300);
  const notes = (art: Book["art"]["opener"]) => (art ? sharpness(art, page.h + 0.25) : []);
  const anyArt = !!book.art.opener || !!book.art.facing || !!chapters?.rows.some((r) => (r.art && r.art !== "none") || (r.facing && r.facing !== "none"));
  return (
    <section>
      <h4>Chapter art</h4>
      <p className="wf-inspector-dim">A picture behind each chapter’s first page with its words printed over it, and one on the left-hand page facing it.</p>
      <ArtPicker
        name="Behind the first page"
        hint={`A whole page at least ${tall.toLocaleString("en-US")} pixels tall`}
        art={book.art.opener}
        notes={notes(book.art.opener)}
        disabled={disabled || !pictures}
        busy={busy === "art.opener"}
        onChoose={(file) => void choose("art.opener", file)}
        onRemove={() => patch({ "art.opener": null })}
      />
      <ArtPicker
        name="Facing the first page"
        hint={`A whole page at least ${tall.toLocaleString("en-US")} pixels tall`}
        art={book.art.facing}
        notes={notes(book.art.facing)}
        disabled={disabled || !pictures}
        busy={busy === "art.facing"}
        onChoose={(file) => void choose("art.facing", file)}
        onRemove={() => patch({ "art.facing": null })}
      />
      <label className="wf-inspector-row">
        <span>Words on a picture</span>
        <select disabled={disabled} value={d.openerInk} onChange={(e) => patch({ "design.openerInk": e.target.value })}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      {anyArt && <p className="wf-inspector-dim">A chapter with a facing picture opens on a right-hand page. A blank page goes before it where needed. Turn on With bleed when you export the paperback, so the art reaches the edge of the paper.</p>}
      {chapters && chapters.rows.length > 0 && (chapters.level >= 4 ? <ChapterList chapters={chapters} pictures={pictures} disabled={disabled} /> : <p className="wf-inspector-dim">A picture for a single chapter needs this server updated. The pictures above are used for every chapter.</p>)}
    </section>
  );
}

const messageOf = (e: unknown, fallback: string): string => (e as Partial<CmdError> | null)?.message || fallback;

/** Each chapter's own choice: the book's picture, none, or its own. */
function ChapterList({ chapters, pictures, disabled }: { chapters: ChapterArtSource; pictures?: CoverPictures; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const choosing = useRef<{ pos: number; which: "art" | "artFacing" } | null>(null);
  const pick = (pos: number, which: "art" | "artFacing") => {
    choosing.current = { pos, which };
    input.current?.click();
  };
  const menu = (row: ChapterArtRow, which: "art" | "artFacing", title: string) => {
    const value = which === "art" ? row.art : row.facing;
    return (
      <Flyout title={title} label={said(value)} disabled={disabled} className="wf-chapter-art-pick">
        {(close) => (
          <>
            <FlyoutItem checked={value === null} onPick={() => (chapters.set(row.pos, which, null), close())}>
              The book’s
            </FlyoutItem>
            <FlyoutItem checked={value === "none"} onPick={() => (chapters.set(row.pos, which, "none"), close())}>
              None
            </FlyoutItem>
            <FlyoutItem checked={!!value && value !== "none"} disabled={!pictures} onPick={() => (pick(row.pos, which), close())}>
              Its own picture…
            </FlyoutItem>
          </>
        )}
      </Flyout>
    );
  };
  return (
    <div className="wf-chapter-art-list">
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          const at = choosing.current;
          if (!file || !at || !pictures) return;
          void (async () => {
            try {
              const { storeArt } = await import("../cover/files");
              const { art, resaved } = await storeArt(file, pictures.upload, pictures.limit);
              chapters.set(at.pos, at.which, encodeArt(art));
              if (resaved) toast("That picture was too heavy to keep as it was, so it was saved as a JPEG.", "info");
            } catch (err) {
              toastError(messageOf(err, "That picture couldn’t be added."));
            }
          })();
        }}
      />
      <div className="wf-chapter-art-row head" aria-hidden>
        <span />
        <span>Behind</span>
        <span>Facing</span>
      </div>
      {chapters.rows.map((row) => (
        <div key={row.pos} className="wf-chapter-art-row">
          <span className="wf-chapter-art-name" title={row.name}>
            {row.name}
          </span>
          {menu(row, "art", `Behind the first page of ${row.name}`)}
          {menu(row, "artFacing", `Facing the first page of ${row.name}`)}
        </div>
      ))}
    </div>
  );
}
