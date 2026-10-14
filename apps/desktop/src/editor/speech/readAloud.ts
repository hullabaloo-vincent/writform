/**
 * Read aloud: the document spoken a sentence at a time, the sentence being
 * spoken highlighted in the text.
 *
 * The voice is the system's (the Web Speech API — nothing leaves the
 * device). A sentence at a time rather than the whole text: it can be
 * paused and stepped, the highlight is exact, and long utterances that
 * some engines cut off never arise.
 *
 * What is read is the text as it would stand: words someone has suggested
 * deleting are skipped, footnotes aren't read into their sentence.
 */

import { Extension, type Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { chapterFocus, inFocus } from "../ChapterFocus";

export interface Sentence {
  from: number;
  to: number;
  text: string;
}

const struck = (node: PmNode) => node.marks.some((m) => m.type.name === "deletion");
const removed = (node: PmNode) => typeof node.attrs.tc === "string" && node.attrs.tc.includes("del:") && !node.isTextblock;

type Splitter = (text: string) => { index: number; segment: string }[];

/** Sentences of a run of text. The platform's own segmenter where there is
 *  one; else at a full stop, question or exclamation mark followed by a
 *  space. */
export function splitter(lang?: string): Splitter {
  const Seg = (Intl as unknown as { Segmenter?: new (lang?: string, opts?: { granularity: string }) => { segment(text: string): Iterable<{ index: number; segment: string }> } }).Segmenter;
  if (Seg) {
    try {
      const seg = new Seg(lang, { granularity: "sentence" });
      return (text) => [...seg.segment(text)].map((s) => ({ index: s.index, segment: s.segment }));
    } catch {
      // An unknown language tag: below.
    }
  }
  return (text) => {
    const out: { index: number; segment: string }[] = [];
    const end = /[.!?…]+["'”’)\]]*\s+/g;
    let start = 0;
    for (let m = end.exec(text); m; m = end.exec(text)) {
      out.push({ index: start, segment: text.slice(start, m.index + m[0].length) });
      start = m.index + m[0].length;
    }
    if (start < text.length) out.push({ index: start, segment: text.slice(start) });
    return out;
  };
}

/** The sentences of one paragraph (the textblock at `pos`). */
export function sentencesOf(block: PmNode, pos: number, split: Splitter): Sentence[] {
  // The text as it will be spoken, and where each of its letters is.
  let text = "";
  const at: number[] = [];
  block.forEach((child, offset) => {
    const start = pos + 1 + offset;
    if (child.isText) {
      if (struck(child)) return;
      const value = child.text ?? "";
      for (let i = 0; i < value.length; i += 1) at.push(start + i);
      text += value;
    } else if (child.type.name === "hardBreak" && !removed(child)) {
      at.push(start);
      text += " ";
    }
  });
  const out: Sentence[] = [];
  for (const piece of split(text)) {
    const lead = piece.segment.length - piece.segment.trimStart().length;
    const spoken = piece.segment.trim();
    if (!spoken || !/[\p{L}\p{N}]/u.test(spoken)) continue;
    const first = piece.index + lead;
    const last = first + spoken.length - 1;
    out.push({ from: at[first], to: at[last] + 1, text: spoken });
  }
  return out;
}

/** Each paragraph that is read, in order (a struck table or picture, and
 *  what is inside a note, are not). */
function blocks(doc: PmNode, from: number, to: number, visit: (block: PmNode, pos: number) => boolean | void): void {
  let done = false;
  doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (node, pos) => {
    if (done) return false;
    if (removed(node)) return false;
    if (node.isTextblock) {
      if (visit(node, pos) === false) done = true;
      return false;
    }
    return true;
  });
}

/** The sentence `pos` is in, or the first one after it. */
export function sentenceFrom(doc: PmNode, pos: number, split: Splitter): Sentence | null {
  let found: Sentence | null = null;
  blocks(doc, pos, doc.content.size, (block, at) => {
    found = sentencesOf(block, at, split).find((s) => s.to > pos) ?? null;
    return found === null;
  });
  return found;
}

/** The sentence that ends at or before `pos`, nearest first. */
export function sentenceBefore(doc: PmNode, pos: number, split: Splitter): Sentence | null {
  let found: Sentence | null = null;
  blocks(doc, 0, pos, (block, at) => {
    const last = sentencesOf(block, at, split)
      .filter((s) => s.to <= pos)
      .pop();
    if (last) found = last;
  });
  return found;
}

// ---- the highlight

const readKey = new PluginKey<DecorationSet>("wf-read-aloud");

/** Shows the sentence being read. (A decoration: nothing in the document
 *  changes, and it moves with the text if someone edits above it.) */
export const ReadAloudHighlight = Extension.create({
  name: "readAloudHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: readKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const next = tr.getMeta(readKey) as { from: number; to: number } | null | undefined;
            if (next === null) return DecorationSet.empty;
            if (next) return DecorationSet.create(tr.doc, [Decoration.inline(next.from, next.to, { class: "wf-reading" })]);
            return tr.docChanged ? old.map(tr.mapping, tr.doc) : old;
          },
        },
        props: {
          decorations: (state) => readKey.getState(state),
        },
      }),
    ];
  },
});

function highlighted(editor: Editor): { from: number; to: number } | null {
  const found = readKey.getState(editor.state)?.find()[0];
  return found ? { from: found.from, to: found.to } : null;
}

// ---- the reader

export interface Voice {
  id: string;
  name: string;
  lang: string;
}

export interface ReadAloudState {
  status: "idle" | "playing" | "paused";
  rate: number;
  /** The chosen voice's id, or null for the system's own choice. */
  voice: string | null;
}

