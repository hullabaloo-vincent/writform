// Page setup from the ribbon: "Custom margins…" (and its neighbours) open
// the inspector at the part they name, and a margin can be typed as well as
// stepped.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";

import { DocSettingsPanel, InchStepper } from "../src/apps/documents/DocSettingsPanel";
import { bodyLook, DEFAULT_SETTINGS, MARGIN_MAX, readDocSettings, settingsFrom, type SetupSection } from "../src/apps/documents/docSettings";
import { cleanLanguage, languageChoices } from "../src/lib/languages";
import { resolveStyles } from "../src/editor/styles/sheet";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
// (jsdom lays nothing out.)
g.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
};
const key = (el: Element, k: string) => el.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

// ------------------------------------------------------------ a margin, typed or stepped

{
  const host = mountPoint();
  const root = createRoot(host);
  let value = 1;
  const changes: number[] = [];
  const draw = () =>
    act(async () =>
      root.render(
        createElement(InchStepper, {
          label: "Top",
          value,
          disabled: false,
          onChange: (v: number) => {
            changes.push(v);
            value = v;
          },
        }),
      ),
    );
  await draw();
  const field = () => host.querySelector("input") as HTMLInputElement;
  const enter = async (text: string) => {
    await act(async () => type(field(), text));
    await act(async () => void key(field(), "Enter"));
    await draw();
  };
  check("a margin shows its figure in a field, with its unit beside it", field()?.value === "1" && host.textContent?.includes("in") === true && field().getAttribute("aria-label") === "Top, inches");
  await enter("1.1");
  check("a figure on no step can be typed", changes.join() === "1.1" && field().value === "1.1");
  await enter("0,75");
  check("…with a comma for the decimal, as much of the world writes it", value === 0.75);
  await enter("2 in");
  check("…or with its unit left on", value === 2);
  await enter("99");
  check("past the widest margin there is, it's held to it", value === MARGIN_MAX);
  const before = changes.length;
  await enter("wide");
  await enter("");
  check("something that isn't a number changes nothing, and the field goes back", changes.length === before && field().value === String(MARGIN_MAX));
  await act(async () => type(field(), "0.5"));
  await act(async () => void key(field(), "Escape"));
  await draw();
  check("Escape gives up what was being typed", changes.length === before && field().value === String(MARGIN_MAX));
  value = 0.86;
  await draw();
  await act(async () => void key(field(), "ArrowUp"));
  await draw();
  check("the arrow keys step, onto the quarter-inch grid from wherever it was", value === 1);
  await act(async () => void (host.querySelector('button[title="Top −"]') as HTMLButtonElement).click());
  await draw();
  check("…and so do the buttons, as before", value === 0.75);
  await act(async () => root.unmount());
}

// ------------------------------------------------------------ the inspector, opened at a part

{
  const ydoc = new Y.Doc();
  const host = mountPoint();
  const root = createRoot(host);
  const format = { styles: resolveStyles(bodyLook(DEFAULT_SETTINGS), {}), level: 2 };
  const draw = (at: { section: SetupSection; n: number } | null) =>
    act(async () => root.render(createElement(DocSettingsPanel, { editor: null, ydoc, settings: readDocSettings(ydoc), readonly: false, format, at })));
  const tab = () => (host.querySelector(".wf-inspector-tabs button.active") as HTMLElement | null)?.textContent?.trim();
  const part = (name: string) => host.querySelector(`[data-setup="${name}"]`) as HTMLElement | null;
  const settle = async () => {
    await act(async () => void (await wait(60)));
  };

  await draw(null);
  check("opened on its own, the inspector starts where it always has (Text)", tab() === "Text" && part("margins") === null);

  await draw({ section: "margins", n: 1 });
  await settle();
  check("“Custom margins…” opens it on the Document tab", tab() === "Document" && part("margins") !== null);
  check("…at Margins, marked so the eye finds it", part("margins")?.classList.contains("wf-inspector-asked") === true);
  const focused = document.activeElement as HTMLInputElement | null;
  check("…with the first margin ready to type in", focused?.tagName === "INPUT" && focused.getAttribute("aria-label") === "Top, inches" && part("margins")!.contains(focused));

  // Typing there changes the document's page setup.
  await act(async () => type(focused!, "1.3"));
  await act(async () => void key(focused!, "Enter"));
  check("a margin typed there is the document's margin", readDocSettings(ydoc).mt === 1.3);

  // Somebody clicks over to Text, then asks for margins again: it comes back.
  await act(async () => void (host.querySelector(".wf-inspector-tabs button") as HTMLButtonElement).click());
  check("(the tabs still switch by hand)", tab() === "Text");
  await draw({ section: "margins", n: 2 });
  await settle();
  check("asking for the same part again brings it back", tab() === "Document" && part("margins")?.classList.contains("wf-inspector-asked") === true);

  await draw({ section: "header", n: 3 });
  await settle();
  check("“Header & footer” opens at headers and footers", tab() === "Document" && part("header")?.classList.contains("wf-inspector-asked") === true && part("header")!.contains(document.activeElement));
  await draw({ section: "body", n: 4 });
  await settle();
  check("a style's “Body text…” opens at the body text", part("body")?.classList.contains("wf-inspector-asked") === true);
  await draw({ section: "indents", n: 5 });
  await settle();
  check("“Indents and spacing…” opens the Text tab at Indents", tab() === "Text" && part("indents")?.classList.contains("wf-inspector-asked") === true);

  await act(async () => root.unmount());

  // Opened for the first time by such a request, it starts on the right tab at once.
  const fresh = mountPoint();
  const second = createRoot(fresh);
  await act(async () => second.render(createElement(DocSettingsPanel, { editor: null, ydoc, settings: readDocSettings(ydoc), readonly: false, format, at: { section: "margins", n: 1 } })));
  check("opened by the request itself, it never shows the wrong tab first", (fresh.querySelector(".wf-inspector-tabs button.active") as HTMLElement | null)?.textContent?.trim() === "Document");
  await act(async () => second.unmount());
}

