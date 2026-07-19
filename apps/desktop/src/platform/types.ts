import type { ReactNode } from "react";

/**
 * WritForm's client is a platform: every feature — including core ones like
 * chat, sessions, and notes — is an "app" that contributes UI through named
 * slots and behavior through commands. Third-party plugins (Phase 6) use this
 * exact same surface, so the API ships pre-proven by the core apps.
 */

/** Permissions an app declares. Enforced for third-party plugins in Phase 6. */
export type AppPermission =
  | "ui"
  | "commands"
  | "data"
  | "net"
  | "vault:read"
  | "vault:write"
  | "editor"
  | "events";

export interface AppManifest {
  /** Unique reverse-dns-ish id, e.g. "writform.chat". */
  id: string;
  name: string;
  /** Dock icon: an icon element (core apps use lucide) or an emoji string
   *  (third-party plugins declare emoji in manifest.json). */
  icon: ReactNode;
  permissions: AppPermission[];
}

/** Named UI mount points apps can contribute to. */
export type SlotName =
  | "nav.rail"
  | "main.view"
  | "panel.right"
  | "statusbar"
  | "settings.section";

export interface SlotContribution {
  /** Unique within the slot, conventionally `${appId}/${localId}`. */
  id: string;
  appId: string;
  /** Lower renders first. Defaults to 0. */
  order?: number;
  render: () => ReactNode;
}

export interface Command {
  id: string;
  appId: string;
  title: string;
  /** Optional keybinding hint, e.g. "mod+k". Binding itself comes later. */
  keybinding?: string;
  run: () => void | Promise<void>;
}

/**
 * The API handed to an app's `activate`. For core apps this is a direct
 * in-process object; for third-party plugins the same shape is served through
 * the permission broker.
 */
export interface AppContext {
  manifest: AppManifest;
  ui: {
    /** Contribute a react node to a slot. Returns an unregister fn. */
    addToSlot(slot: SlotName, contribution: Omit<SlotContribution, "appId">): () => void;
    /**
     * Register this app's main view, shown when its rail icon is active.
     * Also adds the rail icon. Returns an unregister fn.
     */
    registerMainView(render: () => ReactNode): () => void;
  };
  commands: {
    register(cmd: Omit<Command, "appId">): () => void;
    execute(id: string): Promise<void>;
  };
}

export interface WritformApp {
  manifest: AppManifest;
  activate(ctx: AppContext): void;
}
