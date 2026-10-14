# Features

## Writing sessions

A session lives in a group channel and holds **multiple prompts**. Anyone in
the group can create a session. Each prompt can be started, timed
(10 seconds to 24 hours), and stopped early by its creator or a group admin.

- While a prompt runs you write on **a page of paper** in the type a
  document is written in. Your writing stays private until the prompt ends.
- **A bar stays in sight** above the page as you scroll. It holds the clock,
  your word count, your pace in words a minute and whether your words are
  saved, with the tools under it: bold, italic, underline, quote, lists,
  divider, undo and redo. Headings, strikethrough and pictures are under
  **More**. On a phone the tools sit on the keyboard.
- **Only the prompt and the page**: the arrows button at the end of the bar
  fills the window with the prompt and your page and nothing else. Escape
  goes back. The prompt can be put away there too.
- Quotes, apostrophes, dashes and ellipses are a typographer's as you type
  them, as in a document. The switch for that is in Settings ▸ Writing.
- **Your words are kept safe at the bell.** Writing is saved a moment after
  you pause, sooner in the last twenty seconds, and once more just before
  time is up. A save that does not get through is said in the bar and sent
  again. A copy is also kept on this device the whole time. If the app
  closes mid-sprint, the page comes back as you left it. If your last words
  did not reach the server before time ran out, the session says so and
  lets you copy them or save them as a document. The others cannot see
  words the server never got.
- A line under the page says **who else is writing** right now.
- When a prompt ends everyone's writing is shown, your own piece first, each
  on its own page with its word count. A prompt that ended a while ago stays
  folded so a long session is not an endless page.
- **Copy** takes any piece as plain text. **Save as a document** turns your
  own piece into a Document of yours (on this device in the apps, on the
  server in a browser), where everything else in the app works on it.
- The prompt editor has the full formatting toolbar (headings, lists,
  quotes, inline code, pictures) and a choice of timer lengths.
- A **join card** is posted to the channel when a session is created, so
  members can jump in from chat.
- Ended sessions stay browsable forever. The creator or an admin can also
  delete a session permanently.

## Documents

Documents are for Google-Docs-style collaborative writing and are separate
from timed sessions. They are also a book-production tool: write a
manuscript, design the book, export a print-ready paperback, an ebook and a
submission manuscript.

- **Live multi-user editing**: a CRDT (Yjs) syncs everyone's edits and shows
  live cursors. There is no lock, no conflict and no "someone else is
  editing" wall.
- **Your text is never lost**: edits that can't reach the server yet (offline,
  a dropped connection, quitting mid-sync) are kept on this device and sent
  when the server is back. They're never sent to the wrong server or the
  wrong document. The save indicator says *Saved*, *Saving…*, *Offline* or
  *Not saved* (with what to do about it), and closing, signing out or quitting
  waits a moment for unsent edits. On-device documents save atomically, so a
  crash mid-save can't damage the file.
- **Writing formats**: None, Screenplay, Stage Play, Manuscript, or Poetry.
  Each format adds its own element types (scene heading, character,
  dialogue, …) with correct margins and Final-Draft-style Tab/Enter cycling
  between them.
- **Manuscript is the book format**: elements for Chapter Heading, Part
  Heading, Unnumbered Chapter (Prologue, Epilogue, Acknowledgments…),
  Chapter Subtitle, Subheading, Epigraph, Attribution, Verse and Body
  (⌘1–9 set them). Chapters number themselves ("Chapter Three" labels show
  beside each heading). Scene breaks are `* * *` + Enter or the toolbar
  button. A page break (⌘↩ / Ctrl+Enter, or the toolbar's page-break button)
  starts what follows on a new page (a letter, a poem, an interlude on a
  page of its own) in the print PDF, the ebook and the submission manuscript
  alike. Chapters start on a new page by themselves. You write meaning
  rather than layout: indents, fonts and spacing come from the book's
  design, so editing the text can't break the book. In Manuscript, Tab only
  changes an *empty* line's element (it never turns a sentence into a
  heading), and pasted headings and `***` lines become chapters and scene
  breaks.
- **Smart quotes and dashes** as you type (Settings ▸ Writing to turn off):
  curly quotes in the style of the text's language, `--` becomes an em
  dash, and `...` becomes an ellipsis (…). The text's language is the
  book's for a Manuscript. For any other document it is the language set
  in its Details, and this device's language when none is set.
- **AutoCorrect** (Settings ▸ Writing, "Correct as I type"): when a word
  is finished with a space or Enter, a slip is set right (teh, recieve,
  dont), a sentence gets its capital, TWo capitals and a wORD typed with
  the caps lock on are mended, and (c), 1/2 and 1st become ©, ½ and 1st
  with its letters raised. One Undo, or Backspace straight after, takes
  back the correction and leaves what you typed. Each kind has its own
  switch, and **Your corrections…** lists every entry, lets you add your
  own and take any out, and holds your exceptions.
    - It is careful. A word is only changed once you have left it. A slip
      that is part of an address or a file's name is left. A capital in
      the middle of a sentence is taken for a name and left as spelled.
      Nothing is changed in code, and while you are suggesting only your
      own suggested words are touched.
    - The built-in words are English and apply to English text (with
      "licence" and "organisation" where the document's English is
      British). Signs and your own entries apply in every language.
    - A script's lines of capitals, and verse, get no capital of
      AutoCorrect's. On a phone, the list and the capitals start switched
      off, since the phone's keyboard already does both.
    - The English list comes from LibreOffice's (see the notices), with
      every entry left out whose "slip" is a real word.
- **Bold, italic and underline reach the whole word** when the caret is
  inside one and nothing is selected. At a word's edge or in a space they
  set what you type next, as before.
- **Lists start as you type them** in a Document: `1. `, `1) `, `a. `,
  `A. `, `i. ` or `I. ` at the start of an empty paragraph begins a
  numbered list of that kind, and `* ` or `- ` a bulleted one. Start at
  `c. ` or `3) ` and the list starts there. A label typed under a list
  that it continues joins that list.
- **Spaces and hyphens that hold a line together**: a no-break space
  (Ctrl+Shift+Space, or Option+Space on a Mac) keeps two words on one
  line, a no-break hyphen (Ctrl or ⌘ with Shift and the hyphen key) is
  never broken at, and an optional hyphen (Ctrl or ⌘ with the hyphen key)
  shows only where the line breaks there. All three are also in **Insert
  ▸ Symbol**, by name. Find sees through them, Word files keep them, and
  print and PDF honour them.
- **Move a paragraph by key**: Alt+Shift+Up or Down (Ctrl+Shift with the
  arrows on a Mac) moves the paragraph the caret is in, every paragraph a
  selection touches, or a list item with all that is under it. A selected
  picture moves the same way. Each step is one undo. While you are
  suggesting, switch to Editing to move things.
- **Make it a book manuscript**: switching a Document to Manuscript (or
  Export ▸ Make it a book manuscript…) detects chapters, parts, scene breaks
  and front matter and shows what it found before converting. One undo puts
  it back. Importing a Word manuscript does the same automatically.
