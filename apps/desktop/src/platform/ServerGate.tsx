import { Globe, HardDrive, RefreshCw } from "lucide-react";

import { isMobileApp } from "../lib/backend";
import { useSession } from "../stores/session";
import type { AppManifest } from "./types";

/**
 * What a server-only app (Chat, Sessions, Friends) shows while there's no
 * server: not a dead end and not a missing icon, but what it is and the two
 * ways in. The apps that work on this device are untouched by any of this.
 */
export function ServerGate({ app }: { app: AppManifest }) {
  const link = useSession((s) => s.link);
  const target = useSession((s) => s.target);
  const openConnect = useSession((s) => s.openConnect);
  const retry = useSession((s) => s.retry);
  const name = target?.name ?? "the server";

  return (
    <div className="wf-gate">
      <div className="wf-gate-card">
        <span className="wf-gate-icon" aria-hidden>
          {app.icon}
        </span>
        <h2>{app.name} happens on a server</h2>
        {link === "resuming" && (
          <p className="wf-gate-status">
            <span className="wf-spinner sm" aria-hidden /> Reconnecting to {name}…
          </p>
        )}
        {link === "unreachable" && (
          <>
            <p>
              <strong>{name}</strong> isn’t answering. It may be switched off, or you may be away from its
              network. Everything on this device still works.
            </p>
            <div className="wf-gate-actions">
              <button className="wf-primary" onClick={() => void retry()}>
                <RefreshCw size={15} /> Try again
              </button>
              <button onClick={() => openConnect()}>Choose another server</button>
            </div>
          </>
        )}
        {link === "expired" && (
          <>
            <p>
              You’ve been signed out of <strong>{name}</strong>. Sign in again to pick up where you left off.
            </p>
            <div className="wf-gate-actions">
              <button className="wf-primary" onClick={() => openConnect({ addr: target?.addr, expired: true })}>
                Sign in
              </button>
              <button onClick={() => openConnect()}>Choose another server</button>
            </div>
          </>
        )}
        {link === "local" && (
          <>
            <p>
              Writing together — chat, voice, live sessions, shared documents and boards — runs on a server
              that one of you keeps. Join one you’ve been invited to, or start your own. What you write on
              this device stays here either way.
            </p>
            <div className="wf-gate-actions">
              <button className="wf-primary" onClick={() => openConnect()}>
                <Globe size={15} /> Join a server
              </button>
              {!isMobileApp && (
                <button onClick={() => openConnect({ host: true })}>
                  <HardDrive size={15} /> Host on this computer
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
