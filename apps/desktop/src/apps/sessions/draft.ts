/**
 * What a writer types while a prompt runs, kept safe.
 *
 * The server only takes writing while the prompt is running, and a sprint
 * ends on the server's clock. So the last words are the ones at risk: a
 * save still waiting when the bell goes is refused. Three things guard
 * them. Saves come quicker as the end nears, the last ones are made just
 * before it, and a copy is kept on this device the whole time, marked with
 * whether the server has it. Whatever the server never got can still be
 * copied out or kept as a document afterwards.
 *
 * Nothing here knows about React or the editor.
 */

import type { JSONContent } from "@tiptap/react";

// ------------------------------------------------------------------ text

/** A piece as plain text: a paragraph a line, with a blank line between. */
export function pieceText(doc: unknown): string {
  const blocks: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node !== "object" || node === null) return;
    const n = node as { type?: unknown; text?: unknown; content?: unknown };
    if (n.type === "horizontalRule") {
      blocks.push("* * *");
      return;
    }
    const kids = Array.isArray(n.content) ? (n.content as { type?: unknown; text?: unknown }[]) : [];
    const inline = kids.some((k) => typeof k?.text === "string" || k?.type === "hardBreak");
    if (inline) {
      blocks.push(kids.map((k) => (typeof k?.text === "string" ? k.text : k?.type === "hardBreak" ? "\n" : "")).join(""));
      return;
    }
    kids.forEach(walk);
  };
  walk(doc);
  return blocks.filter((b) => b.trim()).join("\n\n");
}

/** Whether two pieces say the same words (formatting aside). */
export const sameWords = (a: unknown, b: unknown): boolean => pieceText(a).trim() === pieceText(b).trim();

/** Words a minute since the prompt began, once a minute has passed (any
 *  sooner and the figure is noise). */
export function pace(words: number, startedAt: number | null, now: number): number | null {
  if (words <= 0 || startedAt == null) return null;
  const minutes = (now - startedAt) / 60_000;
  return minutes >= 1 ? Math.round(words / minutes) : null;
}

// ---------------------------------------------------- the copy on the device

export interface Draft {
  doc: JSONContent;
  /** When it was last typed in (this device's clock). */
  at: number;
  /** The server has exactly this. */
  sent: boolean;
}

const PREFIX = "wf-session-draft:";
/** A draft nobody came back for. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const keyOf = (scope: string, promptId: number) => `${PREFIX}${scope}:${promptId}`;

const listeners = new Set<() => void>();
/** Told whenever a draft on this device changes. */
export function onDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const tell = () => listeners.forEach((l) => l());

export function readDraft(scope: string, promptId: number): Draft | null {
  try {
    const raw = JSON.parse(localStorage.getItem(keyOf(scope, promptId)) ?? "null") as Partial<Draft> | null;
    if (!raw || typeof raw !== "object" || typeof raw.doc !== "object" || raw.doc === null) return null;
    return { doc: raw.doc, at: typeof raw.at === "number" ? raw.at : 0, sent: raw.sent === true };
  } catch {
    return null;
  }
}

export function writeDraft(scope: string, promptId: number, draft: Draft): void {
  try {
    localStorage.setItem(keyOf(scope, promptId), JSON.stringify(draft));
  } catch {
    // No room, or no storage: the server's copy is the only one.
  }
  tell();
}

export function dropDraft(scope: string, promptId: number): void {
  try {
    localStorage.removeItem(keyOf(scope, promptId));
  } catch {
    // Nothing to drop.
  }
  tell();
}

/** Clear out drafts that are a month old. */
export function sweepDrafts(now = Date.now()): void {
  try {
    const old: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(PREFIX)) continue;
      const raw = JSON.parse(localStorage.getItem(key) ?? "null") as { at?: unknown } | null;
      if (!raw || typeof raw.at !== "number" || now - raw.at > KEEP_MS) old.push(key);
    }
    old.forEach((key) => localStorage.removeItem(key));
  } catch {
    // A convenience only.
  }
}

// ----------------------------------------------------------------- saving

/**
 * clean: nothing typed yet. waiting: typed, about to be sent. saving: on
 * its way. saved: the server has it. retrying: it did not get there and
 * will be sent again. closed: the prompt has ended and nothing more can go.
 */
export type SaveState = "clean" | "waiting" | "saving" | "saved" | "retrying" | "closed";

export const SAVE_DELAYS = {
  /** After the last key, ordinarily. */
  idle: 1500,
  /** After the last key in the final stretch. */
  near: 400,
  /** How long before the end counts as the final stretch. */
  nearWindow: 20_000,
  /** The last saves, this long before the end. */
  last: [1500, 400],
  /** The first wait before sending again (doubled each time). */
  retry: 1000,
  retryMax: 8000,
  /** The copy on the device is written at most this often. */
  local: 800,
};

export interface SaverOptions {
  promptId: number;
  /** Whose drafts these are: the server and the person. */
  scope: string;
  save: (doc: JSONContent) => Promise<void>;
  /** When the prompt ends, if it has an end (the server's clock). */
  endsAt: () => number | null;
  onState: (state: SaveState) => void;
  delays?: Partial<typeof SAVE_DELAYS>;
}

