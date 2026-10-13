// Writing sessions: what a writer types while a prompt runs is kept safe
// (saved sooner as the end nears, saved just before it, sent again when it
// does not get there, and kept on the device whatever happens), the desk
// it is written at, and what is shown and can be taken away afterwards.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Editor, JSONContent } from "@tiptap/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { sessionApi } from "../src/apps/sessions/api";
import { draftScope, WritingDesk } from "../src/apps/sessions/Desk";
import { DraftSaver, dropDraft, pace, pieceText, readDraft, sameWords, SAVE_DELAYS, sweepDrafts, writeDraft, writingLine, writingNow, type SaveState } from "../src/apps/sessions/draft";
import { keepAsDocument, pieceTitle } from "../src/apps/sessions/keep";
import { Pieces } from "../src/apps/sessions/Pieces";
import { useSessions } from "../src/apps/sessions/store";
import { useChat } from "../src/apps/chat/store";
import { backend } from "../src/lib/backend";
import { countWordsInDocJson } from "../src/lib/wordCount";
import { useSession } from "../src/stores/session";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 1500) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await wait(5);
  return ok();
};
const para = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
const piece = (...lines: string[]): JSONContent => ({ type: "doc", content: lines.map(para) });

// ------------------------------------------------------------- the words

{
  const doc: JSONContent = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "The Door" }] },
      { type: "paragraph", content: [{ type: "text", text: "It was " }, { type: "text", text: "open", marks: [{ type: "italic" }] }, { type: "text", text: "." }] },
      { type: "paragraph" },
      { type: "horizontalRule" },
      { type: "bulletList", content: [{ type: "listItem", content: [para("One")] }, { type: "listItem", content: [para("Two")] }] },
      { type: "paragraph", content: [{ type: "text", text: "Line" }, { type: "hardBreak" }, { type: "text", text: "after" }] },
    ],
  };
  check("a piece as text: a paragraph a line, marks gone, a divider kept", pieceText(doc) === "The Door\n\nIt was open.\n\n* * *\n\nOne\n\nTwo\n\nLine\nafter", JSON.stringify(pieceText(doc)));
  check("nothing at all is no text", pieceText(null) === "" && pieceText({ type: "doc", content: [{ type: "paragraph" }] }) === "");
  check("the same words in other formatting are the same words", sameWords(piece("It was open."), { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "It was " }, { type: "text", text: "open.", marks: [{ type: "bold" }] }] }] }));
  check("…and one word more is not", !sameWords(piece("It was open."), piece("It was open. Wide.")));
  check("the pace is not given in the first minute", pace(40, 1000, 1000 + 59_000) === null && pace(0, 1000, 1000 + 600_000) === null && pace(40, null, 5000) === null);
  check("…and then it is words a minute", pace(300, 0, 10 * 60_000) === 30);
  check("a kept piece is named for its session and prompt", pieceTitle("Friday sprint", 2) === "Friday sprint (prompt 2)" && pieceTitle("  ", 1) === "Writing session (prompt 1)");
}

// --------------------------------------------------- the copy on the device

{
  const scope = draftScope("host:1", 7);
  check("there is no draft before anything is written", readDraft(scope, 1) === null);
  writeDraft(scope, 1, { doc: piece("Kept."), at: 5000, sent: false });
  const back = readDraft(scope, 1);
  check("a draft comes back as it was written", !!back && pieceText(back.doc) === "Kept." && back.at === 5000 && back.sent === false);
  check("another person's, another server's and another prompt's are apart", readDraft(draftScope("host:1", 8), 1) === null && readDraft(draftScope("host:2", 7), 1) === null && readDraft(scope, 2) === null);
  localStorage.setItem("wf-session-draft:junk:3", "{not json");
  localStorage.setItem("wf-session-draft:junk:4", JSON.stringify({ doc: "words", at: 1 }));
  check("a damaged draft reads as none", readDraft("junk", 3) === null && readDraft("junk", 4) === null);
  dropDraft(scope, 1);
  check("a dropped draft is gone", readDraft(scope, 1) === null);

  // (The harness's stand-in storage has no list of its keys: give it one.)
  const store = new Map<string, string>();
  const real = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  const month = 30 * 24 * 60 * 60 * 1000;
  writeDraft(scope, 10, { doc: piece("Old."), at: 1000, sent: false });
  writeDraft(scope, 11, { doc: piece("New."), at: 1000 + month, sent: false });
  store.set("something-else", "kept");
  sweepDrafts(2000 + month);
  check("drafts a month old are cleared out, newer ones and other things are left", readDraft(scope, 10) === null && !!readDraft(scope, 11) && store.get("something-else") === "kept");
  g.localStorage = real;
}

