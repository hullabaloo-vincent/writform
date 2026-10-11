// The document provider against a fake server: the schema-level plumbing on
// every content request, and what happens when the levels disagree — a
// refusal from the server, and content this app can't represent arriving
// anyway (it must stop sending for good: by then its own editor is deleting
// what it doesn't know).
//
// The raise handshake itself (an edit that needs a newer level) gets its
// harness with the first real level 2; the server's half is covered by
// `schema_levels_gate_older_clients` in documents_flow.rs.

import { check, finish } from "./env";
import "./dom";

import { getSchema, type JSONContent } from "@tiptap/core";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import * as Y from "yjs";

import { b64decode, b64encode, DocProvider } from "../src/apps/documents/collab";
import { classifySendError, isPermanent } from "../src/apps/documents/sync/batch";
import { drainOutbox } from "../src/apps/documents/sync/drain";
import { outbox } from "../src/apps/documents/sync/outbox";
import { docContentExtensions } from "../src/editor/schema/content";
import { DOC_SCHEMA_LEVEL } from "../src/editor/schema/levels";
import { forgetCapabilities } from "../src/apps/documents/sync/caps";
import { backend } from "../src/lib/backend";
import { useSession } from "../src/stores/session";

const DOC = 7;
const schema = getSchema(docContentExtensions());
const para = (t: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text: t }] });

// ---------------------------------------------------------------- a fake server

interface Call {
  method: string;
  path: string;
  body: { update_b64?: string; schema_level?: number | null } | undefined;
}
const calls: Call[] = [];
const server = {
  level: 1,
  /** The newest level it stores (`/document-capabilities`); null: a server
   *  from before the route existed. */
  max: null as number | null,
  seq: 0,
  state: new Y.Doc(),
  /** Answer like a server from before levels (no `schema_level` anywhere). */
  old: false,
  refuse: null as { status: number; code: string } | null,
};
const subs: string[] = [];
let deliver: ((event: unknown) => void) | null = null;

const documentJson = () => ({
  id: DOC,
  owner: { id: 1, username: "me", display_name: null, avatar_attachment_id: null, accent_color: null },
  title: "Novel",
  format: "none",
  folder_id: null,
  created_at: 111,
  updated_at: 111,
  ...(server.old ? {} : { schema_level: server.level }),
});

Object.assign(backend, {
  apiFetch: async (method: string, path: string, body?: Call["body"]) => {
    calls.push({ method, path, body });
    const route = path.split("?")[0];
    if (method === "GET" && route === `/api/v1/documents/${DOC}`) {
      return {
        status: 200,
        body: { document: documentJson(), my_access: "owner", state_b64: b64encode(Y.encodeStateAsUpdate(server.state)), seq: server.seq },
      };
    }
    if (method === "GET" && route === "/api/v1/document-capabilities" && server.max !== null) {
      return { status: 200, body: { max_schema_level: server.max } };
    }
    if (method === "GET" && route === "/api/v1/documents") {
      return { status: 200, body: [{ document: documentJson(), my_access: "owner" }] };
    }
    if (method === "POST" && route === `/api/v1/documents/${DOC}/updates`) {
      if (server.refuse) return { status: server.refuse.status, body: { code: server.refuse.code, message: "refused" } };
      Y.applyUpdate(server.state, b64decode(body!.update_b64!));
      server.seq += 1;
      // The update that needs a newer level raises the document with it.
      if (typeof body!.schema_level === "number") server.level = Math.max(server.level, body!.schema_level);
      return { status: 200, body: server.old ? { seq: server.seq } : { seq: server.seq, schema_level: server.level } };
    }
    if (method === "GET" && route === `/api/v1/documents/${DOC}/updates`) {
      return { status: 200, body: { updates: [], truncated: false } };
    }
    if (route.endsWith("/awareness")) return { status: 204, body: null };
    return { status: 404, body: { code: "not_found", message: "not found" } };
  },
  wsSub: async (rooms: string[]) => void subs.push(...rooms),
  wsUnsub: async () => {},
  onWsEvent: (fn: (event: unknown) => void) => {
    deliver = fn;
    return () => {
      deliver = null;
    };
  },
});
useSession.setState({
  phase: "connected",
  session: { addr: "test:7311", user: { id: 1, username: "me" } } as never,
});

