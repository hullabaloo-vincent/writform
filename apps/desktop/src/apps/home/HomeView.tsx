import { FileText, FileType, FileUp, Globe, HardDrive, NotebookPen, Presentation, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { backend, isCmdError, isMobileApp, isWeb, type HostStatus, type SavedServer } from "../../lib/backend";
import { usePlatform } from "../../platform";
import { greeting, mergeRecents, whenLabel, type Recent } from "../../platform/recentsModel";
import { toast, toastError } from "../../platform/toast";
import { useLocalProfile } from "../../stores/localProfile";
import { useSession } from "../../stores/session";
import { isLocalBoard, useLocalBoards } from "../canvas/local";
import { useCanvas } from "../canvas/store";
import { cleanCard, parseCardCover } from "../documents/card";
import { baseOf, parentOf } from "../notes/paths";
import { FORMAT_LABELS } from "../documents/formats/elements";
import { CardCover } from "../documents/organizer/DocCard";
import { useLocalDocs } from "../documents/local";
import { openKeptPdf, openLocalDoc, openPdfFile, openServerDoc } from "../documents/navigation";
import { looksLikePdf, pdfIntent } from "../../pdf/desk";
import { canKeepPdfs, sizeLabel, usePdfShelf } from "../../pdf/shelf";
import { NewDocumentDialog } from "../documents/NewDocumentDialog";
import { useDocuments } from "../documents/store";
import { useNotesPending } from "../notes/pending";

const ICONS = {
  document: <FileText size={18} />,
  board: <Presentation size={18} />,
  note: <NotebookPen size={18} />,
  pdf: <FileType size={18} />,
};

/**
 * Home: what you can start, what you were last working on, and who you
 * write with. Everything here works with no server at all — servers are
 * the last section, not the door.
 */
export function HomeView() {
  const link = useSession((s) => s.link);
  const session = useSession((s) => s.session);
  const target = useSession((s) => s.target);
  const openConnect = useSession((s) => s.openConnect);
  const profileName = useLocalProfile((s) => s.name);
  const profileLoaded = useLocalProfile((s) => s.loaded);
  const localDocs = useLocalDocs((s) => s.items);
  const localBoards = useLocalBoards((s) => s.items);
  const pdfs = usePdfShelf((s) => s.items);
  const serverDocs = useDocuments((s) => s.items);
  const [notes, setNotes] = useState<{ name: string; modified_at: number }[]>([]);
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [host, setHost] = useState<HostStatus | null>(null);
  const [newDoc, setNewDoc] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const fileRef = useRef<HTMLInputElement>(null);
  const connected = link === "connected";

  useEffect(() => {
    if (!isWeb) {
      if (!useLocalDocs.getState().loaded) void useLocalDocs.getState().load().catch(() => {});
      if (!useLocalBoards.getState().loaded) void useLocalBoards.getState().load().catch(() => {});
      if (canKeepPdfs() && !usePdfShelf.getState().loaded) void usePdfShelf.getState().load().catch(() => {});
      void backend.vaultList().then(setNotes).catch(() => {});
    }
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);
  useEffect(() => {
    if (connected && !useDocuments.getState().loaded) void useDocuments.getState().load().catch(() => {});
    if (isWeb) return;
    void Promise.all([backend.listServers(), backend.hostStatus()])
      .then(([list, status]) => {
        setServers(list);
        setHost(status);
      })
      .catch(() => {});
  }, [connected, link]);

  const recents = useMemo(() => {
    const lists: Recent[][] = [
      localDocs.map((d) => ({
        kind: "document" as const,
        key: `localdoc:${d.id}`,
        title: d.title || "Untitled",
        detail: `${FORMAT_LABELS[d.format] ?? "Document"} · on this device`,
        at: d.updated_at,
        place: "device" as const,
        cover: d.card?.cover ?? null,
      })),
      localBoards.map((b) => ({
        kind: "board" as const,
        key: `localboard:${b.id}`,
        title: b.name || "Untitled board",
        detail: "Board · on this device",
        at: b.updated_at,
        place: "device" as const,
      })),
      notes.map((n) => ({
        kind: "note" as const,
        key: `note:${n.name}`,
        title: baseOf(n.name),
        detail: parentOf(n.name) ? `Note · ${parentOf(n.name)}` : "Note",
        at: n.modified_at,
        place: "device" as const,
      })),
      pdfs.map((f) => ({
        kind: "pdf" as const,
        key: `pdf:${f.id}`,
        title: f.name.replace(/\.pdf$/i, ""),
        detail: `PDF · ${sizeLabel(f.bytes)} · on this device`,
        at: f.modified_at,
        place: "device" as const,
      })),
      connected
        ? serverDocs.map(({ document: d, card }) => ({
            kind: "document" as const,
            key: `doc:${d.id}`,
            title: d.title || "Untitled",
            detail: `${FORMAT_LABELS[d.format] ?? "Document"} · ${session?.addr ?? "server"}`,
            at: d.updated_at,
            place: "server" as const,
            cover: cleanCard(card).cover,
          }))
        : [],
    ];
    return mergeRecents(lists, 8);
  }, [localDocs, localBoards, notes, pdfs, serverDocs, connected, session?.addr]);

  const open = (item: Recent) => {
    const [where, id] = [item.key.slice(0, item.key.indexOf(":")), item.key.slice(item.key.indexOf(":") + 1)];
    const fail = (e: unknown) => toastError(isCmdError(e) ? e.message : String(e));
    if (where === "localdoc") void openLocalDoc(id).catch(fail);
    else if (where === "pdf") void openKeptPdf(id).catch(fail);
    else if (where === "doc") void openServerDoc(Number(id)).catch(fail);
    else if (where === "localboard") {
      usePlatform.getState().setActiveApp("writform.canvas");
      void useCanvas.getState().openBoard(Number(id)).catch(fail);
    } else if (where === "note") {
      useNotesPending.getState().request(id);
      usePlatform.getState().setActiveApp("writform.notes");
    }
  };

  const newBoard = async () => {
    try {
      const id = await useLocalBoards.getState().create("Untitled board");
      usePlatform.getState().setActiveApp("writform.canvas");
      if (isLocalBoard(id)) await useCanvas.getState().openBoard(id);
    } catch (e) {
      toastError(isCmdError(e) ? e.message : String(e));
    }
  };

  const importFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    // A PDF can be edited as the PDF it is, or made a document of.
    if (looksLikePdf(file)) {
      const how = await pdfIntent();
      if (how === null) return;
      if (how === "edit") {
        await openPdfFile(file).catch((e) => toastError(e instanceof Error ? e.message : String(e)));
        return;
      }
    }
    const mod = await import("../documents/import/importFile");
    try {
      // Into the place you're working: the server when connected, else here.
      if (connected) {
        const doc = await mod.importFile(file);
        await openServerDoc(doc.id);
      } else {
        const id = await mod.importFileToLocal(file);
        await openLocalDoc(id);
      }
    } catch (e) {
      // (Thought better of: nothing to report.)
      if (mod.importCancelled(e)) return;
      toastError(isCmdError(e) ? e.message : e instanceof Error ? e.message : String(e));
    }
  };

  const hostedAddr = host?.configured ? `127.0.0.1:${host.port}` : null;
  const store = useSession.getState;

  return (
    <div className="wf-home">
      <div className="wf-home-inner">
        <header className="wf-home-head">
          <h1>{greeting(new Date(now).getHours(), connected && session ? (session.user.display_name ?? session.user.username) : profileName)}</h1>
          {!isWeb && profileLoaded && !profileName && !connected && <NameYourself />}
        </header>

        <section aria-labelledby="home-start">
          <h2 id="home-start">Start something</h2>
          <div className="wf-home-start">
            <button className="wf-home-tile" onClick={() => setNewDoc(true)}>
              <FileText size={22} />
              <span>
                <strong>Document</strong>
                <small>A letter, an essay, a chapter, a script</small>
              </span>
            </button>
            {!isWeb && (
              <button className="wf-home-tile" onClick={() => void newBoard()}>
                <Presentation size={22} />
                <span>
                  <strong>Board</strong>
                  <small>Plot, map, sketch and pin things down</small>
                </span>
              </button>
            )}
            {!isWeb && (
              <button
                className="wf-home-tile"
                onClick={() => usePlatform.getState().setActiveApp("writform.notes")}
              >
                <NotebookPen size={22} />
                <span>
                  <strong>Note</strong>
                  <small>Plain Markdown files in a folder you own</small>
                </span>
              </button>
            )}
            <button className="wf-home-tile" onClick={() => fileRef.current?.click()}>
              <FileUp size={22} />
              <span>
                <strong>Import</strong>
                <small>Word, PDF, Pages, RTF, Markdown or text</small>
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              hidden
              accept=".docx,.pdf,.rtf,.pages,.txt,.md,.markdown"
              onChange={(e) => {
                void importFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        </section>

        <section aria-labelledby="home-recent">
          <h2 id="home-recent">Jump back in</h2>
          {recents.length === 0 ? (
            <p className="wf-home-empty">What you work on will be here with the newest first.</p>
          ) : (
            <ul className="wf-home-recents">
              {recents.map((item) => {
                const cover = parseCardCover(item.cover);
                return (
                  <li key={item.key}>
                    <button onClick={() => open(item)}>
                      {cover ? (
                        <CardCover kind={cover.kind} src={cover.art.src} size="small" />
                      ) : (
                        <span className="wf-home-recent-icon" aria-hidden>
                          {ICONS[item.kind]}
                        </span>
                      )}
                      <span className="wf-home-recent-text">
                        <strong>{item.title}</strong>
                        <small>{item.detail}</small>
                      </span>
                      <time dateTime={new Date(item.at).toISOString()}>{whenLabel(item.at, now)}</time>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {!isWeb && (
          <section aria-labelledby="home-servers">
            <h2 id="home-servers">Write with others</h2>
            {link === "resuming" && (
              <p className="wf-home-linkline">
                <span className="wf-spinner sm" aria-hidden /> Reconnecting to {target?.name ?? "the server"}…
              </p>
            )}
            {link === "unreachable" && (
              <p className="wf-home-linkline">
                Can’t reach {target?.name ?? "the server"}.{" "}
                <button className="wf-link" onClick={() => void store().retry()}>
                  <RefreshCw size={13} /> Try again
                </button>
              </p>
            )}
            {servers.length > 0 && (
              <ul className="wf-home-servers">
                {servers.map((s) => {
                  const current = connected && session?.addr === s.addr;
                  const own = s.addr === hostedAddr;
                  return (
                    <li key={s.addr}>
                      <button
                        disabled={current}
                        onClick={() => {
                          if (s.signed_in) void store().resume(s.addr, s.server_name);
                          else openConnect({ addr: s.addr });
                        }}
                      >
                        <span className="wf-home-recent-icon" aria-hidden>
                          {own ? <HardDrive size={18} /> : <Globe size={18} />}
                        </span>
                        <span className="wf-home-recent-text">
                          <strong>{s.server_name}</strong>
                          <small>{own ? "On this computer" : s.addr}</small>
                        </span>
                        <span className={`wf-home-server-state${current ? " on" : ""}`}>
                          {current ? "Connected" : s.signed_in ? "Connect" : "Sign in"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="wf-home-empty">
              {servers.length === 0
                ? "Chat, voice, live writing sessions and shared documents run on a server one of you keeps. Your work here doesn’t need one."
                : "Servers are for writing together. Your work on this device doesn’t need one."}
            </p>
            <div className="wf-home-actions">
              <button onClick={() => openConnect()}>
                <Globe size={15} /> Join a server
              </button>
              {!isMobileApp && !host?.configured && (
                <button onClick={() => openConnect({ host: true })}>
                  <HardDrive size={15} /> Host on this computer
                </button>
              )}
            </div>
          </section>
        )}
      {!isWeb && (
        <footer className="wf-home-foot">
          <button
            className="wf-link"
            disabled={exporting !== null}
            onClick={() => {
              setExporting("Gathering…");
              void import("./exportDevice")
                .then(({ exportDevice }) => exportDevice(setExporting))
                .then((done) => {
                  if (done.result.status === "saved" && done.skipped) {
                    toast(`${done.skipped} item${done.skipped === 1 ? "" : "s"} couldn’t be read and ${done.skipped === 1 ? "was" : "were"} left out.`, "info");
                  }
                })
                .catch((e) => toastError(isCmdError(e) ? e.message : String(e)))
                .finally(() => setExporting(null));
            }}
          >
            {exporting ?? "Export everything on this device…"}
          </button>
          <small>Documents, boards, notes and your profile in one zip.</small>
        </footer>
      )}
      </div>
      {newDoc && (
        <NewDocumentDialog
          onClose={() => setNewDoc(false)}
          onCreated={(note) => {
            setNewDoc(false);
            if (note) toast(note, "success");
          }}
        />
      )}
    </div>
  );
}

/** First run: one field, so your work has a name on it. Skippable. */
function NameYourself() {
  const [name, setName] = useState("");
  const [hidden, setHidden] = useState(() => localStorage.getItem("wf-home-name-skipped") === "1");
  if (hidden) return null;
  return (
    <form
      className="wf-home-name"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void useLocalProfile.getState().setName(name);
      }}
    >
      <label htmlFor="home-name">What should we call you?</label>
      <div className="wf-connect-row">
        <input id="home-name" value={name} maxLength={64} placeholder="Your name as an author" onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="wf-primary" disabled={!name.trim()}>
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            localStorage.setItem("wf-home-name-skipped", "1");
            setHidden(true);
          }}
        >
          Not now
        </button>
      </div>
      <small>It goes on what you export and stays on this device unless you copy it to a server.</small>
    </form>
  );
}
