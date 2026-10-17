// Publishing a document from this device: one device document becomes one
// server document, shared with as many groups as wanted, never a copy per
// group. A document of the same name already there is offered first, and
// the copy here can be left behind.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";

import { b64encode } from "../src/apps/documents/collab";
import { useLocalDocs } from "../src/apps/documents/local";
import { sharedLine } from "../src/apps/documents/organizer/DocCard";
import { serverItem } from "../src/apps/documents/organizer/model";
import { forgetPublished, notePublished, publishedCopy } from "../src/apps/documents/published";
import { ShareLocalDialog } from "../src/apps/documents/ShareLocalDialog";
import { useDocuments } from "../src/apps/documents/store";
import { backend } from "../src/lib/backend";
import { useSession } from "../src/stores/session";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));

// ------------------------------------------------------------ the record

check("nothing published yet", publishedCopy("a", "host|1") === null);
notePublished("a", "host|1", 12);
notePublished("a", "other|1", 40);
check("one server document per device document and server", publishedCopy("a", "host|1") === 12 && publishedCopy("a", "other|1") === 40 && publishedCopy("a", "host|2") === null);
forgetPublished("a", "host|1");
check("…forgotten for one server only", publishedCopy("a", "host|1") === null && publishedCopy("a", "other|1") === 40);
localStorage.setItem("wf-published", "{nonsense");
check("a spoiled record is no record", publishedCopy("a", "other|1") === null);
localStorage.removeItem("wf-published");

check("who it's shared with, said shortly", sharedLine(["Writers"]) === "Shared with Writers" && sharedLine(["Writers", "Beta"]) === "Shared with Writers and Beta" && sharedLine(["A", "B", "C", "D"]) === "Shared with A, B and 2 more");

// ------------------------------------------------------------ a stand-in server

const me = { id: 7, username: "vin", display_name: "Vin", avatar_attachment_id: null, accent_color: null };
useSession.setState({ phase: "connected", link: "connected", session: { addr: "host:1", user: me } } as never);
const scope = "host:1|7";

type Doc = { id: number; title: string; format: string; shares: { name: string }[] };
const server: Doc[] = [];
const calls: string[] = [];
const listItem = (d: Doc) => ({
  document: { id: d.id, owner: me, title: d.title, format: d.format, folder_id: null, created_at: 1, updated_at: 2, schema_level: 4 },
  my_access: "owner",
  word_count: 17555,
  excerpt: "",
  snippet: null,
  deleted_at: null,
  card: { synopsis: "", cover: null, tags: [] },
  shared_with: d.shares.map((s) => s.name),
});
const groupNames: Record<number, string> = { 3: "Writers", 4: "Beta readers" };
Object.assign(backend, {
  apiFetch: async (method: string, route: string, body?: Record<string, unknown>) => {
    if (method === "GET" && route === "/api/v1/document-capabilities") return { status: 200, body: { max_schema_level: 4 } };
    if (method === "GET" && /^\/api\/v1\/documents(\?|$)/.test(route)) return { status: 200, body: server.map(listItem) };
    if (method === "POST" && route.startsWith("/api/v1/documents") && /\/documents(\?|$)/.test(route)) {
      const d = { id: 100 + server.length, title: String(body?.title), format: String(body?.format), shares: [] };
      server.push(d);
      calls.push(`create ${d.id}`);
      return { status: 200, body: { id: d.id, owner: me, title: d.title, format: d.format, folder_id: null, created_at: 1, updated_at: 1, schema_level: 1 } };
    }
    const m = /^\/api\/v1\/documents\/(\d+)\/(updates|snapshot|shares)/.exec(route);
    const doc = m ? server.find((d) => d.id === Number(m[1])) : undefined;
    if (m && method === "POST" && m[2] === "updates") return { status: 200, body: { seq: 1, schema_level: 1 } };
    if (m && method === "POST" && m[2] === "snapshot") return { status: 200, body: null };
    if (m && doc && method === "GET" && m[2] === "shares") return { status: 200, body: doc.shares.map((s) => ({ subject_name: s.name })) };
    if (m && doc && method === "PUT" && m[2] === "shares") {
      calls.push(`share ${doc.id} ${body?.subject_kind}:${body?.subject_id}`);
      doc.shares.push({ name: groupNames[Number(body?.subject_id)] ?? "someone" });
      return { status: 200, body: {} };
    }
    return { status: 404, body: { code: "not_found", message: `${method} ${route}` } };
  },
  localdocRead: async () => {
    const y = new Y.Doc();
    const text = new Y.XmlText("If I could describe Victoria Falls");
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [text]);
    y.getXmlFragment("default").insert(0, [p]);
    return JSON.stringify({ id: "local-1", title: "Forever in His Veins", format: "manuscript", state_b64: b64encode(Y.encodeStateAsUpdate(y)), created_at: 1 });
  },
});
const removed: string[] = [];
useLocalDocs.setState({ remove: async (id: string) => void removed.push(id) } as never);