- **Book inspector** (the book button, Manuscript): the book's details (title,
  author, series, ISBNs, copyright, dedication, epigraph, also-by, about the
  author, submission contact) and its **design**. The design has five
  presets (Classic, Literary, Fantasy, Romance, Modern) with every choice
  adjustable: fonts, size, leading, chapter labels, drop caps, small-caps
  lead-ins, ornaments, running heads, page numbers. The body and heading
  fonts can be any of the app's seven book faces or any family of the
  **online library** (the same Google Fonts collection documents use): it
  downloads when chosen, draws the manuscript view and the preview, and is
  embedded in the paperback PDF. Other scripts of the family (Cyrillic,
  Greek…) are fetched when the text has them, and where a display face
  lacks an alphabet a title in it is set in the body face. A library family
  has no small capitals or old-style figures of its own (capitals are
  reduced instead), and one with no italic is slanted. If it can't be
  fetched (offline and never downloaded) the book is set in the nearest of
  the app's own and the export says so. Also here: **print** settings (trim
  size, KDP-safe margins that grow with the page count, right-hand chapter
  starts, front and back matter, spine width) and **ebook** settings. Saved
  in the document, so collaborators see the same book.
- **Your own scene break** (Book ▸ Design ▸ Scene breaks): one of the
  typed ornaments, characters of your own (a dagger, a cross), a picture
  of your own (blood drops, a pair of fangs) at the height you choose,
  or a blank line. The picture is drawn in the manuscript, the preview,
  the paperback and the ebook. Your own characters print when the book's
  fonts have them, and asterisks print otherwise.
- **Chapter art** (Book ▸ Design ▸ Chapter art): a picture behind each
  chapter's first page with the chapter's words printed over it, and a
  picture on the left-hand page facing it. Choose them once for every
  chapter, and under them give any chapter its own or none. **Words on a
  picture** sets the words over the art dark or light. A chapter with a
  facing picture opens on a right-hand page, with a blank page before it
  where needed. The art reaches the paper's edge when the paperback is
  exported **With bleed**. In the ebook each picture is a page of its
  own before its chapter. A picture for a single chapter needs the
  server updated to this version.
- **Book preview** (the eye button, Manuscript): every page exactly as it will
  print, with facing pages on a desk, page 1 alone on the right, chapter
  jump, zoom, and "Edit here" from any line. On a wide window it docks
  beside the manuscript and re-sets live as you write (only the chapter
  you're editing is re-set). On a phone it's one page at a time with swipes.
- **Book exports** (Export menu, Manuscript): the **Paperback PDF** is typeset
  with optimal line breaking, hyphenation, no widows or orphans, real small
  caps, drop caps, running heads and roman/arabic page numbers. Fonts are
  embedded, the trim box is set, and it is ready for KDP and IngramSpark.
  For a printer that asks for it, the paperback's dialog can make the file
  as **PDF/X-1a** (black ink only, so pictures are made grey) and **with
  bleed** (each page 0.125 in larger at the top, the bottom and the outside
  edge, with the page itself marked as the trim). The pages are set the
  same either way.
  The **Booklet PDF** is for printing and folding at home. The
  **Ebook (EPUB)** is for Kindle, Apple Books, Kobo and Google Play. With
  *Embed the book's fonts* on, the body and heading fonts' files go inside
  it (the app's own or the library's, each script its own file), so readers
  that honour a publisher's fonts show the book in them. The
  **Submission manuscript** (Standard Manuscript Format) exports as PDF or
  Word. Each shows a preflight list first (missing ISBN digits, glyphs a
  font lacks, a too-short book), each item with a "Show" button.
- **Book cover** (Book inspector ▸ Cover, Manuscript): the cover is kept
  with the manuscript. The **front cover** is the ebook's cover and goes
  into every EPUB export. For the paperback, add a **back** and a **spine**
  to go with it, or the **whole cover** in one picture as a designer sends
  it. The cover sheet is sized from the trim, the paper and the page count
  the layout engine counts, and each picture is checked for sharpness and
  shape. If the page count changes after the artwork went in, it says by
  how much the spine has moved. The sizes follow Amazon KDP's rules.
- **Cover editor** (Cover tab ▸ Open the cover editor, or Export ▸
  Paperback cover): the sheet is drawn as it prints, whole or one part at a
  time (the spine lies on its side so it can be read). Click a part to give
  it a picture or a paper colour, enlarge the picture and drag it to choose
  what shows. Add a title, a subtitle, an author, a spine line and the
  back's blurb, starting from the book's own details, and set each one's
  font, size, colour, alignment, letter and line spacing, with an optional
  band of colour behind it. Drag words into place, pull their sides to set
  the width, nudge with the arrow keys, undo and redo. The words are real
  text set by the book's own typesetting engine, so the screen, the
  **paperback cover PDF** and the ebook's cover agree. The editor also
  saves a **template** at the exact size with the printer's guides (what is
  trimmed off, the margin to keep clear, the spine, the barcode) for
  artwork made elsewhere.
- **Fonts and commercial use**: every font that comes with the app and
  every family in the online library is under the SIL Open Font License,
  Apache 2.0 or the Ubuntu Font Licence. Each allows commercial use, so a
  book set in them can be sold and the fonts embedded in its PDF or ebook.
  A book's design and its cover offer only these. Documents can also use
  the fonts installed on your device. Those carry their makers' own
  licences, which the app can't read, and the font list says so.
- **Version history**: revisions are recorded at the seams of the work. A
  pause of half a minute closes one off, and a long unbroken stretch is cut
  on its own after five minutes. There are also named drafts you save
  yourself. Any revision can be previewed (in the document's own format, or
  as changes against the revision before it) and restored. Restoring saves
  a "Before restoring" version first and keeps comments on untouched
  paragraphs.
- **Find and replace** (⌘F, ⌥⌘F / Ctrl+H): finds phrases even across italics,
  curly and straight quotes match each other, and match case and whole words
  are a click away. ⌘G / F3 step through matches. Replace keeps the
  formatting and Replace All is a single undo. Opening it never moves your
  cursor until you step to a match. Footnotes and endnotes are
  searched too. A match inside a note marks the note's number, the count
  says "in a note", and Replace changes the note's words like any others.
- **Go to** (click the page count, or ⌥⌘G / Ctrl+Alt+G): type a page
  number, `+2` or `-1` for pages from here, or some words of a heading.
  The pages are the printed ones. A book's manuscript goes by headings.
- **Back to where you last wrote** (Shift+F5): the caret returns to the
  last place you changed the text. Press again for the place before, up
  to four. What other people change makes no place of yours.
- **Select more** (F8, or ⌥⌘↑ on a Mac): the word at the caret, then its
  sentence, then its paragraph, then everything. Shift+F8 (⌥⌘↓) goes back
  a step.
- **Formatting marks** (Home ▸ More paragraph formatting ▸ Show ¶) now
  show a dot for each space, an arrow for a tab, a ring for a no-break
  space, a bent arrow where a line is broken by hand and a hook at an
  optional hyphen, beside the mark at each paragraph's end. They are
  drawn over the text and are never part of it.
- **Dark paper** (the zoom menu, or Settings ▸ Writing): the page dark
  with light text, for the screen only. Coloured text is made lighter
  where it could not otherwise be read. Print, PDF and Word files are
  unchanged.
- **Formatting here** (the top of the sliders panel's Text tab, or ⌘K
  "formatting here"): the style of the text at the caret, what its
  paragraph was given on top of that, and what the words themselves were
  given, each with a **Clear** of its own.
- **Move a section from the outline**: in a Document the outline's
  **Reorder** moves a heading with everything under it, up or down past
  its neighbours, and takes it up or down a level with the headings
  beneath it. Drag a heading to do the same by hand.
