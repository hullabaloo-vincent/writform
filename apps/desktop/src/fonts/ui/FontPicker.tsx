import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Flyout } from "../../editor/ui/Flyout";
import { isWeb, type SystemFontFamily } from "../../lib/backend";
import { loadCatalog, searchCatalog, type Catalog } from "../catalog";
import { catalogAlias, fontCssFamily, fontLabel, type FontInfo } from "../css";
import { isFontId } from "../ids";
import { FONTS, knownFont, MENU_FONTS, type FontCategory } from "../registry";
import { onlineFonts, showFamilies, systemFonts } from "../store";
import { BODY_FONT_CSS } from "../../editor/styles/sheet";

export type FontPick = (id: string | null, info?: FontInfo) => void;

interface Row {
  id: string | null;
  name: string;
  /** What kind of font, or where it's from — the small text on the right. */
  note: string;
  /** How to draw its name (absent: the interface's own face). */
  css?: string;
  info?: FontInfo;
  /** A catalog family whose files aren't loaded yet: shown in its own face
   *  once the pointer rests on it. */
  catalogId?: string;
}

const RECENT_KEY = "wf-font-recents";
const RECENT_MAX = 6;

function readRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((v): v is string => isFontId(v)).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function noteRecentFont(id: string | null): void {
  if (!id) return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecents().filter((v) => v !== id)].slice(0, RECENT_MAX)));
  } catch {
    // recents are a convenience
  }
}

const KINDS: { id: FontCategory; label: string }[] = [
  { id: "serif", label: "Serif" },
  { id: "sans-serif", label: "Sans" },
  { id: "monospace", label: "Mono" },
  { id: "display", label: "Display" },
  { id: "handwriting", label: "Script" },
];

const KIND_NOTE: Record<FontCategory, string> = {
  serif: "Serif",
  "sans-serif": "Sans",
  monospace: "Mono",
  display: "Display",
  handwriting: "Script",
};

/** A first look at the online library, before anything is typed. */
const SUGGESTED = [
  "inter", "source-serif-4", "lora", "merriweather", "crimson-pro", "cormorant-garamond", "libre-franklin", "work-sans",
  "open-sans", "roboto", "ibm-plex-serif", "ibm-plex-sans", "jetbrains-mono", "playfair-display", "caveat", "special-elite",
];

/** Fonts that ship with the app (the document menu's, plus the bundled sans). */
const APP_FONTS = [...MENU_FONTS, ...FONTS.filter((f) => f.id === "carlito")];
/** …and the ones a book can be set in: its own typefaces. */
const BOOK_APP_FONTS = FONTS.filter((f) => f.book);

/** Where the font is for: a document takes any font; a book one of the
 *  app's book faces or a family of the online library (it has to be
 *  embedded in what is printed and sold). */
export type FontScope = "document" | "book";

/** What is said over the fonts installed on the device: the app can't
 *  vouch for what they may be used for. */
const DEVICE_HINT = "Each has its maker’s own license. Check it before you publish with one.";

function appRow(id: string, scope: FontScope = "document"): Row | null {
  const f = knownFont(id);
  if (!f || (scope === "book" && !f.book)) return null;
  return { id: f.id, name: scope === "book" ? f.name : (f.menu ?? f.name), note: "With the app", css: f.css };
}

/**
 * The font list: what the document already uses, what you used lately,
 * the fonts that come with the app, the ones installed on this computer,
 * and the online library — searched together, each drawn in itself.
 */
