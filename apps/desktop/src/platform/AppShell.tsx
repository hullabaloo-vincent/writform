import { HardDrive, LayoutGrid, LogIn, RefreshCw, WifiOff } from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import { ConnectSheet } from "../connect/ConnectSheet";
import { useIsPhone } from "../editor/ui/Flyout";

import { backend, isMobileApp, isWeb } from "../lib/backend";
import { haptic } from "../lib/haptics";
import { announceUpdateOnLaunch } from "../lib/updates";
import { useSession } from "../stores/session";
import { AccountMenu } from "./AccountMenu";
import { Avatar } from "./Avatar";
import { CommandPalette } from "./CommandPalette";
import { usePlatform } from "./registry";
import { ServerGate } from "./ServerGate";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { Slot } from "./Slot";

/** Slim banner while the server socket is down; resync clears it on its own. */
function ReconnectBanner() {
  const [down, setDown] = useState(false);
  useEffect(() => backend.onWsStatus((connected) => setDown(!connected)), []);
  if (!down) return null;
  return (
    <div className="wf-reconnect-banner">
      <span className="wf-spinner sm" aria-hidden />
      Connection to the server lost. Reconnecting…
    </div>
  );
}

const STATUS_OPTIONS = [
  { value: "online", label: "Online", dot: "" },
  { value: "busy", label: "Busy", dot: "busy" },
  { value: "hidden", label: "Invisible", dot: "off" },
] as const;

/** Where the app stands with a server while it isn't connected to one. */
function LinkStatus() {
  const link = useSession((s) => s.link);
  const target = useSession((s) => s.target);
  const openConnect = useSession((s) => s.openConnect);
  const retry = useSession((s) => s.retry);
  const name = target?.name ?? "the server";
  if (link === "resuming") {
    return (
      <span className="wf-session-status">
        <span className="wf-spinner sm" aria-hidden /> Reconnecting to {name}…
      </span>
    );
  }
  if (link === "unreachable") {
    return (
      <span className="wf-session-status">
        <span className="wf-offline-label">
          Can’t reach {name} <WifiOff size={13} />
        </span>
        <button onClick={() => void retry()}>
          <RefreshCw size={13} /> Try again
        </button>
      </span>
    );
  }
  if (link === "expired") {
    return (
      <span className="wf-session-status">
        <span className="wf-offline-label">Signed out of {name}</span>
        <button className="wf-primary" onClick={() => openConnect({ addr: target?.addr, expired: true })}>
          <LogIn size={13} /> Sign in
        </button>
      </span>
    );
  }
  return (
    <span className="wf-session-status">
      <span className="wf-offline-label">
        <HardDrive size={13} /> On this device
      </span>
    </span>
  );
}

function SessionStatus() {
  const session = useSession((s) => s.session);
  const setConnected = useSession((s) => s.setConnected);
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
        title={`Status: ${current.label} (click to change)`}
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
    </span>
  );
}

/** The apps a phone keeps on its tab bar; the rest are one tap away. */
const PHONE_TABS = ["writform.home", "writform.documents", "writform.canvas", "writform.chat"];

/**
 * The OS-like chrome: nav rail (dock) on the left, active app's main view in
 * the center, right panel and statusbar slots around it.
 *
 * It's always there. A server is something you connect on top of it: the
 * apps that need one (Chat, Sessions, Friends) stay in the rail and say so,
 * and the ones that don't never notice the difference.
 */
