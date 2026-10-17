// Folders in the notes vault: real folders, as Obsidian has them. A note is
// named by its path, a bare [[link]] finds the nearest note of its name, and
// the sidebar is a tree you add to, rename, delete from and move notes in.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { renderMarkdown } from "../src/apps/notes/markdown";
import { NotesView } from "../src/apps/notes/NotesView";
import { useNotesPending } from "../src/apps/notes/pending";
import { baseOf, buildTree, cleanName, foldersAbove, newNoteFor, parentOf, resolveLink } from "../src/apps/notes/paths";
import { backend } from "../src/lib/backend";
import { ToastHost } from "../src/platform/toast";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const wait = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));

// ------------------------------------------------------------ names and links

check("a name is a path, cleaned as the vault cleans it", cleanName(" Book / Cast /Ana ") === "Book/Cast/Ana" && cleanName("", true) === "");
check("…and nothing climbs out of the vault or hides", ["..", "Book/../x", ".trash/x", "a\\b", "c:d", "a//b", ""].every((n) => cleanName(n) === null));
check("its folder and its own name", parentOf("Book/Cast/Ana") === "Book/Cast" && baseOf("Book/Cast/Ana") === "Ana" && parentOf("Ana") === "" && foldersAbove("A/B/Note").join() === "A,A/B");
const names = ["Ideas", "Book/Ideas", "Book/Cast/Ana", "Other/Ana", "Ana"];
check("a bare link finds the note of its name in the same folder first", resolveLink(names, "ideas", "Book/Chapter") === "Book/Ideas" && resolveLink(names, "Ideas", "Top") === "Ideas");
check("…else the one with the shortest path", resolveLink(names, "Ana", "Book/Chapter") === "Ana" && resolveLink(names, "Ana", "Other/x") === "Other/Ana");
check("a link with a path names that one", resolveLink(names, "book/cast/ana", "Top") === "Book/Cast/Ana" && resolveLink(names, "Book/Missing", "Top") === null);
check("a new note for a link goes beside the note it was written in", newNoteFor("Weather", "Book/Chapter") === "Book/Weather" && newNoteFor("Series/Plan", "Book/Chapter") === "Series/Plan");
check("the preview marks only links that lead nowhere", (() => {
  const html = renderMarkdown("[[Ideas]] [[Nowhere]] [[Cast/Ana]]", ["Book/Ideas", "Cast/Ana"], "Book/Chapter");
  return /data-wf-note="Ideas"/.test(html) && !/class="wf-wikilink missing" data-wf-note="Ideas"/.test(html) && /class="wf-wikilink missing" data-wf-note="Nowhere"/.test(html) && !/missing" data-wf-note="Cast\/Ana"/.test(html);
})());
{
  const tree = buildTree(
    [
      { name: "Top", modified_at: 1 },
      { name: "Book/Chapter 10", modified_at: 1 },
      { name: "Book/Chapter 2", modified_at: 1 },
      { name: "Book/Cast/Ana", modified_at: 1 },
    ],
    ["Empty", "Book"],
  );
  check("the tree: folders first, then notes, in natural order", tree.folders.map((f) => f.name).join() === "Book,Empty" && tree.notes.map((n) => n.name).join() === "Top" && tree.folders[0].notes.map((n) => baseOf(n.name)).join() === "Chapter 2,Chapter 10" && tree.folders[0].folders[0].path === "Book/Cast");
}

// ------------------------------------------------------------ the sidebar

localStorage.setItem("wf-notes-view", "read");
localStorage.removeItem("wf-notes-open");
const vault: Record<string, string> = { Welcome: "Hello", Ideas: "x", "Story/Rain": "From [[Ideas]] to [[Weather]]." };
const dirs = new Set(["Story"]);
const calls: string[] = [];
Object.assign(backend, {
  vaultList: async () => Object.keys(vault).map((name, i) => ({ name, modified_at: i })),
  vaultFolders: async () => [...dirs].sort(),
  vaultRead: async (name: string) => {
    if (!(name in vault)) throw { code: "io", message: "not there" };
    return vault[name];
  },
  vaultWrite: async (name: string, content: string) => {
    vault[name] = content;
  },
  vaultBacklinks: async () => [],
  vaultSearch: async (q: string) => Object.keys(vault).filter((n) => n.toLowerCase().includes(q.toLowerCase())).map((name) => ({ name, snippet: "", modified_at: 0 })),
  vaultFolderCreate: async (path: string) => {
    calls.push(`create ${path}`);
    dirs.add(path);
    return path;
  },
  vaultFolderRename: async (path: string, next: string) => {
    calls.push(`rename ${path} ${next}`);
    dirs.delete(path);
    dirs.add(next);
    for (const n of Object.keys(vault))
      if (n.startsWith(`${path}/`)) {
        vault[next + n.slice(path.length)] = vault[n];
        delete vault[n];
      }
    return next;
  },
  vaultFolderDelete: async (path: string) => {
    calls.push(`delete ${path}`);
    dirs.delete(path);
    for (const n of Object.keys(vault)) if (n.startsWith(`${path}/`)) delete vault[n];
  },
  vaultMove: async (name: string, folder: string) => {
    const moved = folder ? `${folder}/${baseOf(name)}` : baseOf(name);
    calls.push(`move ${name} ${folder}`);
    vault[moved] = vault[name];
    delete vault[name];
    return moved;
  },
});

