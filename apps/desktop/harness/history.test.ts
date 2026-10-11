// Version history for a document on this device: revisions are cut, listed,
// opened (what changed, or the whole text), compared and restored — with no
// server anywhere.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { compactDocString } from "../src/apps/documents/compactJson";
import { loadLocalVersion, readLocalHistory, saveLocalVersion } from "../src/apps/documents/history";
import { LocalHistoryPanel } from "../src/apps/documents/LocalHistoryPanel";
import { docContentExtensions } from "../src/editor/schema/content";
import { backend } from "../src/lib/backend";

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// What the core keeps for a document's history: an index and one file a version.
const index = new Map<string, string>();
const blobs = new Map<string, Uint8Array>();
let failWrites = false;
Object.assign(backend, {
  localdocHistIndexRead: async (id: string) => index.get(id) ?? "",
  localdocHistIndexWrite: async (id: string, content: string) => void index.set(id, content),
  localdocHistoryRead: async () => "",
  localdocHistoryRetire: async () => {},
  localdocHistBlobWrite: async (id: string, version: string, bytes: Uint8Array) => {
    if (failWrites) throw { code: "io", message: "disk full" };
    blobs.set(`${id}/${version}`, bytes.slice());
  },
  localdocHistBlobRead: async (id: string, version: string) => {
    const b = blobs.get(`${id}/${version}`);
    if (!b) throw { code: "io", message: "no such version" };
    return b.slice();
  },
  localdocHistBlobDelete: async (id: string, version: string) => void blobs.delete(`${id}/${version}`),
  localdocList: async () => [{ id: DOC, title: "Novel", format: "none", updated_at: 1, words: 0, excerpt: "" }],
  localdocFoldersRead: async () => "",
});

const DOC = "0f8fad5b-d9cb-469f-a165-70867728950e";
const t = (text: string, ...marks: JSONContent[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks: marks as never } : {}) });
const para = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const cell = (text: string): JSONContent => ({ type: "tableCell", content: [para(t(text))] });
// A document with the newer kinds of content in it: history must take them all.
const first: JSONContent[] = [
  { type: "heading", attrs: { level: 1 }, content: [t("Chapter One")] },
  para(t("It was a bright cold day"), { type: "footnote", content: [t("In April.")] }, t(".")),
  { type: "table", content: [{ type: "tableRow", content: [cell("Ship"), cell("Berth")] }] },
  { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [para(t("Done"))] }] },
];
const editor = new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: { type: "doc", content: first } });
const now = () => compactDocString(editor.getJSON());

// ------------------------------------------------------------ cutting revisions

{
  const v1 = await saveLocalVersion(DOC, now());
  check("the first revision is recorded", !!v1 && v1.kind === "auto" && (await readLocalHistory(DOC)).length === 1, JSON.stringify(v1));
  check("…and nothing is recorded when nothing changed", (await saveLocalVersion(DOC, now())) === null && (await readLocalHistory(DOC)).length === 1);

  editor.commands.insertContentAt(editor.state.doc.content.size, para(t("A new paragraph, twelve words long, is added here at the end.")));
  const v2 = await saveLocalVersion(DOC, now());
  check("an edit is recorded as a change, with what it added", !!v2 && v2.changed_blocks >= 1 && v2.added_words >= 10, JSON.stringify(v2));
  const list = await readLocalHistory(DOC);
  check("revisions are listed newest first", list.length === 2 && list[0].id === v2!.id);
  const back = await loadLocalVersion(DOC, v1!.id);
  check("a revision reads back as the text it was", !!back && back.includes("Chapter One") && !back.includes("A new paragraph"));

  const draft = await saveLocalVersion(DOC, now(), { name: "First draft", kind: "draft" });
  check("a named draft is kept even with no change since the last revision", draft?.kind === "draft" && draft.name === "First draft" && (await readLocalHistory(DOC)).length === 3);
}