export function AppShell() {
  const apps = usePlatform((s) => s.apps);
  const mainViewApps = usePlatform((s) => s.mainViewApps);
  const mainViews = usePlatform((s) => s.mainViews);
  const activeAppId = usePlatform((s) => s.activeAppId);
  const setActiveApp = usePlatform((s) => s.setActiveApp);
  const badges = usePlatform((s) => s.badges);
  const connected = useSession((s) => s.link === "connected");
  const scope = useSession((s) => (s.link === "connected" && s.session ? `${s.session.addr}|${s.session.user.id}` : "local"));
  const immersive = usePlatform((s) => s.immersive);
  const phone = useIsPhone();
  const [allOpen, setAllOpen] = useState(false);

  // Browser client: desktop-only apps (notes vault, plugins) are hidden.
  const dockApps = mainViewApps.filter((id) => !isWeb || apps[id]?.web !== false);
  const tabs = phone ? PHONE_TABS.filter((id) => dockApps.includes(id)) : dockApps;
  const elsewhere = phone ? dockApps.filter((id) => !tabs.includes(id)) : [];
  const elsewhereBadge = elsewhere.reduce((n, id) => n + (badges[id] ?? 0), 0);

  // A few seconds after launch, mention a waiting update (desktop only;
  // installing stays a deliberate act in Settings).
  useEffect(() => {
    const t = setTimeout(() => void announceUpdateOnLaunch(), 6000);
    return () => clearTimeout(t);
  }, []);

  // Mirror the in-app unread total onto the OS: the dock badge on
  // macOS/Linux, the PWA badge in the browser. Windows' overlay icon needs
  // an icon asset, so it silently no-ops there for now. iOS ties app-icon
  // badges to delivered notifications, not windows — nothing to mirror.
  useEffect(() => {
    const total = Object.values(badges).reduce((n, c) => n + c, 0);
    if (isMobileApp) return;
    if ("__TAURI_INTERNALS__" in window) {
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
        getCurrentWindow()
          .setBadgeCount(total > 0 ? total : undefined)
          .catch(() => {}),
      );
    } else {
      const nav = navigator as Navigator & {
        setAppBadge?: (n?: number) => Promise<void>;
        clearAppBadge?: () => Promise<void>;
      };
      if (total > 0) void nav.setAppBadge?.(total).catch(() => {});
      else void nav.clearAppBadge?.().catch(() => {});
    }
  }, [badges]);

  const active = activeAppId ? apps[activeAppId] : undefined;
  const activeView = activeAppId ? mainViews[activeAppId] : undefined;
  // An app that needs a server says so until there is one.
  const gated = !!active && !active.offline && !connected;

  const railItem = (appId: string) => {
    const manifest = apps[appId];
    if (!manifest) return null;
    const badge = badges[appId] ?? 0;
    return (
      <button
        key={appId}
        className={`wf-rail-item ${appId === activeAppId ? "active" : ""}`}
        title={manifest.name}
        onClick={() => {
          haptic("selection");
          setAllOpen(false);
          setActiveApp(appId);
        }}
      >
        <span aria-hidden>{manifest.icon}</span>
        {/* Tab label — hidden on desktop, shown on the phone tab bar. */}
        <span className="wf-rail-label">{manifest.name}</span>
        {badge > 0 && <span className="wf-btn-badge">{badge > 99 ? "99+" : badge}</span>}
      </button>
    );
  };

  return (
    <div className={`wf-shell ${immersive ? "immersive" : ""}`}>
      {connected && <ReconnectBanner />}
      <div className="wf-body">
        <nav className="wf-rail">
          {tabs.map(railItem)}
          <Slot name="nav.rail" />
          {phone ? (
            <button
              className={`wf-rail-item ${allOpen || (activeAppId !== null && elsewhere.includes(activeAppId)) ? "active" : ""}`}
              title="All apps"
              aria-haspopup="dialog"
              aria-expanded={allOpen}
              onClick={() => {
                haptic("selection");
                setAllOpen((v) => !v);
              }}
            >
              <span aria-hidden>
                <LayoutGrid size={20} />
              </span>
              <span className="wf-rail-label">All</span>
              {elsewhereBadge > 0 && <span className="wf-btn-badge">{elsewhereBadge > 99 ? "99+" : elsewhereBadge}</span>}
            </button>
          ) : (
            !isWeb && <AccountMenu />
          )}
        </nav>
        <main className="wf-main">
          {gated && active ? (
            <ServerGate app={active} />
          ) : activeView ? (
            // Server apps start over with the server; what's on this device
            // stays mounted across connecting and leaving.
            <Fragment key={active?.offline ? "device" : scope}>{activeView()}</Fragment>
          ) : (
            <div className="wf-main-empty">No app selected</div>
          )}
        </main>
        <aside className="wf-panel-right">
          <Slot name="panel.right" />
        </aside>
      </div>
      <footer className="wf-statusbar">
        <Slot name="statusbar" />
        <span className="wf-statusbar-spacer" />
        {connected ? <SessionStatus /> : <LinkStatus />}
      </footer>
      {phone && allOpen && (
        <div className="wf-allapps" role="dialog" aria-label="All apps" onClick={() => setAllOpen(false)}>
          <div className="wf-allapps-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="wf-flyout-grip" aria-hidden="true" />
            <div className="wf-allapps-grid">{dockApps.map(railItem)}</div>
            {!isWeb && <AccountMenu inline onNavigate={() => setAllOpen(false)} />}
          </div>
        </div>
      )}
      <ConnectSheet />
      <CommandPalette />
      <ShortcutsOverlay />
    </div>
  );
}
