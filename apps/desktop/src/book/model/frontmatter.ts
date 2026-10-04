/**
 * The generated pages around the story — title page, copyright page,
 * dedication, epigraph, also-by, about the author — as plain content both
 * the ebook and the print book lay out. Pure.
 */

import type { BookMeta, BookPrint } from "./bookMap";
import type { Section } from "./types";

const FICTION =
  "This is a work of fiction. Names, characters, places, and incidents either are the product of the author’s imagination or are used fictitiously. Any resemblance to actual persons, living or dead, events, or locales is entirely coincidental.";

const RIGHTS =
  "All rights reserved. No part of this book may be reproduced in any form or by any electronic or mechanical means, including information storage and retrieval systems, without written permission from the author, except for the use of brief quotations in a book review.";

/** The copyright page, paragraph by paragraph. */
export function copyrightParagraphs(meta: BookMeta, now = new Date()): string[] {
  const year = meta.copyrightYear ?? now.getFullYear();
  const holder = meta.copyrightHolder || meta.author;
  if (meta.copyrightNotice === "custom" && meta.copyrightText.trim()) {
    return meta.copyrightText.split(/\n\s*\n|\n/).map((s) => s.trim()).filter(Boolean);
  }
  const out: string[] = [];
  if (meta.copyrightNotice === "fiction") out.push(FICTION);
  out.push(`Copyright © ${year}${holder ? ` ${holder}` : ""}`);
  out.push(RIGHTS);
  if (meta.isbnPrint) out.push(`ISBN ${meta.isbnPrint} (paperback)`);
  if (meta.isbnEbook) out.push(`ISBN ${meta.isbnEbook} (ebook)`);
  if (meta.edition) out.push(meta.edition);
  if (meta.publisher) out.push(`Published by ${meta.publisher}`);
  return out;
}

/** Whether the book gets a contents page. "auto": when chapters have
 *  titles worth listing (numbers alone make a dull list). */
export function wantsContents(setting: BookPrint["toc"], sections: Section[]): boolean {
  if (setting === "on") return true;
  if (setting === "off") return false;
  const chapters = sections.filter((s) => s.kind === "chapter");
  return chapters.length > 1 && chapters.filter((s) => s.title.trim()).length >= chapters.length / 2;
}

/** A section's line in a table of contents. */
export function contentsLabel(section: Section): string {
  if (section.kind === "part") return [section.label, section.title].filter(Boolean).join(": ");
  if (section.kind === "chapter") {
    if (section.title) return section.label ? `${section.label}: ${section.title}` : section.title;
    return section.label || `Chapter ${section.number ?? ""}`.trim();
  }
  return section.title || "Untitled";
}
