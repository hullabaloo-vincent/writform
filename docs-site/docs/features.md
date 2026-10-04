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
  each heading); scene breaks are `* * *` + Enter or the toolbar button. You
  write meaning, not layout: indents, fonts and spacing come from the book's
  design, so editing the text can't break the book. In Manuscript, Tab only
  changes an *empty* line's element (it never turns a sentence into a
  heading), and pasted headings and `***` lines become chapters and scene
  breaks.
- **Smart quotes and dashes** as you type (Settings ▸ Writing to turn off):
  curly quotes in the book's language style, `--` → —, `...` → ….
- **Make it a book manuscript**: switching a Plain document to Manuscript (or
  Export ▸ Make it a book manuscript…) detects chapters, parts, scene breaks
  and front matter and shows what it found before converting — one undo puts
  it back. Importing a Word manuscript does the same automatically.
- **Book inspector** (the book button, Manuscript): the book's details (title,
  author, series, ISBNs, copyright, dedication, epigraph, also-by, about the
  author, submission contact), its **design** (five presets — Classic,
  Literary, Fantasy, Romance, Modern — with every choice adjustable: fonts,
  size, leading, chapter labels, drop caps, small-caps lead-ins, ornaments,
  running heads, page numbers), **print** settings (trim size, KDP-safe
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
  Play; and the **Submission manuscript** (Standard Manuscript Format) as PDF
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
- **Typography** (Plain format): set font (Times, Palatino, Garamond,
  Libertinus, Baskerville, Literata, Sans, Typewriter, Comic Sans), size, and
  alignment — left, center, right, justify (⌘⇧L/E/R/J) — on the selected
  paragraphs, plus line spacing, space before/after, and a **drop cap** for
  chapter openers (all in the inspector). Select-all restyles the whole
  document; the scripted formats keep their own professional layouts.
- **Document inspector** (the sliders button, Plain format): Pages-style
  settings saved *in* the document, so collaborators see the same layout.
  Text tab: the full paragraph styles for the selection. Document tab:
  paper size (US Letter, Half Letter, US Trade 6×9, A4, A5), margins, and
  body-text defaults — font, size, line spacing, paragraph spacing, and a
  first-line indent (set indent + 0 pt spacing for the classic book look).
- **Page view** (Plain and the scripted formats): the page toggle paginates
  the sheet into real pages — physical gaps between them, page numbers on
  the left, the exact count in the word-count bar.
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
  rename or delete a folder (its documents stay put).
- **Search**: full-text — matches titles and the words of every document
  (never the editor's internal markup), with the matching passage shown.
- **Feedback threads**: select text and leave a comment anchored to it;
  threads track the text even as it moves, resolve/reopen, reply inline,
  and list in the order they appear in the text. Click a highlighted
  passage to open its thread. The highlighter button in the panel header
  shows or hides the anchor highlights — and on-device documents have the
  same panel as **Notes**: comments to your future editing self.
- **Import**: PDF, DOCX, RTF, Pages, TXT, and Markdown files convert into
  new documents — several at once, into the folder you have open. PDF import
  recovers structure, not just text; Word import keeps italics, alignment,
  page breaks and styles, and a Word *manuscript* arrives as a Manuscript
  with its chapters detected.
- **Booklet export** (Plain and scripted formats): beside the straight PDF,
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
  the document, so history works with no server and no connection. **Share
  to server** publishes a copy (optionally shared with a friend or group in
  one step); the local original stays yours and does not live-sync to the
  published copy. While offline, **Import** creates documents here too. The
  reverse works as well: any server document's menu → **Save a copy to this
  device**. Images aren't supported in local documents yet.

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
device; the round trip is lossless, which also makes it the way to publish a
board from this device to a group, or move boards between servers. The board
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
group boards.

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

## Working offline

You don't need a server to write. **Work offline** on the connect screen
opens the app with Notes, your on-device documents (version history and
all), on-device canvas boards, the documentation viewer, and your portable
profile — no account, no connection. Everything
you write is on your computer; when you later join a server, local
documents can be shared to it and your portable profile applied. While
offline, the portable profile's text fields are editable (its images update
from a connected server), and server features — chat, shared documents,
canvas, sessions — appear once you connect.

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
from the connect screen. Using a code revokes every existing session for
that account.
