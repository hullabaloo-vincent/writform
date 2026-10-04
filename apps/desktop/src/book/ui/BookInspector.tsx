import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";

import { InchStepper } from "../../apps/documents/DocSettingsPanel";
import { BOOK_FONTS, bookFont, ORNAMENTS } from "../fonts/registry";
import { choosePreset, TRIMS, updateBook, type Book } from "../model/bookMap";
import { validIsbn } from "../model/buildModel";
import { numberLabel, type NumberStyle } from "../model/chapters";
import { PRESETS, type BookDesign } from "../model/presets";
import { autoMargins, estimatePages, kdpMinInside, spineWidth } from "../model/trims";
import { trimSize } from "../model/bookMap";

type Tab = "book" | "design" | "print" | "ebook";

const LANGUAGES = [
  ["en-US", "English (US)"],
  ["en-GB", "English (UK)"],
  ["fr", "French"],
  ["de", "German"],
  ["es", "Spanish"],
  ["it", "Italian"],
  ["nl", "Dutch"],
  ["pt", "Portuguese"],
] as const;

/**
 * The book inspector (Manuscript format): the book's details, its design,
 * print settings and ebook settings — everything that decides how the book
 * LOOKS, kept apart from the manuscript's text. Saved with the document.
 */
export function BookInspector({
  ydoc,
  book,
  readonly,
  words,
  chapters,
}: {
  ydoc: Y.Doc;
  book: Book;
  readonly: boolean;
  words: number;
  chapters: number;
}) {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem("wf-book-tab") as Tab | null) ?? "book";
    } catch {
      return "book";
    }
  });
  const pick = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem("wf-book-tab", t);
    } catch {
      // per-device convenience only
    }
  };
  const patch = (p: Record<string, unknown>) => {
    if (!readonly) updateBook(ydoc, p);
  };

  return (
    <aside className="wf-doc-panel wf-inspector wf-book-inspector">
      <header className="wf-doc-panel-header wf-inspector-tabs">
        {(["book", "design", "print", "ebook"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => pick(t)}>
            {t === "book" ? "Book" : t === "design" ? "Design" : t === "print" ? "Print" : "Ebook"}
          </button>
        ))}
      </header>
      {tab === "book" && <BookTab book={book} disabled={readonly} patch={patch} />}
      {tab === "design" && (
        <DesignTab ydoc={ydoc} book={book} disabled={readonly} patch={patch} />
      )}
      {tab === "print" && (
        <PrintTab book={book} disabled={readonly} patch={patch} words={words} chapters={chapters} />
      )}
      {tab === "ebook" && <EbookTab book={book} disabled={readonly} patch={patch} />}
    </aside>
  );
}

type Patch = (p: Record<string, unknown>) => void;

/** Text that commits while typing (debounced) and on blur. */
function TextField({
  label,
  value,
  field,
  patch,
  disabled,
  placeholder,
  area,
  rows = 3,
  hint,
  invalid,
}: {
  label: string;
  value: string;
  field: string;
  patch: Patch;
  disabled: boolean;
  placeholder?: string;
  area?: boolean;
  rows?: number;
  hint?: string;
  invalid?: string | null;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const commit = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (v !== value) patch({ [field]: v.trim() ? v : null });
  };
  const common = {
    value: draft,
    disabled,
    placeholder,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      commit(draft);
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const v = e.target.value;
      setDraft(v);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => commit(v), 400);
    },
  };
  return (
    <label className={`wf-inspector-field ${area ? "area" : ""}`}>
      <span>{label}</span>
      {area ? <textarea rows={rows} {...common} /> : <input {...common} />}
      {invalid && <small className="wf-inspector-invalid">{invalid}</small>}
      {hint && !invalid && <small className="wf-inspector-dim">{hint}</small>}
    </label>
  );
}