// ------------------------------------------------------- a document's details

{
  const from = (values: Record<string, unknown>) => settingsFrom((k) => values[k]);
  check("with nothing said there is no subject, no keywords and no language", DEFAULT_SETTINGS.subject === "" && DEFAULT_SETTINGS.keywords === "" && DEFAULT_SETTINGS.lang === "");
  const said = from({ subject: "A study\nof cats", keywords: "cats, dogs", lang: "EN-gb" });
  check("the details are read back clean: one line each, the language as tags are written", said.subject === "A studyof cats" && said.keywords === "cats, dogs" && said.lang === "en-GB", JSON.stringify([said.subject, said.keywords, said.lang]));
  const hostile = from({ subject: 7, keywords: "k".repeat(2000), lang: "not a language" });
  check("what is not a detail is not kept, and a long one is cut", hostile.subject === "" && hostile.keywords.length === 500 && hostile.lang === "");
  check("language tags: small letters, a region in capitals, anything else refused", cleanLanguage("fr") === "fr" && cleanLanguage("pt-br") === "pt-BR" && cleanLanguage("zh-Hant-TW") === "zh-Hant-TW" && cleanLanguage("") === "" && cleanLanguage("e") === "" && cleanLanguage(null) === "");
  check("a language from elsewhere is offered under its own tag", languageChoices("sv")[0][0] === "sv" && languageChoices("fr").length === languageChoices("").length && languageChoices("sv").length === languageChoices("").length + 1);

  const ydoc = new Y.Doc();
  const host = mountPoint();
  const root = createRoot(host);
  const format = { styles: resolveStyles(bodyLook(DEFAULT_SETTINGS), {}), level: 2 };
  const draw = (readonly = false) => act(async () => root.render(createElement(DocSettingsPanel, { editor: null, ydoc, settings: readDocSettings(ydoc), readonly, format, at: { section: "details" as SetupSection, n: 1 } })));
  await draw();
  await act(async () => void (await wait(60)));
  const part = host.querySelector('[data-setup="details"]') as HTMLElement | null;
  const fields = [...(part?.querySelectorAll<HTMLInputElement>('input[type="text"]') ?? [])];
  check("the Document tab has the details: subject, keywords and language", !!part && fields.length === 2 && !!part.querySelector("select") && [...part.querySelectorAll("label > span")].map((n) => n.textContent).join() === "Subject,Keywords,Language");
  await act(async () => type(fields[0], "A study of cats"));
  await act(async () => type(fields[1], "cats, dogs"));
  const select = part!.querySelector("select") as HTMLSelectElement;
  await act(async () => {
    select.value = "en-GB";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  const kept = readDocSettings(ydoc);
  check("what is typed there is kept with the document", kept.subject === "A study of cats" && kept.keywords === "cats, dogs" && kept.lang === "en-GB", JSON.stringify([kept.subject, kept.keywords, kept.lang]));
  await draw(true);
  check("someone who can only read sees them and cannot change them", [...host.querySelectorAll<HTMLInputElement>('[data-setup="details"] input, [data-setup="details"] select')].every((el) => el.disabled));
  await act(async () => root.unmount());
}

finish();
