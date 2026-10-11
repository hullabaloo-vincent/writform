import { Check, Globe, HardDrive, LogOut, Unplug, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { backend, isMobileApp, type HostStatus, type SavedServer } from "../lib/backend";
import { useLocalProfile } from "../stores/localProfile";
import { useSession } from "../stores/session";
import { Avatar } from "./Avatar";
import { confirmDialog } from "./confirm";

/**
 * Who you are and where you're connected: you, the servers you know (the
 * one you're on, and the ones a click away), and the ways to add another.
 * At the foot of the rail on a desktop; inside "All apps" on a phone.
 */
export function AccountMenu({ inline = false, onNavigate }: { inline?: boolean; onNavigate?: () => void }) {
  const [open, setOpen] = useState(inline);
  const wrapRef = useRef<HTMLDivElement>(null);
  const session = useSession((s) => s.session);
  const link = useSession((s) => s.link);
  const target = useSession((s) => s.target);
  const me = useLocalProfile((s) => s.name);
  const myPicture = useLocalProfile((s) => s.avatar);
  const myAccent = useLocalProfile((s) => s.accent);
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [host, setHost] = useState<HostStatus | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void Promise.all([backend.listServers(), backend.hostStatus()])
      .then(([list, status]) => {
        if (!live) return;
        setServers(list);
        setHost(status);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, link]);

  useEffect(() => {
    if (!open || inline) return;
    const onPointer = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, inline]);

  const done = () => {
    if (!inline) setOpen(false);
    onNavigate?.();
  };
  const store = useSession.getState;
  const hostedAddr = host?.configured ? `127.0.0.1:${host.port}` : null;
  const displayName = session ? (session.user.display_name ?? session.user.username) : me || "You";

  const openServer = (s: SavedServer) => {
    done();
    if (session?.addr === s.addr) return;
    if (s.signed_in) void store().resume(s.addr, s.server_name);
    else store().openConnect({ addr: s.addr });
  };

  const signOut = async () => {
    done();
    const ok = await confirmDialog(
      `Sign out of ${session?.addr ?? "this server"}? You'll need your password to come back. What's on this device stays.`,
      { title: "Sign out", confirmLabel: "Sign out" },
    );
    if (ok) void store().logout();
  };

  const panel = (
    <div className={`wf-account-panel${inline ? " inline" : ""}`} role={inline ? undefined : "menu"}>
      <div className="wf-account-me">
        <Avatar
          name={displayName}
          attachmentId={session?.user.avatar_attachment_id ?? null}
          src={session ? null : myPicture}
          accentColor={session ? (session.user.accent_color ?? null) : myAccent}
          size={34}
        />
        <span>
          <strong>{displayName}</strong>
          <small>
            {link === "connected" && session
              ? `${session.user.username} @ ${session.addr}`
              : link === "resuming"
                ? `Reconnecting to ${target?.name ?? "the server"}…`
                : link === "unreachable"
                  ? `Can't reach ${target?.name ?? "the server"}`
                  : link === "expired"
                    ? `Signed out of ${target?.name ?? "the server"}`
                    : "On this device"}
          </small>
        </span>
      </div>

      {(servers.length > 0 || host?.configured) && (
        <div className="wf-account-group">
          <span className="wf-account-label">Servers</span>
          {servers.map((s) => {
            const current = link === "connected" && session?.addr === s.addr;
            const own = s.addr === hostedAddr;
            return (
              <button key={s.addr} className="wf-account-item" role="menuitem" onClick={() => openServer(s)}>
                <span className="wf-account-icon">{current ? <Check size={15} /> : own ? <HardDrive size={15} /> : <Globe size={15} />}</span>
                <span className="wf-account-text">
                  {s.server_name}
                  <small>
                    {current
                      ? "Connected"
                      : own && host && !host.running
                        ? "This computer · stopped"
                        : s.signed_in
                          ? `${own ? "This computer · " : ""}Connect${s.last_username ? ` as ${s.last_username}` : ""}`
                          : `${own ? "This computer · " : ""}Sign in`}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="wf-account-group">
        <button
          className="wf-account-item"
          role="menuitem"
          onClick={() => {
            done();
            store().openConnect();
          }}
        >
          <span className="wf-account-icon">
            <Globe size={15} />
          </span>
          <span className="wf-account-text">Join a server…</span>
        </button>
        {!isMobileApp && !host?.configured && (
          <button
            className="wf-account-item"
            role="menuitem"
            onClick={() => {
              done();
              store().openConnect({ host: true });
            }}
          >
            <span className="wf-account-icon">
              <HardDrive size={15} />
            </span>
            <span className="wf-account-text">Host on this computer…</span>
          </button>
        )}
      </div>

      {link === "connected" && (
        <div className="wf-account-group">
          <button
            className="wf-account-item"
            role="menuitem"
            onClick={() => {
              done();
              void store().disconnect();
            }}
          >
            <span className="wf-account-icon">
              <Unplug size={15} />
            </span>
            <span className="wf-account-text">
              Disconnect
              <small>Stay signed in and work on this device</small>
            </span>
          </button>
          <button className="wf-account-item" role="menuitem" onClick={() => void signOut()}>
            <span className="wf-account-icon">
              <LogOut size={15} />
            </span>
            <span className="wf-account-text">Sign out</span>
          </button>
        </div>
      )}
    </div>
  );

  if (inline) return panel;
  return (
    <div className="wf-account" ref={wrapRef}>
      <button
        className={`wf-rail-item wf-account-button${open ? " active" : ""}`}
        title={`${displayName}: account and servers`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {session ? (
          <Avatar
            name={displayName}
            attachmentId={session.user.avatar_attachment_id}
            accentColor={session.user.accent_color}
            size={28}
          />
        ) : me || myPicture ? (
          <Avatar name={me || "You"} src={myPicture} accentColor={myAccent} size={28} />
        ) : (
          <UserRound size={20} />
        )}
        <span className={`wf-account-dot ${link}`} aria-hidden />
      </button>
      {open && panel}
    </div>
  );
}