- **Show only this chapter** (the button at the end of a row in the
  outline, or ⌘K): the page shows one chapter, from its heading to the
  next. It is the same document, with the rest hidden and not taken
  out, so co-writers and exports see the whole text. A bar over the page
  names the chapter and steps to the one before or after. The caret
  keeps to the chapter, Select All selects it, Find looks only in it and
  the word count is its own. Going somewhere else from outside the text
  (Go to, the outline, a comment, the Check panel) shows the chapter
  that place is in. **Show everything** brings the whole text back. In a
  Document it shows a heading's section, in a screenplay an act.
- **Page count** beside the word count: in a manuscript, the pages of
  the paperback as it is typeset with its front matter, the same count
  as the preview. Elsewhere it is the pages of the sheet you write on.
- **Spellcheck** underlines as you type and uses the dictionary of the
  text's language, so a document set to German is checked as German on a
  device that speaks English.
- **Zoom** the page you are writing on, from 50% to 300%. The figure
  beside the word count opens the sizes, with **Page width** and **Whole
  page** to fit the window. Ctrl or ⌘ with the wheel and a pinch on a
  trackpad change it too. The choice is this device's and holds for every
  document. Zooming moves no line of text: the page is laid out once and
  drawn larger or smaller. The print preview has a zoom of its own. Phones
  have none, since the page already fits the screen there.
- **Focus mode** (the target button, Esc leaves): the app chrome steps
  away and it's just you and the page. Optional **typewriter scrolling**
  keeps the line you're writing vertically centred.
- **Reopen where you left off**: each document remembers its cursor and
  scroll position on this device.
- **Word count**: on every screen, including phones. With text selected it
  reads "120 of 12,345 words". Click it to set a **word-count goal**.
  Progress rides under the count as a thin bar, per document, on this device.
- **The ribbon** (Document format): four Word-style tabs of controls.
  **Home** has undo, the **format painter**, **styles** (below), and font
  and size for the words you select (*Larger*/*Smaller*, ⌘⇧. and ⌘⇧, step
  Word's ladder, and the inspector takes any size). It has bold, italic,
  underline, strikethrough, **subscript** and **superscript** (⌘= and ⌘⇧=),
  **text colour** and **highlight**, inline code, **change case** and
  **clear formatting**. It has bulleted lists with a choice of marker,
  numbered lists with a numbering style (1, a, A, i, I, or legal 1.1.1) and
  *restart* or *continue*, **checklists** (⌘⇧9) with boxes you tick, and
  indent/outdent (of a list item, or of a paragraph, half an inch at a
  time). It also has alignment (⌘⇧L/E/R/J), line and paragraph spacing,
  paragraph **shading** and **borders** (a box, a line above or below, or a
  bar at the left, where neighbours with the same border are one box),
  **sort A to Z**, and **show paragraph marks** (¶).
  **Insert** has page break (⌘↩), column break and section break, and a
  **table** (pick its size from a grid). It has **link** (⌘⇧K: an address,
  and the words to show when nothing is selected), picture, quote, code
  block and divider. It also has **footnote**, **endnote** and a
  **table of contents**, a **symbol** palette, and today's date.
  **Layout** has margins (Normal, Narrow, Moderate, Wide, or custom), paper
  and orientation, columns, **sections**, hyphenation, line numbers, headers
  and footers. A **Table** tab appears while the caret is in a table, and a
  **Picture** tab while a picture is selected. **Review** has Editing,
  Suggesting or Viewing, the suggested changes (next, previous, accept,
  reject), comments, **Check**, history, compare, find, read aloud, preview
  and print.
  Each tab's row holds only what is used every day. The rest is one click
  away under a **More** (⋯) button beside it: *More text formatting*
  (strikethrough, sub- and superscript, inline code, larger/smaller, change
  case, copy formatting, clear formatting), *More paragraph formatting*
  (shading, borders, sort, show ¶), and a **More** on Insert, Layout and
  Review. A More button is lit while something inside it is switched on.
  Alignment is one menu. A list's style menu shows while the caret is in a
  list. Accept and Reject show when there are suggestions to decide. Groups
  that don't fit the window fold into a ⋯ menu at the end of the row. On a
  phone the ribbon is one row that scrolls, and its menus open as sheets.
  While the phone's keyboard is up for the text, the row sits on the
  keyboard under your thumbs. It goes back to the top when you type
  somewhere else (the title, a comment, a search). The scripted formats
  keep their own toolbars (which ride on the keyboard the same way) and
  professional layouts.
- **Selection menu**: select words with the mouse and a small menu appears
  above them. It has **bold**, **italic**, **underline**, text **colour**,
  **highlight**, **link**, **comment** and **clear formatting**, so the
  commonest changes need no trip to the ribbon. It never takes the caret
  out of the text. Escape, or clicking anywhere, puts it away, and it
  follows the selection as the page scrolls (and goes when the selection
  scrolls out of view). Its last button (the sliders) chooses what it
  holds: tick strikethrough, sub- and superscript or inline code in, tick
  anything out, or switch the menu off. Settings ▸ Writing has the same
  choices (and switches it back on). (On a touch screen the system's own
  selection menu is left alone and the toolbar sits on the keyboard
  instead.)
- **Links**: put the caret on a link and a small panel beside it says
  where it goes, with **Open**, **Copy**, **Edit** (its address and its
  words) and **Remove**. A click in the text only places the caret, so a
  link is never followed by accident. ⌘/Ctrl-click follows it, and in a
  document you can only read, any click does. Links open in your browser
  (or mail program) and never inside the app. Escape puts the panel away.
- **Styles** (Document format): Normal, No Spacing, Title, Subtitle,
  Heading 1–6, Quote and Caption, each shown in its own look, plus styles
  of your own. *Modify…* changes what a style looks like everywhere it's
  used (font, size, colour, alignment, spacing, indents). *Update to match
  selection* makes the style look like the paragraph you formatted by hand.
  *New style from selection* names that look. Styles are saved in the
  document, so collaborators, the PDF and the Word file all have them.
  Normal is the document's body text (Document tab of the inspector). After
  a title, subtitle or caption, Enter goes back to body text.
- **Format painter**: click it, then select other text. It takes the
  formatting of the words you were on (and whole paragraphs take the
  paragraph's alignment, spacing and indents too). Escape puts it down.
- **Pasting from Word, Google Docs and the web** (Document format)
  **matches this document** by default: the words come in with their
  structure (paragraphs, headings, lists, tables, links) and their emphasis
  (bold, italics, underline, sub/superscripts), and leave their look behind:
  typeface, size, colour, highlight, alignment, indents and spacing are this
  document's. A small strip under the paste says so and offers
  **Keep its styling**. One click brings the colours, highlights, alignment
  and differing fonts and sizes back (and **Match this document** switches
  again). The choice stays until you type the next thing, and Escape or the
  × settles it sooner. Word's typed-out bullets become real lists. What you
  copy inside the app pastes exactly as it was. ⌘⇧V still pastes plain text.
- **Tables** (Document format): Insert ▸ Table, then type. Tab moves to the
  next cell and adds a row after the last. The Table tab adds and deletes
  rows and columns, merges and splits cells, marks a **header row** (set
  again at the top of each page the table runs onto), chooses which lines
  are drawn (all, between rows, a box, none) and shades cells. Drag a
  column's right edge to resize it, or use *Narrower*/*Wider* (on a touch
  screen). *Even widths* shares the page out equally. A table from Word, a
  spreadsheet or a web page pastes as a table. A table is never wider
  than the sheet: where the window is narrower than the paper, its columns
  keep their proportions. A cell can have **borders of its own** (a
  coloured rule down the side of a column, say). They come in from Word and
  go back out, though there is no control for drawing them here yet. In a
  table with no lines, faint guides show where the cells are while the
  caret is in it or the pointer over it, and nowhere else. On paper a table
  breaks between rows. A row that won't fit what is left of a page is
  **cut across the pages**, each cell going on at the top of the next, and
  page view shows the same break.
- **Footnotes and endnotes** (Document format): Insert ▸ Footnote puts a
  numbered reference where the caret is and opens the note under it to
  write in (bold, italic and underline work, and Enter or Esc goes back to
  the text). Notes are numbered by themselves (1, 2, 3 for footnotes and i,
  ii, iii for endnotes) and renumber as you move text about. A note travels
  with its sentence when you cut and paste, and several people can write in
  one at once. In preview, print and PDF a footnote sits at the foot of the
  page that cites it (running over to the next page if it must) and
  endnotes close the document. Clicking a reference in the PDF goes to its
  note. A note's words aren't counted in the word count. While you write,
  every note is also listed under the document's last page (**Footnotes**
  and **Endnotes**, each with its number). Click a note's words to change
  them right there, or its number to go to the sentence that cites it.
