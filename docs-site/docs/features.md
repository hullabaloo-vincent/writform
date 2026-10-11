# Features

## Writing sessions

A session lives in a group channel and holds **multiple prompts**. Anyone in
the group can create a session; each prompt can be started, timed
(10 seconds to 24 hours), and stopped early by its creator or a group admin.

- While a prompt runs, your writing **autosaves** and stays private — the
  word count shows your sprint pace (≈ words per minute) as you go.
- When it ends, everyone's writing is revealed side by side.
- The prompt editor and your writing area have a full formatting toolbar
  (headings, lists, quotes, inline code, images).
- A **join card** is posted to the channel when a session is created, so
  members can jump in from chat.
- Ended sessions stay browsable forever; the creator or an admin can also
  delete a session permanently.

## Documents

Google-Docs-style collaborative writing, separate from timed sessions — and
a book-production tool: write a manuscript, design the book, export a
print-ready paperback, an ebook and a submission manuscript.

- **Live multi-user editing**: a CRDT (Yjs) syncs everyone's edits and shows
  live cursors — no lock, no conflicts, no "someone else is editing" wall.
- **Your text is never lost**: edits that can't reach the server yet (offline,
  a dropped connection, quitting mid-sync) are kept on this device and sent
  when the server is back — they're never sent to the wrong server or the
  wrong document. The save indicator says *Saved*, *Saving…*, *Offline* or
  *Not saved* (with what to do about it), and closing, signing out or quitting
  waits a moment for unsent edits. On-device documents save atomically, so a
  crash mid-save can't damage the file.
- **Writing formats**: None, Screenplay, Stage Play, Manuscript, or Poetry.
  Each format adds its own element types (scene heading, character,
  dialogue, …) with correct margins and Tab/Enter cycling between them,
  Final-Draft style.
- **Manuscript is the book format**: elements for Chapter Heading, Part
  Heading, Unnumbered Chapter (Prologue, Epilogue, Acknowledgments…),
  Chapter Subtitle, Subheading, Epigraph, Attribution, Verse and Body — ⌘1–9
  set them. Chapters number themselves ("Chapter Three" labels show beside
  each heading); scene breaks are `* * *` + Enter or the toolbar button. A
  page break (⌘↩ / Ctrl+Enter, or the toolbar's page-break button) starts
  what follows on a new page — a letter, a poem, an interlude on a page of
  its own — in the print PDF, the ebook and the submission manuscript alike;
  chapters start on a new page by themselves. You write meaning, not layout:
  indents, fonts and spacing come from the book's design, so editing the
  text can't break the book. In Manuscript, Tab only changes an *empty*
  line's element (it never turns a sentence into a heading), and pasted
  headings and `***` lines become chapters and scene breaks.
- **Smart quotes and dashes** as you type (Settings ▸ Writing to turn off):
  curly quotes in the book's language style, `--` → —, `...` → ….
- **Make it a book manuscript**: switching a Document to Manuscript (or
  Export ▸ Make it a book manuscript…) detects chapters, parts, scene breaks
  and front matter and shows what it found before converting — one undo puts
  it back. Importing a Word manuscript does the same automatically.
- **Book inspector** (the book button, Manuscript): the book's details (title,
  author, series, ISBNs, copyright, dedication, epigraph, also-by, about the
  author, submission contact), its **design** (five presets — Classic,
  Literary, Fantasy, Romance, Modern — with every choice adjustable: fonts,
  size, leading, chapter labels, drop caps, small-caps lead-ins, ornaments,
  running heads, page numbers). The body and heading fonts can be any of
  the app's seven book faces or any family of the **online library** (the
  same Google Fonts collection documents use): it downloads when chosen,
  draws the manuscript view and the preview, and is embedded in the
  paperback PDF; other scripts of the family (Cyrillic, Greek…) are fetched
  when the text has them, and where a display face lacks an alphabet a
  title in it is set in the body face. A library family has no small
  capitals or old-style figures of its own (capitals are reduced instead),
  and one with no italic is slanted. If it can't be fetched (offline and
  never downloaded) the book is set in the nearest of the app's own and
  the export says so. Also here: **print** settings (trim size, KDP-safe
  margins that grow with the page count, right-hand chapter starts, front and
  back matter, spine width) and **ebook** settings. Saved in the document, so
  collaborators see the same book.
- **Book preview** (the eye button, Manuscript): every page exactly as it will
  print — facing pages on a desk, page 1 alone on the right, chapter jump,
  zoom, and "Edit here" from any line. On a wide window it docks beside the
  manuscript and re-sets live as you write (only the chapter you're editing
  is re-set); on a phone it's one page at a time with swipes.
