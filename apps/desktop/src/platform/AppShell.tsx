import { LogIn, LogOut, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

import { backend } from "../lib/backend";
import { useSession } from "../stores/session";
import { Avatar } from "./Avatar";
import { CommandPalette } from "./CommandPalette";
import { usePlatform } from "./registry";
import { Slot } from "./Slot";

/** Slim banner while the server socket is down; resync clears it on its own. */
function ReconnectBanner() {
  const [down, setDown] = useState(false);
  useEffect(() => backend.onWsStatus((connected) => setDown(!connected)), []);
  if (!down) return null;
  return (
    <div className="wf-reconnect-banner">
      <span className="wf-spinner sm" aria-hidden />
      Connection to the server lost — reconnecting…
    </div>
  );
}

const STATUS_OPTIONS = [
  { value: "online", label: "Online", dot: "" },
  { value: "busy", label: "Busy", dot: "busy" },
  { value: "hidden", label: "Invisible", dot: "off" },
] as const;

/** Statusbar identity while working without a server. */
function OfflineStatus() {
  const leaveOffline = useSession((s) => s.leaveOffline);
  return (
    <span className="wf-session-status">
      <span className="wf-offline-label">
        Working Offline <WifiOff size={13} />
      </span>
      <button className="wf-primary" onClick={leaveOffline}>
        <LogIn size={13} /> Connect to a server
      </button>
    </span>
  );
}

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
  const badges = usePlatform((s) => s.badges);
  const offline = useSession((s) => s.phase === "offline");
  const leaveOffline = useSession((s) => s.leaveOffline);

  // Offline: only apps that work without a server appear in the dock.
  const dockApps = offline
    ? mainViewApps.filter((id) => apps[id]?.offline)
    : mainViewApps;

  // Entering offline mode with a server-only app active lands on the first
  // offline-capable one instead of a dead view.
  useEffect(() => {
    if (offline && activeAppId && !apps[activeAppId]?.offline) {
      const first = mainViewApps.find((id) => apps[id]?.offline);
      if (first) setActiveApp(first);
    }
  }, [offline, activeAppId, apps, mainViewApps, setActiveApp]);

  const activeView = activeAppId ? mainViews[activeAppId] : undefined;

  return (
    <div className="wf-shell">
      {!offline && <ReconnectBanner />}
      <div className="wf-body">
        <nav className="wf-rail">
          {dockApps.map((appId) => {
            const manifest = apps[appId];
            if (!manifest) return null;
            const badge = badges[appId] ?? 0;
            return (
              <button
                key={appId}
                className={`wf-rail-item ${appId === activeAppId ? "active" : ""}`}
                title={manifest.name}
                onClick={() => setActiveApp(appId)}
              >
                <span aria-hidden>{manifest.icon}</span>
                {badge > 0 && <span className="wf-btn-badge">{badge > 99 ? "99+" : badge}</span>}
              </button>
            );
          })}
          <Slot name="nav.rail" />
          {offline && (
            <button
              className="wf-rail-item wf-rail-connect"
              title="Connect to a server — your local work stays on this device"
              onClick={leaveOffline}
            >
              <LogIn size={20} />
            </button>
          )}
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
        {offline ? <OfflineStatus /> : <SessionStatus />}
      </footer>
      <CommandPalette />
    </div>
  );
}