/** What the editor does: write through the bound fragment, as a local edit. */
const type = (provider: DocProvider, text: string) =>
  provider.doc.transact(() => {
    const fragment = provider.doc.getXmlFragment("default");
    const scratch = new Y.Doc();
    prosemirrorJSONToYXmlFragment(schema, { type: "doc", content: [para(text)] }, scratch.getXmlFragment("default"));
    fragment.push(scratch.getXmlFragment("default").toArray().map((n) => n.clone() as Y.XmlElement));
  }, "editor");
const serverText = () => server.state.getXmlFragment("default").toString();
const appends = () => calls.filter((c) => c.method === "POST" && c.path.includes("/updates"));
const remote = (update: Uint8Array, room = `document:${DOC}`) =>
  deliver?.({ ev: "event", room, kind: "document.update", data: { doc_id: DOC, seq: ++server.seq, update_b64: b64encode(update) } });

// ---------------------------------------------------------------- plumbing

{
  const provider = new DocProvider(DOC);
  await provider.open();
  const detail = calls.find((c) => c.method === "GET" && c.path.startsWith(`/api/v1/documents/${DOC}`));
  check("opening sends the app's schema level", detail?.path.includes(`sl=${DOC_SCHEMA_LEVEL}`) === true, detail?.path);
  check("on a server from before levels, the app joins only the plain room", subs.join() === `document:${DOC}`, subs.join());
  check("…and its documents may use level 1", provider.level === 1);

  type(provider, "First words.");
  await provider.flush();
  const sent = appends()[0];
  check("an edit is sent with the app's level and no raise", sent?.path.includes(`sl=${DOC_SCHEMA_LEVEL}`) === true && sent.body?.schema_level === null, JSON.stringify(sent?.body?.schema_level));
  check("…and reaches the server", serverText().includes("First words.") && provider.getStatus().kind === "synced");

  // A collaborator's level-1 edit arrives on the plain room.
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(server.state));
  const before = Y.encodeStateVector(peer);
  prosemirrorJSONToYXmlFragment(schema, { type: "doc", content: [para("From a friend.")] }, peer.getXmlFragment("default"));
  remote(Y.encodeStateAsUpdate(peer, before));
  check("a collaborator's edit is applied", provider.doc.getXmlFragment("default").toString().includes("From a friend."));
  check("…without being sent back", appends().length === 1 && !provider.hasUnsent());

  // Something on a room this app never joined is not for it.
  const stray = new Y.Doc();
  stray.getXmlFragment("default").push([new Y.XmlElement("callout")]);
  remote(Y.encodeStateAsUpdate(stray), `docv2:${DOC}`);
  check("an update on a room the app didn't join is ignored", !provider.doc.getXmlFragment("default").toString().includes("callout") && provider.getStatus().kind === "synced");

  // A server from before levels answers without `schema_level`.
  server.old = true;
  type(provider, "Old server.");
  await provider.flush();
  check("a server from before levels still works", serverText().includes("Old server.") && provider.getStatus().kind === "synced");
  server.old = false;
  provider.destroy();
}

// ---------------------------------------------------------------- content this app can't represent

{
  calls.length = 0;
  const provider = new DocProvider(DOC);
  await provider.open();
  type(provider, "Written before.");
  // Not flushed yet: one legitimate edit is waiting when the trouble arrives.
  const newer = new Y.Doc();
  Y.applyUpdate(newer, Y.encodeStateAsUpdate(server.state));
  const before = Y.encodeStateVector(newer);
  const callout = new Y.XmlElement("callout");
  newer.getXmlFragment("default").push([callout]);
  remote(Y.encodeStateAsUpdate(newer, before));

  const status = provider.getStatus();
  check("unknown content from a collaborator stops the provider", status.kind === "error" && status.reason === "outdated", JSON.stringify(status));

  // What the editor's binding does next: delete what it can't render.
  provider.doc.transact(() => {
    const fragment = provider.doc.getXmlFragment("default");
    fragment.delete(fragment.length - 1, 1);
  }, "editor");
  type(provider, "Typed after.");
  await provider.flush();
  await new Promise((r) => setTimeout(r, 400));
  check("…and nothing after that is ever sent", appends().length === 0, `${appends().length} sends`);
  check("…so the server keeps the newer content", !serverText().includes("Typed after."));
  const kept = (await outbox.all()).find((e) => e.docId === DOC);
  check("…while the edit made before is kept on the device", !!kept && kept.pending.length > 0 && kept.error?.reason === "outdated", JSON.stringify(kept?.error));
  provider.retry();
  await new Promise((r) => setTimeout(r, 400));
  check("…and Try Again can't restart it", appends().length === 0);
  provider.destroy();
  for (const e of await outbox.all()) await outbox.remove(e.key);
}