function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  disabled: boolean;
}) {
  return (
    <label className="wf-inspector-row">
      <span>{label}</span>
      <select
        disabled={disabled}
        value={String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const found = options.find(([v]) => String(v) === raw);
          if (found) onChange(found[0]);
        }}
      >
        {options.map(([v, text]) => (
          <option key={String(v)} value={String(v)}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function Check({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
  hint?: string;
}) {
  return (
    <label className="wf-inspector-check" title={hint}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function BookTab({ book, disabled, patch }: { book: Book; disabled: boolean; patch: Patch }) {
  const m = book.meta;
  const isbn = (v: string) => (v && !validIsbn(v) ? "Not a valid ISBN — check the digits." : null);
  const [contactOpen, setContactOpen] = useState(false);
  return (
    <div className="wf-inspector-body">
      <section>
        <h4>Title</h4>
        <TextField label="Title" value={m.title} field="meta.title" patch={patch} disabled={disabled} />
        <TextField label="Subtitle" value={m.subtitle} field="meta.subtitle" patch={patch} disabled={disabled} />
        <TextField label="Author" value={m.author} field="meta.author" patch={patch} disabled={disabled} />
        <div className="wf-inspector-pair">
          <TextField label="Series" value={m.series} field="meta.series" patch={patch} disabled={disabled} />
          <label className="wf-inspector-field narrow">
            <span>Book #</span>
            <input
              type="number"
              min={0}
              max={999}
              disabled={disabled}
              value={m.seriesNumber ?? ""}
              onChange={(e) =>
                patch({ "meta.seriesNumber": e.target.value ? Math.floor(Number(e.target.value)) : null })
              }
            />
          </label>
        </div>
        <Select
          label="Language"
          value={m.language}
          options={LANGUAGES.some(([v]) => v === m.language) ? LANGUAGES : [[m.language, m.language], ...LANGUAGES]}
          onChange={(v) => patch({ "meta.language": v })}
          disabled={disabled}
        />
      </section>

      <section>
        <h4>Publishing</h4>
        <TextField label="Publisher" value={m.publisher} field="meta.publisher" patch={patch} disabled={disabled} />
        <TextField label="Edition" value={m.edition} field="meta.edition" patch={patch} disabled={disabled} placeholder="First edition" />
        <TextField label="ISBN (print)" value={m.isbnPrint} field="meta.isbnPrint" patch={patch} disabled={disabled} invalid={isbn(m.isbnPrint)} />
        <TextField label="ISBN (ebook)" value={m.isbnEbook} field="meta.isbnEbook" patch={patch} disabled={disabled} invalid={isbn(m.isbnEbook)} />
      </section>

      <section>
        <h4>Copyright page</h4>
        <div className="wf-inspector-pair">
          <label className="wf-inspector-field narrow">
            <span>Year</span>
            <input
              type="number"
              min={1000}
              max={9999}
              disabled={disabled}
              placeholder={String(new Date().getFullYear())}
              value={m.copyrightYear ?? ""}
              onChange={(e) =>
                patch({ "meta.copyrightYear": e.target.value ? Math.floor(Number(e.target.value)) : null })
              }
            />
          </label>
          <TextField
            label="Holder"
            value={m.copyrightHolder}
            field="meta.copyrightHolder"
            patch={patch}
            disabled={disabled}
            placeholder={m.author || "Your name"}
          />
        </div>
        <Select
          label="Notice"
          value={m.copyrightNotice}
          options={[
            ["standard", "All rights reserved"],
            ["fiction", "Fiction disclaimer + rights"],
            ["custom", "My own text"],
          ]}
          onChange={(v) => patch({ "meta.copyrightNotice": v })}
          disabled={disabled}
        />
        {m.copyrightNotice === "custom" && (
          <TextField
            label="Copyright text"
            value={m.copyrightText}
            field="meta.copyrightText"
            patch={patch}
            disabled={disabled}
            area
            rows={5}
          />
        )}
      </section>

      <section>
        <h4>Front & back matter</h4>
        <TextField label="Dedication" value={m.dedication} field="meta.dedication" patch={patch} disabled={disabled} area rows={2} placeholder="For…" />
        <TextField label="Epigraph" value={m.epigraph} field="meta.epigraph" patch={patch} disabled={disabled} area rows={3} />
        <TextField label="Epigraph source" value={m.epigraphSource} field="meta.epigraphSource" patch={patch} disabled={disabled} />
        <label className="wf-inspector-field area">
          <span>Also by (one title per line)</span>
          <AlsoBy value={m.alsoBy} patch={patch} disabled={disabled} />
        </label>
        <TextField label="About the author" value={m.aboutAuthor} field="meta.aboutAuthor" patch={patch} disabled={disabled} area rows={4} />
        <TextField
          label="Description"
          value={m.description}
          field="meta.description"
          patch={patch}
          disabled={disabled}
          area
          rows={3}
          hint="Used in the ebook's details."
        />
      </section>

      <section>
        <button className="wf-inspector-disclosure" onClick={() => setContactOpen((v) => !v)}>
          {contactOpen ? "▾" : "▸"} Submission manuscript
        </button>
        {contactOpen && (
          <>
            <p className="wf-inspector-dim">
              For the standard manuscript’s title page. Saved with the document, so collaborators see it.
            </p>
            <TextField label="Legal name" value={book.contact.legalName} field="contact.legalName" patch={patch} disabled={disabled} />
            <TextField label="Address" value={book.contact.address} field="contact.address" patch={patch} disabled={disabled} area rows={2} />
            <TextField label="Email" value={book.contact.email} field="contact.email" patch={patch} disabled={disabled} />
            <TextField label="Phone" value={book.contact.phone} field="contact.phone" patch={patch} disabled={disabled} />
            <TextField label="Agent" value={book.contact.agent} field="contact.agent" patch={patch} disabled={disabled} area rows={2} />
            <TextField label="Short title (header)" value={book.smf.shortTitle} field="smf.shortTitle" patch={patch} disabled={disabled} placeholder={m.title.split(/\s+/).slice(0, 3).join(" ").toUpperCase()} />
            <Select
              label="Typeface"
              value={book.smf.font}
              options={[
                ["times", "Times-style serif"],
                ["courier", "Courier"],
              ] as const}
              onChange={(v) => patch({ "smf.font": v })}
              disabled={disabled}
            />
            <Select
              label="Paper"
              value={book.smf.paper}
              options={[
                ["letter", "US Letter"],
                ["a4", "A4"],
              ] as const}
              onChange={(v) => patch({ "smf.paper": v })}
              disabled={disabled}
            />
            <Select
              label="Italics"
              value={book.smf.italics}
              options={[
                ["italic", "Keep italics"],
                ["underline", "Underline (traditional)"],
              ] as const}
              onChange={(v) => patch({ "smf.italics": v })}
              disabled={disabled}
            />
            <p className="wf-inspector-dim">
              The PDF uses Libertinus for the serif (Times New Roman can’t be embedded); the Word file
              uses Times New Roman itself.
            </p>
          </>
        )}
      </section>

      <p className="wf-inspector-dim wf-inspector-foot">
        Saved with the manuscript — everyone working on it sees the same book.
      </p>
    </div>
  );
}

function AlsoBy({ value, patch, disabled }: { value: string[]; patch: Patch; disabled: boolean }) {
  const [draft, setDraft] = useState(value.join("\n"));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value.join("\n"));
  }, [value]);
  return (
    <textarea
      rows={3}
      disabled={disabled}
      value={draft}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        const list = draft.split("\n").map((s) => s.trim()).filter(Boolean);
        patch({ "meta.alsoBy": list.length ? list : null });
      }}
    />
  );
}

/** A preset's look, drawn in its own fonts. */
function Specimen({ design }: { design: BookDesign }) {
  const label = numberLabel(1, design.chapterNumber === "as-written" ? "word" : design.chapterNumber, design.chapterLabel);
  return (
    <span
      className="wf-book-specimen"
      style={{
        fontFamily: bookFont(design.bodyFont).css,
        textAlign: design.headingAlign,
      }}
    >
      {label && (
        <span
          className="wf-book-specimen-label"
          style={{
            fontFamily: bookFont(design.headingFont).css,
            fontVariant: design.labelCase === "smallcaps" ? "small-caps" : undefined,
            textTransform: design.labelCase === "upper" ? "uppercase" : undefined,
          }}
        >
          {label}
        </span>
      )}
      <span
        className="wf-book-specimen-title"
        style={{
          fontFamily: bookFont(design.headingFont).css,
          fontStyle: design.titleItalic ? "italic" : undefined,
          textTransform: design.titleCase === "upper" ? "uppercase" : undefined,
          fontVariant: design.titleCase === "smallcaps" ? "small-caps" : undefined,
        }}
      >
        The Long Road
      </span>
      {design.headingOrnament && <span className="wf-book-specimen-orn">{design.headingOrnament}</span>}
      <span className="wf-book-specimen-text" style={{ textAlign: design.justify ? "justify" : "left" }}>
        {design.dropCap ? <span className="wf-book-specimen-cap">T</span> : "T"}
        <span style={{ fontVariant: design.leadIn !== "none" ? "small-caps" : undefined }}>he rain</span>{" "}
        had come early that year, and the river ran high past the mill.
      </span>
    </span>
  );
}

function DesignTab({
  ydoc,
  book,
  disabled,
  patch,
}: {
  ydoc: Y.Doc;
  book: Book;
  disabled: boolean;
  patch: Patch;
}) {
  const d = book.design;
  const set = <K extends keyof BookDesign>(key: K, value: BookDesign[K]) => patch({ [`design.${key}`]: value });
  const fonts = BOOK_FONTS.map((f) => [f.id, f.label] as const);
  const customized = book.overridden.length > 0;
  return (
    <div className="wf-inspector-body">
      <section>
        <h4>
          Style{" "}
          {customized && <span className="wf-book-badge">Customized</span>}
        </h4>
        <div className="wf-book-presets">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`wf-book-preset ${d.preset === p.id ? "active" : ""}`}
              disabled={disabled}
              title={p.description}
              onClick={() => choosePreset(ydoc, p.id)}
            >
              <Specimen design={d.preset === p.id ? d : p.design} />
              <span className="wf-book-preset-name">{p.label}</span>
            </button>
          ))}
        </div>
        {customized && (
          <button className="wf-inspector-link" disabled={disabled} onClick={() => choosePreset(ydoc, d.preset)}>
            Reset to {PRESETS.find((p) => p.id === d.preset)?.label ?? "preset"}
          </button>
        )}
      </section>

      <section>
        <h4>Body text</h4>
        <Select label="Font" value={d.bodyFont} options={fonts} onChange={(v) => set("bodyFont", v)} disabled={disabled} />
        <Select
          label="Size"
          value={d.bodySize}
          options={[9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13].map((v) => [v, `${v} pt`] as const)}
          onChange={(v) => set("bodySize", v)}
          disabled={disabled}
        />
        <Select
          label="Line spacing"
          value={d.leading}
          options={[12, 13, 13.5, 14, 14.5, 15, 15.5, 16, 17].map((v) => [v, `${v} pt`] as const)}
          onChange={(v) => set("leading", v)}
          disabled={disabled}
        />
        <Select
          label="Paragraph indent"
          value={d.indent}
          options={[[0.8, "Small"], [1.2, "Medium"], [1.5, "Large"], [2, "Extra large"]] as const}
          onChange={(v) => set("indent", v)}
          disabled={disabled}
        />
        <Check label="Justified text" checked={d.justify} onChange={(v) => set("justify", v)} disabled={disabled} />
        <Check label="Hyphenation" checked={d.hyphenate} onChange={(v) => set("hyphenate", v)} disabled={disabled} />
      </section>

      <section>
        <h4>Chapter headings</h4>
        <Select<NumberStyle>
          label="Numbers"
          value={d.chapterNumber}
          options={[
            ["word", "Chapter One"],
            ["numeral", "Chapter 1"],
            ["roman", "Chapter I"],
            ["none", "No numbers"],
            ["as-written", "As typed in the heading"],
          ]}
          onChange={(v) => set("chapterNumber", v)}
          disabled={disabled}
        />
        {d.chapterNumber !== "none" && d.chapterNumber !== "as-written" && (
          <TextField label="Label" value={d.chapterLabel} field="design.chapterLabel" patch={patch} disabled={disabled} hint="“Chapter”, or empty for the number alone." />
        )}
        <Select
          label="Label style"
          value={d.labelCase}
          options={[["smallcaps", "Small caps"], ["upper", "Uppercase"], ["title", "As written"]] as const}
          onChange={(v) => set("labelCase", v)}
          disabled={disabled}
        />
        <Select
          label="Titles"
          value={d.chapterTitle}
          options={[["show", "Show chapter titles"], ["hide", "Numbers only"]] as const}
          onChange={(v) => set("chapterTitle", v)}
          disabled={disabled}
        />
        <Select
          label="Title style"
          value={d.titleCase}
          options={[["as-typed", "As typed"], ["upper", "Uppercase"], ["smallcaps", "Small caps"]] as const}
          onChange={(v) => set("titleCase", v)}
          disabled={disabled}
        />
        <Check label="Italic titles" checked={d.titleItalic} onChange={(v) => set("titleItalic", v)} disabled={disabled} />
        <Select label="Heading font" value={d.headingFont} options={fonts} onChange={(v) => set("headingFont", v)} disabled={disabled} />
        <Select
          label="Alignment"
          value={d.headingAlign}
          options={[["center", "Centered"], ["left", "Left"]] as const}
          onChange={(v) => set("headingAlign", v)}
          disabled={disabled}
        />
        <Select
          label="Ornament"
          value={d.headingOrnament}
          options={[["", "None"], ...ORNAMENTS.map((o) => [o, o] as const)]}
          onChange={(v) => set("headingOrnament", v)}
          disabled={disabled}
        />
        <label className="wf-inspector-row">
          <span>Space above</span>
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.02}
            disabled={disabled}
            value={d.sink}
            onChange={(e) => set("sink", Number(e.target.value))}
          />
        </label>
      </section>

      <section>
        <h4>Chapter openings</h4>
        <Select
          label="Drop cap"
          value={d.dropCap}
          options={[[0, "None"], [2, "2 lines"], [3, "3 lines"], [4, "4 lines"]] as const}
          onChange={(v) => set("dropCap", v)}
          disabled={disabled}
        />
        <Select
          label="Small caps"
          value={d.leadIn}
          options={[["none", "None"], ["first-words", "First few words"], ["first-line", "Whole first line"]] as const}
          onChange={(v) => set("leadIn", v)}
          disabled={disabled}
        />
      </section>

      <section>
        <h4>Scene breaks</h4>
        <Select
          label="Style"
          value={d.sceneBreak}
          options={[["ornament", "Ornament"], ["blank", "Blank line"]] as const}
          onChange={(v) => set("sceneBreak", v)}
          disabled={disabled}
        />
        {d.sceneBreak === "ornament" && (
          <Select
            label="Ornament"
            value={d.ornament}
            options={ORNAMENTS.map((o) => [o, o] as const)}
            onChange={(v) => set("ornament", v)}
            disabled={disabled}
          />
        )}
        {d.sceneBreak === "blank" && (
          <p className="wf-inspector-dim">A break that lands at the top or bottom of a page still shows the ornament, so it’s never lost.</p>
        )}
      </section>

      <section>
        <h4>Page furniture</h4>
        <Select
          label="Running heads"
          value={d.runningHeads}
          options={[["author-title", "Author / book title"], ["title-chapter", "Book title / chapter"], ["none", "None"]] as const}
          onChange={(v) => set("runningHeads", v)}
          disabled={disabled}
        />
        <Select
          label="Head style"
          value={d.headStyle}
          options={[["smallcaps", "Small caps"], ["italic", "Italic"]] as const}
          onChange={(v) => set("headStyle", v)}
          disabled={disabled}
        />
        <Select
          label="Page numbers"
          value={d.folio}
          options={[["top-outside", "Top, outside"], ["bottom-center", "Bottom, centered"], ["bottom-outside", "Bottom, outside"]] as const}
          onChange={(v) => set("folio", v)}
          disabled={disabled}
        />
        <Check label="Page number on chapter openings" checked={d.folioOnOpeners} onChange={(v) => set("folioOnOpeners", v)} disabled={disabled} />
        <Select
          label="Block quotes"
          value={d.blockquote}
          options={[["indent", "Indented"], ["indent-italic", "Indented, italic"], ["smaller", "Indented, smaller"]] as const}
          onChange={(v) => set("blockquote", v)}
          disabled={disabled}
        />
        <Select
          label="Numbers in text"
          value={d.figures}
          options={[["default", "Font default"], ["oldstyle", "Old-style (1984)"], ["lining", "Lining"]] as const}
          onChange={(v) => set("figures", v)}
          disabled={disabled}
        />
        <Select
          label="Quotes"
          value={d.quotes}
          options={[["auto", "Curly (typographer’s)"], ["straight", "Leave as typed"]] as const}
          onChange={(v) => set("quotes", v)}
          disabled={disabled}
        />
      </section>
    </div>
  );
}