function FontList({
  value,
  docFonts,
  docTable,
  defaultLabel,
  scope,
  onPick,
}: {
  value: string | null;
  docFonts: string[];
  docTable: Record<string, FontInfo>;
  defaultLabel: string;
  scope: FontScope;
  onPick: FontPick;
}) {
  const book = scope === "book";
  const appFonts = book ? BOOK_APP_FONTS : APP_FONTS;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<FontCategory | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [system, setSystem] = useState<SystemFontFamily[]>([]);
  const [allSystem, setAllSystem] = useState(false);
  const [shown, setShown] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  const online = onlineFonts();

  useEffect(() => {
    let live = true;
    void loadCatalog().then((c) => live && setCatalog(c));
    if (!isWeb && !book) void systemFonts().then((map) => live && setSystem([...map.values()]));
    // Typing should work the moment the list opens (not on a phone, where
    // that would throw the keyboard over it).
    if (!window.matchMedia("(pointer: coarse)").matches) inputRef.current?.focus();
    return () => {
      live = false;
      if (dwell.current) clearTimeout(dwell.current);
    };
  }, [book]);

  const catalogRow = (id: string): Row | null => {
    const f = catalog?.byId.get(id);
    if (!f) return null;
    return {
      id: `gf:${f.id}`,
      name: f.family,
      note: KIND_NOTE[f.category],
      info: { name: f.family, category: f.category },
      catalogId: f.id,
      ...(shown.has(f.id) ? { css: `"${catalogAlias(f.id)}"` } : {}),
    };
  };
  const systemRow = (f: SystemFontFamily): Row => ({
    id: `sys:${f.family}`,
    name: f.family,
    note: "On this computer",
    css: `"${f.family}"`,
    info: { name: f.family, category: f.monospace ? "monospace" : "sans-serif" },
  });
  const anyRow = (id: string): Row | null => {
    if (knownFont(id)) return appRow(id, scope);
    if (id.startsWith("gf:")) {
      return catalogRow(id.slice(3).split("@")[0]) ?? { id, name: fontLabel(id, docTable[id]), note: "Online", info: docTable[id] };
    }
    if (!isFontId(id) || book) return null;
    const name = fontLabel(id, docTable[id]);
    const here = system.find((f) => f.family.toLowerCase() === name.toLowerCase());
    return here ? systemRow(here) : { id, name, note: "Not on this computer", css: fontCssFamily(id, docTable[id]) ?? undefined, info: docTable[id] ?? { name } };
  };

  const sections = useMemo((): { title: string; rows: Row[]; more?: () => void; hint?: string }[] => {
    const q = query.trim().toLowerCase();
    const real = <T,>(list: (T | null)[]) => list.filter((r): r is T => r !== null);
    if (q || kind) {
      const matches = (name: string) => !q || name.toLowerCase().includes(q);
      const app = appFonts.filter((f) => matches(f.menu ?? f.name) || matches(f.name)).filter((f) => !kind || f.category === kind);
      const sys = kind && kind !== "monospace" ? [] : system.filter((f) => matches(f.family) && (!kind || f.monospace));
      const found = catalog ? searchCatalog(catalog, q, kind, 80) : [];
      return [
        { title: "With the app", rows: real(app.map((f) => appRow(f.id, scope))) },
        { title: "On this computer", rows: sys.slice(0, 40).map(systemRow), hint: DEVICE_HINT },
        { title: "Online library", rows: real(found.map((f) => catalogRow(f.id))) },
      ].filter((s) => s.rows.length > 0);
    }
    const used = real([...new Set(docFonts)].map(anyRow));
    const recent = real(readRecents().filter((id) => !docFonts.includes(id)).map(anyRow));
    return [
      { title: book ? "In this book" : "In this document", rows: used },
      { title: "Recent", rows: recent },
      { title: "With the app", rows: real(appFonts.map((f) => appRow(f.id, scope))) },
      {
        title: "On this computer",
        hint: DEVICE_HINT,
        rows: (allSystem ? system : system.slice(0, 12)).map(systemRow),
        ...(system.length > 12 && !allSystem ? { more: () => setAllSystem(true) } : {}),
      },
      { title: "Online library", rows: real(SUGGESTED.map(catalogRow)) },
    ].filter((s) => s.rows.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the row builders read the same state
  }, [query, kind, catalog, system, allSystem, shown, docFonts, docTable, scope]);

  const preview = (id: string) => {
    if (shown.has(id) || !online) return;
    if (dwell.current) clearTimeout(dwell.current);
    dwell.current = setTimeout(() => {
      void showFamilies([`gf:${id}`]).then(() => setShown((prev) => new Set(prev).add(id)));
    }, 180);
  };

  return (
    <div className="wf-fontlist">
      <div className="wf-fontlist-search">
        <Search size={14} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={catalog ? `Search ${catalog.fonts.length.toLocaleString()} fonts…` : "Search fonts…"}
          aria-label="Search fonts"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="wf-fontlist-kinds" role="group" aria-label="Kind of font">
        {KINDS.map((k) => (
          <button key={k.id} type="button" aria-pressed={kind === k.id} className={kind === k.id ? "active" : ""} onClick={() => setKind(kind === k.id ? null : k.id)}>
            {k.label}
          </button>
        ))}
      </div>
      <div className="wf-fontlist-rows">
        {!query.trim() && !kind && !book && (
          <button type="button" className={`wf-fontlist-row${value === null ? " current" : ""}`} onClick={() => onPick(null)}>
            <span className="wf-fontlist-name">{defaultLabel}</span>
            <span className="wf-fontlist-note">Default</span>
          </button>
        )}
        {sections.map((section) => (
          <div key={section.title} className="wf-fontlist-section">
            <span className="wf-fontlist-title">{section.title}</span>
            {section.hint && <span className="wf-fontlist-hint">{section.hint}</span>}
            {section.rows.map((row) => (
              <button
                key={`${section.title}:${row.id}`}
                type="button"
                className={`wf-fontlist-row${row.id === value ? " current" : ""}`}
                onPointerEnter={() => row.catalogId && preview(row.catalogId)}
                onPointerLeave={() => dwell.current && clearTimeout(dwell.current)}
                onFocus={() => row.catalogId && preview(row.catalogId)}
                onClick={() => onPick(row.id, row.info)}
              >
                <span className="wf-fontlist-name" style={row.css ? { fontFamily: row.css } : undefined}>
                  {row.name}
                </span>
                <span className="wf-fontlist-note">{row.note}</span>
              </button>
            ))}
            {section.more && (
              <button type="button" className="wf-link wf-fontlist-more" onClick={section.more}>
                Show all on this computer
              </button>
            )}
          </div>
        ))}
        {sections.length === 0 && <p className="wf-fontlist-empty">No font by that name.</p>}
        <p className="wf-fontlist-empty">
          {book
            ? "Every font here is open-licensed and free for commercial use."
            : "Fonts that come with the app or from the online library are open-licensed and free for commercial use."}
        </p>
        {!online && <p className="wf-fontlist-empty">The online library is switched off in Settings, so only fonts already downloaded will load.</p>}
      </div>
    </div>
  );
}

/**
 * The font button: shows the font in force, in itself, and opens the list.
 */
export function FontPicker({
  value,
  docFonts,
  docTable = {},
  defaultLabel,
  title = "Font",
  disabled,
  className,
  scope = "document",
  onPick,
}: {
  /** The font in force (null: the default). */
  value: string | null;
  /** Font ids the document uses (listed first). */
  docFonts: string[];
  docTable?: Record<string, FontInfo>;
  /** What "no font of its own" is called here ("Body font", "Georgia"). */
  defaultLabel: string;
  title?: string;
  disabled?: boolean;
  className?: string;
  /** What the font is for (a book's choice is narrower). */
  scope?: FontScope;
  onPick: FontPick;
}) {
  const label = value ? fontLabel(value, docTable[value]) : defaultLabel;
  const css = value ? fontCssFamily(value, docTable[value]) : BODY_FONT_CSS;
  return (
    <Flyout
      title={title}
      label={<span style={css ? { fontFamily: css } : undefined}>{scope === "book" ? (knownFont(value ?? "")?.name ?? label) : (knownFont(value ?? "")?.menu ?? label)}</span>}
      disabled={disabled}
      className={`wf-font-button${className ? ` ${className}` : ""}`}
      panelClass="wf-font-panel"
    >
      {(close) => (
        <FontList
          value={value}
          docFonts={docFonts}
          docTable={docTable}
          defaultLabel={defaultLabel}
          scope={scope}
          onPick={(id, info) => {
            noteRecentFont(id);
            onPick(id, info);
            close();
          }}
        />
      )}
    </Flyout>
  );
}
