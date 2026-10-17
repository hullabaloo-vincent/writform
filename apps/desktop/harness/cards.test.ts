// A document's card: the synopsis, cover and tags it shows in the lists,
// worked out from the document's own settings, kept up to date by the
// editor (the drawn front of a book's cover, the card sent to the server),
// and shown on the organizer's card and in Home's recents.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";

import { cardCover, cardOf, cleanCard, forServer, frontSignature, parseCardCover, parseTags, serverAddress, settingsMedia, THUMB_KEY, THUMB_OF_KEY, thumbOf } from "../src/apps/documents/card";
import { updateDocSettings } from "../src/apps/documents/docSettings";
import { useLocalDocs } from "../src/apps/documents/local";
import { DocCard } from "../src/apps/documents/organizer/DocCard";
import { localItem, serverItem } from "../src/apps/documents/organizer/model";
import { useDocCard, type DocCardOptions } from "../src/apps/documents/useDocCard";
import type { DocumentCard } from "../src/bindings/proto/DocumentCard";
import { encodeText, newText } from "../src/book/cover/design";
import { readBook, updateBook } from "../src/book/model/bookMap";
import { backend } from "../src/lib/backend";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const FRONT = "1600x2560 writform-att://attachment/12";
const WRAP = "3900x2700 writform-att://attachment/13";
const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

// ------------------------------------------------------------ from settings

check("tags: commas, one of each, cut to size", JSON.stringify(parseTags(" dark romance, Female  lead ,DARK ROMANCE,, ")) === JSON.stringify(["dark romance", "Female lead"]));
check("…twelve at most, forty letters each", parseTags(Array.from({ length: 20 }, (_, i) => `t${i}`).join(",")).length === 12 && parseTags("x".repeat(60))[0].length === 40);

const book = new Y.Doc();
updateBook(book, { "meta.description": "When rogue vampires attack his Pennsylvania high school, Andrei Markov should have died.", "meta.tags": "dark romance, female lead", "cover.front": FRONT });
{
  const card = cardOf(book, "manuscript");
  check("a book's card: its description, tags and front", card.synopsis.startsWith("When rogue vampires") && card.tags.length === 2 && card.cover === `front ${FRONT}`, JSON.stringify(card));
  check("a document of another kind shows none of the book's", cardOf(book, "screenplay").synopsis === "" && cardOf(book, "screenplay").cover === null);
}
{
  const long = new Y.Doc();
  updateBook(long, { "meta.description": "Word ".repeat(400) });
  const synopsis = cardOf(long, "manuscript").synopsis;
  check("a long description is cut at a word", synopsis.length <= 601 && synopsis.endsWith("…"));
}
{
  const doc = new Y.Doc();
  updateDocSettings(doc, { subject: "Notes from the field", keywords: "travel, falls" });
  const card = cardOf(doc, "none");
  check("a Document's card: its subject and keywords", card.synopsis === "Notes from the field" && JSON.stringify(card.tags) === JSON.stringify(["travel", "falls"]) && card.cover === null);
}
{
  const b = readBook(book);
  const signature = frontSignature(b);
  check("the front has a signature", signature.length > 0);
  check("a drawn front is used only when drawn from the cover as it is", cardCover(b, { src: "writform-att://attachment/99", w: 400, h: 640 }, signature) === "front 400x640 writform-att://attachment/99");
  check("…not one drawn from an older cover", cardCover(b, { src: "writform-att://attachment/99", w: 400, h: 640 }, "old") === `front ${FRONT}`);
  const wrapOnly = new Y.Doc();
  updateBook(wrapOnly, { "cover.wrap": WRAP });
  check("a whole cover and nothing else: its right-hand part", cardOf(wrapOnly, "manuscript").cover === `wrap ${WRAP}`);
  const moved = new Y.Doc();
  const words = { title: "Forever in His Veins", subtitle: "", author: "Ambrose Waters", description: "" };
  const text = newText("author", "front", words, []);
  updateBook(moved, { "cover.front": FRONT, [`cover.text.${text.id}`]: encodeText(text) });
  check("words on the front change what it looks like", frontSignature(readBook(moved)) !== signature);
  check("no cover, no signature", frontSignature(readBook(new Y.Doc())) === "");
}
{
  updateBook(book, { "art.ornament": "120x40 writform-att://attachment/14", [THUMB_KEY]: "400x640 writform-att://attachment/99" });
  const media = settingsMedia(book);
  check("every picture the settings name", ["12", "14", "99"].every((n) => media.includes(`writform-att://attachment/${n}`)) && media.length === 3, JSON.stringify(media));
  updateBook(book, { "art.ornament": null, [THUMB_KEY]: null });
}
{
  check("a server picture in any of its spellings", serverAddress("https://writform-att.localhost/attachment/5") === "writform-att://attachment/5" && serverAddress("/api/v1/attachments/5?s=ab") === "writform-att://attachment/5");
  check("…and nothing else", serverAddress("writform-att://localdoc/a1/b2") === null && serverAddress("https://example.com/x.png") === null);
  const sent = forServer({ synopsis: "", cover: "front 10x20 https://writform-att.localhost/attachment/7", tags: [] }, ["writform-att://localdoc/a1/b2", "/api/v1/attachments/8"]);
  check("sent to a server as the server reads them", sent.card.cover === "front 10x20 writform-att://attachment/7" && JSON.stringify(sent.media) === JSON.stringify(["writform-att://attachment/8"]));
  check("a device's picture never goes on a server's card", forServer({ synopsis: "", cover: "front 10x20 writform-att://localdoc/a1/b2", tags: [] }, []).card.cover === null);
  check("a card read from a list is checked", JSON.stringify(cleanCard({ synopsis: 5, cover: "front evil", tags: ["a", 3, "A"] })) === JSON.stringify({ synopsis: "", cover: null, tags: ["a"] }));
  check("…and an old server's list has none", cleanCard(undefined).cover === null && parseCardCover(`wrap ${WRAP}`)?.kind === "wrap");
}

