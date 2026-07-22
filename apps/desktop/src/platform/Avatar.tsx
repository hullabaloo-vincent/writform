/**
 * User/group avatar: the uploaded image when set, otherwise initials over the
 * accent color (or a stable color derived from the name).
 */

import { attachmentUrl } from "../lib/backend";

const PALETTE = ["#8ab6e8", "#93d3a2", "#e8d478", "#e89ab0", "#b7a3ea", "#7fd0c9"];

function fallbackColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function Avatar({
  name,
  attachmentId,
  accentColor,
  size = 24,
  singleInitial = false,
}: {
  /** Display name or username — used for initials + fallback color. */
  name: string;
  attachmentId?: number | null;
  accentColor?: string | null;
  size?: number;
  /** One letter instead of two — reads better in large call tiles. */
  singleInitial?: boolean;
}) {
  const style: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
  };
  if (attachmentId != null) {
    return (
      <img
        className="wf-avatar"
        style={{ ...style, objectFit: "cover" }}
        src={attachmentUrl(attachmentId)}
        alt={name}
        draggable={false}
      />
    );
  }
  return (
    <span
      className="wf-avatar"
      style={{
        ...style,
        display: "inline-grid",
        placeItems: "center",
        background: accentColor ?? fallbackColor(name),
        color: "rgba(0, 0, 0, 0.75)",
        fontSize: Math.max(9, Math.round(size * 0.42)),
        fontWeight: 700,
        userSelect: "none",
      }}
      aria-hidden
    >
      {singleInitial ? initials(name).slice(0, 1) : initials(name)}
    </span>
  );
}
