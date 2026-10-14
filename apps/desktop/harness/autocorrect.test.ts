// AutoCorrect: slips set right as a word is finished, a capital to begin a
// sentence, TWo capitals and the caps lock mended, signs for (c), 1/2 and
// 1st. First the part that decides, as a table. Then in an editor: each
// correction a step of its own for Undo, and nothing done where it should
// keep out.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import * as Y from "yjs";

import { autoCorrect } from "../src/editor/autocorrect/AutoCorrect";
import { fixFor, opensSentence, type Fix, type FixOptions, type Kinds } from "../src/editor/autocorrect/engine";
import { builtIn, cleanChoices, decodeAutoCorrect, defaultChoices, encodeAutoCorrect, listsFor, useAutoCorrect } from "../src/editor/autocorrect/store";
import { setReviewMode, Suggesting } from "../src/editor/review/Suggesting";
import { docContentExtensions } from "../src/editor/schema/content";
import { setSmartPunctuationEnabled, SmartPunctuation } from "../src/editor/SmartPunctuation";

const ALL: Kinds = { list: true, capitals: true, twoCaps: true, capsLock: true, symbols: true, fractions: true, ordinals: true };
const opts = (more: Partial<FixOptions> = {}): FixOptions => ({ kinds: ALL, lists: listsFor("en"), capitalsHere: true, raiseHere: true, ...more });
/** What the text before the caret reads once the key is typed and the correction made. */
const after = (before: string, typed: string, o: FixOptions = opts()): string => {
  const fix: Fix | null = fixFor(before, typed, o);
  const now = typed === "\n" ? before : before + typed;
  if (!fix) return now;
  const text = fix.raise ? `${fix.text.slice(0, fix.raise[0])}^${fix.text.slice(fix.raise[0], fix.raise[1])}^${fix.text.slice(fix.raise[1])}` : fix.text;
  return now.slice(0, fix.from) + text + now.slice(fix.to);
};

useAutoCorrect.getState().reset();
useAutoCorrect.getState().setKind("list", true);
useAutoCorrect.getState().setKind("capitals", true);

// ------------------------------------------------------------ what it decides

check("a slip is set right when its word is left", after("I saw teh", " ") === "I saw the " && after("I saw teh", "\n") === "I saw the");
check("with the comma or full stop that closed it", after("It was teh,", " ") === "It was the, " && after("So I beleive.", " ") === "So I believe. ");
check("a capital on the slip is kept", after("Teh", " ") === "The " && after("He said. Becuase", " ") === "He said. Because ");
check("a contraction gets its apostrophe", after("I dont", " ") === "I don’t " && after("So theyre", " ") === "So they’re ");
check("a lone i is I, and im is I’m", after("so i", " ") === "so I " && after("and im", " ") === "and I’m ");
check("a word that is a word is left alone", after("its were well hell wont cant", " ") === "its were well hell wont cant ");
check("nothing happens while the word is still being typed", fixFor("I saw te", "h", opts()) === null && fixFor("I saw teh", ".", opts()) === null && fixFor("I saw teh", ",", opts()) === null);
check("a slip that is part of something longer is left", after("see teh.txt", " ") === "see teh.txt " && after("mail teh@example.com", " ") === "mail teh@example.com " && after("x/teh", " ") === "x/teh ");
check("a slip in capitals all through was meant", after("the TEH", " ") === "the TEH ");

check("a sentence starts with a capital", after("hello", " ") === "Hello " && after("It ended. then", " ") === "It ended. Then " && after("Really? yes", " ") === "Really? Yes " && after("Stop! now", " ") === "Stop! Now ");
check("after a closing quote or bracket too", after("“Go.” she", " ") === "“Go.” She " && after("(See above.) the", " ") === "(See above.) The ");
check("a one-word sentence gets it at its full stop and space", after("yes.", " ") === "Yes. " && after("He nodded. yes.", " ") === "He nodded. Yes. ");
check("not after a shortening", after("See Dr. smith", " ") === "See Dr. smith " && after("cats, dogs etc. and", " ") === "cats, dogs etc. and " && after("on p. three", " ") === "on p. three ");
check("not after an initial", after("J. smith", " ") === "J. smith ");
check("not after an ellipsis or two full stops", after("So… well", " ") === "So… well " && after("So.. well", " ") === "So.. well ");
check("not a word of mixed case or with a digit", after("iPhone", " ") === "iPhone " && after("He left. eBay", " ") === "He left. eBay " && after("x2", " ") === "x2 ");
check("not a lone letter before a full stop, which is a label", after("a.", " ") === "a. " && after("e.g.", " ") === "e.g. ");
check("not an address or a file's name", after("www.example.com", " ") === "www.example.com " && after("readme.txt", " ") === "readme.txt ");
check("a number ends a sentence as a word does", after("It was 1999. then", " ") === "It was 1999. Then ");
check("where capitals are not to be set (a script's lines, verse) none is", after("hello", " ", opts({ capitalsHere: false })) === "hello " && after("teh", " ", opts({ capitalsHere: false })) === "the ");
check("where a sentence begins", opensSentence("", new Set()) && opensSentence("  ", new Set()) && opensSentence("Done. ", new Set()) && !opensSentence("Done.", new Set()) && !opensSentence("Mr. ", new Set()) && !opensSentence("and ", new Set()));