function PrintTab({
  book,
  disabled,
  patch,
  words,
  chapters,
}: {
  book: Book;
  disabled: boolean;
  patch: Patch;
  words: number;
  chapters: number;
}) {
  const p = book.print;
  const trim = trimSize(p);
  const pages = estimatePages(words, chapters, p, book.design);
  const auto = autoMargins(trim, pages);
  const set = (key: string, value: unknown) => patch({ [`print.${key}`]: value });
  return (
    <div className="wf-inspector-body">
      <section>
        <h4>Trim size</h4>
        <Select
          label="Size"
          value={p.trim}
          options={TRIMS.map((t) => [t.id, t.label] as const)}
          onChange={(v) => set("trim", v)}
          disabled={disabled}
        />
        {p.trim === "custom" && (
          <div className="wf-inspector-grid">
            <InchStepper label="Width" value={p.w} min={3} max={12} step={0.125} disabled={disabled} onChange={(v) => set("w", v)} />
            <InchStepper label="Height" value={p.h} min={4} max={14} step={0.125} disabled={disabled} onChange={(v) => set("h", v)} />
          </div>
        )}
        <Select
          label="Paper"
          value={p.paper}
          options={[["cream", "Cream"], ["white", "White"]] as const}
          onChange={(v) => set("paper", v)}
          disabled={disabled}
        />
        <p className="wf-inspector-dim">
          About {pages.toLocaleString()} pages · spine {spineWidth(pages, p.paper).toFixed(3)} in
        </p>
      </section>

      <section>
        <h4>Margins</h4>
        <Select
          label="Margins"
          value={p.margins}
          options={[["auto", "Automatic (KDP-safe)"], ["custom", "Custom"]] as const}
          onChange={(v) => set("margins", v)}
          disabled={disabled}
        />
        {p.margins === "auto" ? (
          <p className="wf-inspector-dim">
            Inside {auto.inside}″ · outside {auto.outside}″ · top {auto.top}″ · bottom {auto.bottom}″. The
            inside margin grows with the page count (KDP needs {kdpMinInside(pages)}″ at {pages} pages).
          </p>
        ) : (
          <div className="wf-inspector-grid">
            <InchStepper label="Top" value={p.mt} min={0.25} max={2} disabled={disabled} onChange={(v) => set("mt", v)} />
            <InchStepper label="Bottom" value={p.mb} min={0.25} max={2} disabled={disabled} onChange={(v) => set("mb", v)} />
            <InchStepper label="Inside" value={p.mi} min={0.375} max={2} step={0.125} disabled={disabled} onChange={(v) => set("mi", v)} />
            <InchStepper label="Outside" value={p.mo} min={0.25} max={2} step={0.125} disabled={disabled} onChange={(v) => set("mo", v)} />
          </div>
        )}
      </section>

      <section>
        <h4>Pages</h4>
        <Check label="Chapters start on a right-hand page" checked={p.recto} onChange={(v) => set("recto", v)} disabled={disabled} />
        <Select
          label="Page 1 is"
          value={p.arabicStart}
          options={[["first-section", "The first page of the story"], ["first-chapter", "Chapter One"]] as const}
          onChange={(v) => set("arabicStart", v)}
          disabled={disabled}
        />
      </section>

      <section>
        <h4>Front & back matter</h4>
        <Check label="Half title" checked={p.halfTitle} onChange={(v) => set("halfTitle", v)} disabled={disabled} />
        <Check label="Title page" checked={p.titlePage} onChange={(v) => set("titlePage", v)} disabled={disabled} />
        <Check label="Copyright page" checked={p.copyright} onChange={(v) => set("copyright", v)} disabled={disabled} />
        <Check label="Dedication" checked={p.dedication} onChange={(v) => set("dedication", v)} disabled={disabled} />
        <Check label="Epigraph" checked={p.epigraph} onChange={(v) => set("epigraph", v)} disabled={disabled} />
        <Select
          label="Contents"
          value={p.toc}
          options={[["auto", "When chapters have titles"], ["on", "Always"], ["off", "Never"]] as const}
          onChange={(v) => set("toc", v)}
          disabled={disabled}
        />
        <Select
          label="Also by"
          value={p.alsoBy}
          options={[["front", "In the front"], ["back", "In the back"], ["off", "Leave out"]] as const}
          onChange={(v) => set("alsoBy", v)}
          disabled={disabled}
        />
        <Check label="About the author" checked={p.aboutAuthor} onChange={(v) => set("aboutAuthor", v)} disabled={disabled} />
      </section>
    </div>
  );
}