- **Book exports** (Export menu, Manuscript): **Paperback PDF** — typeset with
  optimal line breaking, hyphenation, no widows or orphans, real small caps,
  drop caps, running heads and roman/arabic page numbers, fonts embedded,
  trim box set, ready for KDP and IngramSpark; **Booklet PDF** to print and
  fold at home; **Ebook (EPUB)** for Kindle, Apple Books, Kobo and Google
  Play — with *Embed the book's fonts* on, the body and heading fonts'
  files go inside it (the app's own or the library's, each script its own
  file), so readers that honour a publisher's fonts show the book in them;
  and the **Submission manuscript** (Standard Manuscript Format) as PDF
  or Word. Each shows a preflight list first (missing ISBN digits, glyphs a
  font lacks, a too-short book), each item with a "Show" button.
- **Version history**: revisions are recorded at the seams of the work — a
  pause of half a minute closes one off, a long unbroken stretch is cut on
  its own after five minutes — plus named drafts you save yourself. Any
  revision can be previewed (in the document's own format, or as changes
  against the revision before it) and restored — restoring saves a "Before
  restoring" version first and keeps comments on untouched paragraphs.
- **Find and replace** (⌘F, ⌥⌘F / Ctrl+H): finds phrases even across italics,
  curly and straight quotes match each other, match case and whole words are
  a click away; ⌘G / F3 step through matches. Replace keeps the formatting
  and Replace All is a single undo. Opening it never moves your cursor until
  you step to a match.
- **Spellcheck** underlines as you type.
- **Focus mode** (the target button, Esc leaves): the app chrome steps
  away and it's just you and the page — with optional **typewriter
  scrolling** that keeps the line you're writing vertically centred.
- **Reopen where you left off**: each document remembers its cursor and
  scroll position on this device.
- **Word count**: on every screen, including phones; with text selected it
  reads "120 of 12,345 words". Click it to set a **word-count goal**;
  progress rides under the count as a thin bar, per document, on this device.