// ----------------------------------------------------------------- saving

const QUICK = { idle: 40, near: 10, nearWindow: 20_000, last: [70, 20], retry: 25, retryMax: 60, local: 5 };

await (async () => {
  const scope = draftScope("host:1", 7);
  const sent: string[] = [];
  const states: SaveState[] = [];
  let fail: unknown = null;
  let hold: (() => void) | null = null;
  let holding = false;
  const make = (promptId: number, endsAt: number | null = null) =>
    new DraftSaver({
      promptId,
      scope,
      endsAt: () => endsAt,
      onState: (s) => states.push(s),
      delays: QUICK,
      save: async (doc) => {
        if (holding) await new Promise<void>((r) => (hold = r));
        if (fail) throw fail;
        sent.push(pieceText(doc));
      },
    });

  // Ordinary typing: one save, a little after the last key.
  let s = make(21);
  s.change(piece("One"));
  s.change(piece("One two"));
  s.change(piece("One two three"));
  check("nothing is sent while the keys are still going", sent.length === 0 && s.unsent);
  await until(() => sent.length === 1);
  await wait(20);
  check("a pause sends the latest words, once", sent.join("|") === "One two three" && !s.unsent);
  check("…and the bar is told: waiting, saving, saved", states.join() === "waiting,saving,saved", states.join());
  check("…and the copy on the device knows the server has them", readDraft(scope, 21)?.sent === true && pieceText(readDraft(scope, 21)!.doc) === "One two three");

  // Typed while a save is on its way: those words go next.
  sent.length = 0;
  holding = true;
  s.change(piece("Four"));
  await until(() => hold !== null);
  s.change(piece("Four five"));
  holding = false;
  hold!();
  hold = null;
  await until(() => sent.length === 2);
  check("words typed while a save is on its way are sent after it", sent.join("|") === "Four|Four five" && !s.unsent);
  await s.stop();

  // The server does not answer: say so, keep trying, and keep the words.
  sent.length = 0;
  states.length = 0;
  s = make(22);
  fail = { code: "http_502", message: "bad gateway" };
  s.change(piece("Stormy night"));
  await until(() => states.includes("retrying"));
  check("a save that fails says so and the words stay unsent", s.unsent && sent.length === 0 && readDraft(scope, 22)?.sent === false);
  fail = null;
  await until(() => sent.length === 1);
  await wait(20);
  check("…and it is sent again until it gets there", sent[0] === "Stormy night" && !s.unsent && states[states.length - 1] === "saved" && readDraft(scope, 22)?.sent === true, states.join());
  await s.stop();

  // The prompt ended on the server first: nothing more can go.
  sent.length = 0;
  states.length = 0;
  s = make(23);
  fail = { code: "not_running", message: "writing is only saved while the prompt runs" };
  s.change(piece("Too late"));
  await until(() => states.includes("closed"));
  const tries = states.filter((x) => x === "saving").length;
  s.change(piece("Too late by far"));
  await wait(120);
  check("once the server says the prompt is over nothing more is sent", states.filter((x) => x === "saving").length === tries && sent.length === 0);
  const kept = readDraft(scope, 23);
  check("…and the words are on the device, marked as never having got there", !!kept && kept.sent === false && pieceText(kept.doc) === "Too late by far");
  fail = null;
  await s.stop();

  // The end is near: the last saves are made just before it, however
  // recently a key was pressed.
  sent.length = 0;
  const end = Date.now() + 150;
  const slow = new DraftSaver({ promptId: 24, scope, endsAt: () => end, onState: () => {}, delays: { ...QUICK, idle: 5000, near: 5000 }, save: async (doc) => void sent.push(pieceText(doc)) });
  slow.change(piece("The last line"));
  await wait(60);
  check("(a save is not due yet by the ordinary rule)", sent.length === 0);
  await until(() => sent.length === 1, 400);
  check("the last words are sent before time is up, not after", sent[0] === "The last line" && Date.now() < end + 5, String(Date.now() - end));
  await slow.stop();

  // In the final stretch a pause is saved sooner.
  sent.length = 0;
  const near = new DraftSaver({ promptId: 25, scope, endsAt: () => Date.now() + 10_000, onState: () => {}, delays: { ...QUICK, idle: 5000, near: 15, last: [] }, save: async (doc) => void sent.push(pieceText(doc)) });
  near.change(piece("Hurry"));
  check("in the last seconds a pause is saved almost at once", await until(() => sent.length === 1, 300));
  await near.stop();

  // Leaving the desk: whatever is unsent gets one more try.
  sent.length = 0;
  s = make(26);
  s.change(piece("On the way out"));
  await s.stop();
  check("leaving the desk sends what was not yet sent", sent.join("|") === "On the way out" && readDraft(scope, 26)?.sent === true);
  sent.length = 0;
  s = make(27);
  holding = true;
  s.change(piece("First"));
  await until(() => hold !== null);
  s.change(piece("First and last"));
  const leaving = s.stop();
  holding = false;
  hold!();
  hold = null;
  await leaving;
  check("…and words typed while a save was on its way get their try too", sent.join("|") === "First|First and last", sent.join("|"));
})();

