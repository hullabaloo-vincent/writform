import { LogOut } from "lucide-react";

import { useSession } from "../stores/session";
import { CommandPalette } from "./CommandPalette";
import { usePlatform } from "./registry";
import { Slot } from "./Slot";

function SessionStatus() {
  const session = useSession((s) => s.session);
  const logout = useSession((s) => s.logout);
  if (!session) return null;
  return (
    <span className="wf-session-status">
      {session.user.username} @ {session.addr}
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