- **The ribbon** (Document format): four tabs of controls, Word-style.
  **Home** — undo and the **format painter**; **styles** (below); font and
  size for the words you select (*Larger*/*Smaller*, ⌘⇧. and ⌘⇧, step Word's
  ladder; the inspector takes any size); bold, italic, underline,
  strikethrough, **subscript** and **superscript** (⌘= and ⌘⇧=), **text
  colour** and **highlight**, inline code, **change case**, **clear
  formatting**; bulleted lists with a choice of marker, numbered lists with
  a numbering style (1, a, A, i, I, or legal 1.1.1) and *restart* or
  *continue*, **checklists** (⌘⇧9) with boxes you tick, and indent/outdent
  — of a list item, or of a paragraph, half an inch at a time; alignment
  (⌘⇧L/E/R/J), line and paragraph spacing, paragraph **shading** and
  **borders** (a box, a line above or below, a bar at the left — neighbours
  with the same border are one box), **sort A to Z**, and **show paragraph
  marks** (¶).
  **Insert** — page break (⌘↩), column break and section break; a **table**
  (pick its size from a grid); **link** (⌘⇧K: an address, and the words to
  show when nothing is selected), picture, quote, code block, divider;
  **footnote**, **endnote** and a **table of contents**; a **symbol**
  palette, and today's date. **Layout** — margins (Normal, Narrow, Moderate,
  Wide, or custom), paper and orientation, columns, **sections**,
  hyphenation, line numbers, headers and footers. A **Table** tab appears
  while the caret is in a table, and a **Picture** tab while a picture is
  selected. **Review** — Editing, Suggesting or Viewing, the suggested
  changes (next, previous, accept, reject), comments, history, compare,
  find, read aloud, preview and print. Groups that don't fit the window
  fold into a ⋯ menu; on a phone the ribbon is one row that scrolls, and its
  menus open as sheets. While the phone's keyboard is up for the text, the
  row sits on the keyboard, under your thumbs — and goes back to the top
  when you type somewhere else (the title, a comment, a search). The
  scripted formats keep their own toolbars (which ride on the keyboard the
  same way) and professional layouts.
- **Styles** (Document format): Normal, No Spacing, Title, Subtitle,
  Heading 1–6, Quote and Caption, each shown in its own look — and styles
  of your own. *Modify…* changes what a style looks like everywhere it's
  used (font, size, colour, alignment, spacing, indents); *Update to match
  selection* makes the style look like the paragraph you formatted by hand;
  *New style from selection* names that look. Styles are saved in the
  document, so collaborators, the PDF and the Word file all have them.
  Normal is the document's body text (Document tab of the inspector). After
  a title, subtitle or caption, Enter goes back to body text.
- **Format painter**: click it, then select other text — it takes the
  formatting of the words you were on (and whole paragraphs take the
  paragraph's alignment, spacing and indents too). Escape puts it down.
- **Pasting from Word, Google Docs and the web** (Document format) keeps
  bold, italics, colours, highlights, sub/superscripts and lists — Word's
  typed-out bullets become real lists — and takes on this document's body
  font and size, so a paste doesn't arrive in Calibri 11. Text that differed
  from its surroundings (a larger line, another typeface) keeps the
  difference. ⌘⇧V still pastes plain text.
- **Tables** (Document format): Insert ▸ Table, then type; Tab moves to the
  next cell and adds a row after the last. The Table tab adds and deletes
  rows and columns, merges and splits cells, marks a **header row** (set
  again at the top of each page the table runs onto), chooses which lines
  are drawn (all, between rows, a box, none) and shades cells. Drag a
  column's right edge to resize it, or use *Narrower*/*Wider* (on a touch
  screen); *Even widths* shares the page out equally. A table from Word, a
  spreadsheet or a web page pastes as a table. On a phone a wide table
  scrolls sideways in its own strip. On paper a table breaks between rows,
  and a row taller than a page between its lines.
- **Footnotes and endnotes** (Document format): Insert ▸ Footnote puts a
  numbered reference where the caret is and opens the note under it to
  write in (bold, italic and underline work; Enter or Esc goes back to the
  text). Notes are numbered by themselves — 1, 2, 3 for footnotes, i, ii,
  iii for endnotes — and renumber as you move text about. A note travels
  with its sentence when you cut and paste, and several people can write in
  one at once. In preview, print and PDF a footnote sits at the foot of the
  page that cites it (running over to the next page if it must) and
  endnotes close the document; clicking a reference in the PDF goes to its
  note. A note's words aren't counted in the word count.
- **Table of contents** (Document format): Insert ▸ Contents lists the
  document's headings and keeps itself up to date; click an entry to go to
  it. On paper each entry has its page number and a row of dots, and in the
  PDF each is a link.
- **Sections** (Document format): Layout ▸ Section starts a new section at
  the paragraph the caret is in. A section begins on a new page and can
  have its own paper, orientation, margins, number of columns, and page
  numbering that starts again; what it doesn't set is as the document. A
  landscape page in the middle of a portrait document is a section. A
  **column break** (Insert ▸ breaks) sends what follows to the top of the
  next column.
- **Pictures** (Document format): drag a corner handle to resize — the
  proportions are kept. The Picture tab sets one at the left, in the middle
  or at the right, and gives it a **caption**, which stays under it on the
  page.
- **Document inspector** (the sliders button, Document format): settings
  saved *in* the document, so collaborators see the same layout. Text tab:
  the selection's font and size (any size), alignment, line spacing (a
  multiple, or *exactly* / *at least* so many points), space before and
  after, **indents** (left, right, first line or hanging), **keep with
  next**, **keep lines together**, start on a new page, plus a **drop cap**
  for chapter openers. Document tab — the page setup: **paper** (US Letter, Legal,
  Tabloid, Executive, Half Letter, US Trade 6×9, A3, A4, A5, B5, or a custom
  size) and orientation; **margins**, a binding **gutter** and **facing
  pages** (mirrored margins); one to three **columns**; **headers and
  footers** with a left, centre and right slot each and live fields (page
  number, page count, title, author, date), optionally different on the
  first page and on even pages; **page numbers** in 1/i/I/a/A style from any
  starting number; body-text defaults (font, size, line spacing, paragraph
  spacing, first-line indent — indent + 0 pt spacing gives the classic book
  look); hyphenation and line numbers.
- **Preview** (the eye button; every format): every page exactly
  as it will print — the same layout the PDF and the printer get. A
  screenplay, a stage play and a poem preview on their format's own page. Docked
  beside the text on a wide window, it follows your typing and shows *Page
  3 of 12*; click any line for **Edit here**.
- **Print** (⌘P, or Export ▸ Print…): the document is typeset to a PDF and
  handed to the system's print panel — on a Mac the native one, on an iPhone
  the system print sheet, in a browser or on Windows the browser's own.
  Where that isn't possible it opens as a PDF you can print from. "As a
  booklet" imposes the pages for folding.
