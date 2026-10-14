/**
 * Cover artwork in and out: a chosen picture put with the book, the stored
 * pictures read back, and the two PDFs made from them (see pdf.ts).
 */

import type { JSONContent } from "@tiptap/core";

import { normalizeAttachmentSrc, type CmdError } from "../../lib/backend";
import { imageSize, sniffImageType } from "../../lib/imageSize";
import type { ImageUploader } from "../../lib/upload";
import type { Book } from "../model/bookMap";
import { hasCover, type CoverArt, type CoverSlot } from "./art";
import { panelTrim, type CoverGeometry } from "./geometry";

const MB = 1024 * 1024;
/** The most pixels a canvas is sure to hold on a phone. */
const CANVAS_PIXELS = 16_000_000;

const trouble = (code: string, message: string): CmdError => ({ code, message });

/** A picture as a JPEG (white behind anything see-through), at `quality`. */
async function asJpeg(file: Blob, quality: number): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, Math.sqrt(CANVAS_PIXELS / Math.max(1, img.naturalWidth * img.naturalHeight)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A picture no heavier than where it is kept allows. Print artwork is big,
 * and a PNG of a whole cover is often past what a server keeps: such a
 * picture is saved again as a JPEG, as lightly pressed as will fit.
 * `changed` says so.
 */
export async function fitUnder(file: Blob, limit: number): Promise<{ blob: Blob; changed: boolean }> {
  if (file.size <= limit) return { blob: file, changed: false };
  for (const quality of [0.92, 0.85, 0.75]) {
    const blob = await asJpeg(file, quality);
    if (blob && blob.size <= limit) return { blob, changed: true };
  }
  throw trouble("too_large", `That picture is over ${Math.round(limit / MB)} MB even as a JPEG, which is the most that can be kept with a book. Save a smaller copy and try again.`);
}

/**
 * Put a chosen picture with the book. Only a JPEG or a PNG (what a PDF and
 * an ebook can both carry), whatever the file is called.
 */
export async function storeArt(file: File, upload: ImageUploader, limit: number): Promise<{ art: CoverArt; resaved: boolean }> {
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const type = sniffImageType(head);
  if (type !== "image/jpeg" && type !== "image/png") {
    throw trouble("bad_image", "A cover is a JPEG or a PNG picture. Save the artwork as one of those and try again.");
  }
  const { blob, changed } = await fitUnder(file, limit);
  const bytes = changed ? new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer()) : head;
  const size = imageSize(bytes) ?? imageSize(new Uint8Array(await blob.arrayBuffer()));
  if (!size) throw trouble("bad_image", "That picture can’t be read. Save it again as a JPEG or a PNG and try again.");
  const kept = changed ? "image/jpeg" : type;
  const name = `cover.${kept === "image/png" ? "png" : "jpg"}`;
  const src = await upload(new File([blob], name, { type: kept }));
  return { art: { src, w: size.width, h: size.height }, resaved: changed };
}

/** A stored piece of artwork, read back. Null when it can't be. */
export async function artBytes(art: CoverArt): Promise<{ bytes: Uint8Array; type: "image/jpeg" | "image/png" } | null> {
  try {
    const res = await fetch(normalizeAttachmentSrc(art.src));
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const type = sniffImageType(bytes);
    return type === "image/jpeg" || type === "image/png" ? { bytes, type } : null;
  } catch {
    return null;
  }
}

const fileBase = (book: Book) => (book.meta.title || "Book").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "Book";

export interface CoverFile {
  bytes: Uint8Array;
  fileName: string;
  /** Pictures that couldn't be read (left as paper). */
  unread: CoverSlot[];
  /** Fonts that couldn't be fetched (their words are in a stand-in). */
  standIns: string[];
}

/** The paperback's cover for the printer: the cover as designed. */
export async function buildCoverFile(book: Book, g: CoverGeometry): Promise<CoverFile> {
  if (!hasCover(book.cover)) throw trouble("no_cover", "There is nothing on the cover yet.");
  const { buildScene, coverFaces } = await import("./scene");
  const faces = await coverFaces(book.cover.texts);
  const scene = buildScene(book.cover, g, faces);
  const unread: CoverSlot[] = [];
  const pictures = new Map<string, Uint8Array>();
  for (const picture of scene.pictures) {
    const got = await artBytes(book.cover[picture.slot]!);
    if (got) pictures.set(picture.src, got.bytes);
    else unread.push(picture.slot);
  }
  if (scene.pictures.length > 0 && pictures.size === 0 && scene.texts.length === 0) {
    throw trouble("no_cover", "The cover’s pictures couldn’t be read. Check the connection and try again.");
  }
  const { coverPdf } = await import("./pdf");
  const bytes = await coverPdf(g, scene, pictures, (face) => faces.set.font(face), { title: book.meta.title, author: book.meta.author });
  return { bytes, fileName: `${fileBase(book)} (paperback cover).pdf`, unread, standIns: faces.missing };
}

/**
 * The ebook's cover. The front's picture just as it came, when that is all
 * the front is. When more has been made of it (words on it, a colour, a
 * picture moved, a whole cover it is part of) the front is drawn as
 * designed, 2,560 pixels tall. Null when there is no front to speak of.
 */
