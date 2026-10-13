// What lives on this device, without a server: folders for its documents,
// searching their text and the words on its boards, publishing a board to a
// server, and — on a phone — the toolbar that rides on the keyboard.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";

import { importBoardFile, isCancelled, packBoard, publishLocalBoard } from "../src/apps/canvas/boardFile";
import { openLocalBoard, closeLocalBoard, readLocalBoard, searchLocalBoards, useLocalBoards } from "../src/apps/canvas/local";
import { b64encode } from "../src/apps/documents/collab";
import { stateDigest } from "../src/apps/documents/docText";
import { folderOfLocal, searchLocalDocs, useLocalDocs } from "../src/apps/documents/local";
import { localItem, matchesLocal } from "../src/apps/documents/organizer/model";
import { contentSchema, docContentExtensions } from "../src/editor/schema/content";
import { KeyboardDock } from "../src/editor/ui/KeyboardDock";
import { backend } from "../src/lib/backend";
import { useLocalProfile } from "../src/stores/localProfile";
import { useSession } from "../src/stores/session";
import { useWhenConnected } from "../src/stores/whenConnected";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;

// ------------------------------------------------------------ a device

/** What the Rust core keeps, in memory: files with the time they were
 *  written, so "text older than its document" means what it does on disk. */
let clock = 1_000;
const tick = () => (clock += 10_000);
const docs = new Map<string, { content: string; at: number }>();
const metas = new Map<string, string>();
const texts = new Map<string, { text: string; at: number }>();
const trash = new Map<string, { content: string; meta?: string; text?: { text: string; at: number }; deleted_at: number }>();
let folders = "";
const boards = new Map<string, string>();
const calls = { textWrites: [] as string[], searches: 0, reads: [] as string[], api: [] as { method: string; path: string; body?: Record<string, unknown> }[] };
let failRead: string | null = null;
let nextServerId = 100;
const serverBoards = new Map<number, { name: string; style: string; elements: Record<string, unknown>[] }>();

const snippetOf = (text: string, needle: string): string | null => {
  const at = text.toLowerCase().indexOf(needle);
  return at < 0 ? null : text.slice(Math.max(0, at - 40), at + needle.length + 40).replace(/\s+/g, " ").trim();
};