check("TWo capitals are one", after("THe", " ") === "The " && after("He said. WHen", " ") === "He said. When ");
check("but not a short plural of capitals or a name spelled so", after("three IDs", " ") === "three IDs " && after("two TVs", " ") === "two TVs " && after("her PhD", " ") === "her PhD " && after("the BBC", " ") === "the BBC ");
check("a word typed with the caps lock on is mended", after("so wORD", " ") === "so Word " && after("tHEN", " ") === "Then ");
check("but not one that is spelled that way", after("on iOS", " ") === "on iOS " && after("the mRNA", " ") === "the mRNA " && after("a pH", " ") === "a pH ");

check("signs for a few keys in a row", after("(c", ")") === "©" && after("Acme (tm", ")") === "Acme ™" && after("a -", ">") === "a →" && after("a <", "-") === "a ←" && after("a =", ">") === "a ⇒" && after("a <-", ">") === "a ↔");
check("not in the middle of a longer run of them", after("a --", ">") === "a -->" && after("a ==", ">") === "a ==>");
check("a fraction that has a character of its own", after("add 1/2", " ") === "add ½ " && after("3/4", "\n") === "¾" && after("about 2/3.", " ") === "about ⅔. ");
check("not a date or a longer number", after("on 11/2", " ") === "on 11/2 " && after("1/2/26", " ") === "1/2/26 " && after("5/8", " ") === "5/8 ");
check("an ordinal's letters are raised", after("the 1st", " ") === "the 1^st^ " && after("22nd", " ") === "22^nd^ " && after("113th,", " ") === "113^th^, " && after("the 3rd", "\n") === "the 3^rd^");
check("only when they are the right ones", after("the 22th", " ") === "the 22th " && after("11st", " ") === "11st " && after("1nd", " ") === "1nd ");
check("and only where letters can be raised", after("the 1st", " ", opts({ raiseHere: false })) === "the 1st ");

{
  const off = (kind: keyof Kinds) => opts({ kinds: { ...ALL, [kind]: false } });
  check("each kind has its own switch", after("teh", " ", off("list")) === "Teh " && after("teh", " ", off("capitals")) === "the " && after("THe", " ", off("twoCaps")) === "THe " && after("wORD", " ", off("capsLock")) === "wORD " && after("(c", ")", off("symbols")) === "(c)" && after("1/2", " ", off("fractions")) === "1/2 " && after("1st", " ", off("ordinals")) === "1st ");
  check("the built-in words are English: French text keeps its own", fixFor("teh", " ", opts({ lists: listsFor("fr") }))?.kind === "capitals" && after("le teh", " ", opts({ lists: listsFor("fr") })) === "le teh " && after("(c", ")", opts({ lists: listsFor("fr") })) === "©");
  check("no built-in entry is a word it would change by mistake", ["its", "were", "well", "hell", "shell", "ill", "wed", "id", "wont", "lets", "cant", "wether", "calender", "fora", "withe", "directer", "herat", "alway", "stroy", "cliche", "resume", "cafe"].every((w) => !builtIn().has(w)));
  check("every built-in entry changes something and has no space in what is typed", [...builtIn()].every(([from, to]) => from !== to && !/\s/.test(from) && from === from.toLowerCase() && /^[a-z]+$/.test(from)) && builtIn().size > 800, String(builtIn().size));
  check("LibreOffice's list is in it, with the app's own", builtIn().get("yeserday") === "yesterday" && builtIn().get("accordingto") === "according to" && builtIn().get("im") === "I’m" && builtIn().get("wierd") === "weird");
  check("a few have another answer where English is spelled the British way", after("a lisense", " ", opts({ lists: listsFor("en-GB") })) === "a licence " && after("a lisense", " ", opts({ lists: listsFor("en-US") })) === "a license " && after("an orginization", " ", opts({ lists: listsFor("en-AU") })) === "an organisation " && after("an orginization", " ", opts({ lists: listsFor("en") })) === "an organization ");
  check("a capital in the middle of a sentence is a name, and is left as spelled", after("I met Hsi", " ") === "I met Hsi " && after("the hsi", " ") === "the his " && after("Hsi", " ") === "His " && after("with Mr. Teh", " ") === "with Mr. Teh ");
}

