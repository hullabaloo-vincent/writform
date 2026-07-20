import { Trash2, Users, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { Friend } from "../../bindings/proto/Friend";
import { isCmdError } from "../../lib/backend";
import { Avatar } from "../../platform/Avatar";
import { useChat } from "../chat/store";
import { friendsApi } from "../friends/FriendsView";
import { documentsApi } from "./api";
import { useDocuments } from "./store";

/**
 * Owner-only sharing: grant read or write to individual friends or to a
 * whole group. Group shares also drop a document card into the group's chat.
 */
export function ShareDialog({ onClose }: { onClose: () => void }) {
  const docId = useDocuments((s) => s.activeDocId);
  const shares = useDocuments((s) => s.shares);
  const refreshShares = useDocuments((s) => s.refreshShares);
  const refreshActivity = useDocuments((s) => s.refreshActivity);
  const groups = useChat((s) => s.groups);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void friendsApi.friends().then(setFriends).catch(() => {});
  }, []);

  if (docId === null) return null;

  const shareOf = (kind: string, id: number) =>
    shares.find((s) => s.subject_kind === kind && s.subject_id === id);

  const setShare = async (kind: string, id: number, access: string) => {
    try {
      await documentsApi.setShare(docId, { subject_kind: kind, subject_id: id, access });
      await refreshShares();
      await refreshActivity();
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
    }
  };

  const revoke = async (kind: string, id: number) => {
    try {
      await documentsApi.deleteShare(docId, kind, id);
      await refreshShares();
      await refreshActivity();
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
    }
  };

  const row = (
    kind: string,
    id: number,
    label: React.ReactNode,
  ) => {
    const existing = shareOf(kind, id);
    return (
      <li key={`${kind}:${id}`} className="wf-doc-share-row">
        {label}
        <span className="wf-statusbar-spacer" />
        <select
          value={existing?.access ?? ""}
          onChange={(e) => {
            if (e.target.value) void setShare(kind, id, e.target.value);
          }}
        >
          <option value="" disabled>
            not shared
          </option>
          <option value="read">can read</option>
          <option value="write">can edit</option>
        </select>
        {existing && (
          <button className="wf-icon" title="Revoke access" onClick={() => void revoke(kind, id)}>
            <Trash2 size={14} />
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="wf-modal-backdrop" onClick={onClose}>
      <div className="wf-modal wf-doc-share-modal" onClick={(e) => e.stopPropagation()}>
        <header className="wf-doc-panel-header">
          <h3>Share document</h3>
          <span className="wf-statusbar-spacer" />
          <button className="wf-icon" onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        {error && (
          <p className="wf-connect-error" onClick={() => setError(null)}>
            {error}
          </p>
        )}
        <h4>Friends</h4>
        <ul className="wf-doc-share-list">
          {friends.map((f) =>
            row(
              "user",
              f.user.id,
              <span className="wf-doc-share-name">
                <Avatar
                  name={f.user.display_name ?? f.user.username}
                  attachmentId={f.user.avatar_attachment_id}
                  accentColor={f.user.accent_color}
                  size={20}
                />
                {f.user.display_name ?? f.user.username}
              </span>,
            ),
          )}
          {friends.length === 0 && (
            <li className="wf-friend-dim">No friends to share with yet.</li>
          )}
        </ul>
        <h4>Groups</h4>
        <ul className="wf-doc-share-list">
          {groups.map((g) =>
            row(
              "group",
              g.id,
              <span className="wf-doc-share-name">
                <Users size={16} /> {g.name}
              </span>,
            ),
          )}
          {groups.length === 0 && <li className="wf-friend-dim">You're not in any groups.</li>}
        </ul>
        <p className="wf-doc-share-note">
          Sharing with a group posts a card in its chat so members can open the document.
        </p>
      </div>
    </div>
  );
}