const host = mountPoint();
const root = createRoot(host);
await act(async () => root.render(createElement("div", null, createElement(NotesView), createElement(ToastHost))));
await wait();
const rows = () => [...host.querySelectorAll(".wf-notes-side li")].map((li) => li.textContent?.trim());
const folderButton = (name: string) => [...host.querySelectorAll<HTMLButtonElement>(".wf-note-folder-toggle")].find((b) => b.textContent?.trim() === name);
check("the sidebar: folders closed, then the notes at the top", rows().join("|") === "Story|Ideas|Welcome", rows().join("|"));
await act(async () => folderButton("Story")!.click());
check("a folder opens to show its notes", rows().join("|") === "Story|Rain|Ideas|Welcome" && folderButton("Story")!.getAttribute("aria-expanded") === "true");

// A new note goes in the folder last picked.
await act(async () => host.querySelector<HTMLButtonElement>('.wf-notes-side-top button[title^="New note"]')!.click());
await wait();
check("a new note goes in the folder picked", "Story/Untitled" in vault && rows().includes("Untitled") && host.querySelector(".wf-notes-title")?.textContent?.trim() === "Untitled");
check("…and its header says which folder it is in", (host.querySelector<HTMLSelectElement>(".wf-notes-move select")?.value ?? "") === "Story");

// Moving it out.
const move = host.querySelector<HTMLSelectElement>(".wf-notes-move select")!;
await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(move, "");
  move.dispatchEvent(new Event("change", { bubbles: true }));
});
await wait(40);
check("choosing another folder moves the note", calls.includes("move Story/Untitled ") && "Untitled" in vault && host.querySelector<HTMLSelectElement>(".wf-notes-move select")?.value === "");

// A link in a note in a folder.
await act(async () => useNotesPending.getState().request("Story/Rain"));
await wait();
const links = [...host.querySelectorAll<HTMLButtonElement>(".wf-notes-preview .wf-wikilink")];
check("its links are drawn, the one to nowhere marked", links.length === 2 && !links[0].classList.contains("missing") && links[1].classList.contains("missing"));
await act(async () => links[1].click());
await wait();
check("following a link to nowhere makes the note beside it", "Story/Weather" in vault && host.querySelector(".wf-notes-title")?.textContent?.trim() === "Weather");

// A folder in a folder, named in place.
await act(async () => folderButton("Story")!.click());
await act(async () => folderButton("Story")!.click());
await act(async () => host.querySelector<HTMLButtonElement>('.wf-notes-side-top button[title^="New folder"]')!.click());
const input = host.querySelector<HTMLInputElement>(".wf-note-folder-input");
check("a new folder is named in the list", !!input);
await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input!, "Drafts");
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  input!.blur();
});
await wait(40);
check("…and made inside the folder picked", calls.includes("create Story/Drafts") && !!folderButton("Drafts"), calls.join());

// Its menu: rename and delete.
const more = () => [...host.querySelectorAll<HTMLButtonElement>(".wf-note-folder-more")];
const menuItem = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>(".wf-flyout button")].find((b) => b.textContent?.trim() === label);
const storyMenu = more()[0];
await act(async () => {
  storyMenu.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  storyMenu.click();
});
check("a folder's menu", ["New note here", "New folder inside", "Rename", "Delete"].every((l) => !!menuItem(l)));
await act(async () => menuItem("Rename")!.click());
const rename = host.querySelector<HTMLInputElement>(".wf-note-folder-input")!;
check("renaming starts from its name", rename.value === "Story");
await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(rename, "Stories");
  rename.dispatchEvent(new Event("input", { bubbles: true }));
  rename.blur();
});
await wait(40);
check("renamed, with what was in it", calls.includes("rename Story Stories") && "Stories/Rain" in vault && !!folderButton("Stories") && host.querySelector(".wf-notes-title")?.textContent?.trim() === "Weather");
await act(async () => {
  more()[0].dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  more()[0].click();
});
await act(async () => menuItem("Delete")!.click());
await wait(40);
check("deleted, with an Undo", calls.includes("delete Stories") && !folderButton("Stories") && /Deleted the folder “Stories” and its 2 notes/.test(document.body.textContent ?? ""), document.body.textContent?.slice(-200));
check("…and the note that was open in it is closed", !host.querySelector(".wf-notes-title"));

// Searching: a flat list, each with its folder.
vault["Book/Rainfall"] = "";
const search = host.querySelector<HTMLInputElement>(".wf-notes-side-top input")!;
await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(search, "rain");
  search.dispatchEvent(new Event("input", { bubbles: true }));
});
await wait(300);
check("searching lists matches from every folder, each with its folder", [...host.querySelectorAll(".wf-note-folder")].some((f) => f.textContent === "Book"), rows().join("|"));

await act(async () => root.unmount());
finish();