Object.assign(backend, {
  localdocList: async () =>
    [...docs.entries()].map(([id, d]) => {
      const file = JSON.parse(d.content) as { title?: string; format?: string };
      const meta = JSON.parse(metas.get(id) ?? "{}") as { words?: number; excerpt?: string };
      return { id, title: file.title ?? "Untitled", format: file.format ?? "none", updated_at: d.at, words: meta.words ?? 0, excerpt: meta.excerpt ?? "" };
    }),
  localdocRead: async (id: string) => {
    calls.reads.push(id);
    if (failRead === id) throw { code: "io", message: "unreadable" };
    const d = docs.get(id);
    if (!d) throw { code: "io", message: "no such document" };
    return d.content;
  },
  localdocWrite: async (id: string, content: string, meta?: string, text?: string) => {
    const at = tick();
    docs.set(id, { content, at });
    if (meta) metas.set(id, meta);
    if (text !== undefined) texts.set(id, { text, at });
  },
  localdocSearch: async (query: string) => {
    calls.searches += 1;
    const needle = query.trim().toLowerCase();
    const hits: { id: string; snippet: string }[] = [];
    const stale: string[] = [];
    for (const [id, d] of docs) {
      const t = texts.get(id);
      if (!t || t.at < d.at) stale.push(id);
      const snippet = t ? snippetOf(t.text, needle) : null;
      if (snippet !== null) hits.push({ id, snippet });
    }
    return { hits, stale };
  },
  localdocTextWrite: async (id: string, text: string) => {
    calls.textWrites.push(id);
    texts.set(id, { text, at: tick() });
  },
  localdocFoldersRead: async () => folders,
  localdocFoldersWrite: async (content: string) => {
    JSON.parse(content);
    folders = content;
  },
  localdocTrash: async (id: string) => {
    const d = docs.get(id);
    if (!d) throw { code: "io", message: "no such document" };
    trash.set(id, { content: d.content, meta: metas.get(id), text: texts.get(id), deleted_at: tick() });
    docs.delete(id);
    metas.delete(id);
    texts.delete(id);
  },
  localdocTrashList: async () =>
    [...trash.entries()].map(([id, t]) => ({ id, title: (JSON.parse(t.content) as { title: string }).title, format: "none", deleted_at: t.deleted_at, words: 0, excerpt: "" })),
  localdocRestore: async (id: string) => {
    const t = trash.get(id);
    if (!t) throw { code: "io", message: "not in Recently Deleted" };
    docs.set(id, { content: t.content, at: tick() });
    if (t.meta) metas.set(id, t.meta);
    if (t.text) texts.set(id, { text: t.text.text, at: clock });
    trash.delete(id);
  },
  localdocPurge: async (id: string) => void trash.delete(id),
  localdocTrashEmpty: async () => trash.clear(),

  localboardList: async () => [...boards.entries()].map(([id, raw]) => ({ id, name: (JSON.parse(raw) as { name: string }).name, updated_at: 5 })),
  localboardRead: async (id: string) => {
    const raw = boards.get(id);
    if (raw === undefined) throw { code: "io", message: "no such board" };
    return raw;
  },
  localboardWrite: async (id: string, content: string) => void boards.set(id, content),
  localboardSearch: async (query: string) => {
    const needle = query.trim().toLowerCase();
    const hits: { id: string; snippet: string }[] = [];
    for (const [id, raw] of boards) {
      const board = JSON.parse(raw) as { name: string; elements: { kind: string; text: string }[] };
      const el = board.elements.find((e) => ["sticky", "text", "shape", "frame"].includes(e.kind) && e.text.toLowerCase().includes(needle));
      if (el) hits.push({ id, snippet: el.text });
      else if (board.name.toLowerCase().includes(needle)) hits.push({ id, snippet: "" });
    }
    return hits;
  },

  apiFetch: async (method: string, path: string, body?: Record<string, unknown>) => {
    calls.api.push({ method, path, body });
    let m: RegExpExecArray | null;
    if (method === "POST" && (m = /^\/api\/v1\/groups\/(\d+)\/boards$/.exec(path))) {
      const id = (nextServerId += 1);
      serverBoards.set(id, { name: String(body?.name), style: "", elements: [] });
      return { status: 200, body: { id, group_id: Number(m[1]), name: body?.name, style: "", created_at: 1, creator: { id: 1, username: "me" } } };
    }
    if (method === "PATCH" && (m = /^\/api\/v1\/boards\/(\d+)$/.exec(path))) {
      const board = serverBoards.get(Number(m[1]))!;
      board.style = String(body?.style ?? "");
      return { status: 200, body: { id: Number(m[1]), style: board.style } };
    }
    if (method === "POST" && (m = /^\/api\/v1\/boards\/(\d+)\/elements$/.exec(path))) {
      const board = serverBoards.get(Number(m[1]))!;
      if (body?.text === "REFUSE") return { status: 500, body: { code: "boom", message: "the server fell over" } };
      const id = (nextServerId += 1);
      board.elements.push({ ...body, id });
      return { status: 200, body: { ...body, id, board_id: Number(m[1]) } };
    }
    if (method === "DELETE" && (m = /^\/api\/v1\/boards\/(\d+)$/.exec(path))) {
      serverBoards.delete(Number(m[1]));
      return { status: 200, body: null };
    }
    if (method === "GET" && /^\/api\/v1\/groups\/\d+\/boards$/.test(path)) return { status: 200, body: [] };
    return { status: 404, body: { code: "not_found", message: `no route ${method} ${path}` } };
  },
});