/** The server said the prompt is over (as against not answering). */
const isOver = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "not_running";

export class DraftSaver {
  private latest: JSONContent | null = null;
  private version = 0;
  private dirty = false;
  private flying: Promise<void> | null = null;
  private failures = 0;
  private closed = false;
  private stopped = false;
  /** The one more try made on the way out has been made. */
  private lastTry = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private localTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTimers: ReturnType<typeof setTimeout>[] = [];
  private state: SaveState = "clean";
  private readonly delays: typeof SAVE_DELAYS;

  constructor(private readonly opts: SaverOptions) {
    this.delays = { ...SAVE_DELAYS, ...opts.delays };
    this.rearm();
  }

  /** Words the server may not have. */
  get unsent(): boolean {
    return this.dirty;
  }

  private set(state: SaveState): void {
    if (state === this.state) return;
    this.state = state;
    this.opts.onState(state);
  }

  private remaining(): number | null {
    const end = this.opts.endsAt();
    return end == null ? null : end - Date.now();
  }

  /** The writer typed. */
  change(doc: JSONContent): void {
    this.latest = doc;
    this.version += 1;
    this.dirty = true;
    this.keepLocal(false);
    if (this.closed) return;
    this.set(this.failures > 0 ? "retrying" : "waiting");
    const left = this.remaining();
    this.schedule(left !== null && left < this.delays.nearWindow ? this.delays.near : this.delays.idle);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  /** The copy on this device: now, or soon. */
  private keepLocal(now: boolean): void {
    const write = () => {
      this.localTimer = null;
      if (this.latest) writeDraft(this.opts.scope, this.opts.promptId, { doc: this.latest, at: Date.now(), sent: !this.dirty });
    };
    if (now) {
      if (this.localTimer) clearTimeout(this.localTimer);
      write();
    } else if (!this.localTimer) {
      this.localTimer = setTimeout(write, this.delays.local);
    }
  }

  /** Send what there is, now. */
  flush(): Promise<void> {
    if (this.flying) return this.flying;
    if (!this.dirty || !this.latest || this.closed) return Promise.resolve();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const sending = this.version;
    const doc = this.latest;
    this.set("saving");
    this.flying = this.opts
      .save(doc)
      .then(
        () => {
          this.failures = 0;
          if (this.version === sending) {
            this.dirty = false;
            this.set("saved");
          } else {
            this.set("waiting");
          }
        },
        (error: unknown) => {
          if (isOver(error)) {
            this.closed = true;
            this.set("closed");
          } else {
            this.failures += 1;
            this.set("retrying");
          }
        },
      )
      .then(() => {
        this.flying = null;
        this.keepLocal(true);
        if (this.closed || !this.dirty) return;
        if (this.stopped) {
          // Leaving with words typed while a save was on its way: they get
          // their one try too.
          if (this.lastTry) return;
          this.lastTry = true;
          return this.flush();
        }
        // More was typed meanwhile, or it has to go again.
        if (this.failures > 0) this.schedule(Math.min(this.delays.retryMax, this.delays.retry * 2 ** (this.failures - 1)));
        else if (!this.timer) this.schedule(this.delays.near);
      });
    return this.flying;
  }

  /** The end moved (a timer was set, or Stop was pressed): aim the last
   *  saves at it. */
  rearm(): void {
    this.lastTimers.forEach(clearTimeout);
    this.lastTimers = [];
    const left = this.remaining();
    if (left === null) return;
    for (const before of this.delays.last) {
      const wait = left - before;
      if (wait > 0) this.lastTimers.push(setTimeout(() => void this.flush(), wait));
    }
  }

  /** The writer is leaving the desk: one more try, and the copy on the
   *  device says how it ended. */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.lastTimers.forEach(clearTimeout);
    this.lastTimers = [];
    this.keepLocal(true);
    this.lastTry = !this.flying;
    return this.flush();
  }
}

// ------------------------------------------------------------ who is writing

/** How long after a save someone still counts as writing. */
export const WRITING_MS = 20_000;

/** The people (not `me`) whose writing for a prompt reached the server in
 *  the last few seconds. */
export function writingNow(writers: Record<number, number> | undefined, me: number | undefined, now: number): number[] {
  if (!writers) return [];
  return Object.entries(writers)
    .filter(([id, at]) => Number(id) !== me && now - at < WRITING_MS)
    .map(([id]) => Number(id));
}

/** "Ana is writing too", "Ana and Ben are writing too", "3 others are
 *  writing too". Names that are not known are counted. */
export function writingLine(ids: number[], nameOf: (id: number) => string | null): string {
  if (ids.length === 0) return "";
  const names = ids.map(nameOf);
  if (names.every((n): n is string => !!n)) {
    if (names.length === 1) return `${names[0]} is writing too`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are writing too`;
  }
  return ids.length === 1 ? "Someone else is writing too" : `${ids.length} others are writing too`;
}
