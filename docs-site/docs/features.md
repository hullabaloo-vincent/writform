# Features

## Writing sessions

A session lives in a group channel and holds **multiple prompts**. Anyone in
the group can create a session; each prompt can be started, timed
(10 seconds to 24 hours), and stopped early by its creator or a group admin.

- While a prompt runs, your writing **autosaves** and stays private.
- When it ends, everyone's writing is revealed side by side.
- The prompt editor and your writing area have a full formatting toolbar
  (headings, lists, quotes, inline code, images).
- A **join card** is posted to the channel when a session is created, so
  members can jump in from chat.
- Ended sessions stay browsable forever; the creator or an admin can also
  delete a session permanently.

## Documents

Google-Docs-style collaborative writing, separate from timed sessions.

- **Live multi-user editing**: a CRDT (Yjs) syncs everyone's edits and shows
  live cursors — no lock, no conflicts, no "someone else is editing" wall.
- **Writing formats**: None, Screenplay, Stage Play, Manuscript, or Poetry.
  Each format adds its own element types (scene heading, character,
  dialogue, …) with correct margins and Tab/Enter cycling between them,
  Final-Draft style.
- **Version history**: automatic snapshots as you write, plus named
  versions you save yourself. Any version can be previewed and restored.
- **Folders**: organize your documents; move a document between folders,
  rename or delete a folder (its documents stay put).
- **Search**: full-text — matches titles and document content.
- **Feedback threads**: select text and leave a comment anchored to it;
  threads track the text even as it moves, resolve/reopen, reply inline.
- **Import**: PDF, DOCX, RTF, Pages, TXT, and Markdown files convert into a
  new document (best-effort for PDF/Pages, which are text-only extractions).
- **Export all**: back up every document you can see as Markdown + JSON —
  your writing is never locked in.
- **Sharing**: private by default; the owner grants read or write access to
  individual friends or to a whole group (which also posts a card in that
  group's chat) or shares an entire folder at once.
- **Canvas references**: send a whole document or just a selection to a
  canvas board as a live-updating excerpt card.
- **Documents on this device**: the "On this device" section holds
  single-user documents stored on your computer, never on the server — same
  editor, formats, outline, find, word count, and PDF/DOCX export. **Share
  to server** publishes a copy (optionally shared with a friend or group in
  one step); the local original stays yours and does not live-sync to the
  published copy. While offline, **Import** (PDF, DOCX, RTF, Pages, TXT,
  Markdown) creates documents here too. The reverse works as well:
  right-click any server document → **Save to this device** copies it into
  this section (owners are then offered the option of deleting the server
  copy, turning it into a move). Images aren't supported in local documents
  yet, and "Export all" covers server documents only.

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
- **Custom emotes** per group (admins add them via the emote picker) —
  type `:name:` anywhere.
- **Uploads**: attach, paste, or drag & drop images.
- **Presence**: online / busy / invisible, shown next to every name.
- **Profile cards**: click anyone's name or avatar for their bio, accent
  color, and status.
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

Shared storyboards per group: sticky notes, text, colored frames,
connectors, pasted **images**, **link cards** with server-fetched previews,
and live **document references** (a whole document or a selection, kept in
sync as it's edited). Multi-select with shift-click or shift-drag; moving a
frame moves what's inside it; snap-to-grid toggle; per-element text
formatting (bold/italic/underline, size, alignment, bullets); connectors
have per-side anchors, dashed styles, and arrow/dot end decorations.
Everything syncs live.

## Notes

A local, Obsidian-compatible markdown vault with `[[wiki-links]]` and
backlinks. Share a note snapshot to a friend over DM; they can save it into
their own vault.

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
the notes vault, on-device documents, the portable profile, hosting, and
plugins.

## Working offline

You don't need a server to write. **Work offline** on the connect screen
opens the app with Notes, your on-device documents, the documentation
viewer, and your portable profile — no account, no connection. Everything
you write is on your computer; when you later join a server, local
documents can be shared to it and your portable profile applied. While
offline, the portable profile's text fields are editable (its images update
from a connected server), and server features — chat, shared documents,
canvas, sessions — appear once you connect.

## Account recovery

Locked out? A server admin can issue a one-time reset code for your account
(Settings → Admin) — hand it to you out of band and you set a new password
from the connect screen. Using a code revokes every existing session for
that account.