const t = (text: string): JSONContent => ({ type: "text", text });
const para = (text: string): JSONContent => ({ type: "paragraph", ...(text ? { content: [t(text)] } : {}) });
const heading = (text: string): JSONContent => ({ type: "heading", attrs: { level: 1 }, content: [t(text)] });
/** The stored state of a document with this content. */
const stateOf = (...content: JSONContent[]): string => {
  const ydoc = new Y.Doc();
  ydoc.transact(() => prosemirrorJSONToYXmlFragment(contentSchema(), { type: "doc", content }, ydoc.get("default", Y.XmlFragment)));
  const out = b64encode(Y.encodeStateAsUpdate(ydoc));
  ydoc.destroy();
  return out;
};
const store = () => useLocalDocs.getState();

// ------------------------------------------------------------ the text of a document

{
  const state = stateOf(
    heading("Chapter One"),
    para("The lighthouse keeper counted the ships."),
    { type: "bulletList", content: [{ type: "listItem", content: [para("None came")] }] },
    para(""),
  );
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, Uint8Array.from(atob(state), (c) => c.charCodeAt(0)));
  const digest = stateDigest(Y.encodeStateAsUpdate(ydoc));
  check("a document's text: one block to a line, empty ones left out", digest.text === "Chapter One\nThe lighthouse keeper counted the ships.\nNone came", JSON.stringify(digest.text));
  check("…with the count and opening words the list has always had", digest.words === 10 && digest.excerpt.startsWith("The lighthouse keeper"));
}

// ------------------------------------------------------------ searching the documents

const novel = await store().create("Novel", "manuscript", stateOf(heading("One"), para("The lighthouse keeper counted the ships.")));
const recipe = await store().create("Bread", "none", stateOf(para("Flour, water, salt and time.")));
check("a new document's text is written with it", texts.get(novel)?.text.includes("lighthouse keeper") === true && texts.get(recipe)?.at === docs.get(recipe)?.at);
{
  const found = await searchLocalDocs("  LIGHTHOUSE ");
  check("search finds a word in the text, any case", found.size === 1 && found.get(novel)?.includes("lighthouse keeper") === true);
  check("…and nothing had to be read to do it", calls.textWrites.length === 0);
  check("a word nowhere finds nothing", (await searchLocalDocs("zeppelin")).size === 0);
  const hits = await searchLocalDocs("salt");
  const items = store().items.map((d) => localItem(d, null, hits.get(d.id) ?? null));
  const shown = items.filter((i) => matchesLocal(i, "salt") || hits.has(i.id as string));
  check("the organizer shows the words around the match on the card", shown.length === 1 && shown[0].title === "Bread" && shown[0].snippet === "Flour, water, salt and time.");
  check("a title still matches from the list alone", items.filter((i) => matchesLocal(i, "nov")).length === 1);
}

// A document from before search read text: found once its text is written.
const legacy = "aaaa1111-0000-4000-8000-000000000001";
docs.set(legacy, { content: JSON.stringify({ id: legacy, title: "Old notes", format: "none", state_b64: stateOf(para("A zeppelin over the harbour.")), created_at: 1 }), at: tick() });
await store().load();
{
  calls.reads.length = 0;
  const found = await searchLocalDocs("zeppelin");
  check("an older document is read once, its text kept, and then found", found.get(legacy)?.includes("zeppelin over") === true && calls.textWrites.join() === legacy && calls.reads.join() === legacy);
  calls.reads.length = 0;
  calls.textWrites.length = 0;
  await searchLocalDocs("zeppelin");
  await searchLocalDocs("harbour");
  check("…and never read again for a search", calls.reads.length === 0 && calls.textWrites.length === 0);
}

// One that can't be read stays findable by title, and isn't retried per keystroke.
const broken = "bbbb2222-0000-4000-8000-000000000002";
docs.set(broken, { content: JSON.stringify({ id: broken, title: "Damaged", format: "none", state_b64: "" }), at: tick() });
await store().load();
failRead = broken;
{
  calls.reads.length = 0;
  await searchLocalDocs("zep");
  await searchLocalDocs("zepp");
  await searchLocalDocs("zeppe");
  check("a document that can't be read is tried once, not on every keystroke", calls.reads.filter((id) => id === broken).length === 1);
  check("…and the search still answers", (await searchLocalDocs("zeppelin")).has(legacy));
}
failRead = null;