// ------------------------------------------------------------ the writer's own list

{
  const s = useAutoCorrect.getState();
  check("an entry of the writer's own is used", s.put("Hte", "the") && s.put("sig", "Yours ever") && after("so sig", " ") === "so Yours ever ");
  check("in any language", after("alors sig", " ", opts({ lists: listsFor("fr") })) === "alors Yours ever ");
  check("one with a space in what is typed, or that changes nothing, is refused", !s.put("two words", "x") && !s.put("same", "same") && !s.put("", "x"));
  s.remove("teh");
  check("a built-in entry taken out is no longer made", after("see teh", " ") === "see teh " && useAutoCorrect.getState().drop.includes("teh"));
  s.restore("teh");
  check("and can be brought back", after("see teh", " ") === "see the ");
  s.remove("sig");
  check("one of the writer's own is simply gone", !("sig" in useAutoCorrect.getState().add) && after("so sig", " ") === "so sig ");
  s.setExceptions("noCapAfter", ["approx.", "Ibid"]);
  check("a shortening of the writer's own stops a capital", after("approx. ten", " ") === "approx. ten " && after("See ibid. and", " ") === "See ibid. and ");
  s.setExceptions("keepCaps", ["MAcro", "wEIRD"]);
  check("and a word to leave as typed is left", after("a MAcro", " ") === "a MAcro " && after("so wEIRD", " ") === "so wEIRD ");
  check("the choices are kept on the device", JSON.parse(localStorage.getItem("wf-autocorrect") ?? "{}").add.hte === "the");

  const file = encodeAutoCorrect();
  const back = decodeAutoCorrect(file);
  check("and go into a file and come out the same", !!back && back.add.hte === "the" && back.keepCaps.join() === "MAcro,wEIRD" && back.noCapAfter.join() === "approx,ibid");
  check("a file that is something else is refused", decodeAutoCorrect("{}") === null && decodeAutoCorrect("not json") === null);
  const hostile = cleanChoices({ off: "yes", kinds: { list: "no", nonsense: true }, add: { ok: "fine", "has space": "x", n: 5, big: "x".repeat(900) }, drop: [1, "teh", {}], noCapAfter: "x", keepCaps: [null, "Ok"] });
  check("what a stranger's file holds is cleaned", hostile.off === false && hostile.kinds.list === defaultChoices().kinds.list && JSON.stringify(hostile.add) === JSON.stringify({ ok: "fine" }) && hostile.drop.join() === "teh" && hostile.noCapAfter.length === 0 && hostile.keepCaps.join() === "Ok");
  s.reset();
  s.setKind("list", true);
  s.setKind("capitals", true);
}

// ------------------------------------------------------------ in an editor

const p = (...text: string[]): JSONContent => ({ type: "paragraph", ...(text.length ? { content: text.map((t) => ({ type: "text", text: t })) } : {}) });
let lang = "en";
const editorWith = (content: JSONContent[], extra: unknown[] = [], history = true): Editor =>
  new Editor({
    element: mountPoint(),
    extensions: [
      ...docContentExtensions(history ? {} : { history: false }),
      SmartPunctuation.configure({}),
      Suggesting.configure({ author: () => "Me" }),
      ...autoCorrect({ lang: () => lang, capitals: (block) => block.attrs.element !== "verse", raise: () => true }),
      ...(extra as never[]),
    ],
    content: { type: "doc", content },
  });
const type = (e: Editor, text: string) => {
  for (const ch of text) {
    const { from, to } = e.state.selection;
    const deflt = () => e.state.tr.insertText(ch, from, to);
    if (!e.view.someProp("handleTextInput", (f) => f(e.view, from, to, ch, deflt))) e.view.dispatch(deflt());
  }
};
const key = (e: Editor, name: string): boolean => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  for (const plugin of e.state.plugins) {
    if (plugin.props.handleKeyDown?.call(plugin, e.view, event)) return true;
  }
  return false;
};
const text = (e: Editor) => e.state.doc.textBetween(0, e.state.doc.content.size, "¶");
/** The caret at the end of the first block (a block that is not a paragraph is given an empty one after it, which is not where these checks type). */
const end = (e: Editor) => e.commands.setTextSelection(e.state.doc.firstChild!.nodeSize - 1);