- **Table of contents** (Document format): Insert ▸ Contents lists the
  document's headings and keeps itself up to date. Click an entry to go to
  it. On paper each entry has its page number and a row of dots, and in the
  PDF each is a link.
- **Sections** (Document format): Layout ▸ Section starts a new section at
  the paragraph the caret is in. A section begins on a new page and can
  have its own paper, orientation, margins, number of columns, and page
  numbering that starts again. What it doesn't set is as the document. A
  landscape page in the middle of a portrait document is a section. A
  **column break** (Insert ▸ breaks) sends what follows to the top of the
  next column.
- **Pictures** (Document format): drag a corner handle to resize and the
  proportions are kept. The Picture tab sets one at the left, in the middle
  or at the right, gives it a **border** (a colour and a thickness) and
  **rounded corners** (up to a circle), an exact **size** in inches, a
  **caption** that stays under it on the page, and a **description** for
  someone who can't see it. A picture is a block of its own between the
  other blocks, with no anchors or wrapping to go wrong. To **move** it,
  drag the handle on its corner to where it should go (a line shows the
  place), or use *Up* and *Down* on the Picture tab or ⌥↑ and ⌥↓. Borders
  and corners come in from Word and go back out.
- **Document inspector** (the sliders button, Document format): settings
  saved *in* the document, so collaborators see the same layout. Text tab:
  the selection's font and size (any size), alignment, line spacing (a
  multiple, or *exactly* / *at least* so many points), space before and
  after, **indents** (left, right, first line or hanging), **keep with
  next**, **keep lines together**, start on a new page, plus a **drop cap**
  for chapter openers. Document tab (the page setup): **paper** (US Letter,
  Legal, Tabloid, Executive, Half Letter, US Trade 6×9, A3, A4, A5, B5, or a
  custom size. A new Document starts on the paper of where you are: US
  Letter in the countries that print on it and A4 everywhere else. The
  choice is kept with the document, so everyone who opens it sees the same
  sheet) and orientation, **margins**, a binding **gutter** and
  **facing pages** (mirrored margins), and one to three **columns**.
  **Headers and footers** have a left, centre and right slot each and live
  fields (page number, page count, title, author, date), and are optionally
  different on the first page and on even pages. **Page numbers** are in
  1/i/I/a/A style from any starting number. Body-text defaults cover font,
  size, line spacing, paragraph spacing and first-line indent (indent + 0 pt
  spacing gives the classic book look). Hyphenation and line numbers are
  here too.
- **Preview** (the eye button, every format): every page exactly as it
  will print, in the same layout the PDF and the printer get. A screenplay,
  a stage play and a poem preview on their format's own page. Docked beside
  the text on a wide window, it follows your typing and shows
  *Page 3 of 12*. Click any line for **Edit here**.
- **Print** (⌘P, or Export ▸ Print…): the document is typeset to a PDF and
  handed to the system's print panel. On a Mac that is the native one, on an
  iPhone the system print sheet, and in a browser or on Windows the
  browser's own. Where that isn't possible it opens as a PDF you can print
  from. "As a booklet" imposes the pages for folding.
- **Screenplay, stage play and poetry pages**: their PDFs, printouts and
  previews are typeset by the same engine as a Document's, on the format's
  own page. A screenplay is set in twelve-point Courier, six lines to the
  inch, with scene headings, action, character names, parentheticals,
  dialogue and transitions at their standard measures and the page number
  at the top right from page two. A stage play is set likewise and opens
  with its title. A poem is set in a book face with long lines turned over
  and set in, and its title at the top. Any alphabet prints (the old
  typewriter pages turned everything but Latin into question marks), a
  character's name is never left at the foot of a page without the speech,
  and bold, italic and underline are kept.
- **PDF** (Document format): typeset in real typefaces with proper line
  breaking. It has mixed fonts and sizes, bold and italic, underline and
  strikethrough, lists, quotes, code, pictures, links you can click, page
  breaks, an outline of your headings, headers, footers and page numbers,
  with no line left alone at the top or foot of a page and headings kept
  with their text. Every font prints as itself where it can (see
  **Fonts**). Where it can't, the export says what stood in.
- **Export PDF** (Export ▸ Export PDF…, every format but Manuscript): a
  small dialog with the choices for the file, remembered on the device.
  **Pictures** go in for a *Screen* (150 pixels an inch, a file small
  enough to send), for *Print* (300) or as the *Original* files. A picture
  is sized by how large it prints, so one shown small costs little. A JPEG
  that is already good enough goes in untouched and is never encoded a
  second time. A photograph taken on its side stays the right way up, a
  see-through picture stays see-through, and a screenshot stays sharp.
  What a camera wrote beside a photograph (where and when it was taken) is
  not copied into the PDF.
  **Tags for screen readers** writes the document's structure into the
  file: headings, paragraphs, lists, tables with their header cells, notes,
  links and each picture's description, in reading order. Running heads
  and page numbers are marked as decoration. The export says how many
  pictures have no description yet.
  **Archive copy (PDF/A)** makes a PDF/A-2b file, meant to open the same
  way in many years: every font is inside it, and it says what its colours
  mean.
  **Keep an editable copy inside** puts the document itself into the PDF
  beside its pages (see **Import**).
  **Details** are the subject, keywords and language. They are kept with
  the document, travel in a Word export too, and are what search and
  screen readers look at.
- **What every PDF says of itself**: its title, author, subject, keywords
  and language, when it was made, and its page labels, so a reader's
  "page iv" or "page 12" is the page that prints that number.