- **Screenplay, stage play and poetry pages**: their PDFs, printouts and
  previews are typeset by the same engine as a Document's, on the format's
  own page — a screenplay in twelve-point Courier, six lines to the inch,
  with scene headings, action, character names, parentheticals, dialogue
  and transitions at their standard measures and the page number at the
  top right from page two; a stage play likewise, opening with its title;
  a poem in a book face with long lines turned over and set in, its title
  at the top. Any alphabet prints (the old typewriter pages turned
  everything but Latin into question marks), a character's name is never
  left at the foot of a page without the speech, and bold, italic and
  underline are kept.
- **PDF** (Document format): typeset in real typefaces with proper line
  breaking — mixed fonts and sizes, bold and italic, underline and
  strikethrough, lists, quotes, code, pictures, links you can click, page
  breaks, an outline of your headings, headers, footers and page numbers,
  with no line left alone at the top or foot of a page and headings kept
  with their text. Every font prints as itself where it can (see **Fonts**);
  where it can't, the export says what stood in.
- **Fonts** (Document format): the font button opens one list of everything
  you can set a paragraph (or the whole body) in, each drawn in itself and
  searched together — the fonts **in this document**, your **recent** ones,
  those **with the app**, the fonts **on this computer** (desktop), and an
  **online library** of nearly 2,000 open-licensed families (the Google
  Fonts collection), filtered by kind: serif, sans, mono, display, script.
  A library font downloads the first time a document uses it and is kept
  on the device; other scripts of a family (Cyrillic, Greek, Vietnamese…)
  download only if your text has them. The same font files draw the editor,
  the preview, the PDF and the printout, so they agree. Installed fonts are
  embedded in a PDF only when the font's own licence setting allows it, and
  are never uploaded. When a document names a font this device doesn't have
  — a collaborator's, or one from a Word file — it's shown and printed in
  the closest stand-in: a same-metrics family where one exists (Gelasio for
  Georgia, Tinos for Times New Roman, Arimo for Arial, Carlito for Calibri),
  so lines and pages fall the same; a line under the ribbon says so and
  offers **Replace…**. Settings ▸ Fonts has the switch for the online
  library, the downloaded fonts (and a way to remove them), and the
  licences.
- **Word (.docx)** in and out (fonts included: a Word file's fonts are
  matched to the app's own, to those installed here, then to the online
  library, and otherwise kept by name; exports carry real family names and
  tell Word what to fall back to): headings 1–6, real nested and numbered
  lists (bullet styles, legal numbering and checklists included),
  bold/italic/underline/strikethrough, text colour, highlight,
  sub/superscript and a font or size on part of a paragraph, links,
  pictures with their sizes, alignment, spacing, indents, line-height
  rules, borders and shading, keep-with-next, quotes, code, dividers, page
  breaks and drop caps; **tables** (widths, merged cells, header row,
  shading), **footnotes and endnotes**, a **table of contents** (a real
  field Word can update), picture placement and captions, **sections** and
  column breaks — plus **styles** (a Word file's Title, headings and
  the writer's own styles come in as the document's styles, looking as they
  did; yours go out as real Word styles) and the page setup, headers,
  footers and page numbers. What Word shows is what the document says, and a file written by
  subScribe reads back the same.
- **Page view** (Document and the scripted formats): the page toggle shows
  the sheet as its printed pages — gaps between them, page numbers on the
  left, the count in the word-count bar. The pages are the printed ones: the
  text breaks where the PDF's pages do, in the middle of a paragraph or
  between the rows of a table, a moment after you stop typing, and the
  count is the PDF's. Lines within a page are still the screen's own, so a
  page on screen is as tall as its text needs (never shorter than the
  paper); Preview shows the page line for line. Settings ▸ Writing has a
  switch back to the simpler view that only moves whole paragraphs.
- **Outline**: parts, chapters and sections with their labels and word
  counts; drag to reorder chapters (or use Reorder on a phone) — one undo
  puts them back.
- **Organizer**: cards show each document's opening words (or, when
  searching, the passage that matched) and "Manuscript · 98,412 words ·
  Oct 3". Sort by modified, created or name (in natural order: Chapter 2
  before Chapter 10) — remembered on this device. Every ⋯ menu works from the
  keyboard (Shift+F10 too): Rename, Duplicate, Move, Share, Version history,
  Delete.
- **Recently Deleted**: deleting is undoable — the toast has **Undo**, and
  deleted documents (from the server and from this device) wait in Recently
  Deleted for 30 days, with their history, before they're gone for good.
- **Combine into one manuscript**: select documents (⌘/Ctrl-click,
  Shift-click, or Select on a phone) or use a folder's menu — put them in
  order, name the book, and each becomes a chapter. The originals stay.