export const RATES = [0.75, 1, 1.25, 1.5, 2];

const synth = (): SpeechSynthesis | null => (typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined" ? window.speechSynthesis : null);

/** Whether this device can speak. */
export const canReadAloud = (): boolean => synth() !== null;

/** The system's voices, those for `lang` first (all of them when it has
 *  none for the language). */
export function voicesFor(lang: string): Voice[] {
  const all = (synth()?.getVoices() ?? []).map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang }));
  const base = lang.toLowerCase().split("-")[0];
  const mine = all.filter((v) => v.lang.toLowerCase().split(/[-_]/)[0] === base);
  return mine.length ? mine : all;
}

const RATE_KEY = "wf-read-rate";
const VOICE_KEY = "wf-read-voice";

const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // A convenience only.
  }
};

export class ReadAloud {
  private state: ReadAloudState;
  /** Where reading is, should the highlight be lost to an edit. */
  private last: Sentence | null = null;
  /** Each utterance has a number; an ended one that isn't the current is
   *  one we cancelled. */
  private turn = 0;
  private split: Splitter;

  constructor(
    private editor: Editor,
    private lang: string,
    private onChange: (state: ReadAloudState) => void,
  ) {
    const rate = Number(stored(RATE_KEY));
    this.state = { status: "idle", rate: RATES.includes(rate) ? rate : 1, voice: stored(VOICE_KEY) };
    this.split = splitter(lang);
  }

  get current(): ReadAloudState {
    return this.state;
  }

  private set(patch: Partial<ReadAloudState>) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  private show(sentence: Sentence | null) {
    const { editor } = this;
    if (editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(readKey, sentence ? { from: sentence.from, to: sentence.to } : null).setMeta("addToHistory", false));
    if (sentence) editor.view.dom.querySelector(".wf-reading")?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  /** Where reading is now, in today's document. */
  private where(): number {
    const mark = highlighted(this.editor);
    if (mark) return mark.to;
    return Math.min(this.last?.to ?? 0, this.editor.state.doc.content.size);
  }

  private speak(found: Sentence | null) {
    // (While one chapter is shown, reading ends where it does.)
    const sentence = found && inFocus(this.editor.state, found.from) ? found : null;
    const engine = synth();
    this.turn += 1;
    const turn = this.turn;
    engine?.cancel();
    if (!engine || !sentence) {
      this.last = null;
      this.show(null);
      this.set({ status: "idle" });
      return;
    }
    this.last = sentence;
    this.show(sentence);
    const utterance = new SpeechSynthesisUtterance(sentence.text);
    utterance.lang = this.lang;
    utterance.rate = this.state.rate;
    const voice = this.state.voice ? engine.getVoices().find((v) => v.voiceURI === this.state.voice) : undefined;
    if (voice) utterance.voice = voice;
    utterance.onend = () => {
      if (turn !== this.turn || this.state.status !== "playing" || this.editor.isDestroyed) return;
      this.speak(sentenceFrom(this.editor.state.doc, this.where(), this.split));
    };
    utterance.onerror = (event) => {
      if (turn !== this.turn) return;
      // Cancelling (a skip, a pause) reports itself as an error.
      if (event.error === "interrupted" || event.error === "canceled") return;
      this.stop();
    };
    this.set({ status: "playing" });
    engine.speak(utterance);
  }

  /** Start at the sentence the caret is in (or continue where it paused). */
  play(): void {
    if (this.state.status === "paused" && this.last) {
      const again = sentenceFrom(this.editor.state.doc, Math.max(0, this.where() - 1), this.split);
      this.speak(again);
      return;
    }
    const { from } = this.editor.state.selection;
    const start = chapterFocus(this.editor.state)?.from ?? 0;
    this.speak(sentenceFrom(this.editor.state.doc, from, this.split) ?? sentenceFrom(this.editor.state.doc, start, this.split));
  }

  pause(): void {
    if (this.state.status !== "playing") return;
    this.turn += 1;
    synth()?.cancel();
    this.set({ status: "paused" });
  }

  stop(): void {
    this.turn += 1;
    synth()?.cancel();
    this.last = null;
    this.show(null);
    this.set({ status: "idle" });
  }

  /** To the next sentence, or back to the one before this. */
  step(dir: 1 | -1): void {
    const doc = this.editor.state.doc;
    const mark = highlighted(this.editor) ?? this.last;
    const pos = mark ? (dir > 0 ? mark.to : mark.from) : this.editor.state.selection.from;
    const target = dir > 0 ? sentenceFrom(doc, pos, this.split) : (sentenceBefore(doc, pos, this.split) ?? sentenceFrom(doc, 0, this.split));
    if (!target) return;
    if (this.state.status === "playing") this.speak(target);
    else {
      // Paused or stopped: move the place, don't start talking.
      this.last = target;
      this.show(target);
      this.set({ status: "paused" });
    }
  }

  setRate(rate: number): void {
    store(RATE_KEY, String(rate));
    this.set({ rate });
    // The sentence under way is said again at the new speed.
    if (this.state.status === "playing" && this.last) this.speak(sentenceFrom(this.editor.state.doc, Math.max(0, this.where() - 1), this.split));
  }

  setVoice(voice: string | null): void {
    store(VOICE_KEY, voice);
    this.set({ voice });
    if (this.state.status === "playing" && this.last) this.speak(sentenceFrom(this.editor.state.doc, Math.max(0, this.where() - 1), this.split));
  }

  destroy(): void {
    this.turn += 1;
    synth()?.cancel();
    if (!this.editor.isDestroyed) this.show(null);
  }
}