- **Fonts** (Document format): the font button opens one list of everything
  you can set a paragraph (or the whole body) in, each drawn in itself and
  searched together. The list has the fonts **in this document**, your
  **recent** ones, those **with the app**, the fonts **on this computer**
  (desktop), and an **online library** of nearly 2,000 open-licensed
  families (the Google Fonts collection), filtered by kind: serif, sans,
  mono, display, script. A library font downloads the first time a document
  uses it and is kept on the device. Other scripts of a family (Cyrillic,
  Greek, Vietnamese…) download only if your text has them. The same font
  files draw the editor, the preview, the PDF and the printout, so they
  agree. Installed fonts are embedded in a PDF only when the font's own
  licence setting allows it, and are never uploaded. When a document names
  a font this device doesn't have (a collaborator's, or one from a Word
  file) it's shown and printed in the closest stand-in: a same-metrics
  family where one exists (Gelasio for Georgia, Tinos for Times New Roman,
  Arimo for Arial, Carlito for Calibri), so lines and pages fall the same.
  A line under the ribbon says so and offers **Replace…**. Settings ▸ Fonts
  has the switch for the online library, the downloaded fonts (and a way to
  remove them), and the licences.
- **Word (.docx)** in and out, including fonts. A Word file's fonts are
  matched to the app's own, to those installed here, then to the online
  library, and otherwise kept by name. Exports carry real family names and
  tell Word what to fall back to. Both directions keep headings 1–6, real
  nested and numbered lists (bullet styles, legal numbering and checklists
  included), bold/italic/underline/strikethrough, text colour, highlight,
  sub/superscript and a font or size on part of a paragraph, links,
  pictures with their sizes, alignment, spacing, indents, line-height
  rules, borders and shading, keep-with-next, quotes, code, dividers, page
  breaks and drop caps. They also keep **tables** (widths, merged cells,
  header row, shading), **footnotes and endnotes**, a
  **table of contents** (a real field Word can update), picture placement
  and captions, **sections** and column breaks, plus **styles** (a Word
  file's Title, headings and the writer's own styles come in as the
  document's styles, looking as they did, and yours go out as real Word
  styles) and the page setup, headers, footers and page numbers. What Word
  shows is what the document says, and a file written by subScribe reads
  back the same.
- **Page view** (Document and the scripted formats): the page toggle shows
  the sheet as its printed pages, with gaps between them, page numbers on
  the left and the count in the word-count bar. The pages are the printed
  ones: the text breaks where the PDF's pages do, in the middle of a
  paragraph or between the rows of a table, and the count is the PDF's.
  It keeps up as you type. The gaps between pages hold still and the text
  moves across them. Lines within a page are still the screen's own, so a
  page whose text needs much more room than the paper is made taller.
  Preview shows the page line for line. Settings ▸ Writing has
  a switch back to the simpler view that only moves whole paragraphs.
- **Outline**: parts, chapters and sections with their labels and word
  counts. Drag to reorder chapters (or use Reorder on a phone). One undo
  puts them back.
- **Organizer**: cards show each document's opening words (or, when
  searching, the passage that matched) and "Manuscript · 98,412 words ·
  Oct 3". Sort by modified, created or name (in natural order: Chapter 2
  before Chapter 10). The sort is remembered on this device. Every ⋯ menu
  works from the keyboard (Shift+F10 too): Rename, Duplicate, Move, Share,
  Version history, Delete.
- **Recently Deleted**: deleting is undoable. The toast has **Undo**, and
  deleted documents (from the server and from this device) wait in Recently
  Deleted for 30 days, with their history, before they're gone for good.
- **Combine into one manuscript**: select documents (⌘/Ctrl-click,
  Shift-click, or Select on a phone) or use a folder's menu. Put them in
  order, name the book, and each becomes a chapter. The originals stay.
- **Folders**: organize your documents. Move documents between folders, and
  rename or delete a folder (its documents stay put). Documents on this
  device have folders of their own, which are kept on the device.
  **New folder** asks where when there's a choice, and a folder's card says
  *on this device*. New documents, imports and combined manuscripts made
  with such a folder open land in it, and a document restored from Recently
  Deleted goes back to the folder it was in.