// --------------------------------------------------------- who is writing

{
  const writers = { 7: 9_000, 8: 9_500, 9: 1_000, 10: 9_900 };
  const now = 10_000 + 15_000;
  check("someone whose words arrived a moment ago is writing, someone long quiet is not, and I am not counted", writingNow(writers, 7, now).join() === "8,10" && writingNow(undefined, 7, now).length === 0);
  const names: Record<number, string> = { 8: "Ana", 10: "Ben", 11: "Cy" };
  const nameOf = (id: number) => names[id] ?? null;
  check("one name", writingLine([8], nameOf) === "Ana is writing too");
  check("two names", writingLine([8, 10], nameOf) === "Ana and Ben are writing too");
  check("more are counted", writingLine([8, 10, 11], nameOf) === "3 others are writing too");
  check("someone not known by name is still counted", writingLine([99], nameOf) === "Someone else is writing too" && writingLine([8, 99], nameOf) === "2 others are writing too");
  check("nobody is no line", writingLine([], nameOf) === "");
}

// ------------------------------------------------------------- the desk

const me = { id: 7, username: "vin", display_name: "Vin", avatar_attachment_id: null, accent_color: null };
const ana = { id: 8, username: "ana", display_name: "Ana", avatar_attachment_id: null, accent_color: null };
useSession.setState({ session: { user: me, addr: "host:1" } } as never);
useChat.setState({ members: [{ user: me, role: "member", joined_at: 0 }, { user: ana, role: "member", joined_at: 0 }] } as never);

const promptOf = (id: number, more: Record<string, unknown> = {}) =>
  ({ id, session_id: 1, creator_id: 8, position: 0, prompt_doc: piece("Write about a door."), timer_seconds: 600, state: "running", started_at: Date.now() - 5 * 60_000, ends_at: Date.now() + 5 * 60_000, ended_at: null, ...more }) as never;
const sessionOf = (prompts: unknown[], submissions: unknown[]) =>
  ({ session: { id: 1, channel_id: 1, creator: ana, title: "Friday sprint", state: "active", chat_channel_id: 2, created_at: 0, ended_at: null }, prompts, submissions }) as never;

