import { useEffect, useState } from "react";

import type { Book } from "../model/bookMap";

/**
 * How many pages a paperback has (the cover is sized for them and the
 * toolbar counts them): the layout engine's count, once it has set the
 * book (`count`), and an estimate until then. `key` is whatever
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
export const pagesKey = (book: Book, words: number): string => JSON.stringify([book.print, book.design, book.art, Math.round(words / 150)]);