- **Search**: full-text. It matches titles and the words of every document
  (never the editor's internal markup) and shows the matching passage.
  Documents on this device are searched the same way, with or without a
  server: the first search after an update reads the documents once, and
  after that it's instant.
- **Suggested changes** (track changes): switch to **Suggesting** and what
  you type, delete or paste is proposed instead of done. Additions are
  underlined in your colour, deletions are struck through, a new or removed
  paragraph break is marked with a ¶, and a table, picture, divider or
  footnote is outlined. Each says who and when. Anyone who can edit accepts
  or rejects them one at a time or all at once, from the Review tab or from
  the **Changes** list beside the comments (where a change can also be
  commented on). Taking back your own suggestion just removes it. The mode
  is yours alone, so one person can suggest while another edits.
  **Viewing** shows the text as it would read with everything accepted and
  keeps it locked. Formatting isn't tracked: bold, styles, lists and a
  table's rows and columns change directly. Printing, PDFs, books and the
  word count use the text with suggestions accepted. Suggested changes
  travel to and from Word as its tracked changes. *Export Word (clean copy)*
  leaves them out. Works in every format (the mode switch is in the Changes
  list, and a Document also has it on its ribbon). Like the other newer
  formatting it needs an up-to-date server. Where the server is older,
  Suggesting isn't offered.
- **Read aloud**: the text is spoken by your system's voice a sentence at a
  time, with the sentence highlighted as it's read. It reads from the caret,
  with pause, back and on a sentence, speed and a choice of voice. Nothing
  is sent anywhere. Struck (suggested-deleted) words and footnotes aren't
  read.
- **Check**: a reading of the whole text for slips and for things written
  two ways. Open it from the Review tab, the header button or **F7**, in
  any kind of document. Each finding lists the places it occurs with the
  words round them. Choosing a place selects it in the text. **Fix**
  changes one place and **Fix all** changes every one as a single step
  you can undo. In Suggesting mode each fix is a suggestion. Where the
  text does a thing two ways, you say which is meant and the others are
  listed to change. It looks for:
  - words spelled the American way in some places and the British way in
    others (color, colour). Choose American, British, British with -ize,
    Canadian or Australian in Rules and every spelling outside it is
    listed. Names are left alone, and so are spellings that are also
    another word (check, tire, story)
  - one word spelled two ways (judgement, judgment) and -ise mixed with
    -ize
  - a word with its accent in some places and without in others (café,
    cafe)
  - slips a spelling checker passes because each word is a word (could
    of, sneak peak, its a). How people talk is left alone inside quote
    marks
  - a phrase hyphenated in some places and open in others (a short-term
    plan, a short term plan). "In the short term" is a different case and
    is not weighed against it. Also one word hyphenated and closed
    (co-operate, cooperate)
  - a range of numbers with a hyphen and with an en dash, and the dash in
    a sentence drawn more than one way
  - numbers in a sentence as words in some places and figures in others,
    and twenty-one with and without its hyphen. Labels, measures, times,
    dates and money are not counted
  - a word with a capital in some places and without in others (the
    President, the president). The first word of a sentence, a word
    beside another capital, and words that are also names (Will, Rose)
    are not weighed
  - headings of one kind capitalised in more than one way
  - two names so alike that one may be the other misspelled (Katherine,
    Kathryn). Two names that keep turning up together are two people and
    are left alone
  - the comma before "and" in a list, with it in some places and without
    in others. Rules can ask for always or never
  - the items of one list ending or beginning differently
  - a title or a name in italic in some places and plain in others
  - an abbreviation written two ways (NASA, Nasa). In a Document it also
    looks at definitions: explained twice, given two meanings, used
    before it is explained, never explained, explained and never used
  - the same word twice in a row (the the)
  - brackets and quote marks opened and not closed. A speech that runs
    over several paragraphs and closes only the last is left alone
  - straight quote marks mixed with curly ones, and the same for
    apostrophes
  - speech in double marks in some places and single in others
  - two spaces in a row, a space before punctuation or inside brackets, no
    space after a comma, spaces at the end of a paragraph
  - what a draft leaves behind: highlighting, TK, TODO, XXX, notes in
    square brackets, open comments and suggested changes

  The panel's **Rules** tab holds the house style, in two places. **This
  document** has rules of its own that travel with it and that every
  co-writer shares. **All my documents** has your own rules for
  everything you open on this device. The document has the last word, and
  it can ask that only its own rules be used so that everyone sees the
  same findings. A rule can:
  - switch a check on or off
  - write one word or phrase for another (per cent as percent), fixed in
    the capitals it was written in
  - point a word out each time it is used, with a note of your own
  - say that a word or phrase is never to be flagged

  A place you skip is remembered in the document by the words at that
  place, so it stays skipped when the text moves and comes back if those
  words change. A whole finding can be set aside for now, for this
  document, or in all your documents. Rules save to a file and load from
  one, and your own are part of "Export everything on this device".

  The **Reports** tab (in a manuscript and in a Document) shows what the
  text is like. Nothing in it is a fault to fix. Each report says what was
  counted, and choosing a row shows it in the text.
  - **Overview**: words, sentences, paragraphs, the average sentence, a
    reading grade and the share of the words inside quote marks
  - **Chapter by chapter**: one row a chapter with its length, its share
    of speech and its average sentence. A chapter is marked where a
    number stands well apart from the other chapters. Sort the table, or
    choose a row to go there and make every report about that chapter
  - **Sentences**: a chart of every sentence's length in order (click a
    bar to go to it), how sentences begin, sentences in a row that open
    with the same word, runs all of one length, long sentences and long
    paragraphs. Speech is left out of the patterns
  - **Repeats**: the same word again within about thirty words, phrases
    said again and again, the words used most, and a word one chapter
    leans on far more than the rest of the book. Names and small words
    are never counted. Say **This is fine** to a word and it is left
    alone, in this document or in all of yours
  - **Word choice** (English): likely passive verbs, words in -ly listed
    by word, filter words (she saw, he felt), feelings told (felt
    angry), padding words (very, really, just), worn phrases, words that
    say it twice (nodded his head, stood up), wordy phrases (in order
    to), and every use of words that are easily taken for one another
    (affect, effect). Where there is a plain fix it is offered, one place
    or all of them, and made as a suggestion in Suggesting mode. In
    fiction, speech is left out unless you ask for it
  - **Dialogue** (English): how much of the text is speech, the tags
    that carry it (said and asked, other verbs, actions such as smiled),
    tags with a word in -ly, long exchanges where nobody is named, and
    punctuation amiss between speech and tag, each with its fix. A
    sentence of its own after speech is a beat and is left alone
  - **Pace**: the text in stretches of about 300 words, each drawn as
    quick, steady or slow-leaning, and a list of long stretches with
    little or no speech. It is told from the shape of the text alone
    (how much is speech, how long the sentences and paragraphs are, how
    often it looks back or goes inside a head), so a stretch is named for
    what was measured and never called a fault
  - **Senses** (English): words that name sight, sound, touch, smell and
    taste, counted outside speech. There is no right balance, so none is
    given

  A report covers the whole text, the chapter the caret is in, or the
  paragraphs you have selected. An outside figure is shown only where a
  published source gives one (the Plain English Campaign's 15 to 20 words
  for the average sentence of writing that explains). For fiction the
  reports compare your chapters with each other.

  The checks that depend on English (spelling, accents, slips, hyphens,
  capitals, headings, numbers, the serial comma) run only for English
  text, and the panel says how many did not run. Of the reports, Word
  choice, Dialogue and Senses read English. Overview, Chapter by chapter,
  Sentences, Repeats and Pace run in any language with spaces between its
  words, and Repeats knows the small words of French, German, Spanish,
  Italian, Dutch and Portuguese. The table of which English uses which spelling comes from VarCon,
  part of the SCOWL project, used under its licence. Its notice is shown
  at the foot of the Rules tab.

  The arrows beside Close make the panel about twice as wide and back.
  Wider, the charts have more room, the reports sit two abreast and the
  chapter table shows more of each chapter. The choice is kept on this
  device.

  Nothing is sent anywhere, and nothing runs while the panel is closed. It
  reads the text again after each pause in your writing and never moves
  your selection. On a phone it opens as a sheet under the page and folds
  to a bar with previous, next and Fix while you step through the places.
- **Find by pattern**: the pattern button in Find and replace makes the
  words to find a regular expression. In the replacement, `$1` is what
  the first pair of brackets found. Replace all is still one undo.
- **Compare**: any saved version beside the text as it is now, or the
  document beside a Word file. Paragraphs are aligned, and what was taken
  out is marked on one side and what was put in on the other, word by word.
  On a phone both are in one column. Jump between differences, show only
  what changed or the whole text, swap the sides.
- **Feedback threads**: select text and leave a comment anchored to it.
  Threads track the text even as it moves, resolve/reopen, reply inline,
  and list in the order they appear in the text. Click a highlighted
  passage to open its thread. The highlighter button in the panel header
  shows or hides the anchor highlights. On-device documents have the same
  panel as **Notes**: comments to your future editing self.
- **Edit a PDF** (pick a PDF with Import and choose **Edit this PDF**): the
  PDF opens as the PDF it is, to read, search and change. **Pages**: move
  them by dragging in the list, turn them, copy them, take them out, add an
  empty page or the pages of another PDF, and save some pages as a PDF of
  their own. **Mark up**: highlight, underline or strike through selected
  text, add notes, draw, put a box or an arrow, and type words on the page.
  **Forms** are filled in on the page. **Sign** by drawing your signature
  or using a picture of it. That is a signature as ink on paper is. It is
  not a certificate. **Change text** (Beta) lets you click a piece of the
  page's own text and retype it. Every step can be undone. Your file is
  never written over: **Save a copy** writes the result where you say, and
  the apps can also **keep** a PDF on the device to come back to, listed
  in Documents and in Home. A PDF with a password asks for it. One whose
  owner does not allow changes says so and keeps those tools off.