function EbookTab({ book, disabled, patch }: { book: Book; disabled: boolean; patch: Patch }) {
  const e = book.ebook;
  const set = (key: string, value: unknown) => patch({ [`ebook.${key}`]: value });
  return (
    <div className="wf-inspector-body">
      <section>
        <h4>Ebook</h4>
        <Check label="Contents page" checked={e.toc} onChange={(v) => set("toc", v)} disabled={disabled} hint="Readers always get navigation; this adds a page too." />
        <Check label="Embed the book’s fonts" checked={e.embedFonts} onChange={(v) => set("embedFonts", v)} disabled={disabled} />
        <Check label="Drop caps" checked={e.dropCaps} onChange={(v) => set("dropCaps", v)} disabled={disabled} />
        <Check label="Copyright page at the back" checked={e.copyrightAtBack} onChange={(v) => set("copyrightAtBack", v)} disabled={disabled} />
        <p className="wf-inspector-dim">
          Identifier:{" "}
          {book.meta.isbnEbook && validIsbn(book.meta.isbnEbook)
            ? `ISBN ${book.meta.isbnEbook}`
            : e.uuid
              ? `urn:uuid:${e.uuid}`
              : "created on first export"}
        </p>
        <p className="wf-inspector-dim">
          Most ebook readers use their own fonts and margins — the ebook keeps your structure,
          headings, scene breaks and front matter, and lets the reader do the rest.
        </p>
      </section>
    </div>
  );
}