const editorIn = (host: HTMLElement): Editor => (host.querySelector(".wf-paper .tiptap") as unknown as { editor: Editor }).editor;
/** A key at a time, through the rules for what is typed. */
const typeIn = async (e: Editor, text: string) =>
  act(async () => {
    for (const ch of text) {
      const { from, to } = e.state.selection;
      const deflt = () => e.state.tr.insertText(ch, from, to);
      const handled = e.view.someProp("handleTextInput", (f) => f(e.view, from, to, ch, deflt));
      if (!handled) e.view.dispatch(deflt());
    }
  });

Object.assign(SAVE_DELAYS, QUICK, { last: [] });
const saves: { prompt: number; text: string }[] = [];
let refuse: unknown = null;
(sessionApi as unknown as Record<string, unknown>).saveSubmission = async (prompt: number, doc: unknown) => {
  if (refuse) throw refuse;
  saves.push({ prompt, text: pieceText(doc) });
  return null;
};

await (async () => {
  const scope = draftScope("host:1", 7);
  const prompt = promptOf(31);
  useSessions.setState({ detail: sessionOf([prompt], []), writers: {} });
  const host = mountPoint();
  const root = createRoot(host);
  await act(async () => root.render(createElement(WritingDesk, { prompt, clock: createElement("span", { className: "wf-countdown" }, "5:00") })));
  const e = editorIn(host);
  const desk = host.querySelector(".wf-desk")!;
  check("the desk shows the clock, an empty count and that it saves by itself", desk.querySelector(".wf-countdown")?.textContent === "5:00" && desk.querySelector(".wf-desk-count")?.textContent === "0 words" && desk.querySelector(".wf-desk-save")?.textContent === "Saved as you write");
  check("the page is paper, and its tools are in the bar that stays in sight", !!desk.querySelector(".wf-desk-bar .wf-desk-tools") && !!desk.querySelector(".wf-paper .tiptap"));
  check("the text says what language it is in, for the spelling", !!e.view.dom.getAttribute("lang") && e.view.dom.getAttribute("spellcheck") === "true");

  await typeIn(e, '"It\'s open," she said -- and it was...');
  const typed = e.state.doc.textContent;
  check("quotes, apostrophes, dashes and dots are a typographer's as they are typed", typed === "“It’s open,” she said — and it was…", typed);
  check("the count keeps up with the typing", desk.querySelector(".wf-desk-count")?.textContent === "8 words", desk.querySelector(".wf-desk-count")?.textContent ?? "");
  check("…with the pace, after the first minute", /\d+ a minute/.test(desk.querySelector(".wf-desk-rate")?.textContent ?? ""));
  await act(async () => void (await until(() => saves.length === 1)));
  await act(async () => wait(20));
  check("what was typed is saved to its prompt after a pause", saves.length === 1 && saves[0].prompt === 31 && saves[0].text === typed);
  check("…and the bar says so", desk.querySelector(".wf-desk-save")?.textContent === "Saved" && desk.querySelector(".wf-desk-save")?.classList.contains("saved") === true);

  // The tools.
  const tool = (title: string) => [...desk.querySelectorAll<HTMLButtonElement>(".wf-desk-tools button")].find((b) => (b.getAttribute("title") ?? "").startsWith(title))!;
  await act(async () => {
    e.commands.selectAll();
    tool("Underline").click();
  });
  check("the bar's tools work on the text (underline, which the old box had no button for)", e.isActive("underline") && tool("Underline").classList.contains("active"));
  await act(async () => tool("Underline").click());
  // (A caret again: with everything selected each key would replace the last.)
  await act(async () => void e.commands.setTextSelection(3));
  await act(async () => {
    tool("More").dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    tool("More").click();
  });
  const more = [...document.body.querySelectorAll<HTMLButtonElement>(".wf-flyout .wf-flyout-item")];
  check("the rarer tools are under More", more.map((b) => b.textContent?.replace("✓", "").trim()).join() === "Heading,Smaller heading,Strikethrough,Picture", more.map((b) => b.textContent).join());
  await act(async () => more[0].click());
  check("…and they work", e.isActive("heading", { level: 1 }) && !document.body.querySelector(".wf-flyout"));
  await act(async () => void e.chain().toggleHeading({ level: 1 }).run());

  // Only the prompt and the page.
  check("(the prompt is not repeated inside the desk until it is all there is)", !desk.querySelector(".wf-desk-prompt"));
  await act(async () => desk.querySelector<HTMLButtonElement>(".wf-desk-focus")!.click());
  check("the focus view is the same desk made the whole window, with the prompt above the page", desk.classList.contains("focus") && desk.querySelector(".wf-desk-prompt")?.textContent === "Write about a door." && editorIn(host) === e);
  const toggle = desk.querySelector<HTMLButtonElement>(".wf-desk-toggle")!;
  await act(async () => toggle.click());
  check("the prompt can be put away there", !desk.querySelector(".wf-desk-prompt") && toggle.getAttribute("aria-pressed") === "false");
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  check("Escape goes back to the session, with the words as they were", !desk.classList.contains("focus") && e.state.doc.textContent === typed);

  // Who else is writing.
  check("(nobody else is writing yet)", !desk.querySelector(".wf-desk-others"));
  await act(async () => useSessions.setState({ writers: { 31: { 7: Date.now(), 8: Date.now() } } }));
  check("someone else's writing arriving is said under the page", desk.querySelector(".wf-desk-others")?.textContent === "Ana is writing too");

  // The server stops answering.
  refuse = { code: "http_503", message: "unavailable" };
  await act(async () => void e.commands.focus("end"));
  await typeIn(e, " More.");
  await act(async () => void (await until(() => desk.querySelector(".wf-desk-save")?.classList.contains("retrying") === true)));
  check("a save that does not get there is said in the bar", desk.querySelector(".wf-desk-save")?.textContent === "Not saved yet. Trying again");
  check("…and the words are on the device meanwhile", await until(() => readDraft(scope, 31)?.sent === false && pieceText(readDraft(scope, 31)!.doc).endsWith("More.")));

  // The app is closed with those words unsent, and opened again.
  await act(async () => root.unmount());
  refuse = null;
  saves.length = 0;
  writeDraft(scope, 31, { doc: piece("From the device, unsent."), at: Date.now(), sent: false });
  useSessions.setState({ detail: sessionOf([prompt], [{ id: 1, prompt_id: 31, author: me, doc: piece("From the server."), updated_at: 1 }]) });
  const host2 = mountPoint();
  const root2 = createRoot(host2);
  await act(async () => root2.render(createElement(WritingDesk, { prompt })));
  check("words this device has and the server never got are put back on the page", editorIn(host2).state.doc.textContent === "From the device, unsent." && !!host2.querySelector(".wf-desk-note"));
  await act(async () => void (await until(() => saves.length === 1)));
  await act(async () => wait(20));
  check("…and sent at the first chance", saves[0]?.text === "From the device, unsent." && readDraft(scope, 31)?.sent === true && !host2.querySelector(".wf-desk-note"));
  await act(async () => root2.unmount());

  // A copy on the device that the server already has changes nothing.
  writeDraft(scope, 31, { doc: piece("Old words."), at: 1, sent: true });
  const host3 = mountPoint();
  const root3 = createRoot(host3);
  await act(async () => root3.render(createElement(WritingDesk, { prompt })));
  check("a copy the server already has is not put over the server's", editorIn(host3).state.doc.textContent === "From the server." && !host3.querySelector(".wf-desk-note"));
  await act(async () => root3.unmount());
  dropDraft(scope, 31);
})();