const meta = { id: "local-1", title: "Forever in His Veins", format: "manuscript" };
const host = mountPoint();
const root = createRoot(host);
let open = true;
const show = async () => {
  open = true;
  useDocuments.setState({ loaded: false, items: [] } as never);
  await act(async () => root.render(createElement(ShareLocalDialog, { meta, onClose: () => void (open = false) })));
  await wait(30);
};
const text = () => document.body.textContent ?? "";
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>("button")];
const press = async (label: string) => {
  const b = buttons().find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button ${label}: ${buttons().map((x) => x.textContent).join("|")}`);
  await act(async () => b.click());
  await wait(40);
};
const pick = async (value: string) => {
  const select = document.body.querySelector<HTMLSelectElement>(".wf-share-who");
  if (!select) throw new Error("no share picker");
  // The picker's groups come from the chat store.
  const option = document.createElement("option");
  option.value = value;
  select.appendChild(option);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

// The first time: nothing there, so it is published.
await show();
check("first time: it offers to publish", buttons().some((b) => b.textContent === "Publish without sharing"), text());
await pick("group:3");
await press("Publish + share");
check("published once and shared with the group", calls.join() === "create 100,share 100 group:3", calls.join());
check("…and remembered", publishedCopy("local-1", scope) === 100);
check("…the dialog now speaks of that one copy", /This is the one copy to share/.test(text()) && /Shared with Writers/.test(text()), text());

// The second time (another group): the same document, shared again.
await act(async () => root.render(createElement("div")));
await show();
check("next time it opens on the copy it made", /on this server/.test(text()) && /Shared with Writers/.test(text()) && !buttons().some((b) => b.textContent === "Publish without sharing"), text());
await pick("group:4");
await press("Share");
check("sharing with another group makes no new copy", calls.join() === "create 100,share 100 group:3,share 100 group:4", calls.join());
check("…and says who has it", /Shared with Writers, Beta readers/.test(text()), text());
check("the list's card for it says so too", serverItem(listItem(server[0]) as never).sharedWith.join() === "Writers,Beta readers");

// Leaving only the server copy.
await press("Keep only the server copy");
check("the copy here goes to Recently Deleted", removed.join() === "local-1" && !open);

// A copy gone from the server is forgotten.
server.splice(0);
await act(async () => root.render(createElement("div")));
await show();
check("a copy no longer there is forgotten, and it offers to publish", publishedCopy("local-1", scope) === null && buttons().some((b) => b.textContent === "Publish without sharing"));

// Copies made before (one per group): same name, same kind.
server.push({ id: 7, title: "Forever in His Veins", format: "manuscript", shares: [{ name: "Writers" }] }, { id: 8, title: "forever in his veins ", format: "manuscript", shares: [] }, { id: 9, title: "Forever in His Veins", format: "none", shares: [] });
await act(async () => root.render(createElement("div")));
await show();
check("documents of the same name and kind already there are offered", /You already have 2 documents called/.test(text()) && document.body.querySelectorAll(".wf-publish-same li").length === 2, text());
check("…with who each is shared with", /shared with Writers/.test(document.body.querySelector(".wf-publish-same")?.textContent ?? ""));
await act(async () => document.body.querySelector<HTMLButtonElement>(".wf-publish-same li button")!.click());
await wait(30);
check("using one of them remembers it, and makes nothing new", publishedCopy("local-1", scope) === 7 && calls.filter((c) => c.startsWith("create")).length === 1 && /This is the one copy to share/.test(text()));
await press("Put another copy on the server");
check("another copy can still be made on purpose", buttons().some((b) => b.textContent === "Publish without sharing"));

await act(async () => root.unmount());
finish();