{
  const e = editorWith([p()]);
  type(e, "i saw teh fox. it dont stop ");
  check("typing is corrected as it goes", text(e) === "I saw the fox. It don’t stop ", text(e));
  check("the caret is where the typing left it", e.state.selection.empty && e.state.selection.from === e.state.doc.content.size - 1);
  type(e, "(c) 1/2 the 2nd ");
  check("signs, a fraction and an ordinal among words", text(e).endsWith("© ½ the 2nd "), text(e));
  const raised: string[] = [];
  e.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((m) => m.type.name === "vscript" && m.attrs.v === "super")) raised.push(node.text ?? "");
  });
  check("the ordinal's letters are raised, and nothing after them", raised.join("|") === "nd", raised.join("|"));

  // Undo and Backspace take back only the correction.
  e.commands.setContent({ type: "doc", content: [p("So ")] });
  end(e);
  type(e, "teh ");
  check("corrected", text(e) === "So the ");
  check("Backspace straight after puts back what was typed, with the space", key(e, "Backspace") && text(e) === "So teh ", text(e));
  check("and a second Backspace is an ordinary one", !key(e, "Backspace"));
  // (A new editor: what was done above is not part of what Undo goes through here.)
  const fresh = editorWith([p("So ")]);
  end(fresh);
  type(fresh, "teh ");
  fresh.commands.undo();
  check("one Undo takes back the correction alone", text(fresh) === "So teh ", text(fresh));
  fresh.commands.undo();
  check("the next takes back the typing", text(fresh) === "So ", text(fresh));
  fresh.commands.redo();
  fresh.commands.redo();
  check("and Redo brings both back", text(fresh) === "So the ", text(fresh));
  fresh.destroy();

  // Enter finishes a word too.
  e.commands.setContent({ type: "doc", content: [p("It was ")] });
  end(e);
  type(e, "teh");
  check("Enter corrects the word before it and is still Enter", key(e, "Enter") && text(e) === "It was the¶", text(e));

  // After moving away, Backspace is only Backspace.
  e.commands.setContent({ type: "doc", content: [p("So ")] });
  end(e);
  type(e, "teh ");
  e.commands.setTextSelection(2);
  end(e);
  check("once the caret has moved, Backspace is only Backspace", !key(e, "Backspace") && text(e) === "So the ");

  // The other rules still have the key first.
  e.commands.setContent({ type: "doc", content: [p()] });
  end(e);
  type(e, "1. ");
  check("a list is still started by its number", e.getJSON().content?.[0]?.type === "orderedList");
  e.commands.setContent({ type: "doc", content: [p()] });
  end(e);
  type(e, 'he said "dont" -- ');
  check("smart quotes and dashes still happen, with the corrections", text(e) === "He said “don’t” — ", text(e));
  setSmartPunctuationEnabled(false);
  e.commands.setContent({ type: "doc", content: [p("I ")] });
  end(e);
  type(e, "dont ");
  check("with smart punctuation off the apostrophe is a plain one", text(e) === "I don't ", text(e));
  setSmartPunctuationEnabled(true);

  // Where it keeps out.
  e.commands.setContent({ type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: "x = " }] }] });
  end(e);
  type(e, "teh (c) ");
  check("nothing is corrected in code", text(e).startsWith("x = teh (c) "), text(e));
  e.commands.setContent({ type: "doc", content: [{ type: "paragraph", attrs: { element: "verse" } }] });
  end(e);
  type(e, "and teh sea ");
  check("verse gets its words set right and no capital", text(e) === "and the sea ", text(e));
  lang = "fr";
  e.commands.setContent({ type: "doc", content: [p("Le ")] });
  end(e);
  type(e, "teh (c) ");
  check("a French text keeps teh and still gets the sign", text(e) === "Le teh © ", text(e));
  lang = "en";
  useAutoCorrect.getState().setOff(true);
  e.commands.setContent({ type: "doc", content: [p()] });
  end(e);
  type(e, "i saw teh ");
  check("switched off, nothing is touched", text(e) === "i saw teh ");
  useAutoCorrect.getState().setOff(false);
  e.setEditable(false);
  check("a reader's editor does nothing", !e.view.someProp("handleTextInput", (f) => f(e.view, 1, 1, " ", () => e.state.tr)));
  e.setEditable(true);

  // While suggesting.
  e.commands.setContent({ type: "doc", content: [p("It was teh")] });
  setReviewMode(e, "suggest");
  end(e);
  type(e, " ");
  check("while suggesting, a slip that was already in the text is left", text(e) === "It was teh ", text(e));
  type(e, "adn ");
  check("and the writer's own suggested word is set right", text(e) === "It was teh and ", text(e));
  let valid = true;
  try {
    e.state.doc.check();
  } catch {
    valid = false;
  }
  check("leaving a sound document", valid);
  setReviewMode(e, "edit");
  e.destroy();
}