- **Folders**: organize your documents; move documents between folders,
  rename or delete a folder (its documents stay put). Documents on this
  device have folders of their own, kept on the device — **New folder**
  asks where when there's a choice, and a folder's card says *on this
  device*. New documents, imports and combined manuscripts made with such a
  folder open land in it, and a document restored from Recently Deleted
  goes back to the folder it was in.
- **Search**: full-text — matches titles and the words of every document
  (never the editor's internal markup), with the matching passage shown.
  Documents on this device are searched the same way, with or without a
  server: the first search after an update reads the documents once, and
  after that it's instant.
- **Suggested changes** (track changes): switch to **Suggesting** and what
  you type, delete or paste is proposed instead of done — additions
  underlined in your colour, deletions struck through, a new or removed
  paragraph break marked with a ¶, a table, picture, divider or footnote
  outlined. Each says who and when. Anyone who can edit accepts or rejects
  them one at a time or all at once, from the Review tab or from the
  **Changes** list beside the comments (where a change can also be
  commented on); taking back your own suggestion just removes it. The mode
  is yours alone — one person can suggest while another edits — and
  **Viewing** shows the text as it would read with everything accepted,
  locked. Formatting isn't tracked: bold, styles, lists and a table's rows
  and columns change directly. Printing, PDFs, books and the word count
  use the text with suggestions accepted. Suggested changes travel to and
  from Word as its tracked changes; *Export Word, clean copy* leaves them
  out. Works in every format (the mode switch is in the Changes list; a
  Document also has it on its ribbon). Like the other newer formatting it
  needs an up-to-date server; where the server is older, Suggesting isn't
  offered.
- **Read aloud**: the text spoken by your system's voice, a sentence at a
  time, the sentence highlighted as it's read — from the caret, with pause,
  back and on a sentence, speed and a choice of voice. Nothing is sent
  anywhere. Struck (suggested-deleted) words and footnotes aren't read.
- **Compare**: any saved version beside the text as it is now, or the
  document beside a Word file — paragraphs aligned, what was taken out
  marked on one side and what was put in on the other, word by word; on a
  phone both in one column. Jump between differences, show only what
  changed or the whole text, swap the sides.
- **Feedback threads**: select text and leave a comment anchored to it;
  threads track the text even as it moves, resolve/reopen, reply inline,
  and list in the order they appear in the text. Click a highlighted
  passage to open its thread. The highlighter button in the panel header
  shows or hides the anchor highlights — and on-device documents have the
  same panel as **Notes**: comments to your future editing self.
- **Import**: PDF, DOCX, RTF, Pages, TXT, and Markdown files convert into
  new documents — several at once, into the folder you have open. PDF import
  recovers structure, not just text. Word import keeps headings, lists,
  links, pictures, fonts, spacing and the page setup (see above), and says
  what it couldn't keep yet — text boxes arrive as their text, a section
  break that doesn't start a page is left out. Word's tracked changes come
  in as suggested changes, under the names Word has for them. A Word
  *manuscript* arrives as a Manuscript with its chapters detected.
- **Booklet export** (Document and scripted formats): beside the straight PDF,
  "Export booklet PDF" imposes pages for saddle stitching — two per
  landscape sheet in fold order. Print two-sided flipping on the short edge,
  fold the stack in half, and it reads 1…N.
- **Saving files**: on a Mac or PC every export opens a Save dialog (the
  toast after offers *Show in Finder*); on iPhone and iPad exports land in
  Files ▸ On My iPhone ▸ subScribe, with a Share… button; in the browser
  they download.
- **Export all**: back up every document you can see — server documents and
  the ones on this device — as Markdown + JSON. Your writing is never locked
  in.
- **Sharing**: private by default; the owner grants read or write access to
  individual friends or to a whole group (which also posts a card in that
  group's chat) or shares an entire folder at once.
- **Canvas references**: send a whole document or just a selection to a
  canvas board as a live-updating excerpt card.
- **Documents on this device**: the "On this device" section holds
  single-user documents stored on your computer, never on the server — same
  editor, formats, outline, find, word count, version history, book
  preview and exports. Their revisions are kept on this device too, beside
  the document, so history works with no server and no connection.
  **Publish to a server…** (a document's ⋯ menu, or the share button in its
  header) publishes a copy, optionally shared with a friend or group in
  one step; the local original stays yours and does not live-sync to the
  published copy. If you aren't connected it opens the connect sheet first
  and carries on once you are. Without a server, **Import** creates
  documents here too.
  The reverse works as well: any server document's menu → **Save a copy to
  this device**. Pictures work here as they do on a server: they're kept
  beside the document on this device, travel with it to Recently Deleted
  and back, are embedded in its PDF and Word exports, and are uploaded with
  it when you publish.

## Chat

Groups work like small Discord servers: channels, invites, roles.

- **Invites two ways**: admins generate expiring invite codes, or set a
  permanent **join code** (gear next to the group name) — a memorable code
  like `writers-club` that works in the normal join box until an admin
  clears it.

- **Markdown**: `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``,
  fenced ``` blocks, links.
- **@mentions and #channel references**: `@username` pings and highlights;
  `#channel` links and jumps.
- **Read state that follows you**: what you've read syncs through the
  server, so unread counts agree across your devices. Opening a channel
  lands on a "New messages" divider where you left off, and messages are
  grouped under day separators (Today, Yesterday, …).
- **Typing indicators**: a quiet "…is typing" line above the composer, in
  channels and DMs.
- **Search**: the magnifier in the channel header searches every channel in
  the group — full text. Click a hit and you land on that message in
  context, highlighted.
- **Pinned messages**: pin from a message's hover actions (your own, or any
  as an admin); the pin in the header counts them, lists them, and jumps.
- **Reactions** can use the group's custom emotes as well as emoji.
- **Mute a channel**: the bell on a channel row (or a right-click) silences
  its notifications and badges on this device; unread shows as a quiet dot.
- **Custom emotes** per group (admins add them via the emote picker) —
  type `:name:` anywhere.
- **Uploads**: attach, paste, or drag & drop images.
- **Presence**: online / busy / invisible, shown next to every name.
- **Profile cards**: click anyone's name or avatar for their bio, accent
  color, and status — with a **Message** button for friends (straight into
  your conversation) and **Add friend** / **Accept friend request** for
  everyone else.
- **Moderation**: authors and group admins can delete messages; admins can
  kick members, rename and delete channels, and delete the whole group
  (gear next to the group name → Delete group — erases its channels,
  messages, sessions, boards, and emotes for every member, irreversibly).
- **Slash commands**: type `/` to see commands contributed by plugins.

## Voice & video

Voice channels sit under a group's text channels. Media is a direct
peer-to-peer mesh between members (DTLS-SRTP); the server only relays
connection setup. Mute, speaking indicators, and a persistent voice bar in
the status bar — the call follows you around the app.

Turn on your **camera** or **share your screen** from the voice bar. Video
appears in a floating panel you can drag, resize, and keep open while you
work in Canvas or Documents; click a tile to enlarge it. Peers' tiles show
mute and screen-share badges. Screen sharing is available on Windows and
Linux; macOS can watch shares but not send them (its webview has no screen
capture), and camera video works everywhere.

Settings → Voice lets you pick input devices, adjust input gain and output
volume, test your mic and camera, and choose video quality (360p default —
the mesh sends a copy to every peer, so higher quality multiplies upload
bandwidth).

## Canvas

Shared storyboards per group: sticky notes, text, **shapes** (rectangle,
ellipse, diamond, triangle, star, heart — with centered labels and
colorable outlines, hollow or filled),
colored frames, connectors, pasted or **dropped images** (drag a file onto
the board and it lands under the cursor; croppable from any edge, with
rotate/flip), **link cards** with server-fetched previews, and live
**document references** (a whole document or a selection, kept in sync as
it's edited). Multi-select with shift-click or shift-drag; moving a frame
moves what's inside it; note, frame and shape fills are translucent, so
overlapping them layers the color instead of hiding what's underneath — and
a selected note has an opacity slider of its own;
snap-to-grid toggle, and holding shift while
dragging a resize handle keeps the element's proportions; per-element text
formatting
(bold/italic/underline, size, alignment, bullets, four typefaces, text
colors); connectors run straight, at right angles or as a smooth curve, with per-side
anchors, line weight and color, dashed styles, arrow/dot ends, and a label
that rides the middle of the line. Selecting several elements offers a text
color for all of them at once. Everything syncs live.

**Lining things up**: drag an element near a neighbor and **smart guides**
appear — accent lines when edges or centers align, with a gentle snap
(they outrank the dot grid on the axis they match). A multi-selection's
toolbar has an **align & distribute** menu (left/center/right, top/middle/
bottom, even out the gaps). **⌘G groups** a selection so it selects and
moves as one — click again to pick a single element out of the group,
⌘⇧G ungroups, and copies of a group stay grouped on their own.

**Pages**: a board is a stack of pages, listed above the canvas. Add one with
the plus, double-click a tab to rename it, right-click for rename and delete
(deleting takes its contents with it, and undo brings both back). Each page
is its own space — what you draw, select, or fit to screen belongs to the
page you're on. Peers' live cursors appear only on the page you share with
them; a dot on a page tab (their accent color, or a count) shows someone is
working over there.

**Linking as you go**: select an element and four arrows appear around it.
Click one and you get a new element on that side, already connected and ready
to type into — the quickest way to grow a diagram outward.

**Sketches**: the pencil in the toolbar opens a pad you can draw on with a
mouse, trackpad, finger or stylus — pick an ink color and nib, switch to the
eraser to rub out strokes you've drawn, undo a stroke at a time, then insert
it onto the board. Sketches stay editable: double-click
one (or use the pencil on its toolbar) to reopen the pad and keep drawing.
They're stored as strokes rather than as a picture, so they stay sharp at any
zoom, resize cleanly, and work on a board with no server behind it. One
person draws at a time: while someone has a sketch open, others trying to
edit it are told who's in there instead of silently overwriting each other.

**Copy and paste**: ⌘/Ctrl-C, X, V and D copy, cut, paste and duplicate the
selection, and ⌘/Ctrl-A selects everything on the board. A connector with
both ends in the selection comes along and is re-pointed at the copies, so
a pasted diagram stays wired the way you drew it. Copies go
through the system clipboard, so they can be pasted into another board.

**Right-click** anything on the board for bring to front and send to back,
cut, copy, paste and duplicate, lock (a locked element still selects, so you
can unlock it, but won't move or resize), round corners, and delete —
everything applies to the whole selection. Right-clicking the board itself
offers paste, select all, and fit to screen. Selecting one element also puts
a **corner-radius handle** inside its top-left corner, opposite the scale
handle: drag it away from the corner to round it off, back toward the corner
to square it up.

**Getting around**: press **F** to frame the current selection — the view
centers on it and zooms to fit — or, with nothing selected, to fit the whole
board on screen.

**Find and replace**: ⌘/Ctrl-F (or the search button in the board header)
opens a bar that searches every note, text block, shape label and frame
name. Enter and Shift-Enter step through the matches in reading order,
selecting and centering each one, and you can replace the current match or
all of them at once — a Replace All is a single undo step. Link cards,
images, and document cards aren't searched: their text holds a URL, an
attachment, or a document reference rather than prose.

**Background**: the palette button in the board header dresses the page
you're on — a background color, or an image you upload (filled, fitted,
stretched, tiled, or centered) — and can turn the dot grid off. Each page
keeps its own, everyone in the group sees it, and undo covers it like any
other change.

**Export & import boards**: the download button in a board's header saves it
as a `.wfboard` file — the board's pages, elements, connectors and pictures,
self-contained. Import one from the board list into a group or onto this
device; the round trip is lossless, which also makes it the way to move
boards between servers. The board
list also imports **FigJam and Freeform PDF exports** (desktop app only):
since a PDF stores drawings rather than board structure, the import
reconstructs it — pictures become image elements, small text cards become
notes, larger cards become tinted frames holding their photos and text where
they were laid out, and each imported page keeps the export's white paper so
its black text reads as it did — editable, but approximate; card colors map
to the board palette, and freehand ink and decorations don't survive.

**Boards on this device**: the canvas list has an "On this device" section
for boards stored on your computer, never on the server — the same tools,
the same board, kept in a file beside your local documents. They need no
group and no connection, so they work in offline mode — pictures included:
paste one and it's stored beside the board on your computer, background
images too. The trade is that nobody else can see the board, there are no
live cursors, and document cards (which point at server documents) stay on
group boards. **Publish to a server…** (the share button in the board's
header, or the board's ⋯ menu in the list) puts a copy — pictures included —
in a group you choose; the board on this device stays, and later changes to
it don't follow. Not connected, it opens the connect sheet first. The
search field above the list finds boards by name and, for boards on this
device, by the words on their notes, text, shapes and frames.

## Notes

A local, Obsidian-compatible markdown vault with `[[wiki-links]]` and
backlinks. Share a note snapshot to a friend over DM; they can save it into
their own vault.

## Getting around

- **⌘K** (Ctrl+K) is the quick switcher: type a few letters and jump to any
  channel, group, document, board, note, or conversation — or run a
  command.
- **⌘/** shows a keyboard-shortcut cheat sheet.
- The desktop window remembers its size and position between launches, and
  unread counts appear on the app's dock icon (macOS/Linux) — the installed
  web app badges its icon too.
- The desktop app quietly checks for updates a few seconds after launch and
  mentions a waiting one; Settings → Application shows the release notes
  before you install.

## Notifications

Native OS notifications for direct messages, @mentions, new writing
sessions, shared documents and notes, and friend requests — delivered only
when you're not already looking at the relevant conversation.

## Customization

- **Profile**: avatar, banner image, accent color, bio, and status
  (Settings → Profile). Your accent tints your name in chat and fills the
  profile-card banner when no banner image is set.
- **Portable profile**: save your look (display name, colors, bio, avatar,
  banner) on your computer and apply it to any server you join — profiles
  are otherwise per-server. It's offered once when you register on a new
  server and available any time from Settings → Profile; it is never
  applied without asking. Usernames are per-server and aren't included.
  It is also who you are when no server is connected: Settings → Profile
  then edits it directly — name, accent, about, and a picture and banner
  chosen from this device (a large photo is scaled down first).
- **Groups**: admins set a group icon and accent color (gear next to the
  group name). The active group's accent shows as a stripe on the app rail,
  and Canvas and Sessions show a chip naming the group you're working in —
  share and send-to-canvas pickers preselect it too.

## In the browser

Servers can serve the app at `/` — open the server's address in any
browser (phones included) for chat, documents, canvas, sessions, and
voice in a responsive layout. Use your browser's **Add to Home Screen** to install it — it opens full-screen with its own icon, like a native app. Desktop-only features stay on the desktop:
the notes vault, on-device documents and boards, the portable profile,
hosting, and plugins.

## On iPhone and iPad

subScribe also builds as a native iOS app (the same codebase through
Tauri). Beyond the responsive layout the web client already has, the
native app adds what a browser can't:

- **Real notifications** through iOS, with permission asked the first
  time something wants your attention.
- **Haptics**: a tap when a message sends, a success thump when you
  accept a friend request, a warning buzz when a sketch is locked by
  someone else drawing on it.
- **Voice keeps going** when you lock the phone or switch apps, like a
  calls app.
- **Liquid-glass chrome**: menus, toolbars, dialogs, and the phone's
  slide-over panels are translucent materials that blur the content
  moving beneath them.
- The keyboard pushes the composer up instead of covering it, the app
  never rubber-bands off its edges, and launch fades straight into the
  app's own dark background.

Building it needs a Mac with Xcode: `npm run tauri ios dev` from
`apps/desktop` (the repo README's iOS section covers signing).

## Working on this device

You don't need a server to write, and there is no "offline mode" to enter:
the app opens straight into **Home**, with everything that lives on your
device —

- **Start something**: a document (any format), a board, a note, or import
  a Word, PDF, Pages, RTF, Markdown or text file.
- **Jump back in**: the documents, boards and notes you last changed,
  newest first — from this device and, while connected, from the server.
- **Write with others**: the servers you know, each a click away, and the
  two ways to add one — join, or host on this computer.

Documents (with their history, pictures, exports and book publishing),
boards and notes all work with no account and no connection. The first time
you open the app it asks what to call you; that name goes on what you
export — and on the boards you make here — and stays on this device unless
you copy your profile to a server. Settings → Profile adds a picture (shown
at the foot of the rail), an accent colour and a few words about you.

**Servers are accounts you add.** Chat, Sessions and Friends stay in the
rail and say what they need when there's no server. The button at the foot
of the rail is you: the servers you've joined (the one you're on, and the
ones a click away), **Join a server…**, **Host on this computer…**,
**Disconnect** (leave, but stay signed in — coming back needs no password)
and **Sign out** (forget this device's session). Joining or hosting opens
in a sheet over whatever you have open: your document, board or note stays
exactly where it is, whether you connect or change your mind.

If a server you were signed in to doesn't answer at launch, the app is
already open; the status bar says *Can't reach …* with **Try again**. If
your session there has ended, it says so and offers **Sign in**. Nothing on
this device is affected either way.

**Kept safe.** Documents, boards and notes on this device are saved
atomically (a crash or a full disk mid-save can't leave half a file).
Deleting a document, a board or a note moves it to Recently Deleted for 30
days, with **Undo** on the spot. **Export everything on this device** (at
the foot of Home) writes one zip: every document as Word and as lossless
JSON (in its folder, if it's in one), every board with its pictures, your
notes as the Markdown files they are, and your profile.

In the browser client there is no device storage, so there the server
comes first: it opens on the sign-in page.

## Staying signed in

**Remember me** (checked by default on the login form) keeps your session
on the device — relaunching the app signs you straight back in. Sessions
last 30 days from their last use on the server side; if one does expire,
the app says so and reopens that server's login with your username filled
in, instead of silently dumping you at the start. Unchecking it keeps the
session for that run only. Logging out always forgets the stored session.

## Account recovery

Locked out? A server admin can issue a one-time reset code for your account
(Settings → Admin) — hand it to you out of band and you set a new password
from the sign-in form. Using a code revokes every existing session for
that account.
