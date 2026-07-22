import { useChat } from "./store";

/** Small "current group" indicator for app headers outside Chat, so it's
 *  always clear which group boards/sessions/shares belong to. */
export function GroupChip() {
  const groups = useChat((s) => s.groups);
  const activeGroupId = useChat((s) => s.activeGroupId);
  const group = groups.find((g) => g.id === activeGroupId);
  if (!group) return null;
  return (
    <span className="wf-group-chip" title={`Working in ${group.name}`}>
      <span
        className="wf-group-chip-dot"
        style={{ background: group.accent_color ?? "var(--wf-accent)" }}
      />
      {group.name}
    </span>
  );
}
