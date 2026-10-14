/* tslint:disable */
/* eslint-disable */

export class PdfDoc {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Make a mark (`mark` is a `NewMark` as JSON). `pixels`: a picture's, where the mark is one.
     */
    addMark(mark: string, pixels?: Uint8Array | null): string;
    /**
     * Put text on a page (`text` is a `NewText` as JSON).
     */
    addText(page: number, text: string): string;
    /**
     * What was added to a page.
     */
    added(page: number): string;
    /**
     * What time it is (seconds since 1970), for whatever is made next: nothing in here reads a
     * clock.
     */
    clock(now: number): void;
    deleteAdded(page: number, index: number): string;
    deleteMark(page: number, index: number): string;
    deletePages(pages: Uint32Array): string;
    duplicatePages(pages: Uint32Array): string;
    /**
     * Some pages as a PDF of their own.
     */
    extract(pages: Uint32Array, now: number): Uint8Array;
    /**
     * The form's fields.
     */
    fields(): string;
    /**
     * Make what was filled in and signed part of the pages (all pages when none are named).
     */
    flattenFillSign(pages: Uint32Array): string;
    /**
     * Its pages, its title, what may be done to it, and whether there is anything to undo.
     */
    info(): string;
    insertBlank(at: number, width: number, height: number): string;
    /**
     * Pages of another PDF, before page `at`. `pages` empty: all of them.
     */
    insertFrom(other: Uint8Array, password: string | null | undefined, pages: Uint32Array, at: number): string;
    markSaved(bytes: Uint8Array): void;
    /**
     * The marks on a page.
     */
    marks(page: number): string;
    movePages(pages: Uint32Array, to: number): string;
    /**
     * Open a PDF from its bytes.
     */
    constructor(bytes: Uint8Array, password?: string | null);
    redo(): string;
    replaceBlock(page: number, block: number, text: string): string;
    rotate(pages: Uint32Array, degrees: number): string;
    /**
     * The document as a file (see `Session::save`).
     */
    save(full: boolean, now: number): Uint8Array;
    /**
     * Set a field (`value` is a `Value` as JSON: `{"text": "…"}`, `{"check": true}`…).
     */
    setField(name: string, value: string): string;
    /**
     * A page's own text, as blocks that can be changed.
     */
    textBlocks(page: number): string;
    undo(): string;
    updateMark(page: number, index: number, patch: string): string;
    updateText(page: number, index: number, text: string): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_pdfdoc_free: (a: number, b: number) => void;
    readonly pdfdoc_addMark: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pdfdoc_addText: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pdfdoc_added: (a: number, b: number, c: number) => void;
    readonly pdfdoc_clock: (a: number, b: number) => void;
    readonly pdfdoc_deleteAdded: (a: number, b: number, c: number, d: number) => void;
    readonly pdfdoc_deleteMark: (a: number, b: number, c: number, d: number) => void;
    readonly pdfdoc_deletePages: (a: number, b: number, c: number, d: number) => void;
    readonly pdfdoc_duplicatePages: (a: number, b: number, c: number, d: number) => void;
    readonly pdfdoc_extract: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pdfdoc_fields: (a: number, b: number) => void;
    readonly pdfdoc_flattenFillSign: (a: number, b: number, c: number, d: number) => void;
    readonly pdfdoc_info: (a: number, b: number) => void;
    readonly pdfdoc_insertBlank: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pdfdoc_insertFrom: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly pdfdoc_markSaved: (a: number, b: number, c: number, d: number) => void;
    readonly pdfdoc_marks: (a: number, b: number, c: number) => void;
    readonly pdfdoc_movePages: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pdfdoc_open: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pdfdoc_redo: (a: number, b: number) => void;
    readonly pdfdoc_replaceBlock: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pdfdoc_rotate: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pdfdoc_save: (a: number, b: number, c: number, d: number) => void;
    readonly pdfdoc_setField: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pdfdoc_textBlocks: (a: number, b: number, c: number) => void;
    readonly pdfdoc_undo: (a: number, b: number) => void;
    readonly pdfdoc_updateMark: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pdfdoc_updateText: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