- **Import**: PDF, DOCX, RTF, Pages, TXT, and Markdown files convert into
  new documents. Several can be imported at once, and they go into the
  folder you have open. PDF import reads the pages back into a document:
  paragraphs (a word broken at a line's end is put together again),
  headings, lists, tables, links, footnotes, and pictures with what is
  said under them, in the order the page is read even where it is set in
  columns. The paper, the margins, the columns, the font and size of the
  text, its colours, and what was printed at the head and foot of every
  page become the document's own page setup, header and footer. A tagged
  PDF (from Word, Google Docs, InDesign or this app) is read by its tags
  and not guessed at. A PDF with a password asks for it. A scanned PDF
  asks whether to **read the text** out of its pages or **keep them as
  pictures**. Reading uses the system's own text recogniser on a Mac, an
  iPhone or an iPad. It runs on the device and sends nothing anywhere.
  Other devices keep a scan's pages as pictures. A long import shows how
  far it is and can be cancelled. A note afterwards says what was left
  out, such as drawings and text set at an angle. A
  PDF exported from here with *Keep an editable copy inside* holds the
  whole document, with its styles, page setup and pictures. Importing it
  asks whether to **open the document** or **read the pages**. Suggested
  changes were saved as accepted, and comments and history are not in it.
  Anyone who has such a PDF can open the document the same way. Word
  import keeps headings, lists, links, pictures, fonts, spacing and the
  page setup (see above), and says what it couldn't keep yet: text boxes
  arrive as their text, and a section break that doesn't start a page is
  left out. Word's tracked changes come in as suggested changes, under the
  names Word has for them. A Word *manuscript* arrives as a Manuscript with
  its chapters detected.
- **Booklet export** (Document and scripted formats): beside the straight PDF,
  "Export booklet PDF" imposes pages for saddle stitching, with two per
  landscape sheet in fold order. Print two-sided flipping on the short edge,
  fold the stack in half, and it reads 1…N.
- **Saving files**: on a Mac or PC every export opens a Save dialog (the
  toast after offers *Show in Finder*). On iPhone and iPad exports land in
  Files ▸ On My iPhone ▸ subScribe, with a Share… button. In the browser
  they download.
- **Export all**: back up every document you can see (server documents and
  the ones on this device) as Markdown + JSON. Your writing is never locked
  in.
- **Sharing**: private by default. The owner grants read or write access to
  individual friends or to a whole group (which also posts a card in that
  group's chat) or shares an entire folder at once.
- **Canvas references**: send a whole document or just a selection to a
  canvas board as a live-updating excerpt card.
- **Documents on this device**: the "On this device" section holds
  single-user documents stored on your computer and never on the server.
  They have the same editor, formats, outline, find, word count, version
  history, book preview and exports. Their revisions are kept on this
  device too, beside the document, so history works with no server and no
  connection. **Publish to a server…** (a document's ⋯ menu, or the share
  button in its header) publishes a copy, optionally shared with a friend
  or group in one step. The local original stays yours and does not
  live-sync to the published copy. If you aren't connected it opens the
  connect sheet first and carries on once you are. Without a server,
  **Import** creates documents here too.
  The reverse works as well: any server document's menu → **Save a copy to
  this device**. Pictures work here as they do on a server: they're kept
  beside the document on this device, travel with it to Recently Deleted
  and back, are embedded in its PDF and Word exports, and are uploaded with
  it when you publish.

## Chat

Groups work like small Discord servers: channels, invites, roles.

- **Invites two ways**: admins generate expiring invite codes, or set a
  permanent **join code** (gear next to the group name). A join code is a
  memorable code like `writers-club` that works in the normal join box
  until an admin clears it.

- **Markdown**: `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``,
  fenced ``` blocks, links.
- **@mentions and #channel references**: `@username` pings and highlights,
  and `#channel` links and jumps.
- **Read state that follows you**: what you've read syncs through the
  server, so unread counts agree across your devices. Opening a channel
  lands on a "New messages" divider where you left off, and messages are
  grouped under day separators (Today, Yesterday, …).
- **Typing indicators**: a quiet "…is typing" line above the composer, in
  channels and DMs.
- **Search**: the magnifier in the channel header searches the full text of
  every channel in the group. Click a hit and you land on that message in
  context, where it is highlighted.
- **Pinned messages**: pin from a message's hover actions (your own, or any
  as an admin). The pin in the header counts them, lists them, and jumps.
- **Reactions** can use the group's custom emotes as well as emoji.
- **Mute a channel**: the bell on a channel row (or a right-click) silences
  its notifications and badges on this device. Unread shows as a quiet dot.
- **Custom emotes** per group (admins add them via the emote picker). Type
  `:name:` anywhere.
- **Uploads**: attach, paste, or drag & drop images.
- **Presence**: online / busy / invisible, shown next to every name.
- **Profile cards**: click anyone's name or avatar for their bio, accent
  color, and status. The card has a **Message** button for friends (straight
  into your conversation) and **Add friend** / **Accept friend request** for
  everyone else.
- **Moderation**: authors and group admins can delete messages. Admins can
  kick members, rename and delete channels, and delete the whole group
  (gear next to the group name → Delete group). Deleting a group
  irreversibly erases its channels, messages, sessions, boards, and emotes
  for every member.
- **Slash commands**: type `/` to see commands contributed by plugins.

## Voice & video

Voice channels sit under a group's text channels. Media is a direct
peer-to-peer mesh between members (DTLS-SRTP), and the server only relays
connection setup. A call has mute, speaking indicators, and a persistent
voice bar in the status bar, and it follows you around the app.

Turn on your **camera** or **share your screen** from the voice bar. Video
appears in a floating panel you can drag, resize, and keep open while you
work in Canvas or Documents. Click a tile to enlarge it. Peers' tiles show
mute and screen-share badges. Screen sharing is available on Windows and
Linux. macOS can watch shares but not send them (its webview has no screen
capture), and camera video works everywhere.

Settings → Voice lets you pick input devices, adjust input gain and output
volume, test your mic and camera, and choose video quality (360p default:
the mesh sends a copy to every peer, so higher quality multiplies upload
bandwidth).

## Canvas

Shared storyboards per group: sticky notes, text, **shapes** (rectangle,
ellipse, diamond, triangle, star or heart, with centered labels and
colorable outlines, hollow or filled), colored frames, connectors, pasted
or **dropped images** (drag a file onto the board and it lands under the
cursor, and images are croppable from any edge, with rotate/flip),
**link cards** with server-fetched previews, and live
**document references** (a whole document or a selection, kept in sync as
it's edited). Multi-select with shift-click or shift-drag. Moving a frame
moves what's inside it. Note, frame and shape fills are translucent, so
overlapping them layers the color instead of hiding what's underneath, and
a selected note has an opacity slider of its own. There is a snap-to-grid
toggle, and holding shift while dragging a resize handle keeps the
element's proportions. Each element has its own text formatting
(bold/italic/underline, size, alignment, bullets, four typefaces, text
colors). Connectors run straight, at right angles or as a smooth curve,
with per-side anchors, line weight and color, dashed styles, arrow/dot
ends, and a label that rides the middle of the line. Selecting several
elements offers a text color for all of them at once. Everything syncs live.

**Lining things up**: drag an element near a neighbor and **smart guides**
appear. They are accent lines that show when edges or centers align, with a
gentle snap (they outrank the dot grid on the axis they match). A
multi-selection's toolbar has an **align & distribute** menu
(left/center/right, top/middle/bottom, even out the gaps). **⌘G groups** a
selection so it selects and moves as one. Click again to pick a single
element out of the group, ⌘⇧G ungroups, and copies of a group stay grouped
on their own.

**Pages**: a board is a stack of pages, listed above the canvas. Add one with
the plus, double-click a tab to rename it, right-click for rename and delete
(deleting takes its contents with it, and undo brings both back). Each page
is its own space: what you draw, select, or fit to screen belongs to the
page you're on. Peers' live cursors appear only on the page you share with
them. A dot on a page tab (their accent color, or a count) shows someone is
working over there.

**Linking as you go**: select an element and four arrows appear around it.
Click one and you get a new element on that side, already connected and ready
to type into. It is the quickest way to grow a diagram outward.

**Sketches**: the pencil in the toolbar opens a pad you can draw on with a
mouse, trackpad, finger or stylus. Pick an ink color and nib, switch to the
eraser to rub out strokes you've drawn, undo a stroke at a time, then insert
it onto the board. Sketches stay editable: double-click one (or use the
pencil on its toolbar) to reopen the pad and keep drawing. They're stored as
strokes rather than as a picture, so they stay sharp at any zoom, resize
cleanly, and work on a board with no server behind it. One person draws at a
time: while someone has a sketch open, others trying to edit it are told
who's in there instead of silently overwriting each other.

**Copy and paste**: ⌘/Ctrl-C, X, V and D copy, cut, paste and duplicate the
selection, and ⌘/Ctrl-A selects everything on the board. A connector with
both ends in the selection comes along and is re-pointed at the copies, so
a pasted diagram stays wired the way you drew it. Copies go
through the system clipboard, so they can be pasted into another board.

**Right-click** anything on the board for bring to front and send to back,
cut, copy, paste and duplicate, lock (a locked element still selects, so you
can unlock it, but won't move or resize), round corners, and delete.
Everything applies to the whole selection. Right-clicking the board itself
offers paste, select all, and fit to screen. Selecting one element also puts
a **corner-radius handle** inside its top-left corner, opposite the scale
handle: drag it away from the corner to round it off, back toward the corner
to square it up.

**Getting around**: press **F** to frame the current selection (the view
centers on it and zooms to fit) or, with nothing selected, to fit the whole
board on screen.

**Find and replace**: ⌘/Ctrl-F (or the search button in the board header)
opens a bar that searches every note, text block, shape label and frame
name. Enter and Shift-Enter step through the matches in reading order,
selecting and centering each one, and you can replace the current match or
all of them at once. A Replace All is a single undo step. Link cards,
images, and document cards aren't searched: their text holds a URL, an
attachment, or a document reference rather than prose.

**Background**: the palette button in the board header dresses the page
you're on with a background color, or an image you upload (filled, fitted,
stretched, tiled, or centered), and can turn the dot grid off. Each page
keeps its own, everyone in the group sees it, and undo covers it like any
other change.

**Export & import boards**: the download button in a board's header saves it
as a `.wfboard` file. The file is self-contained and holds the board's
pages, elements, connectors and pictures. Import one from the board list
into a group or onto this device. The round trip is lossless, which also
makes it the way to move boards between servers. The board list also
imports **FigJam and Freeform PDF exports** (desktop app only). Since a PDF
stores drawings rather than board structure, the import reconstructs it:
pictures become image elements, small text cards become notes, larger cards
become tinted frames holding their photos and text where they were laid
out, and each imported page keeps the export's white paper so its black
text reads as it did. The result is editable but approximate. Card colors
map to the board palette, and freehand ink and decorations don't survive.

**Boards on this device**: the canvas list has an "On this device" section
for boards stored on your computer and never on the server. These are the
same boards with the same tools, kept in a file beside your local
documents. They need no group and no connection, so they work in offline
mode. That includes pictures: paste one and it's stored beside the board on
your computer, and so are background images. The trade is that nobody else
can see the board, there are no live cursors, and document cards (which
point at server documents) stay on group boards. **Publish to a server…**
(the share button in the board's header, or the board's ⋯ menu in the list)
puts a copy (pictures included) in a group you choose. The board on this
device stays, and later changes to it don't follow. Not connected, it opens
the connect sheet first. The search field above the list finds boards by
name and, for boards on this device, by the words on their notes, text,
shapes and frames.

## Notes

A local, Obsidian-compatible markdown vault with `[[wiki-links]]` and
backlinks. Share a note snapshot to a friend over DM, and they can save it
into their own vault.

## Getting around

- **⌘K** (Ctrl+K) is the quick switcher: type a few letters and jump to any
  channel, group, document, board, note, or conversation, or run a command.
  While a document is open it also runs the editor's commands by name:
  type "table", "heading 2" or "page break" and press Enter. Each command
  shows its key beside it, the selection stays where it was, and the text
  has the focus again afterwards. Only what can be done just then is
  offered, so someone who can only read a document is offered Find and
  Print and nothing that changes the text.
- **⌘/** shows a keyboard-shortcut cheat sheet, with every key of the
  document editor listed by what it is for.
- The desktop window remembers its size and position between launches, and
  unread counts appear on the app's dock icon (macOS/Linux). The installed
  web app badges its icon too.
- The desktop app quietly checks for updates a few seconds after launch and
  mentions a waiting one. Settings → Application shows the release notes
  before you install.

## Notifications

Native OS notifications for direct messages, @mentions, new writing
sessions, shared documents and notes, and friend requests. They are
delivered only when you're not already looking at the relevant conversation.

## Customization

- **Profile**: avatar, banner image, accent color, bio, and status
  (Settings → Profile). Your accent tints your name in chat and fills the
  profile-card banner when no banner image is set.
- **Portable profile**: save your look (display name, colors, bio, avatar,
  banner) on your computer and apply it to any server you join. Profiles
  are otherwise per-server. It's offered once when you register on a new
  server and available any time from Settings → Profile. It is never
  applied without asking. Usernames are per-server and aren't included.
  It is also who you are when no server is connected. Settings → Profile
  then edits it directly: name, accent, about, and a picture and banner
  chosen from this device (a large photo is scaled down first).
- **Groups**: admins set a group icon and accent color (gear next to the
  group name). The active group's accent shows as a stripe on the app rail,
  and Canvas and Sessions show a chip naming the group you're working in.
  Share and send-to-canvas pickers preselect it too.

## In the browser

Servers can serve the app at `/`. Open the server's address in any
browser (phones included) for chat, documents, canvas, sessions, and
voice in a responsive layout. Use your browser's **Add to Home Screen** to
install it. Once installed it opens full-screen with its own icon, like a
native app. Desktop-only features stay on the desktop: the notes vault,
on-device documents and boards, the portable profile, hosting, and plugins.

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

You don't need a server to write, and there is no "offline mode" to enter.
The app opens straight into **Home**, with everything that lives on your
device:

- **Start something**: a document (any format), a board, a note, or import
  a Word, PDF, Pages, RTF, Markdown or text file.
- **Jump back in**: the documents, boards and notes you last changed,
  newest first. They come from this device and, while connected, from the
  server.
- **Write with others**: the servers you know, each a click away, and the
  two ways to add one (join, or host on this computer).

Documents (with their history, pictures, exports and book publishing),
boards and notes all work with no account and no connection. The first time
you open the app it asks what to call you. That name goes on what you
export and on the boards you make here, and it stays on this device unless
you copy your profile to a server. Settings → Profile adds a picture (shown
at the foot of the rail), an accent colour and a few words about you.

**Servers are accounts you add.** Chat, Sessions and Friends stay in the
rail and say what they need when there's no server. The button at the foot
of the rail is you: the servers you've joined (the one you're on, and the
ones a click away), **Join a server…**, **Host on this computer…**,
**Disconnect** (leave, but stay signed in, so coming back needs no password)
and **Sign out** (forget this device's session). Joining or hosting opens
in a sheet over whatever you have open: your document, board or note stays
exactly where it is, whether you connect or change your mind.

If a server you were signed in to doesn't answer at launch, the app is
already open and the status bar says *Can't reach …* with **Try again**. If
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
on the device, so relaunching the app signs you straight back in. Sessions
last 30 days from their last use on the server side. If one does expire,
the app says so and reopens that server's login with your username filled
in, instead of silently dumping you at the start. Unchecking it keeps the
session for that run only. Logging out always forgets the stored session.

## Account recovery

Locked out? A server admin can issue a one-time reset code for your account
(Settings → Admin). The admin hands it to you out of band and you set a new
password from the sign-in form. Using a code revokes every existing session
for that account.