// Renaming a closed document rewrites its file — and its text with it.
{
  await store().rename(recipe, "Sourdough");
  calls.textWrites.length = 0;
  calls.reads.length = 0;
  const found = await searchLocalDocs("flour");
  check("a renamed document is still current for search (nothing re-read)", found.has(recipe) && calls.reads.length === 0 && (JSON.parse(docs.get(recipe)!.content) as { title: string }).title === "Sourdough");
}

// The open document writes its own text; a search leaves it alone.
{
  await store().open(novel);
  // As if edited since its text was last written.
  docs.get(novel)!.at = tick();
  calls.reads.length = 0;
  const found = await searchLocalDocs("lighthouse");
  check("the open document is searched as last written, without re-reading its file", found.has(novel) && calls.reads.length === 0);
  store().close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check("closing it writes its text", (texts.get(novel)?.at ?? 0) >= (docs.get(novel)?.at ?? 1));
}

// ------------------------------------------------------------ folders

{
  const drafts = await store().createFolder("  Drafts  ");
  const ideas = await store().createFolder("Ideas");
  check("a folder is made, named as typed (trimmed)", store().folders.find((f) => f.id === drafts)?.name === "Drafts" && store().folders.length === 2);
  let refused = false;
  await store().createFolder("   ").catch(() => (refused = true));
  check("a folder needs a name", refused && store().folders.length === 2);

  await store().moveTo([novel, recipe], drafts);
  check("documents go into a folder", folderOfLocal(novel) === drafts && folderOfLocal(recipe) === drafts && folderOfLocal(legacy) === null);
  await store().moveTo([recipe], ideas);
  check("…from one to another", folderOfLocal(recipe) === ideas && folderOfLocal(novel) === drafts);
  await store().renameFolder(drafts, "First drafts");
  check("renaming a folder keeps what's in it", store().folders.find((f) => f.id === drafts)?.name === "First drafts" && folderOfLocal(novel) === drafts);

  // What's on disk is what a fresh start reads back.
  const saved = JSON.parse(folders) as { folders: { id: string; name: string }[]; docs: Record<string, string> };
  check("the folders file holds the folders and each document's place", saved.folders.length === 2 && saved.docs[novel] === drafts && saved.docs[recipe] === ideas);
  useLocalDocs.setState({ folders: [], folderOf: {} });
  await store().load();
  check("…and is read back on the next start", folderOfLocal(novel) === drafts && store().folders.length === 2);

  // Recently Deleted keeps a document's place; deleting it for good forgets it.
  await store().remove(novel);
  check("a deleted document isn't listed", !store().items.some((d) => d.id === novel));
  await store().restore(novel);
  check("…and restored, it is back in its folder", folderOfLocal(novel) === drafts);
  await store().remove(recipe);
  await store().loadTrash();
  await store().purge(recipe);
  check("deleted for good, its place is forgotten", !(recipe in store().folderOf) && !(recipe in (JSON.parse(folders) as { docs: Record<string, string> }).docs));

  let gone = false;
  await store().moveTo([legacy], "no-such-folder").catch(() => (gone = true));
  check("nothing can be moved into a folder that isn't there", gone && folderOfLocal(legacy) === null);

  await store().moveTo([novel], null);
  check("a document can be taken out of its folder", folderOfLocal(novel) === null);
  await store().moveTo([novel, legacy], drafts);
  await store().deleteFolder(drafts);
  check("deleting a folder keeps its documents, in no folder", folderOfLocal(novel) === null && folderOfLocal(legacy) === null && store().items.some((d) => d.id === novel) && store().folders.length === 1);

  // A damaged or foreign file never takes the documents with it.
  folders = "{not json";
  await store().load();
  check("a damaged folders file reads as no folders — the documents are all still listed", store().folders.length === 0 && store().items.length === 3);
  folders = JSON.stringify({ folders: [{ id: "f1", name: "Kept" }, { name: "no id" }, null], docs: { [novel]: "f1", [legacy]: "missing" } });
  await store().load();
  check("…and a file with stray entries keeps the good ones", store().folders.length === 1 && folderOfLocal(novel) === "f1" && folderOfLocal(legacy) === null);
}

