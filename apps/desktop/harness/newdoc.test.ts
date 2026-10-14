// A new document: the paper it starts on (the region's, written into it as
// it is made), and the language its text goes by (the spell checker's
// dictionary and the quote marks typed).

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor } from "@tiptap/core";
import * as Y from "yjs";

import { b64decode } from "../src/apps/documents/collab";
import { DEFAULT_SETTINGS, pageDims, readDocSettings } from "../src/apps/documents/docSettings";
import { convertFile } from "../src/apps/documents/import/importFile";
import { useLocalDocs } from "../src/apps/documents/local";
import { createBlankOnDevice, createBlankOnServer, LETTER_REGIONS, newDocumentMaps, paperForLocales, regionPaper } from "../src/apps/documents/newDocument";
import { EDITOR_PROPS, textLanguage } from "../src/apps/documents/shell/hooks";
import { docContentExtensions } from "../src/editor/schema/content";
import { quoteStyleFor, SmartPunctuation } from "../src/editor/SmartPunctuation";
import { backend } from "../src/lib/backend";

/** Say the device's languages are these. */
const speak = (...tags: string[]) => {
  Object.defineProperty(navigator, "languages", { value: tags, configurable: true });
  Object.defineProperty(navigator, "language", { value: tags[0] ?? "", configurable: true });
};

// ------------------------------------------------------------ the paper

check("the United States prints on Letter", paperForLocales(["en-US"]) === "letter");
check("Britain prints on A4", paperForLocales(["en-GB"]) === "a4");
check("a language with no place named means its likeliest one: French is France", paperForLocales(["fr"]) === "a4");
check("and English with no place named is the United States", paperForLocales(["en"]) === "letter");
check("Mexico prints on Letter, Spain on A4", paperForLocales(["es-MX"]) === "letter" && paperForLocales(["es-ES"]) === "a4");
check("Canada in French is still Letter", paperForLocales(["fr-CA"]) === "letter");
check("a script in the tag does not hide the place", paperForLocales(["zh-Hant-TW"]) === "a4" && paperForLocales(["sr_Latn_RS"]) === "a4");
check("the first language that names a place decides", paperForLocales(["de-DE", "en-US"]) === "a4" && paperForLocales(["en-US", "de-DE"]) === "letter");
check("no languages at all: Letter, as documents always were", paperForLocales([]) === "letter" && paperForLocales([""]) === "letter");
check("a tag nobody can read is passed over", paperForLocales(["!!", "en-AU"]) === "a4");
check("the Letter countries are the fourteen of the Unicode list", LETTER_REGIONS.size === 14 && LETTER_REGIONS.has("PH") && !LETTER_REGIONS.has("GB"));

speak("de-DE", "en");
check("the device's own languages are read", regionPaper() === "a4");
check("a new Document is given that paper", JSON.stringify(newDocumentMaps("none")) === JSON.stringify({ settings: { pageSize: "a4" } }));
check("a screenplay, a play, a poem and a manuscript keep their own sheets", ["screenplay", "stageplay", "poetry", "manuscript"].every((f) => Object.keys(newDocumentMaps(f)).length === 0));
check("a document that says nothing still reads as Letter", DEFAULT_SETTINGS.pageSize === "letter");

// ------------------------------------------------------------ on this device

const files = new Map<string, string>();
Object.assign(backend, {
  localdocList: async () => [...files.entries()].map(([id, content]) => ({ id, ...(JSON.parse(content) as { title: string; format: string }), updated_at: 1, words: 0, excerpt: "" })),
  localdocWrite: async (id: string, content: string) => void files.set(id, content),
  localdocFoldersRead: async () => "",
});

/** The settings a stored document opens with, and whether it has any text. */
const opened = (id: string) => {
  const file = JSON.parse(files.get(id) ?? "{}") as { state_b64?: string; title?: string; format?: string };
  const doc = new Y.Doc();
  if (file.state_b64) Y.applyUpdate(doc, b64decode(file.state_b64));
  return { file, settings: readDocSettings(doc), words: doc.getXmlFragment("default").length };
};

{
  const id = await createBlankOnDevice("A letter", "none");
  const made = opened(id);
  check("a Document made on this device opens on A4", made.settings.pageSize === "a4" && Math.abs(pageDims(made.settings).h - 11.69) < 0.01);
  check("with its name and no text", made.file.title === "A letter" && made.words === 0);
  check("and everything else about its page as before", made.settings.mt === DEFAULT_SETTINGS.mt && made.settings.ml === DEFAULT_SETTINGS.ml && made.settings.fR === DEFAULT_SETTINGS.fR);
  check("it is in the list", useLocalDocs.getState().items.some((d) => d.id === id));

  const play = await createBlankOnDevice("A play", "stageplay");
  check("a play made on this device is given nothing", !opened(play).file.state_b64);

  speak("en-US");
  const us = await createBlankOnDevice("Stateside", "none");
  check("in the United States a Document says Letter", opened(us).settings.pageSize === "letter");
  speak("de-DE", "en");
}