// With the shared document's own undo.
{
  const ydoc = new Y.Doc();
  const e = editorWith([], [Collaboration.configure({ document: ydoc })], false);
  e.commands.setTextSelection(1);
  type(e, "So ");
  const before = text(e);
  type(e, "teh ");
  check("in a shared document it is corrected the same", text(e) === "So the ", text(e));
  e.commands.undo();
  check("and one Undo takes back the correction alone", text(e) === "So teh ", `${JSON.stringify(text(e))} from ${JSON.stringify(before)}`);
  e.destroy();
}

// ------------------------------------------------------------ where capitals are set, and the list in Settings

{
  const { capitalsHere } = await import("../src/editor/autocorrect/where");
  const block = (element: string | null) => ({ attrs: { element } }) as never;
  check("a screenplay's scene headings, cues and transitions get no capital of ours", !capitalsHere("screenplay", block("scene_heading")) && !capitalsHere("screenplay", block("character")) && !capitalsHere("screenplay", block("transition")) && capitalsHere("screenplay", block("action")) && capitalsHere("screenplay", block("dialogue")));
  check("nor a play's headings and cues, nor any line of a poem, nor verse in a book", !capitalsHere("stageplay", block("act_heading")) && capitalsHere("stageplay", block("dialogue")) && !capitalsHere("poetry", block(null)) && !capitalsHere("manuscript", block("verse")) && capitalsHere("manuscript", block(null)) && capitalsHere("none", block("title")));

  const g = globalThis as unknown as Record<string, unknown>;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: AutoCorrectDialog } = await import("../src/editor/autocorrect/AutoCorrectDialog");
  const host = mountPoint();
  const root = createRoot(host);
  await act(async () => root.render(createElement(AutoCorrectDialog, { onClose: () => {} })));
  const rows = () => [...document.querySelectorAll(".wf-autocorrect-list li")].map((li) => li.textContent ?? "");
  const set = async (label: string, value: string) =>
    act(async () => {
      const input = document.querySelector<HTMLInputElement>(`.wf-autocorrect input[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor((window as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  check("the list in Settings shows the built-in corrections", rows().length === builtIn().size && rows().some((r) => r.startsWith("teh→the")), `${rows().length} ${rows()[0]}`);
  await set("What is typed", "mss");
  await set("What it becomes", "manuscript");
  await act(async () => void document.querySelector(".wf-autocorrect-add")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  check("one added there is the writer's own, at the top", rows()[0] === "mss→manuscriptyoursRemove" && useAutoCorrect.getState().add.mss === "manuscript", rows()[0]);
  await set("Find a correction", "teh");
  check("the list can be searched", rows().length < 12 && rows().some((r) => r.startsWith("teh→the")) && rows().every((r) => r.includes("teh")), rows().join(" | "));
  const rowOf = (typed: string) => [...document.querySelectorAll(".wf-autocorrect-list li")].find((li) => (li.querySelector(".wf-autocorrect-typed")?.textContent ?? "") === typed);
  await act(async () => (rowOf("teh")!.querySelector("button") as HTMLButtonElement).click());
  check("a built-in one can be taken out, and is listed as taken out", useAutoCorrect.getState().drop.includes("teh") && (document.querySelector(".wf-autocorrect-back")?.textContent ?? "") === "teh" && !rowOf("teh"));
  await act(async () => (document.querySelector(".wf-autocorrect-back") as HTMLButtonElement).click());
  check("and brought back with a click", !useAutoCorrect.getState().drop.includes("teh") && !!rowOf("teh"));
  await act(async () => root.unmount());
  useAutoCorrect.getState().reset();
}

finish();