// ------------------------------------------------------------ the panel

{
  const host = mountPoint();
  const root = createRoot(host);
  const compared: string[] = [];
  await act(async () => root.render(createElement(LocalHistoryPanel, { docId: DOC, editor: editor as never, onCompare: (side) => void compared.push(side.title) })));
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
  const rows = () => [...host.querySelectorAll(".wf-doc-version")] as HTMLButtonElement[];
  const tabs = () => [...host.querySelectorAll(".wf-doc-history-tabs button")] as HTMLButtonElement[];
  const modal = () => document.querySelector(".wf-doc-version-modal") as HTMLElement | null;
  const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));

  check("the panel lists the changes", rows().length === 2 && /blocks/.test(rows()[0].textContent ?? ""), rows().map((r) => r.textContent).join(" | "));
  await act(async () => void rows()[0].click());
  await settle();
  check("opening a change shows what that save changed", modal()?.textContent?.includes("A new paragraph, twelve words long") === true && !!modal()?.querySelector(".wf-doc-diff"), modal()?.textContent?.slice(0, 200));
  check("…with Restore and Compare with now", ["Restore", "Compare with now"].every((label) => [...(modal()?.querySelectorAll("button") ?? [])].some((b) => b.textContent?.includes(label))));
  await act(async () => void [...modal()!.querySelectorAll("button")].find((b) => b.textContent?.includes("Compare with now"))!.click());
  check("Compare hands the version over to be set beside the text now", compared.length === 1 && modal() === null);

  // The oldest change has nothing before it: the whole text is shown.
  await act(async () => void rows()[1].click());
  await settle();
  check("the first revision opens as the whole text — table, note and checklist drawn", !!modal()?.querySelector("table") && modal()?.textContent?.includes("Chapter One") === true && !!modal()?.querySelector("[data-footnote], sup"), modal()?.innerHTML.slice(0, 300));
  await act(async () => void (modal()!.querySelector('button[title="Close"]') as HTMLButtonElement).click());

  // Drafts.
  await act(async () => void tabs()[1].click());
  check("drafts are listed under their own tab, by name", rows().length === 1 && rows()[0].textContent?.includes("First draft") === true);
  const field = host.querySelector(".wf-doc-panel-row input") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(field, "Second draft");
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => void host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  await settle();
  check("a draft can be saved from the panel, and shows at once", rows().length === 2 && rows()[0].textContent?.includes("Second draft") === true, rows().map((r) => r.textContent).join(" | "));

  // Restore: back to the first revision; what was there is kept as a draft.
  await act(async () => void tabs()[0].click());
  await act(async () => void rows()[rows().length - 1].click());
  await settle();
  // (The confirm dialog isn't on the page here: say yes for it.)
  const before = editor.state.doc.textContent;
  const { applyRestore } = await import("../src/apps/documents/restore");
  const oldest = (await readLocalHistory(DOC)).filter((v) => v.kind !== "draft").slice(-1)[0];
  await act(async () => {
    await applyRestore(editor as never, JSON.parse((await loadLocalVersion(DOC, oldest.id))!));
  });
  check("restoring a revision puts its text back", !editor.state.doc.textContent.includes("A new paragraph") && before.includes("A new paragraph") && editor.state.doc.textContent.includes("Chapter One"));

  // Trouble writing is said, not hidden.
  failWrites = true;
  editor.commands.insertContentAt(1, t("X"));
  await saveLocalVersion(DOC, now()).catch(() => {});
  editor.commands.insertContentAt(1, t("Y"));
  await saveLocalVersion(DOC, now()).catch(() => {});
  await settle();
  check("when versions can't be written, the panel says so", host.textContent?.includes("aren’t being saved") === true);
  failWrites = false;
  await saveLocalVersion(DOC, now());
  await settle();
  check("…and stops saying so once they can", host.textContent?.includes("aren’t being saved") === false);

  await act(async () => root.unmount());
}

finish();
