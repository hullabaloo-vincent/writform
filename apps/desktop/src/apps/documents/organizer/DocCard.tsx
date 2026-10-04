import { Check, HardDrive, MoreHorizontal } from "lucide-react";

import { Avatar } from "../../../platform/Avatar";
import { metaLine, type OrgItem } from "./model";

/**
 * A document in the organizer: title, its opening words (or the search
 * match), and "Manuscript · 98,412 words · Oct 3". Opening and the options
 * menu are separate buttons, so both work from the keyboard; Shift+F10 or
 * the context-menu key on the card opens its menu. While selecting, a
 * click (or ⌘/Ctrl/Shift-click any time) selects instead of opening.
 */
export function DocCard({
  item,
  selected,
  selecting,
  extra,
  onOpen,
  onMenu,
  onSelect,
}: {
  item: OrgItem;
  selected: boolean;
  selecting: boolean;
  /** A line under the meta (Recently Deleted's "27 days left"). */
  extra?: string;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  onSelect?: (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => void;
}) {
  const text = item.snippet ?? item.excerpt;
  return (
    <div
      className={`wf-doc-card${selected ? " selected" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <button
        className="wf-doc-card-open"
        aria-pressed={selecting ? selected : undefined}
        onClick={(e) => {
          if (onSelect && (selecting || e.metaKey || e.ctrlKey || e.shiftKey)) onSelect(e);
          else onOpen();
        }}
        onKeyDown={(e) => {
          if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(r.left + 24, r.top + 28);
          }
        }}
      >
        <span className="wf-doc-card-title">
          {item.kind === "local" && <HardDrive size={14} />}
          {item.title || "Untitled"}
        </span>
        {text && <span className="wf-doc-card-excerpt">{text}</span>}
        <span className="wf-doc-card-meta">
          <span>{metaLine(item)}</span>
          {item.access !== "owner" && (
            <span className="wf-doc-card-access">{item.access === "write" ? "can edit" : "read only"}</span>
          )}
        </span>
        {extra && <span className="wf-doc-card-extra">{extra}</span>}
        {item.owner && (
          <span className="wf-doc-card-owner">
            <Avatar
              name={item.owner.display_name ?? item.owner.username}
              attachmentId={item.owner.avatar_attachment_id}
              accentColor={item.owner.accent_color}
              size={16}
            />
            {item.owner.display_name ?? item.owner.username}
          </span>
        )}
      </button>
      {selecting ? (
        <span className="wf-doc-card-check" aria-hidden>
          {selected && <Check size={13} />}
        </span>
      ) : (
        <button
          className="wf-doc-card-kebab"
          title="Options"
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(r.left, r.bottom + 4);
          }}
        >
          <MoreHorizontal size={15} />
        </button>
      )}
    </div>
  );
}
