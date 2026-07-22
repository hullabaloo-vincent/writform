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

## Chat

Groups work like small Discord servers: channels, invites, roles.

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
  kick members and manage channels.
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

- **Profile**: avatar, accent color, bio, and status (Settings → Profile).
  Your accent tints your name in chat.
- **Groups**: admins set a group icon and accent color (gear next to the
  group name).

## Account recovery

Locked out? A server admin can issue a one-time reset code for your account
(Settings → Admin) — hand it to you out of band and you set a new password
from the connect screen. Using a code revokes every existing session for
that account.