// ------------------------------------------------------------ on a server

{
  const sent: { method: string; route: string; body?: Record<string, unknown> }[] = [];
  let failUpdates = false;
  Object.assign(backend, {
    apiFetch: async (method: string, route: string, body?: Record<string, unknown>) => {
      sent.push({ method, route, body });
      if (method === "POST" && route === "/api/v1/documents") return { status: 200, body: { id: 41, title: body?.title, format: body?.format } };
      if (method === "POST" && /\/updates\?/.test(route)) {
        if (failUpdates) return { status: 500, body: { code: "io", message: "no" } };
        return { status: 200, body: { seq: 1, schema_level: 1 } };
      }
      return { status: 404, body: null };
    },
  });
  const doc = await createBlankOnServer("Shared", "none");
  const updates = sent.filter((c) => /\/documents\/41\/updates\?/.test(c.route));
  check("a Document made on a server is created, then told its paper in one update", doc.id === 41 && sent[0].route === "/api/v1/documents" && updates.length === 1);
  const seeded = new Y.Doc();
  Y.applyUpdate(seeded, b64decode(String(updates[0]?.body?.update_b64 ?? "")));
  check("that update holds the paper and no text", readDocSettings(seeded).pageSize === "a4" && seeded.getXmlFragment("default").length === 0);
  check("it asks for no newer formatting", updates[0]?.body?.schema_level === null);

  sent.length = 0;
  await createBlankOnServer("A poem", "poetry");
  check("a poem made on a server gets no update", sent.length === 1);

  sent.length = 0;
  failUpdates = true;
  const still = await createBlankOnServer("Shaky", "none").catch(() => null);
  check("should the update fail, the document is still made", still?.id === 41);
}

// ------------------------------------------------------------ what is imported

{
  const text = await convertFile(new File(["One line.\n\nAnother."], "notes.txt", { type: "text/plain" }));
  check("plain text, which has no page of its own, is set on the region's paper", (text.maps.settings as Record<string, unknown> | undefined)?.pageSize === "a4");
  const md = await convertFile(new File(["# Title\n\nWords."], "notes.md", { type: "text/markdown" }));
  check("and so is Markdown", (md.maps.settings as Record<string, unknown> | undefined)?.pageSize === "a4");
}

// ------------------------------------------------------------ the language

{
  const book = { meta: { language: "en-US" } };
  speak("fr-FR");
  check("a book goes by its own language", textLanguage("manuscript", { meta: { language: "pt-BR" } }, { lang: "de" }) === "pt-BR");
  check("a Document goes by the language it was given", textLanguage("none", book, { lang: "de-AT" }) === "de-AT");
  check("and by the device's when it was given none", textLanguage("none", book, { lang: "" }) === "fr-FR");
  check("a book's language is no business of a Document's", textLanguage("none", { meta: { language: "ja" } }, { lang: "" }) === "fr-FR");
  check("the editors no longer fix a language on the text itself", !("lang" in EDITOR_PROPS.attributes));

  /** Type into a Document whose language is this. */
  const typed = (lang: string, keys: string): string => {
    const editor = new Editor({
      element: mountPoint(),
      extensions: [...docContentExtensions(), SmartPunctuation.configure({ quotes: () => quoteStyleFor(textLanguage("none", book, { lang })) })],
    });
    for (const ch of keys) {
      const { from, to } = editor.state.selection;
      const deflt = () => editor.state.tr.insertText(ch, from, to);
      if (!editor.view.someProp("handleTextInput", (f) => f(editor.view, from, to, ch, deflt))) editor.view.dispatch(deflt());
    }
    const text = editor.state.doc.textContent;
    editor.destroy();
    return text;
  };
  const de = typed("de", '"Ja"');
  check("a German Document types German quote marks", de === "„Ja“", JSON.stringify(de));
  const en = typed("en-GB", '"Yes"');
  check("an English one types English ones", en === "“Yes”", JSON.stringify(en));
  const none = typed("", '"Oui"');
  check("one that says nothing goes by the device (French here)", none.startsWith("«") && none.endsWith("»"), JSON.stringify(none));
}

finish();
