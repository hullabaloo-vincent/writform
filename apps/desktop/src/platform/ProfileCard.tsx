import { useEffect, useState } from "react";
import { create } from "zustand";

import type { UserProfile } from "../bindings/proto/UserProfile";
import { backend, isCmdError, type CmdError } from "../lib/backend";
import { Avatar } from "./Avatar";

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

  if (userId === null) return null;
  const close = () => useProfileCard.setState({ userId: null });
  const name = profile?.display_name ?? profile?.username ?? "";

  return (
    <div className="wf-modal-backdrop" onClick={close}>
      <div className="wf-profile-card" onClick={(e) => e.stopPropagation()}>
        {error ? (
          <p className="wf-connect-error" style={{ margin: 16 }}>
            {error}
          </p>
        ) : !profile ? (
          <p className="wf-session-meta" style={{ margin: 16 }}>
            Loading…
          </p>
        ) : (
          <>
            <div
              className="wf-profile-banner"
              style={{ background: profile.accent_color ?? "var(--wf-accent)" }}
            />
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
      </div>
    </div>
  );
}