// -------------------------------------------------------- after the prompt

await (async () => {
  const scope = draftScope("host:1", 7);
  let copied = "";
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void (copied = text) } });
  const mine = { id: 1, prompt_id: 41, author: me, doc: piece("My door was red.", "It did not open."), updated_at: 1 };
  const hers = { id: 2, prompt_id: 41, author: ana, doc: piece("Hers was blue."), updated_at: 1 };
  const fresh = promptOf(41, { state: "ended", ended_at: Date.now() - 2000 });
  useSessions.setState({ detail: sessionOf([fresh], [hers, mine]) });
  const host = mountPoint();
  const root = createRoot(host);
  await act(async () => root.render(createElement(Pieces, { prompt: fresh, index: 1, sessionTitle: "Friday sprint" })));
  const names = () => [...host.querySelectorAll(".wf-piece > header strong")].map((n) => n.textContent);
  check("a prompt that has just ended shows what was written, the reader's own piece first", names().join() === "Your piece,Ana", names().join());
  check("each piece says how long it is, and is set on paper", [...host.querySelectorAll(".wf-piece > header .wf-session-meta")].map((n) => n.textContent).join() === "8 words,3 words" && host.querySelectorAll(".wf-piece .wf-paper .tiptap").length === 2);
  const acts = (i: number) => [...host.querySelectorAll(".wf-piece")[i].querySelectorAll<HTMLButtonElement>(".wf-piece-act")];
  check("any piece can be copied, and only your own kept as a document", acts(0).map((b) => b.textContent?.trim()).join() === "Copy,Save as a document" && acts(1).map((b) => b.textContent?.trim()).join() === "Copy");
  await act(async () => acts(1)[0].click());
  await wait(5);
  check("Copy puts the piece's words on the clipboard", copied === "Hers was blue.");
  check("nothing is said about unsent words when there are none", !host.querySelector(".wf-pieces-unsent"));

  // Kept as a document. (The harness is a browser as far as the app can
  // tell, and a browser keeps it on the server. In the apps the same piece
  // goes to createLocalDocument, which the import and device checks hold.)
  const made: { title: string; format: string; updates: number; snapshot: string; version: string }[] = [];
  Object.assign(backend, {
    apiFetch: async (method: string, route: string, body?: Record<string, unknown>) => {
      if (method === "GET" && route === "/api/v1/document-capabilities") return { status: 200, body: { max_schema_level: 3 } };
      if (method === "POST" && route === "/api/v1/documents") {
        made.push({ title: String(body?.title), format: String(body?.format), updates: 0, snapshot: "", version: "" });
        return { status: 200, body: { id: made.length, title: body?.title, format: body?.format } };
      }
      const doc = made[made.length - 1];
      if (method === "POST" && /\/updates\?/.test(route)) {
        doc.updates += 1;
        return { status: 200, body: { seq: doc.updates, schema_level: 1 } };
      }
      if (method === "POST" && /\/snapshot\?/.test(route)) {
        doc.snapshot = String(body?.doc_json);
        doc.version = String(body?.name);
        return { status: 200, body: null };
      }
      return { status: 404, body: { code: "not_found", message: `no route ${method} ${route}` } };
    },
  });
  await act(async () => acts(0)[1].click());
  await act(async () => void (await until(() => !!made[0]?.snapshot, 4000)));
  check("Save as a document makes a document of the piece, named for the session and prompt", made.length === 1 && made[0].title === "Friday sprint (prompt 2)" && made[0].format === "none" && made[0].updates >= 1, JSON.stringify(made[0]).slice(0, 200));
  check("…holding the piece's words, with a version that says where it came from", pieceText(JSON.parse(made[0]?.snapshot || "null")) === "My door was red.\n\nIt did not open." && made[0]?.version === "From a writing session", made[0]?.snapshot.slice(0, 200));
  await keepAsDocument("Nothing", null).catch((e) => console.log("keep failed:", e));
  check("a piece with nothing in it still makes a document (an empty one)", made.length === 2 && made[1].title === "Nothing" && !!made[1].snapshot);

  // Words that never reached the server.
  await act(async () => writeDraft(scope, 41, { doc: piece("My door was red.", "It did not open.", "Until it did."), at: Date.now(), sent: false }));
  const notice = host.querySelector(".wf-pieces-unsent");
  check("words the server never got are said plainly, with how many there are", !!notice && /did not reach the server/.test(notice.textContent ?? "") && /11 words in all/.test(notice.textContent ?? ""), notice?.textContent ?? "");
  const noticeActs = [...host.querySelectorAll<HTMLButtonElement>(".wf-pieces-acts button")];
  check("…with ways to keep them", noticeActs.map((b) => b.textContent?.trim()).join() === "Copy them,Save as a document,Discard");
  await act(async () => noticeActs[0].click());
  await wait(5);
  check("…as text, in full", copied === "My door was red.\n\nIt did not open.\n\nUntil it did.");
  check("…and they stay on the device until the writer says otherwise", readDraft(scope, 41)?.sent === false);
  await act(async () => dropDraft(scope, 41));
  check("discarded, the notice goes", !host.querySelector(".wf-pieces-unsent"));

  // A copy the server has is only tidied away.
  await act(async () => writeDraft(scope, 41, { doc: piece("My door was red.", "It did not open."), at: Date.now(), sent: false }));
  check("a copy on the device that says what the server has is no cause for alarm, and is cleared", !host.querySelector(".wf-pieces-unsent") && readDraft(scope, 41) === null);

  // Folding.
  const fold = host.querySelector<HTMLButtonElement>(".wf-subs-toggle")!;
  check("(the writing can be folded away)", fold.textContent === "Hide the writing" && fold.getAttribute("aria-expanded") === "true");
  await act(async () => fold.click());
  check("folded, the button says how much there is and how long the reader's own is", !host.querySelector(".wf-piece") && /Show all 2 pieces/.test(fold.textContent ?? "") && /yours is 8 words/.test(fold.textContent ?? ""), fold.textContent ?? "");
  await act(async () => root.unmount());

  // An old prompt, and one nobody wrote for.
  const old = promptOf(42, { state: "ended", ended_at: Date.now() - 60 * 60_000 });
  useSessions.setState({ detail: sessionOf([old], [{ ...hers, prompt_id: 42 }]) });
  const host2 = mountPoint();
  const root2 = createRoot(host2);
  await act(async () => root2.render(createElement(Pieces, { prompt: old, index: 0, sessionTitle: "Friday sprint" })));
  check("a prompt that ended a while ago stays folded, so a long session is not an endless page", !host2.querySelector(".wf-piece") && host2.querySelector(".wf-subs-toggle")?.textContent === "Show the piece");
  await act(async () => root2.unmount());
  const empty = promptOf(43, { state: "ended", ended_at: Date.now() - 1000 });
  useSessions.setState({ detail: sessionOf([empty], []) });
  const host3 = mountPoint();
  const root3 = createRoot(host3);
  await act(async () => root3.render(createElement(Pieces, { prompt: empty, index: 0, sessionTitle: "Friday sprint" })));
  check("a prompt nobody wrote for says so", host3.textContent === "No one wrote for this prompt.");
  await act(async () => root3.unmount());
})();

