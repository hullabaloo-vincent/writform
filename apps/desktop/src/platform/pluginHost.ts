/**
 * Third-party plugin runtime.
 *
 * A plugin's `main.js` is evaluated with a single argument: `writform`, the
 * permission-scoped host API. Only capabilities declared in the manifest (and
 * therefore shown to the user at enable time) are present on the object —
 * everything else is simply absent. This is a consent-based model, not a
 * hard sandbox (see docs/plugin-api.md).
 */

import { createElement, useEffect, useRef } from "react";

import { backend } from "../lib/backend";
import { registerApp, usePlatform } from "./registry";
import type { AppPermission, SlotName } from "./types";

/** Renders a plugin-owned raw DOM element inside the React tree. */
function DomHost({ el }: { el: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const parent = ref.current;
    parent?.appendChild(el);
    return () => {
      if (parent?.contains(el)) parent.removeChild(el);
    };
  }, [el]);
  return createElement("div", { ref });
}

export const PLUGIN_API_VERSION = 1;

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  icon: string;
  permissions: string[];
  min_api_version: number;
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  enabled: boolean;
}

interface PluginRegistration {
  activate(ctx: unknown): void;
}

function buildHostApi(manifest: PluginManifest, register: (r: PluginRegistration) => void) {
  const has = (p: string) => manifest.permissions.includes(p);
  const api: Record<string, unknown> = {
    apiVersion: PLUGIN_API_VERSION,
    manifest: { ...manifest },
    register,
    // Lets plugins build UI with plain DOM instead of React.
    __wrapDom: (el: HTMLElement) => createElement(DomHost, { el }),
  };
  if (has("net")) {
    api.net = {
      // Same constraint as core apps: only /api/v1/ on the connected server.
      fetch: (method: string, path: string, body?: unknown) =>
        backend.apiFetch(method, path, body),
    };
  }
  if (has("data")) {
    const base = `/api/v1/plugins/${manifest.id}/data`;
    api.data = {
      get: async (scope: string, scopeId: number, key: string) =>
        (await backend.apiFetch("GET", `${base}/${scope}/${scopeId}/${key}`)).body,
      put: (scope: string, scopeId: number, key: string, value: unknown) =>
        backend.apiFetch("PUT", `${base}/${scope}/${scopeId}/${key}`, value),
      list: async (scope: string, scopeId: number) =>
        (await backend.apiFetch("GET", `${base}/${scope}/${scopeId}`)).body,
    };
  }
  if (has("events")) {
    api.events = {
      onWsEvent: (handler: (e: unknown) => void) => backend.onWsEvent(handler),
      sub: (rooms: string[]) => backend.wsSub(rooms),
    };
  }
  if (has("vault:read")) {
    api.vaultRead = {
      list: () => backend.vaultList(),
      read: (name: string) => backend.vaultRead(name),
    };
  }
  if (has("vault:write")) {
    api.vaultWrite = {
      write: (name: string, content: string) => backend.vaultWrite(name, content),
    };
  }
  return api;
}

/** Load and activate every enabled plugin. Called once at startup. */
export async function loadEnabledPlugins(): Promise<void> {
  let plugins: InstalledPlugin[] = [];
  try {
    plugins = await backend.pluginsList();
  } catch {
    return; // e.g. mock/browser mode
  }

  for (const plugin of plugins.filter((p) => p.enabled)) {
    const { manifest } = plugin;
    if (manifest.min_api_version > PLUGIN_API_VERSION) {
      console.warn(`plugin ${manifest.id} needs a newer WritForm`);
      continue;
    }
    try {
      const source = await backend.pluginReadEntry(manifest.id);
      let registration: PluginRegistration | null = null;
      const host = buildHostApi(manifest, (r) => {
        registration = r;
      });
      // Evaluated with app privileges by design; the user consented to this
      // plugin's permission list when enabling it.
      new Function("writform", source)(host);
      const reg = registration as PluginRegistration | null;
      if (!reg) {
        console.warn(`plugin ${manifest.id} never called writform.register`);
        continue;
      }
      registerApp({
        manifest: {
          id: `plugin.${manifest.id}`,
          name: manifest.name,
          icon: manifest.icon || "🧩",
          permissions: manifest.permissions.filter((p): p is AppPermission =>
            [
              "ui",
              "commands",
              "chat",
              "data",
              "net",
              "vault:read",
              "vault:write",
              "editor",
              "events",
            ].includes(p),
          ),
        },
        activate(ctx) {
          // ui/commands surfaces come from the platform AppContext, filtered
          // by declared permissions.
          const scoped: Record<string, unknown> = {};
          if (manifest.permissions.includes("ui")) {
            scoped.ui = {
              addToSlot: (slot: SlotName, c: Parameters<typeof ctx.ui.addToSlot>[1]) =>
                ctx.ui.addToSlot(slot, c),
              registerMainView: ctx.ui.registerMainView,
            };
          }
          if (manifest.permissions.includes("commands")) {
            scoped.commands = ctx.commands;
          }
          if (manifest.permissions.includes("chat")) {
            scoped.chat = {
              registerCommand: ctx.chat.registerCommand,
              // Post a message to a channel the user can access.
              send: (channelId: number, content: string) =>
                backend.apiFetch("POST", `/api/v1/channels/${channelId}/messages`, {
                  content,
                  reply_to_id: null,
                  attachment_ids: [],
                }),
            };
          }
          reg.activate(scoped);
        },
      });
    } catch (e) {
      console.error(`failed to load plugin ${manifest.id}:`, e);
    }
  }
}

/** Enable/disable + list, for the Plugin Manager UI. */
export const pluginManager = {
  list: () => backend.pluginsList(),
  setEnabled: (id: string, enabled: boolean) => backend.pluginSetEnabled(id, enabled),
};

export function usePluginCount(): number {
  return usePlatform((s) => Object.keys(s.apps).filter((id) => id.startsWith("plugin.")).length);
}