// ---------------------------------------------------------------- refused by the server

{
  check("client_too_old is its own, permanent kind", classifySendError({ status: 403, code: "client_too_old" }) === "outdated" && isPermanent("outdated"));
  check("schema_unsupported likewise", classifySendError({ status: 400, code: "schema_unsupported" }) === "server_old" && isPermanent("server_old"));
  check("a plain 403 is still 'forbidden'", classifySendError({ status: 403, code: "read_only" }) === "forbidden");

  calls.length = 0;
  const provider = new DocProvider(DOC);
  await provider.open();
  // Someone raised the document while this app wasn't looking.
  server.refuse = { status: 403, code: "client_too_old" };
  type(provider, "Unsendable for now.");
  await provider.flush();
  const status = provider.getStatus();
  check("a refused edit stops with the update-the-app message", status.kind === "error" && status.reason === "outdated" && /newer version/.test(status.message), JSON.stringify(status));
  provider.destroy();
  const kept = (await outbox.all()).find((e) => e.docId === DOC);
  check("…and waits in the outbox with a full copy", !!kept && kept.error?.reason === "outdated" && !!kept.rescue);

  // The background sender re-checks "outdated" entries: still too new…
  server.level = DOC_SCHEMA_LEVEL + 1;
  calls.length = 0;
  await drainOutbox();
  check("the background sender leaves it while the document is newer than the app", appends().length === 0 && (await outbox.all()).some((e) => e.docId === DOC));
  // …until the app understands the document (here: the document is back in reach).
  server.level = 1;
  server.refuse = null;
  await drainOutbox();
  check("…and sends it once the app understands the document", serverText().includes("Unsendable for now.") && !(await outbox.all()).some((e) => e.docId === DOC));
}

// ---------------------------------------------------------------- the raise (level 2 is real)

{
  // A server that has been updated: the document may use what this app has.
  forgetCapabilities();
  server.max = DOC_SCHEMA_LEVEL;
  server.level = 1;
  server.refuse = null;
  subs.length = 0;
  calls.length = 0;
  const provider = new DocProvider(DOC);
  await provider.open();
  check("on an updated server the document may use this app's level", provider.level === DOC_SCHEMA_LEVEL && DOC_SCHEMA_LEVEL >= 2);
  check("…and the app joins the rooms newer updates travel on", subs.includes(`document:${DOC}`) && subs.includes(`docv2:${DOC}`), subs.join());

  type(provider, "Still plain.");
  await provider.flush();
  check("a plain edit doesn't raise the document", appends().every((c) => c.body?.schema_level === null) && server.level === 1);

  // Colour on some words: level-2 vocabulary.
  calls.length = 0;
  provider.doc.transact(() => {
    const scratch = new Y.Doc();
    prosemirrorJSONToYXmlFragment(
      schema,
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "In colour.", marks: [{ type: "textColor", attrs: { c: "#c00000" } }] }] }] },
      scratch.getXmlFragment("default"),
    );
    provider.doc.getXmlFragment("default").push(scratch.getXmlFragment("default").toArray().map((n) => n.clone() as Y.XmlElement));
  }, "editor");
  await provider.flush();
  const raising = appends()[0];
  check("the first edit that uses newer formatting raises the document with it", raising?.body?.schema_level === 2 && server.level === 2, JSON.stringify(raising?.body?.schema_level));

  calls.length = 0;
  type(provider, "After the raise.");
  await provider.flush();
  check("…once, not on every edit after", appends().length === 1 && appends()[0].body?.schema_level === null, JSON.stringify(appends().map((c) => c.body?.schema_level)));
  provider.destroy();
}

{
  // A server that answers, but hasn't been updated: held to its level.
  forgetCapabilities();
  server.max = 1;
  server.level = 1;
  subs.length = 0;
  const provider = new DocProvider(DOC);
  await provider.open();
  check("a server at level 1 holds its documents there", provider.level === 1 && !subs.some((r) => r.startsWith("docv")), subs.join());
  provider.destroy();
}

finish();
