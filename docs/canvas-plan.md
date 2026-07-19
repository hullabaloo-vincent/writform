# Freeform canvas / storyboarding — plan & implementation notes

Status: **v1 implemented** as a platform app (`apps/desktop/src/apps/canvas/`),
server side in `crates/writform-server/src/routes/canvas.rs` + migration
`0002_canvas.sql`, covered by `tests/canvas_flow.rs`. The sections below are
the original plan annotated with what shipped and what was deliberately
deferred.

## What shipped in v1

- **Boards per group** — create/open/delete (creator or group admin deletes),
  live board list via `canvas.board.*` events on the group room.
- **Elements:** sticky notes (5 colors), text blocks, named frames, and
  connectors (arrows between two elements). Drag, resize, double-click text
  editing, bring-to-front, delete (toolbar or Delete key).
- **Realtime:** server-authoritative element rows updated **last-write-wins**
  over REST, fanned out on the `canvas:{board_id}` WS room; drags are
  throttled (~8 updates/s) with a final commit on release. Elements held
  locally (mid-drag) ignore remote echoes.
- **Viewport:** pan (drag background), zoom (wheel/pinch + toolbar, 20–250%).
- **Permissions:** board access = group membership, enforced on every route
  and on WS room subscription.

**v1 uses LWW rows, not a CRDT.** Whole-element last-write-wins is the right
cost/benefit for storyboarding (elements are small and rarely co-edited);
the CRDT design below remains the upgrade path if per-character text merging
or offline editing becomes a requirement. Rendering is DOM + an SVG layer for
connectors rather than Canvas2D — free text editing/accessibility, and boards
of hundreds of elements don't need more.

**Not yet:** image elements, freehand ink, presence cursors, undo/redo,
per-board view-only flag, "present" mode. These are the next milestones.

## Goals

A Figma-/FigJam-style collaborative board for **storyboarding and concept
work** around writing sessions: arranging scene cards, character maps, mood
boards, plot threads. Not a general design tool.

**Non-goals (v1):** vector path editing, components/variants, auto-layout,
comments/threads, export fidelity. Cut ruthlessly; this is a story tool.

## Element types (v1)

- **Sticky note** (colored, markdown-lite text)
- **Text block** (free text, larger)
- **Image** (attachment-backed, `writform-att://`)
- **Frame** (named container for grouping — acts as storyboard panel)
- **Connector** (arrow between elements — plot/relationship lines)
- **Freehand ink** (simple polyline, pressure ignored)

## Data model & sync — CRDT

Concurrent editing with offline tolerance ⇒ CRDT, not OT.

- **Choice to evaluate first: `yrs`** (Rust port of Yjs) on both the client
  core and optionally server-side for compaction; Yjs on the webview side via
  `y-protocols` messages. Automerge is the fallback if yrs' map/array types
  prove awkward for the scene graph.
- Scene = `Y.Map<elementId, Y.Map>` (type, x, y, w, h, rotation, props),
  z-order as a `Y.Array<elementId>`, per-element text as `Y.Text`.
- **Transport:** Yjs update messages as binary WS frames over the existing
  socket, room `canvas:{board_id}` (new `bin` op in the envelope, or a
  parallel `/api/v1/canvas/{id}/sync` WS). Server relays updates to the room
  and appends them to an update log.
- **Persistence:** `canvas_boards` (id, group_id, name, created_by) +
  `canvas_updates` (board_id, seq, bytes) + periodic snapshot row
  (`canvas_snapshots`) so joins are O(snapshot + tail), with tail compaction
  on snapshot. All SQLite, same DB.
- **Presence cursors:** ephemeral — Yjs awareness protocol relayed through
  the room, never persisted.

## Rendering

- **Canvas2D first** (single `<canvas>`, retained scene graph in memory,
  dirty-rect redraws). Boards of a few hundred elements don't need WebGL;
  revisit only if profiling says so.
- Viewport culling + LOD text (skip text layout below zoom threshold).
- Hit testing on the scene graph (not DOM).

## Permissions

- Board belongs to a group; group members edit, admins delete/rename.
- Per-board "view-only" flag for sharing finished boards.

## Undo/redo

Yjs `UndoManager` scoped to the local client's transactions (standard CRDT
practice — undo undoes *your* changes, not your collaborator's).

## Milestones

1. **M1 — solo board:** create/open board, sticky/text/image elements, pan/
   zoom, drag, persistence via snapshot only. No realtime.
2. **M2 — realtime:** yrs sync over WS room, presence cursors, update log +
   compaction, undo manager.
3. **M3 — story tools:** frames as storyboard panels, connectors, freehand,
   "present" mode walking frames in order.
4. **M4 — integration:** attach a board to a writing session (panel.right
   slot), link canvas elements to notes (`[[note]]` on a sticky opens the
   vault note).

## Risks

- **CRDT payload growth** — mitigated by snapshot+compaction from day one.
- **Canvas text editing** — use an overlay DOM textarea during edit, render
  to canvas on commit (the standard whiteboard trick).
- **Binary frames through the existing WS envelope** — decide early: extend
  the envelope with a binary op vs a second socket; prototype in M2 week 1.
