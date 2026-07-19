import { LogOut } from "lucide-react";
import { useState } from "react";

import { backend } from "../lib/backend";
import { useSession } from "../stores/session";
import { Avatar } from "./Avatar";
import { CommandPalette } from "./CommandPalette";
import { usePlatform } from "./registry";
import { Slot } from "./Slot";

const STATUS_OPTIONS = [
  { value: "online", label: "Online", dot: "" },
  { value: "busy", label: "Busy", dot: "busy" },
  { value: "hidden", label: "Invisible", dot: "off" },
] as const;

function SessionStatus() {
  const session = useSession((s) => s.session);
  const setConnected = useSession((s) => s.setConnected);
  const logout = useSession((s) => s.logout);
  const [open, setOpen] = useState(false);
  if (!session) return null;
  const current =
    STATUS_OPTIONS.find((o) => o.value === session.user.status) ?? STATUS_OPTIONS[0];

  const pick = (value: string) => {
    setOpen(false);
    void backend
      .apiFetch("PUT", "/api/v1/auth/status", { status: value })
      .then((res) => {
        if (res.status < 400) {
          setConnected({ ...session, user: res.body as typeof session.user });
        }
      })
      .catch(() => {});
  };

  return (
    <span className="wf-session-status">
      <button
        className="wf-status-toggle"
        title={`Status: ${current.label} — click to change`}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar
          name={session.user.display_name ?? session.user.username}
          attachmentId={session.user.avatar_attachment_id}
          accentColor={session.user.accent_color}
          size={16}
        />
        <span className={`wf-presence-dot ${current.dot}`} />
        {session.user.username}
      </button>
      {open && (
        <span className="wf-status-menu">
          {STATUS_OPTIONS.map((o) => (
            <button key={o.value} onClick={() => pick(o.value)}>
              <span className={`wf-presence-dot ${o.dot}`} /> {o.label}
            </button>
          ))}
        </span>
      )}
      <span className="wf-session-addr">@ {session.addr}</span>
      <button onClick={() => void logout()} title="Log out">
        <LogOut size={13} />
      </button>
    </span>
  );
}

/**
 * The OS-like chrome: nav rail (dock) on the left, active app's main view in
 * the center, right panel and statusbar slots around it.
 */
export function AppShell() {
  const apps = usePlatform((s) => s.apps);
  const mainViewApps = usePlatform((s) => s.mainViewApps);
  const mainViews = usePlatform((s) => s.mainViews);
  const activeAppId = usePlatform((s) => s.activeAppId);
  const setActiveApp = usePlatform((s) => s.setActiveApp);

  const activeView = activeAppId ? mainViews[activeAppId] : undefined;

  return (
    <div className="wf-shell">
      <div className="wf-body">
        <nav className="wf-rail">
          {mainViewApps.map((appId) => {
            const manifest = apps[appId];
            if (!manifest) return null;
            return (
              <button
                key={appId}
                className={`wf-rail-item ${appId === activeAppId ? "active" : ""}`}
                title={manifest.name}
                onClick={() => setActiveApp(appId)}
              >
                <span aria-hidden>{manifest.icon}</span>
              </button>
            );
          })}
          <Slot name="nav.rail" />
        </nav>
        <main className="wf-main">
          {activeView ? activeView() : <div className="wf-main-empty">No app selected</div>}
        </main>
        <aside className="wf-panel-right">
          <Slot name="panel.right" />
        </aside>
      </div>
      <footer className="wf-statusbar">
        <Slot name="statusbar" />
        <span className="wf-statusbar-spacer" />
        <SessionStatus />
      </footer>
      <CommandPalette />
    </div>
  );
}