// ------------------------------------------------------------ kept up to date

function Probe(props: DocCardOptions) {
  useDocCard(props);
  return null;
}

{
  const doc = new Y.Doc();
  updateBook(doc, { "meta.description": "A first line.", "cover.front": FRONT });
  const sent: DocumentCard[] = [];
  const media: string[][] = [];
  let drawn = 0;
  const opts: DocCardOptions = {
    doc,
    format: "manuscript",
    canWrite: true,
    quiet: 20,
    upload: async () => "writform-att://attachment/99",
    draw: async () => {
      drawn += 1;
      return { file: new File([new Uint8Array([1, 2, 3])], "cover.jpg", { type: "image/jpeg" }), w: 400, h: 640 };
    },
    send: async (card, m) => {
      sent.push(card);
      media.push(m);
      return card;
    },
  };
  const root = createRoot(mountPoint());
  await act(async () => root.render(createElement(Probe, opts)));
  await wait(150);
  const { thumb, of } = thumbOf(doc);
  check("the front is drawn and kept with the book", drawn === 1 && thumb?.src === "writform-att://attachment/99" && of === frontSignature(readBook(doc)));
  const last = () => sent[sent.length - 1];
  check("the card sent shows the drawn front", last()?.cover === "front 400x640 writform-att://attachment/99" && last()?.synopsis === "A first line.", JSON.stringify(sent));
  check("…with every picture the settings name", JSON.stringify(media[media.length - 1]) === JSON.stringify(["writform-att://attachment/12", "writform-att://attachment/99"]));

  const before = sent.length;
  await act(async () => updateBook(doc, { "meta.description": "A better line." }));
  await wait(150);
  check("a new description is sent, the front is not drawn again", sent.length === before + 1 && last().synopsis === "A better line." && drawn === 1);
  await act(async () => updateBook(doc, { "meta.series": "The Markov Books" }));
  await wait(150);
  check("a change the card doesn't show sends nothing", sent.length === before + 1);

  await act(async () => updateBook(doc, { "cover.front": "1600x2560 writform-att://attachment/15" }));
  await wait(150);
  check("a new front picture is drawn again", drawn === 2 && last().cover === "front 400x640 writform-att://attachment/99");

  await act(async () => updateBook(doc, { "cover.front": null }));
  await wait(150);
  check("no front: the drawn one goes too", doc.getMap("book").get(THUMB_KEY) === undefined && doc.getMap("book").get(THUMB_OF_KEY) === undefined && last().cover === null);
  await act(async () => root.unmount());
}
{
  const doc = new Y.Doc();
  updateBook(doc, { "meta.description": "Read only." });
  let sends = 0;
  const root = createRoot(mountPoint());
  await act(async () => root.render(createElement(Probe, { doc, format: "manuscript", canWrite: false, quiet: 20, upload: null, send: async () => (sends += 1) })));
  await wait(100);
  check("a reader changes nothing", sends === 0);
  await act(async () => root.unmount());
}