// ------------------------------------------------------------ the styles

{
  // (The harness runs from harness/.out.)
  const css = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/styles.css"), "utf8");
  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`);
    return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
  };
  check("the bar stays in sight while the page scrolls under it", /position: sticky/.test(rule(".wf-desk-bar")) && /top: 0/.test(rule(".wf-desk-bar")));
  check("the focus view is over everything but dialogs and menus, and stops at a phone's keyboard", /position: fixed/.test(rule(".wf-desk.focus")) && /z-index: 90/.test(rule(".wf-desk.focus")) && /bottom: max\(var\(--wf-kb-inset, 0px\), var\(--wf-kb, 0px\)\)/.test(rule(".wf-desk.focus")));
  check("the page is light paper whatever the theme, in a size a phone does not zoom in on", /color-scheme: light/.test(rule(".wf-paper")) && /font-size: 17px/.test(rule(".wf-paper .wf-rich .tiptap")));
  check("nothing of the box the desk replaced is left in the stylesheet", !/\.wf-writing\b|\.wf-submission\b/.test(css));
  check("no other part of the app has these names", (css.match(/\n\.wf-paper \{/g) ?? []).length === 1 && (css.match(/\n\.wf-desk \{/g) ?? []).length === 1);
}

check("(the word counter the desk and the pieces share)", countWordsInDocJson(piece("One two", "three")) === 3);

finish();
