/**
 * WordprocessingML is a sequence schema: the children of `w:pPr`, `w:rPr`,
 * `w:sectPr` and friends must appear in one fixed order, and Word reports
 * a file as damaged ("unreadable content") when they don't. Properties are
 * therefore collected by name and written through these tables, never
 * concatenated by hand.
 */

export const ORDER = {
  pPr: [
    "pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr",
    "suppressLineNumbers", "pBdr", "shd", "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap",
    "overflowPunct", "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd",
    "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc",
    "textDirection", "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr",
    "sectPr", "pPrChange",
  ],
  rPr: [
    // (Of a paragraph's mark only: the break is a tracked change.)
    "ins", "del",
    "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline",
    "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color",
    "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd",
    "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath",
  ],
  sectPr: [
    "headerReference", "footerReference", "footnotePr", "endnotePr", "type", "pgSz", "pgMar",
    "paperSrc", "pgBorders", "lnNumType", "pgNumType", "cols", "formProt", "vAlign", "noEndnote",
    "titlePg", "textDirection", "bidi", "rtlGutter", "docGrid",
  ],
  style: [
    "name", "aliases", "basedOn", "next", "link", "autoRedefine", "hidden", "uiPriority",
    "semiHidden", "unhideWhenUsed", "qFormat", "locked", "personal", "personalCompose",
    "personalReply", "rsid", "pPr", "rPr", "tblPr", "trPr", "tcPr", "tblStylePr",
  ],
  font: [
    "altName", "panose1", "charset", "family", "notTrueType", "pitch", "sig", "embedRegular",
    "embedBold", "embedItalic", "embedBoldItalic",
  ],
  tblPr: [
    "tblStyle", "tblpPr", "tblOverlap", "bidiVisual", "tblStyleRowBandSize", "tblStyleColBandSize",
    "tblW", "jc", "tblCellSpacing", "tblInd", "tblBorders", "shd", "tblLayout", "tblCellMar",
    "tblLook", "tblCaption", "tblDescription",
  ],
  tblBorders: ["top", "left", "start", "bottom", "right", "end", "insideH", "insideV"],
  trPr: [
    "cnfStyle", "divId", "gridBefore", "gridAfter", "wBefore", "wAfter", "cantSplit", "trHeight",
    "tblHeader", "tblCellSpacing", "jc", "hidden", "ins", "del",
  ],
  tcPr: [
    "cnfStyle", "tcW", "gridSpan", "hMerge", "vMerge", "tcBorders", "shd", "noWrap", "tcMar",
    "textDirection", "tcFitText", "vAlign", "hideMark",
  ],
  lvl: [
    "start", "numFmt", "lvlRestart", "pStyle", "isLgl", "suff", "lvlText", "lvlPicBulletId",
    "legacy", "lvlJc", "pPr", "rPr",
  ],
  settings: [
    "writeProtection", "view", "zoom", "removePersonalInformation", "removeDateAndTime",
    "doNotDisplayPageBoundaries", "displayBackgroundShape", "printPostScriptOverText",
    "printFractionalCharacterWidth", "printFormsData", "embedTrueTypeFonts", "embedSystemFonts",
    "saveSubsetFonts", "saveFormsData", "mirrorMargins", "alignBordersAndEdges",
    "bordersDoNotSurroundHeader", "bordersDoNotSurroundFooter", "gutterAtTop", "hideSpellingErrors",
    "hideGrammaticalErrors", "activeWritingStyle", "proofState", "formsDesign", "attachedTemplate",
    "linkStyles", "stylePaneFormatFilter", "stylePaneSortMethod", "documentType", "mailMerge",
    "revisionView", "trackRevisions", "doNotTrackMoves", "doNotTrackFormatting",
    "documentProtection", "autoFormatOverride", "styleLockTheme", "styleLockQFSet",
    "defaultTabStop", "autoHyphenation", "consecutiveHyphenLimit", "hyphenationZone",
    "doNotHyphenateCaps", "showEnvelope", "summaryLength", "clickAndTypeStyle",
    "defaultTableStyle", "evenAndOddHeaders", "bookFoldRevPrinting", "bookFoldPrinting",
    "bookFoldPrintingSheets", "drawingGridHorizontalSpacing", "drawingGridVerticalSpacing",
    "displayHorizontalDrawingGridEvery", "displayVerticalDrawingGridEvery",
    "doNotUseMarginsForDrawingGridOrigin", "drawingGridHorizontalOrigin",
    "drawingGridVerticalOrigin", "doNotShadeFormData", "noPunctuationKerning",
    "characterSpacingControl", "printTwoOnOne", "strictFirstAndLastChars", "noLineBreaksAfter",
    "noLineBreaksBefore", "savePreviewPicture", "doNotValidateAgainstSchema",
    "saveInvalidXml", "ignoreMixedContent", "alwaysShowPlaceholderText",
    "doNotDemarcateInvalidXml", "saveXmlDataOnly", "useXSLTWhenSaving", "saveThroughXslt",
    "showXMLTags", "alwaysMergeEmptyNamespace", "updateFields", "hdrShapeDefaults",
    "footnotePr", "endnotePr", "compat", "docVars", "rsids", "mathPr", "attachedSchema",
    "themeFontLang", "clrSchemeMapping", "doNotIncludeSubdocsInStats",
    "doNotAutoCompressPictures", "forceUpgrade", "captions", "readModeInkLockDown",
    "smartTagType", "schemaLibrary", "shapeDefaults", "doNotEmbedSmartTags", "decimalSymbol",
    "listSeparator",
  ],
} as const;

export type OrderKind = keyof typeof ORDER;

/**
 * Children for a sequence element, in schema order. `parts` maps a local
 * name (`jc`) to its complete XML (`<w:jc w:val="center"/>`), or to several
 * for a repeatable child. Throws on a name the table doesn't have — a
 * misplaced element must fail a test, not reach Word.
 */
export function ordered(kind: OrderKind, parts: Record<string, string | string[] | null | undefined | false>): string {
  const order = ORDER[kind] as readonly string[];
  let out = "";
  for (const name of Object.keys(parts)) {
    if (!order.includes(name)) throw new Error(`${name} is not a child of w:${kind}`);
  }
  for (const name of order) {
    const part = parts[name];
    if (!part) continue;
    out += Array.isArray(part) ? part.join("") : part;
  }
  return out;
}

/** `<w:pPr>…</w:pPr>`, or nothing when there is nothing to say. */
export function wrap(kind: OrderKind, parts: Record<string, string | string[] | null | undefined | false>): string {
  const inner = ordered(kind, parts);
  return inner ? `<w:${kind}>${inner}</w:${kind}>` : "";
}