// ------------------------------------------------------------ shown

const base = {
  document: { id: 4, owner: { id: 1, username: "ana", display_name: null, avatar_attachment_id: null, accent_color: null }, title: "Forever in His Veins", format: "manuscript", folder_id: null, created_at: 1, updated_at: 2, schema_level: 4 },
  my_access: "owner",
  word_count: 127121,
  excerpt: "If I could describe Victoria Falls",
  snippet: null,
  deleted_at: null,
} as never;
check("an older server's list item has an empty card", serverItem(base).cover === null && serverItem(base).synopsis === "");
const item = serverItem({ ...(base as object), card: { synopsis: "When rogue vampires attack.", cover: `front ${FRONT}`, tags: ["dark romance", "female lead", "a", "b", "c", "d"] } } as never);
{
  const el = mountPoint();
  const root = createRoot(el);
  await act(async () => root.render(createElement(DocCard, { item, selected: false, selecting: false, onOpen() {}, onMenu() {} })));
  const img = el.querySelector(".wf-doc-card-cover img");
  check("a book's card has its cover", !!el.querySelector(".wf-doc-card.has-cover") && !!img && /attachments?\/12/.test(img.getAttribute("src") ?? ""));
  check("…its synopsis in place of the opening words", (el.textContent ?? "").includes("When rogue vampires") && !(el.textContent ?? "").includes("Victoria Falls"));
  const tags = [...el.querySelectorAll(".wf-doc-card-tag")].map((t) => t.textContent);
  check("…four tags and how many more", tags.length === 4 && tags[0] === "dark romance" && el.querySelector(".wf-doc-card-more")?.textContent === "+2");
  await act(async () => root.render(createElement(DocCard, { item: { ...item, snippet: "the falls at night" }, selected: false, selecting: false, onOpen() {}, onMenu() {} })));
  check("a search's match still comes first", (el.textContent ?? "").includes("the falls at night") && !(el.textContent ?? "").includes("When rogue"));
  await act(async () => root.render(createElement(DocCard, { item: { ...item, cover: null, tags: [] }, selected: false, selecting: false, onOpen() {}, onMenu() {} })));
  check("no cover: the card as it always was", !el.querySelector(".wf-doc-card.has-cover") && !el.querySelector(".wf-doc-card-cover") && !el.querySelector(".wf-doc-card-tags"));
  await act(async () => root.unmount());
}
{
  const b = backend as unknown as Record<string, unknown>;
  b.localdocList = async () => [
    { id: "a", title: "Kept", format: "manuscript", updated_at: 5, words: 10, excerpt: "", card: { synopsis: "Mine.", cover: "front 10x20 writform-att://localdoc/a/b", tags: ["x"] } },
    { id: "b", title: "Spoiled", format: "manuscript", updated_at: 4, card: "nonsense" },
    { id: "c", title: "Old", format: "none", updated_at: 3 },
  ];
  b.localdocFoldersRead = async () => "";
  await useLocalDocs.getState().load();
  const [kept, spoiled, old] = useLocalDocs.getState().items.map((d) => localItem(d));
  check("a document on this device shows its card", kept.synopsis === "Mine." && kept.cover === "front 10x20 writform-att://localdoc/a/b" && kept.tags[0] === "x");
  check("…and a spoiled or missing one shows none", spoiled.cover === null && spoiled.synopsis === "" && old.tags.length === 0);
}

finish();
