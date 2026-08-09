import { useEffect, useState } from "react";
import { create } from "zustand";

import type { UserProfile } from "../bindings/proto/UserProfile";
import { attachmentUrl, backend, isCmdError, type CmdError } from "../lib/backend";
import { useSession } from "../stores/session";
import { Avatar } from "./Avatar";
import { Loading } from "./Loading";
import { Modal } from "./Modal";
import { usePlatform } from "./registry";

/** How the viewer relates to the profiled user — drives the action row.
 *  "unknown" (fetch failed, offline) simply shows no actions. */
type Relation =
  | { kind: "loading" }
  | { kind: "self" }
  | { kind: "friends" }
  | { kind: "outgoing" }
  | { kind: "incoming"; requestId: number }
  | { kind: "none" }
  | { kind: "unknown" };

/**
 * Profile card: click any user (member list, message author, friend) to see
 * their banner, avatar, status, bio, and member-since date.
 */

const useProfileCard = create<{ userId: number | null }>(() => ({ userId: null }));

export function showProfile(userId: number): void {
  useProfileCard.setState({ userId });
}

const STATUS_LABEL: Record<string, string> = { online: "Online", busy: "Busy" };

export function ProfileCardHost() {
  const userId = useProfileCard((s) => s.userId);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [relation, setRelation] = useState<Relation>({ kind: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setProfile(null);
    setError(null);
    if (userId === null) return;
    let live = true;
    backend
      .apiFetch("GET", `/api/v1/users/${userId}/profile`)
      .then((res) => {
        if (!live) return;
        if (res.status >= 400) {
          const err = (res.body ?? {}) as Partial<CmdError>;
          setError(err.message ?? "profile unavailable");
        } else {
          setProfile(res.body as UserProfile);
        }
      })
      .catch((e) => live && setError(isCmdError(e) ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [userId]);

  // Where do we stand with this person? (Drives Message / Add friend.)
  useEffect(() => {
    setRelation({ kind: "loading" });
    setActionError(null);
    if (userId === null) return;
    const meId = useSession.getState().session?.user.id;
    if (meId === undefined) {
      setRelation({ kind: "unknown" });
      return;
    }
    if (userId === meId) {
      setRelation({ kind: "self" });
      return;
    }
    let live = true;
    // Lazy import: platform code must not statically pull app modules.
    void import("../apps/friends/FriendsView")
      .then(({ friendsApi }) =>
        Promise.all([friendsApi.friends(), friendsApi.requests()]),
      )
      .then(([friends, requests]) => {
        if (!live) return;
        if (friends.some((f) => f.user.id === userId)) {
          setRelation({ kind: "friends" });
        } else if (requests.outgoing.some((r) => r.to.id === userId)) {
          setRelation({ kind: "outgoing" });
        } else {
          const incoming = requests.incoming.find((r) => r.from.id === userId);
          setRelation(incoming ? { kind: "incoming", requestId: incoming.id } : { kind: "none" });
        }
      })
      .catch(() => live && setRelation({ kind: "unknown" }));
    return () => {
      live = false;
    };
  }, [userId]);

  if (userId === null) return null;
  const close = () => useProfileCard.setState({ userId: null });
  const name = profile?.display_name ?? profile?.username ?? "";

  const message = () => {
    close();
    void import("../apps/friends/store").then(({ useFriends }) => {
      useFriends.getState().requestDm(userId);
      usePlatform.getState().setActiveApp("writform.friends");
    });
  };

  const addFriend = () => {
    const username = profile?.username;
    if (!username) return;
    setActionError(null);
    setRelation({ kind: "outgoing" }); // optimistic; reverted on failure
    void import("../apps/friends/FriendsView").then(({ friendsApi }) =>
      friendsApi.send(username).catch((e: unknown) => {
        setRelation({ kind: "none" });
        setActionError(isCmdError(e) ? e.message : "Couldn't send the request.");
      }),
    );
  };

  const acceptRequest = (requestId: number) => {
    setActionError(null);
    void import("../apps/friends/FriendsView").then(({ friendsApi }) =>
      friendsApi
        .accept(requestId)
        .then(() => setRelation({ kind: "friends" }))
        .catch((e: unknown) =>
          setActionError(isCmdError(e) ? e.message : "Couldn't accept the request."),
        ),
    );
  };

  return (
    <Modal boxClass="wf-profile-card" onClose={close}>
      {error ? (
        <p className="wf-connect-error" style={{ margin: 16 }}>
          {error}
        </p>
      ) : !profile ? (
        <Loading />
      ) : (
        <>
          <div
            className="wf-profile-banner"
            style={{ background: profile.accent_color ?? "var(--wf-accent)" }}
          >
            {profile.banner_attachment_id != null && (
              <img
                className="wf-profile-banner-img"
                src={attachmentUrl(profile.banner_attachment_id)}
                alt=""
                draggable={false}
              />
            )}
          </div>
          <div className="wf-profile-avatar">
            <Avatar
              name={name}
              attachmentId={profile.avatar_attachment_id}
              accentColor={profile.accent_color}
              size={72}
            />
          </div>
          <div className="wf-profile-body">
            <h3>
              {name}
              <span
                className={`wf-presence-dot ${
                  profile.status === "busy" ? "busy" : profile.status ? "" : "off"
                }`}
                title={profile.status ? STATUS_LABEL[profile.status] : "Offline"}
              />
            </h3>
            <p className="wf-profile-username">
              @{profile.username}
              <span className="wf-session-meta">
                {" · "}
                {profile.status ? STATUS_LABEL[profile.status] : "Offline"}
              </span>
            </p>
            {actionError && <p className="wf-connect-error">{actionError}</p>}
            {(relation.kind === "friends" ||
              relation.kind === "none" ||
              relation.kind === "outgoing" ||
              relation.kind === "incoming") && (
              <div className="wf-profile-actions">
                {relation.kind === "friends" && (
                  <button className="wf-primary" onClick={message}>
                    Message
                  </button>
                )}
                {relation.kind === "none" && (
                  <button className="wf-primary" onClick={addFriend}>
                    Add friend
                  </button>
                )}
                {relation.kind === "outgoing" && (
                  <button disabled>Friend request sent</button>
                )}
                {relation.kind === "incoming" && (
                  <button
                    className="wf-primary"
                    onClick={() => acceptRequest(relation.requestId)}
                  >
                    Accept friend request
                  </button>
                )}
              </div>
            )}
            {profile.bio && <p className="wf-profile-bio">{profile.bio}</p>}
            <p className="wf-profile-since">
              Member since{" "}
              {new Date(profile.created_at).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </p>
          </div>
        </>
      )}
    </Modal>
  );
}