// ------------------------------------------------------------ boards

const el = (id: number, kind: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  board_id: -5,
  kind,
  x: id * 10,
  y: 0,
  w: 100,
  h: 60,
  z: id,
  text,
  page: 0,
  color: "",
  style: "",
  from_id: null,
  to_id: null,
  updated_by: 0,
  updated_at: 1,
  ...extra,
});
boards.set(
  "5",
  JSON.stringify({
    id: -5,
    name: "Plot wall",
    style: "",
    created_at: 7,
    next_element_id: 9,
    elements: [el(3, "sticky", "The heist goes wrong at the harbour"), el(4, "text", "Act two"), el(8, "connector", "", { from_id: 3, to_id: 4 })],
  }),
);
boards.set("6", JSON.stringify({ id: -6, name: "Harbour map", style: "", created_at: 8, next_element_id: 1, elements: [] }));
await useLocalBoards.getState().load();
{
  const found = await searchLocalBoards("harbour");
  check("boards are found by the words on them and by name, under the ids the app uses", found.get(-5) === "The heist goes wrong at the harbour" && found.get(-6) === "" && found.size === 2);

  useLocalProfile.setState({ name: "Ada Lovelace", accent: "#8ab6e8" });
  const read = await readLocalBoard(-5);
  check("a board is read without opening it", read.board.name === "Plot wall" && read.elements.length === 3);
  check("…and it's yours, by the name this device knows you by", read.board.creator.display_name === "Ada Lovelace" && read.board.creator.accent_color === "#8ab6e8");
  useLocalProfile.setState({ name: "", accent: null });
  check("…or simply “You” before you've said", (await readLocalBoard(-5)).board.creator.display_name === "You");
}

// Publishing: packed as a board file, imported into a group on the server.
{
  const before = boards.get("5");
  const steps: string[] = [];
  const result = await publishLocalBoard(-5, 3, (p) => steps.push(p.label), new AbortController().signal);
  const made = serverBoards.get(result.boardId);
  check("publishing makes the board in the group, by its own name", made?.name === "Plot wall" && calls.api.some((c) => c.method === "POST" && c.path === "/api/v1/groups/3/boards"));
  const bodies = (made?.elements ?? []).filter((e) => e.kind !== "connector");
  const link = (made?.elements ?? []).find((e) => e.kind === "connector");
  check("…with everything on it", bodies.length === 2 && bodies.map((e) => e.text).join("|") === "The heist goes wrong at the harbour|Act two");
  check("…and its connector joined to the new copies of what it joined", !!link && link.from_id === bodies[0].id && link.to_id === bodies[1].id);
  check("the board on this device is untouched", boards.get("5") === before && result.notice === null);
  check("progress is said along the way", steps.includes("Reading the board") && steps.includes("Placing elements"));

  // An open board publishes what's on screen, saved first, and stays open.
  await openLocalBoard(-5);
  const { activeLocalBoard } = await import("../src/apps/canvas/local");
  activeLocalBoard()!.createElement({ kind: "sticky", x: 0, y: 0, w: 10, h: 10, text: "Just added", page: 0, color: "", style: "", from_id: null, to_id: null } as never);
  const second = await publishLocalBoard(-5, 3, () => {}, new AbortController().signal);
  check("an open board publishes with what was just added, and stays open", serverBoards.get(second.boardId)?.elements.some((e) => e.text === "Just added") === true && activeLocalBoard()?.id === -5);
  check("…having been saved first", boards.get("5")!.includes("Just added"));
  await closeLocalBoard();

  // Cancelled before it starts: nothing reaches the server.
  const stopped = new AbortController();
  stopped.abort();
  const apiBefore = calls.api.length;
  let cancelled = false;
  await publishLocalBoard(-5, 3, () => {}, stopped.signal).catch((e) => (cancelled = isCancelled(e)));
  check("cancelled before it starts, nothing reaches the server", cancelled && calls.api.length === apiBefore);

  // A failure half-way takes the half-made copy with it.
  boards.set("7", JSON.stringify({ id: -7, name: "Doomed", style: "", created_at: 9, next_element_id: 3, elements: [el(1, "sticky", "fine"), el(2, "sticky", "REFUSE")] }));
  const count = serverBoards.size;
  let failed = "";
  await publishLocalBoard(-7, 3, () => {}, new AbortController().signal).catch((e: { message?: string }) => (failed = e.message ?? "?"));
  check("a failure half-way removes the half-made copy and says why", failed === "the server fell over" && serverBoards.size === count && ![...serverBoards.values()].some((b) => b.name === "Doomed"));

  // The file a publish sends is the one Export writes.
  const packed = await packBoard({ name: "Plot wall", style: "" }, (await readLocalBoard(-5)).elements);
  const again = await importBoardFile(new File([packed.bytes as BlobPart], "x.wfboard"), { kind: "group", groupId: 4 }, () => {}, new AbortController().signal);
  check("a packed board is an ordinary board file", serverBoards.get(again.boardId)?.elements.length === 4 && packed.skippedMedia === 0);
}

