import { useEffect, useState } from "react";

/** Friend/group picker + access level; used by the list share dialog and
 *  the local-document publish dialog. Preselects the active group. */
export function SharePicker({
  onShare,
  submitLabel = "Share",
}: {
  onShare: (subjectKind: string, subjectId: number, access: string) => Promise<void>;
  submitLabel?: string;
}) {
  const [friends, setFriends] = useState<{ id: number; label: string }[]>([]);
  const [groups, setGroups] = useState<{ id: number; label: string }[]>([]);
  const [subject, setSubject] = useState("");
  const [access, setAccess] = useState("read");

  useEffect(() => {
    void import("../friends/FriendsView").then(({ friendsApi }) =>
      friendsApi
        .friends()
        .then((fs) =>
          setFriends(
            fs.map((f) => ({ id: f.user.id, label: f.user.display_name ?? f.user.username })),
          ),
        )
        .catch(() => {}),
    );
    void import("../chat/store").then(({ useChat }) => {
      const s = useChat.getState();
      setGroups(s.groups.map((g) => ({ id: g.id, label: g.name })));
      // Preselect the group the user is currently working in.
      if (s.activeGroupId !== null && s.groups.some((g) => g.id === s.activeGroupId)) {
        setSubject((prev) => prev || `group:${s.activeGroupId}`);
      }
    });
  }, []);

  return (
    <form
      className="wf-doc-panel-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (!subject) return;
        const [kind, id] = subject.split(":");
        void onShare(kind, Number(id), access);
      }}
    >
      <select value={subject} onChange={(e) => setSubject(e.target.value)}>
        <option value="" disabled>
          Share with…
        </option>
        {friends.length > 0 && (
          <optgroup label="Friends">
            {friends.map((f) => (
              <option key={`user:${f.id}`} value={`user:${f.id}`}>
                {f.label}
              </option>
            ))}
          </optgroup>
        )}
        {groups.length > 0 && (
          <optgroup label="Groups">
            {groups.map((g) => (
              <option key={`group:${g.id}`} value={`group:${g.id}`}>
                {g.label}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <select value={access} onChange={(e) => setAccess(e.target.value)}>
        <option value="read">can read</option>
        <option value="write">can edit</option>
      </select>
      <button type="submit" className="wf-primary" disabled={!subject}>
        {submitLabel}
      </button>
    </form>
  );
}
