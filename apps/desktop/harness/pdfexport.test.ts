// Exporting a PDF: what is chosen in the dialog, what is remembered on the
// device, what is kept with the document, and the two taps (make it, then
// save it) a phone needs.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";

import { readDocSettings, updateDocSettings } from "../src/apps/documents/docSettings";
import { ExportPdfDialog, type BuiltPdf } from "../src/apps/documents/ExportPdfDialog";
import { loadPdfOptions, savePdfOptions } from "../src/apps/documents/pdfOptions";
import { cleanPdfOptions, DEFAULT_PDF_OPTIONS, type PdfOptions } from "../src/book/render/options";
import { backend } from "../src/lib/backend";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const type = (input: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor((window as unknown as { HTMLInputElement: { prototype: object } }).HTMLInputElement.prototype, "value")!.set!;
  set.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
};

// ------------------------------------------------------------ the choices

{
  check("the usual: pictures for print, tags on, no archive copy, no copy inside", JSON.stringify(DEFAULT_PDF_OPTIONS) === JSON.stringify({ pictures: "print", tagged: true, archive: false, source: false }));
  check("choices from anywhere are made whole", JSON.stringify(cleanPdfOptions({ pictures: "screen", tagged: "yes", source: true, more: 1 })) === JSON.stringify({ pictures: "screen", tagged: true, archive: false, source: true }));
  check("…and nonsense is the usual", JSON.stringify(cleanPdfOptions("x")) === JSON.stringify(DEFAULT_PDF_OPTIONS) && JSON.stringify(cleanPdfOptions(null)) === JSON.stringify(DEFAULT_PDF_OPTIONS));
  check("nothing remembered yet: the usual", JSON.stringify(loadPdfOptions()) === JSON.stringify(DEFAULT_PDF_OPTIONS));
  savePdfOptions({ pictures: "original", tagged: false, archive: true, source: true });
  check("what was chosen is remembered on this device", JSON.stringify(loadPdfOptions()) === JSON.stringify({ pictures: "original", tagged: false, archive: true, source: true }));
  localStorage.setItem("wf-pdf-export", "{broken");
  check("a damaged memory is the usual again", JSON.stringify(loadPdfOptions()) === JSON.stringify(DEFAULT_PDF_OPTIONS));
  localStorage.removeItem("wf-pdf-export");
}

// ------------------------------------------------------------- the dialog