// ------------------------------------------------------------ waiting for a server

{
  const ran: string[] = [];
  let ask: (what: string) => void = () => {};
  function Probe() {
    const go = useWhenConnected((what: string) => ran.push(what));
    useEffect(() => {
      ask = go;
    }, [go]);
    return null;
  }
  const root = createRoot(mountPoint());
  useSession.setState({ link: "local", connect: null, session: null });
  await act(async () => root.render(createElement(Probe)));

  await act(async () => ask("the novel"));
  check("not connected: asking opens the connect sheet and waits", ran.length === 0 && useSession.getState().connect !== null);
  await act(async () => useSession.setState({ link: "connected", connect: null }));
  check("…and carries on once there is a server", ran.join() === "the novel");

  await act(async () => ask("a board"));
  check("connected: it runs at once", ran.join() === "the novel,a board");

  await act(async () => useSession.setState({ link: "local", connect: null }));
  await act(async () => ask("dropped"));
  await act(async () => useSession.getState().closeConnect());
  await act(async () => useSession.setState({ link: "connected" }));
  check("the sheet closed without connecting: nothing happens later", ran.join() === "the novel,a board");

  // Picking a saved server closes the sheet while it reconnects.
  await act(async () => useSession.setState({ link: "local" }));
  await act(async () => ask("after resume"));
  await act(async () => useSession.setState({ link: "resuming", connect: null }));
  check("a server being reconnected to is waited for", ran.length === 2);
  await act(async () => useSession.setState({ link: "connected" }));
  check("…and then it runs", ran[2] === "after resume");
  await act(async () => ask("x"));
  await act(async () => useSession.setState({ link: "local" }));
  await act(async () => ask("never"));
  await act(async () => useSession.setState({ link: "resuming", connect: null }));
  await act(async () => useSession.setState({ link: "unreachable" }));
  await act(async () => useSession.setState({ link: "connected" }));
  check("…unless it couldn't be reached", !ran.includes("never"));
  await act(async () => root.unmount());
}

// ------------------------------------------------------------ the toolbar on the phone keyboard

