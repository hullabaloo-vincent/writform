//! Markdown → HTML for the notes preview, Obsidian-flavoured: GFM (task
//! lists, strikethrough, tables) plus `[[wikilinks]]` and `> [!tip]` callouts.
//!
//! The output is sanitized before it reaches `dangerouslySetInnerHTML`. Notes
//! are usually the user's own, but a friend can send one over `/notes/share`,
//! and this webview holds filesystem IPC — so raw HTML in a note must never
//! execute.

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked, type Tokens, type TokenizerAndRendererExtension } from "marked";

/** Obsidian callout aliases → the variants we actually style. */
const CALLOUT_ALIASES: Record<string, string> = {
  note: "note",
  info: "note",
  todo: "note",
  abstract: "abstract",
  summary: "abstract",
  tldr: "abstract",
  tip: "tip",
  hint: "tip",
  important: "tip",
  success: "success",
  check: "success",
  done: "success",
  question: "question",
  help: "question",
  faq: "question",
  warning: "warning",
  caution: "warning",
  attention: "warning",
  failure: "danger",
  fail: "danger",
  missing: "danger",
  danger: "danger",
  error: "danger",
  bug: "danger",
  example: "example",
  quote: "quote",
  cite: "quote",
};

/** Minimal lucide-style glyphs; kept inline so the preview stays a string. */
const CALLOUT_ICONS: Record<string, string> = {
  note: '<path d="M12 8v8M8 12h8"/>',
  abstract: '<path d="M8 7h8M8 12h8M8 17h5"/>',
  tip: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>',
  success: '<path d="M20 6 9 17l-5-5"/>',
  question: '<path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
  warning: '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  danger: '<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>',
  example: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  quote: '<path d="M6 17h3l2-4V7H5v6h3zM14 17h3l2-4V7h-6v6h3z"/>',
};

const CALLOUT_TITLES: Record<string, string> = {
  note: "Note",
  abstract: "Summary",
  tip: "Tip",
  success: "Success",
  question: "Question",
  warning: "Warning",
  danger: "Danger",
  example: "Example",
  quote: "Quote",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Note names that currently exist, so unresolved links can be styled
 * differently. Assigned by `renderMarkdown` immediately before parsing —
 * `marked.parse` is synchronous, so nothing can interleave between the two.
 */
let knownNotes = new Set<string>();

const wikiLink: TokenizerAndRendererExtension = {
  name: "wikiLink",
  level: "inline",
  start(src: string) {
    return src.indexOf("[[");
  },
  tokenizer(src: string) {
    const m = /^\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/.exec(src);
    if (!m) return undefined;
    const target = m[1].trim();
    if (!target) return undefined;
    return {
      type: "wikiLink",
      raw: m[0],
      target,
      label: (m[2] ?? m[1]).trim(),
    };
  },
  renderer(token) {
    const { target, label } = token as unknown as { target: string; label: string };
    const missing = knownNotes.has(target.toLowerCase()) ? "" : " missing";
    // A button, not an <a>: these resolve to vault files, not URLs.
    return `<button type="button" class="wf-wikilink${missing}" data-wf-note="${escapeHtml(
      target,
    )}">${escapeHtml(label)}</button>`;
  },
};

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  extensions: [wikiLink],
  renderer: {
    code(token: Tokens.Code) {
      const lang = (token.lang ?? "").split(/\s+/)[0];
      const supported = lang && hljs.getLanguage(lang);
      const body = supported
        ? hljs.highlight(token.text, { language: lang }).value
        : escapeHtml(token.text);
      const cls = supported ? ` class="language-${escapeHtml(lang)}"` : "";
      return `<pre><code${cls}>${body}</code></pre>\n`;
    },

    link(token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      // Tauri routes _blank to the system browser via the opener plugin.
      return `<a href="${escapeHtml(
        token.href,
      )}"${title} target="_blank" rel="noreferrer">${text}</a>`;
    },

    blockquote(token: Tokens.Blockquote) {
      const m = /^\[!([A-Za-z]+)\]([+-]?)[ \t]*(.*)(?:\n|$)/.exec(token.text);
      if (!m) return `<blockquote>${this.parser.parse(token.tokens)}</blockquote>\n`;

      const kind = CALLOUT_ALIASES[m[1].toLowerCase()] ?? "note";
      const fold = m[2];
      const title = m[3].trim() || CALLOUT_TITLES[kind];
      const rest = token.text.slice(m[0].length);
      const body = rest.trim() ? marked.parse(rest, { async: false }) : "";
      const icon = `<svg class="wf-callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${CALLOUT_ICONS[kind]}</svg>`;
      const head = `${icon}<span>${escapeHtml(title)}</span>`;

      if (fold) {
        const open = fold === "+" ? " open" : "";
        return `<details class="wf-callout wf-callout-${kind}"${open}><summary class="wf-callout-title">${head}</summary><div class="wf-callout-body">${body}</div></details>\n`;
      }
      return `<div class="wf-callout wf-callout-${kind}"><div class="wf-callout-title">${head}</div>${
        body ? `<div class="wf-callout-body">${body}</div>` : ""
      }</div>\n`;
    },
  },
});

/**
 * Renders note markdown to sanitized HTML. `notes` are the vault's current
 * note names, used to mark `[[links]]` that don't resolve yet.
 */
export function renderMarkdown(src: string, notes: Iterable<string> = []): string {
  knownNotes = new Set([...notes].map((n) => n.toLowerCase()));
  const html = marked.parse(src, { async: false });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true, svg: true } });
}
