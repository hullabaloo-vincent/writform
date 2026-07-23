import { useEffect, useState } from "react";

import { isCmdError } from "../../lib/backend";
import { Puzzle } from "lucide-react";
import { confirmDialog } from "../../platform";
import type { WritformApp } from "../../platform";
import {
  pluginManager,
  type InstalledPlugin,
} from "../../platform/pluginHost";

function PluginManagerView() {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);

  const refresh = () => void pluginManager.list().then(setPlugins).catch(() => {});
  useEffect(refresh, []);

  const toggle = async (plugin: InstalledPlugin) => {
    const { manifest } = plugin;
    if (!plugin.enabled) {
      const perms = manifest.permissions.length
        ? manifest.permissions.join(", ")
        : "none";
      const ok = await confirmDialog(
        `Permissions it requests: ${perms}\n\n` +
          `Plugins run with the app's access — only enable plugins you trust.`,
        { title: `Enable "${manifest.name}"?`, confirmLabel: "Enable plugin" },
      );
      if (!ok) return;
    }
    try {
      await pluginManager.setEnabled(manifest.id, !plugin.enabled);
      setNeedsReload(true);
      refresh();
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
    }
  };

  return (
    <div className="wf-plugins">
      <h2>Plugins</h2>
      <p className="wf-session-meta">
        Install plugins by dropping a folder (with <code>manifest.json</code> +{" "}
        <code>main.js</code>) into the app's <code>plugins/</code> directory. Plugins use the same
        extension points as subScribe's own apps.
      </p>
      {error && <p className="wf-connect-error">{error}</p>}
      {needsReload && (
        <p className="wf-chat-invite" onClick={() => window.location.reload()}>
          Changes take effect after reload — click here to reload now.
        </p>
      )}
      <ul className="wf-plugin-list">
        {plugins.map((p) => (
          <li key={p.manifest.id}>
            <span className="wf-plugin-icon">{p.manifest.icon || "🧩"}</span>
            <div className="wf-plugin-info">
              <strong>{p.manifest.name}</strong>
              <span className="wf-session-meta">
                {p.manifest.id} {p.manifest.version && `· v${p.manifest.version}`} · permissions:{" "}
                {p.manifest.permissions.join(", ") || "none"}
              </span>
            </div>
            <button onClick={() => void toggle(p)}>{p.enabled ? "Disable" : "Enable"}</button>
          </li>
        ))}
        {plugins.length === 0 && <li className="wf-friend-dim">No plugins installed.</li>}
      </ul>
    </div>
  );
}

export const pluginManagerApp: WritformApp = {
  manifest: {
    id: "writform.plugins",
    name: "Plugins",
    icon: <Puzzle size={20} />,
    web: false,
    permissions: ["ui", "commands"],
  },
  activate(ctx) {
    ctx.ui.registerMainView(() => <PluginManagerView />);
  },
};