{
  const win = window as unknown as Record<string, unknown>;
  let phone = true;
  win.matchMedia = () => ({ matches: phone, addEventListener() {}, removeEventListener() {} });
  const listeners = new Set<() => void>();
  const viewport = {
    height: window.innerHeight,
    offsetTop: 0,
    addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
  };
  win.visualViewport = viewport;
  const keyboard = async (height: number) => {
    viewport.height = window.innerHeight - height;
    await act(async () => listeners.forEach((fn) => fn()));
  };

  const editor = new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: { type: "doc", content: [para("Once upon a time")] } });
  const title = document.createElement("input");
  document.body.appendChild(title);
  const menu = document.createElement("div");
  menu.className = "wf-flyout";
  const fontSearch = document.createElement("input");
  menu.appendChild(fontSearch);
  document.body.appendChild(menu);

  const host = mountPoint();
  const root = createRoot(host);
  await act(async () => root.render(createElement(KeyboardDock, { editor, children: createElement("button", { className: "tool" }, "B") })));
  const dock = host.querySelector(".wf-kbdock") as HTMLElement;
  const docked = () => dock.classList.contains("docked");
  const cssVar = (name: string) => document.documentElement.style.getPropertyValue(name);

  check("the toolbar starts in its place in the page", !!dock && !docked() && !!dock.querySelector(".tool"));
  await act(async () => (editor.view.dom as HTMLElement).focus());
  check("the text has focus but no keyboard is up (a hardware keyboard): it stays", !docked());
  await keyboard(336);
  check("the keyboard comes up for the text: the toolbar rides on it", docked() && cssVar("--wf-kb") === "336px");
  check("…and what it holds is the same element, not a copy", dock.querySelector(".tool") !== null && host.querySelectorAll(".tool").length === 1);

  await act(async () => fontSearch.focus());
  check("a field in one of its own menus keeps it there", docked());
  await act(async () => title.focus());
  check("typing somewhere else (a title): it goes back, out of the way", !docked() && cssVar("--wf-kb") === "");
  await act(async () => (editor.view.dom as HTMLElement).focus());
  check("back in the text: on the keyboard again", docked());

  await keyboard(291);
  check("a keyboard that changes height is followed", cssVar("--wf-kb") === "291px");
  await keyboard(40);
  check("a sliver (the browser's own bars) is not a keyboard", !docked());
  await keyboard(336);
  await keyboard(0);
  check("the keyboard goes away: so does the strip, and what it set", !docked() && cssVar("--wf-kb") === "" && cssVar("--wf-kbdock-h") === "");

  phone = false;
  const wideHost = mountPoint();
  const wide = createRoot(wideHost);
  await act(async () => wide.render(createElement(KeyboardDock, { editor, children: createElement("span", null, "x") })));
  await act(async () => (editor.view.dom as HTMLElement).focus());
  await keyboard(336);
  check("on anything wider than a phone it never moves", !(wideHost.querySelector(".wf-kbdock") as HTMLElement).classList.contains("docked"));

  await act(async () => {
    root.unmount();
    wide.unmount();
  });
  editor.destroy();
}

// ------------------------------------------- the row a document is shared from

{
  // "Publish + share" was pushed out of its dialog: two lists and a button
  // in a row that could not get narrower (a list is never narrower than its
  // longest entry unless told it may be). There is no layout here to
  // measure, so the stylesheet and the picker's own classes are held to.
  const { readFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const app = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const css = readFileSync(resolve(app, "src/styles.css"), "utf8");
  const picker = readFileSync(resolve(app, "src/apps/documents/SharePicker.tsx"), "utf8");
  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`);
    return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
  };
  check("a list in a row may be narrower than its longest entry", /min-width: 0/.test(rule(".wf-doc-panel-row select")));
  check("the share row wraps, so its button goes to a new line and never out of the dialog", /flex-wrap: wrap/.test(rule(".wf-share-picker")));
  check("the list of names is the one that gives way", /flex: 1 1 120px/.test(rule(".wf-share-picker .wf-share-who")));
  check("…and the button and the short list keep their size", /\.wf-share-picker select:not\(\.wf-share-who\),\n\.wf-share-picker button \{\n  flex: none;/.test(css));
  check("the picker carries those names", /className="wf-doc-panel-row wf-share-picker"/.test(picker) && /className="wf-share-who"/.test(picker));
}

finish();