export async function ebookCover(book: Book, g: CoverGeometry): Promise<{ bytes: Uint8Array; type: "image/jpeg" | "image/png" } | null> {
  const cover = book.cover;
  const { frontIsMade } = await import("./scene");
  if (frontIsMade(cover)) {
    const drawn = await drawFront(book, g).catch(() => null);
    if (drawn) return { bytes: drawn, type: "image/jpeg" };
  }
  return cover.front ? artBytes(cover.front) : null;
}

/** The front cover as designed, as a JPEG (drawn on a canvas, in the fonts
 *  the page has loaded). */
async function drawFront(book: Book, g: CoverGeometry): Promise<Uint8Array | null> {
  const [{ buildScene, coverFaces }, { showFamilies }] = await Promise.all([import("./scene"), import("../../fonts/store")]);
  const faces = await coverFaces(book.cover.texts);
  await showFamilies(faces.families);
  const scene = buildScene(book.cover, g, faces);
  const trim = panelTrim(g, "front");
  const view = { x: trim.x * 72, y: trim.y * 72, w: trim.w * 72, h: trim.h * 72 };
  const scale = Math.min(2560 / view.h, Math.sqrt(CANVAS_PIXELS / (view.w * view.h)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(view.w * scale);
  canvas.height = Math.round(view.h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(scale, scale);
  ctx.translate(-view.x, -view.y);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(view.x, view.y, view.w, view.h);
  for (const paper of scene.papers) {
    ctx.fillStyle = paper.color;
    ctx.fillRect(paper.clip.x, paper.clip.y, paper.clip.w, paper.clip.h);
  }
  for (const picture of scene.pictures) {
    const got = await artBytes(book.cover[picture.slot]!);
    if (!got) continue;
    const bitmap = await createImageBitmap(new Blob([got.bytes as BlobPart], { type: got.type }));
    ctx.save();
    ctx.beginPath();
    ctx.rect(picture.clip.x, picture.clip.y, picture.clip.w, picture.clip.h);
    ctx.clip();
    ctx.drawImage(bitmap, picture.at.x, picture.at.y, picture.at.w, picture.at.h);
    ctx.restore();
    bitmap.close();
  }
  for (const text of scene.texts) {
    ctx.save();
    ctx.translate(text.origin.x, text.origin.y);
    if (text.turn) ctx.rotate((text.turn * Math.PI) / 180);
    if (text.band) {
      ctx.fillStyle = text.band.color;
      ctx.fillRect(text.band.x, text.band.y, text.band.w, text.band.h);
    }
    for (const it of text.items) {
      const face = scene.faces[it.face];
      const font = `${face?.cssStyle ?? "normal"} ${face?.fakeBold ? 400 : (face?.cssWeight ?? 400)} ${it.size}px ${face?.cssFamily ?? "serif"}`;
      await document.fonts.load(font, it.text).catch(() => {});
      ctx.font = font;
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = it.color ?? "#000000";
      ctx.strokeStyle = it.color ?? "#000000";
      ctx.lineWidth = it.size * 0.035;
      ctx.save();
      // (A family without an italic is slanted about its baseline, as in print.)
      if (face?.fakeItalic) ctx.transform(1, 0, -0.21, 1, 0.21 * it.y, 0);
      const words = it.text.split(" ");
      words.forEach((word, i) => {
        let x = it.xs?.[i] ?? it.x;
        // Letter by letter where there is spacing between them (not every
        // webview's canvas spaces letters itself).
        for (const piece of it.cs ? [...word] : [word]) {
          ctx.fillText(piece, x, it.y);
          if (face?.fakeBold) ctx.strokeText(piece, x, it.y);
          x += ctx.measureText(piece).width + (it.cs ?? 0);
        }
      });
      ctx.restore();
    }
    ctx.restore();
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** The template for the artwork: the sheet at its exact size, with guides. */
export async function buildTemplateFile(book: Book, g: CoverGeometry): Promise<CoverFile> {
  const [{ coverTemplatePdf }, { loadFontFiles }] = await Promise.all([import("./pdf"), import("../fonts/files")]);
  const face = (await loadFontFiles(["carlito"])).find((f) => f.style === "regular");
  if (!face) throw trouble("no_font", "The template’s lettering couldn’t be loaded.");
  const bytes = await coverTemplatePdf(g, { title: book.meta.title }, face.bytes);
  return { bytes, fileName: `${fileBase(book)} (cover template).pdf`, unread: [], standIns: [] };
}

/** How many pages the paperback really has (the layout engine sets it, on
 *  its own thread). Null when it can't be set. A newer count asked for on
 *  the same `channel` overtakes this one. */
export async function countBookPages(doc: JSONContent, format: string, book: Book, channel = "cover-pages"): Promise<number | null> {
  try {
    const [{ buildModel }, { typesetter }] = await Promise.all([import("../model/buildModel"), import("../engine/client")]);
    const dl = await typesetter().layout("paperback", buildModel(doc, format, book), () => {}, channel);
    return dl ? dl.pages.length : null;
  } catch {
    return null;
  }
}
