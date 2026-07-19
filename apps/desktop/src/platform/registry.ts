import { create } from "zustand";

import type {
  AppContext,
  AppManifest,
  ChatCommand,
  Command,
  SlotContribution,
  SlotName,
  WritformApp,
} from "./types";

interface PlatformState {
  apps: Record<string, AppManifest>;
  /** Apps that registered a main view, in registration order. */
  mainViewApps: string[];
  mainViews: Record<string, () => React.ReactNode>;
  slots: Partial<Record<SlotName, SlotContribution[]>>;
  commands: Record<string, Command>;
  /** Chat slash commands by name (no leading slash). */
  chatCommands: Record<string, ChatCommand>;
  activeAppId: string | null;
  setActiveApp: (appId: string) => void;
}

export const usePlatform = create<PlatformState>((set) => ({
  apps: {},
  mainViewApps: [],
  mainViews: {},
  slots: {},
  commands: {},
  chatCommands: {},
  activeAppId: null,
  setActiveApp: (appId) => set({ activeAppId: appId }),
}));

function addSlotContribution(slot: SlotName, contribution: SlotContribution): () => void {
  usePlatform.setState((s) => ({
    slots: {
      ...s.slots,
      [slot]: [...(s.slots[slot] ?? []), contribution].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0),
      ),
    },
  }));
  return () => {
    usePlatform.setState((s) => ({
      slots: {
        ...s.slots,
        [slot]: (s.slots[slot] ?? []).filter((c) => c.id !== contribution.id),
      },
    }));
  };
}

function makeContext(manifest: AppManifest): AppContext {
  return {
    manifest,
    ui: {
      addToSlot(slot, contribution) {
        return addSlotContribution(slot, { ...contribution, appId: manifest.id });
      },
      registerMainView(render) {
        usePlatform.setState((s) => ({
          mainViewApps: [...s.mainViewApps, manifest.id],
          mainViews: { ...s.mainViews, [manifest.id]: render },
          // First app to register becomes the initial view.
          activeAppId: s.activeAppId ?? manifest.id,
        }));
        return () => {
          usePlatform.setState((s) => {
            const { [manifest.id]: _removed, ...mainViews } = s.mainViews;
            return {
              mainViewApps: s.mainViewApps.filter((id) => id !== manifest.id),
              mainViews,
              activeAppId: s.activeAppId === manifest.id ? null : s.activeAppId,
            };
          });
        };
      },
    },
    commands: {
      register(cmd) {
        const command: Command = { ...cmd, appId: manifest.id };
        usePlatform.setState((s) => ({ commands: { ...s.commands, [command.id]: command } }));
        return () => {
          usePlatform.setState((s) => {
            const { [command.id]: _removed, ...commands } = s.commands;
            return { commands };
          });
        };
      },
      async execute(id) {
        const cmd = usePlatform.getState().commands[id];
        if (!cmd) throw new Error(`unknown command: ${id}`);
        await cmd.run();
      },
    },
    chat: {
      registerCommand(cmd) {
        const name = cmd.name.toLowerCase();
        if (!/^[a-z0-9_-]{1,32}$/.test(name)) {
          throw new Error(`invalid chat command name: ${cmd.name}`);
        }
        const command: ChatCommand = { ...cmd, name, appId: manifest.id };
        usePlatform.setState((s) => ({
          chatCommands: { ...s.chatCommands, [name]: command },
        }));
        return () => {
          usePlatform.setState((s) => {
            const { [name]: _removed, ...chatCommands } = s.chatCommands;
            return { chatCommands };
          });
        };
      },
    },
  };
}

/** Register and activate an app. Core apps call this at startup. */
export function registerApp(app: WritformApp): void {
  const { manifest } = app;
  if (usePlatform.getState().apps[manifest.id]) {
    throw new Error(`app already registered: ${manifest.id}`);
  }
  usePlatform.setState((s) => ({ apps: { ...s.apps, [manifest.id]: manifest } }));
  app.activate(makeContext(manifest));
}

/** Execute a registered command from anywhere (rail, palette, keybindings). */
export async function executeCommand(id: string): Promise<void> {
  const cmd = usePlatform.getState().commands[id];
  if (!cmd) throw new Error(`unknown command: ${id}`);
  await cmd.run();
}
