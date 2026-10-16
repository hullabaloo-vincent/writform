// The phone and the iPad: the editor's header keeps one row on a phone
// with its tools in one sheet, an open document has the phone's whole
// screen, and the app stays clear of the screen's own edges at any width
// (an iPad's home-screen app draws under its status bar).

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { ExportMenu } from "../src/apps/documents/shell/ExportMenu";
import { HeaderTools } from "../src/apps/documents/shell/HeaderTools";
import { useFillsPhone, usePlatform } from "../src/platform/registry";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
let phone = true;
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: phone, addEventListener() {}, removeEventListener() {} });

const ran: string[] = [];
const tools = () =>
  createElement(
    HeaderTools,
    { lead: createElement("label", { className: "wf-head-format" }, "Format") },
    createElement("button", { title: "Document history", "data-label": "History", onClick: () => ran.push("history") }),
    createElement(ExportMenu, { items: [{ label: "Export PDF…", run: async () => void ran.push("pdf") }], onError: () => {} }),
  );

{
  const host = mountPoint();
  const root = createRoot(host);
  await act(async () => root.render(tools()));
  const more = host.querySelector<HTMLButtonElement>("button.wf-doc-more");
  check("on a phone the header has one More for its tools", !!more && host.querySelectorAll("button").length === 1);
  await act(async () => more!.click());
  const sheet = document.body.querySelector(".wf-flyout.sheet.wf-head-sheet");
  check("…which opens a sheet with them and the format", !!sheet && !!sheet.querySelector(".wf-head-format") && !!sheet.querySelector('.wf-head-tools > button[data-label="History"]'));
  const exportRow = [...(sheet?.querySelectorAll<HTMLButtonElement>(".wf-head-export button") ?? [])];
  check("the exports are rows of the sheet, not a menu of their own", exportRow.length === 1 && exportRow[0].textContent === "Export PDF…" && !sheet?.querySelector(".wf-doc-export-wrap"));
  await act(async () => sheet!.querySelector<HTMLButtonElement>('button[data-label="History"]')!.click());
  check("a tool does its work and the sheet closes", ran.includes("history") && !document.body.querySelector(".wf-head-sheet"));
  await act(async () => more!.click());
  await act(async () => document.body.querySelector<HTMLButtonElement>(".wf-head-export button")!.click());
  await act(async () => new Promise((r) => setTimeout(r, 5)));
  check("…an export too", ran.includes("pdf") && !document.body.querySelector(".wf-head-sheet"));
  await act(async () => root.unmount());
}
{
  phone = false;
  const host = mountPoint();
  const root = createRoot(host);
  await act(async () => root.render(tools()));
  check("on a desktop the tools sit in the header as they always have", !host.querySelector(".wf-doc-more") && !!host.querySelector('button[data-label="History"]') && !!host.querySelector(".wf-doc-export-wrap"));
  await act(async () => root.unmount());
}
{
  function Room() {
    useFillsPhone();
    return null;
  }
  const host = mountPoint();
  const root = createRoot(host);
  check("(nothing fills the phone at first)", !usePlatform.getState().fillsPhone);
  await act(async () => root.render(createElement(Room)));
  check("an open document fills the phone", usePlatform.getState().fillsPhone);
  await act(async () => root.unmount());
  check("…until it closes", !usePlatform.getState().fillsPhone);
}

// ------------------------------------------------------------ the stylesheet and the editors

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.resolve(here, "../../", file), "utf8");
const css = read("src/styles.css");
const rule = (selector: string, from = 0): string => {
  const at = css.indexOf(`\n${selector} {`, from);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};
const phoneAt = css.indexOf("@media (max-width: 767px)");
check("at any width the shell stays clear of the clock and the camera", /padding-top: env\(safe-area-inset-top/.test(rule(".wf-shell")) && rule(".wf-shell").indexOf("padding-top") > 0 && css.indexOf("\n.wf-shell {") < phoneAt);
check("…and of a phone's corners held sideways", /padding-left: env\(safe-area-inset-left/.test(rule(".wf-shell")) && /padding-right: env\(safe-area-inset-right/.test(rule(".wf-shell")));
check("the status bar stays clear of the home indicator", /env\(safe-area-inset-bottom/.test(rule(".wf-statusbar")));
check("an open document on a phone hides the tab bar and the status strip", /\.wf-shell\.detail \.wf-rail,\s*\.wf-shell\.detail \.wf-statusbar \{\s*display: none;/.test(css));
check("the header keeps one row on a phone", /\.wf-doc-header \{\s*flex-wrap: nowrap;/.test(css));

for (const file of ["src/apps/documents/DocumentEditor.tsx", "src/apps/documents/LocalDocumentEditor.tsx"]) {
  const src = read(file);
  const block = src.slice(src.indexOf("<HeaderTools"), src.indexOf("</HeaderTools>"));
  const buttons = block.split("<button").slice(1);
  const unnamed = buttons.filter((b) => !/data-label=/.test(b.slice(0, b.indexOf(">"))));
  check(`every tool in ${path.basename(file)} has a name for the sheet`, buttons.length >= 12 && unnamed.length === 0, `${buttons.length} buttons, ${unnamed.length} without`);
  check(`…and the format moves into it on a phone`, /\{!phone && formatSelect\}/.test(src) && /useFillsPhone\(\)/.test(src));
}

finish();