await (async () => {
  const saved: { name: string; kind: string; size: number }[] = [];
  Object.assign(backend, {
    saveFile: async (name: string, kind: string, bytes: Uint8Array) => {
      saved.push({ name, kind, size: bytes.length });
      return { status: "saved" };
    },
  });

  const ydoc = new Y.Doc();
  const made: PdfOptions[] = [];
  let release: (() => void) | null = null;
  let fail: string | null = null;
  const build = async (options: PdfOptions, onProgress: (message: string) => void): Promise<BuiltPdf> => {
    made.push(options);
    onProgress("Writing page 1 of 3…");
    await new Promise<void>((r) => (release = r));
    if (fail) throw new Error(fail);
    return { bytes: new Uint8Array([37, 80, 68, 70]), pages: 3, notes: ["Georgia is set in Gelasio here."] };
  };
  let closed = 0;
  const host = mountPoint();
  const root = createRoot(host);
  const draw = (readonly = false) =>
    act(async () =>
      root.render(
        createElement(ExportPdfDialog, {
          title: "Notes: a study",
          details: { settings: readDocSettings(ydoc), readonly, onPatch: (patch) => updateDocSettings(ydoc, patch) },
          build,
          onClose: () => {
            closed += 1;
          },
        }),
      ),
    );
  await draw();
  const box = () => document.body.querySelector(".wf-export-pdf-modal") as HTMLElement;
  const button = (label: string) => [...box().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
  check("the dialog says what it will export", box().querySelector("h3")?.textContent === "Export “Notes: a study” as a PDF");
  check("nothing is made until asked", made.length === 0 && !!button("Create PDF") && !button("Save…"));
  check("the document's details are there to fill in, folded away", !!box().querySelector("details.wf-export-pdf-fold") && [...box().querySelectorAll(".wf-doc-details label > span")].map((n) => n.textContent).join() === "Subject,Keywords,Language");

  await act(async () => type(box().querySelector('.wf-doc-details input[type="text"]') as HTMLInputElement, "What the notes are about"));
  await draw();
  check("a detail typed here is kept with the document", readDocSettings(ydoc).subject === "What the notes are about");

  await act(async () => button("Create PDF")!.click());
  check("Create PDF makes the file with the choices, and says how far along it is", made.length === 1 && JSON.stringify(made[0]) === JSON.stringify(DEFAULT_PDF_OPTIONS) && box().querySelector(".wf-export-progress")?.textContent === "Writing page 1 of 3…" && button("Making the PDF…")?.disabled === true);
  check("…and the choices are remembered from then on", localStorage.getItem("wf-pdf-export") !== null);
  await act(async () => {
    release!();
    await wait(5);
  });
  check("made, it says how long it is and what to know about it", box().querySelector(".wf-export-ready")?.textContent === "Ready: 3 pages" && box().querySelector(".wf-print-notes")?.textContent === "Georgia is set in Gelasio here.");
  check("saving is its own tap (a phone opens its share sheet only from one)", saved.length === 0 && !!button("Save…") && !button("Create PDF"));

  // A detail changed after the file was made: that file is no longer the document.
  await act(async () => type(box().querySelectorAll<HTMLInputElement>('.wf-doc-details input[type="text"]')[1], "notes, study"));
  await draw();
  check("changing a detail afterwards asks for the file to be made again", !!button("Create PDF") && !button("Save…") && !box().querySelector(".wf-export-ready"));
  await act(async () => button("Create PDF")!.click());
  await act(async () => {
    release!();
    await wait(5);
  });
  await act(async () => {
    button("Save…")!.click();
    await wait(5);
  });
  check("Save writes the file under the document's name, made safe for a file", saved.length === 1 && saved[0].name === "Notes- a study.pdf" && saved[0].kind === "pdf" && saved[0].size === 4, JSON.stringify(saved));
  check("…and the dialog closes", closed === 1);

  // It could not be made.
  // (The file just saved is still there to save again: a change makes it stale.)
  fail = "A font could not be read.";
  await act(async () => type(box().querySelector('.wf-doc-details input[type="text"]') as HTMLInputElement, "Another subject"));
  await draw();
  await act(async () => button("Create PDF")!.click());
  await act(async () => {
    release!();
    await wait(5);
  });
  check("when the file cannot be made the dialog says why and can be tried again", box().querySelector(".wf-connect-error")?.textContent === "A font could not be read." && !!button("Create PDF"));

  // The choices.
  fail = null;
  const tags = () => [...box().querySelectorAll<HTMLInputElement>('.wf-print-option input[type="checkbox"]')].find((el) => el.parentElement?.textContent?.startsWith("Tags for screen readers"))!;
  check("tags for screen readers are on unless turned off", tags().checked === true);
  await act(async () => tags().click());
  await act(async () => button("Create PDF")!.click());
  check("turned off, the file is made without them, and that is remembered", made[made.length - 1].tagged === false && loadPdfOptions().tagged === false);
  await act(async () => {
    release!();
    await wait(5);
  });
  await act(async () => tags().click());
  check("a choice changed after the file was made asks for it to be made again", !!button("Create PDF") && !button("Save…") && tags().checked === true);

  // A copy made to last.
  const archive = () => [...box().querySelectorAll<HTMLInputElement>('.wf-print-option input[type="checkbox"]')].find((el) => el.parentElement?.textContent?.startsWith("Archive copy"))!;
  check("an archive copy is offered, and is not made unless asked for", archive().checked === false);
  await act(async () => archive().click());
  await act(async () => button("Create PDF")!.click());
  check("asked for, the file is made as one, and that is remembered", made[made.length - 1].archive === true && loadPdfOptions().archive === true);
  await act(async () => {
    release!();
    await wait(5);
  });
  await act(async () => archive().click());
  check("…and turned off again, asks for the file again", archive().checked === false && !!button("Create PDF") && !button("Save…"));

  // The document itself, kept inside.
  const inside = () => [...box().querySelectorAll<HTMLInputElement>('.wf-print-option input[type="checkbox"]')].find((el) => el.parentElement?.textContent?.startsWith("Keep an editable copy inside"))!;
  check("keeping the document inside is offered, off until ticked, with what it means for whoever gets the file", inside().checked === false && !!inside().parentElement?.textContent?.includes("Anyone who has this PDF can open the whole document"));
  await act(async () => inside().click());
  await act(async () => button("Create PDF")!.click());
  check("ticked, the file is made with it, and the device remembers", made[made.length - 1].source === true && loadPdfOptions().source === true);
  await act(async () => {
    release!();
    await wait(5);
  });
  await act(async () => inside().click());
  check("…and unticked afterwards, asks for the file again", inside().checked === false && !!button("Create PDF") && !button("Save…"));

  // How pictures go in.
  const pictures = () => [...box().querySelectorAll<HTMLInputElement>('.wf-export-pdf-pictures input[type="radio"]')];
  const chosen = () => pictures().find((el) => el.checked)?.parentElement?.textContent?.trim();
  const hint = () => box().querySelector(".wf-export-pdf-pictures small")?.textContent ?? "";
  check("pictures go in for print unless another way is chosen, and what that means is said", pictures().length === 3 && chosen() === "Print" && hint().includes("300 pixels an inch"), `${chosen()}: ${hint()}`);
  await act(async () => pictures()[0].click());
  check("another choice says what it means", chosen() === "Screen" && hint().includes("150 pixels an inch"));
  await act(async () => button("Create PDF")!.click());
  check("…is what the file is made with, and is remembered", made[made.length - 1].pictures === "screen" && loadPdfOptions().pictures === "screen" && pictures().every((el) => el.closest("fieldset")?.disabled));
  await act(async () => {
    release!();
    await wait(5);
  });
  await act(async () => pictures()[2].click());
  check("…and changed afterwards, asks for the file again", chosen() === "Original" && hint().includes("as it is in the document") && !!button("Create PDF") && !button("Save…"));

  await draw(true);
  check("someone who can only read can still export, and cannot change the details", [...box().querySelectorAll<HTMLInputElement>(".wf-doc-details input, .wf-doc-details select")].every((el) => el.disabled) && !button("Create PDF")!.disabled);
  await act(async () => root.unmount());

  // A script has no details of its own to show.
  const host2 = mountPoint();
  const root2 = createRoot(host2);
  await act(async () => root2.render(createElement(ExportPdfDialog, { title: "A Play", details: null, build, onClose: () => {} })));
  check("a format without details of its own shows none", !document.body.querySelector(".wf-export-pdf-fold") && !!document.body.querySelector(".wf-export-pdf-modal"));
  await act(async () => root2.unmount());
})();

finish();
