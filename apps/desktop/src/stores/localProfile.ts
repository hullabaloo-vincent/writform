import { create } from "zustand";

import { backend, isDevPreview, isWeb, localProfileImageUrl, type PortableProfile } from "../lib/backend";
import { shrinkImage } from "../lib/shrinkImage";

/**
 * Who you are on this device: the name and look that go with your work
 * when no server is saying who you are — the author of a document you
 * export, the greeting on Home, the face at the foot of the rail. It's the
 * same saved profile that can be copied to a server from Settings, so it
 * reads as one identity: yours, carried to the servers you join, rather
 * than a different one on each.
 */
interface LocalProfileState {
  loaded: boolean;
  /** Empty until you've said. */
  name: string;
  accent: string | null;
  bio: string | null;
  /** Where your picture and the banner behind it can be shown from. */
  avatar: string | null;
  banner: string | null;
  load: () => Promise<void>;
  setName: (name: string) => Promise<void>;
  setFields: (fields: { name: string; accent: string | null; bio: string | null }) => Promise<void>;
  /** Set a picture from a file chosen on this device (null takes it off). */
  setImage: (kind: "avatar" | "banner", file: Blob | null) => Promise<void>;
  /** Start over: nothing saved. Servers keep the profiles they have. */
  clear: () => Promise<void>;
}

function shown(profile: PortableProfile | null) {
  // The dev preview has no way to serve the pictures back.
  const url = (kind: "avatar" | "banner", path: string | null) =>
    path && profile && !isDevPreview ? localProfileImageUrl(kind, profile.saved_at) : null;
  return {
    name: profile?.display_name?.trim() ?? "",
    accent: profile?.accent_color ?? null,
    bio: profile?.bio ?? null,
    avatar: url("avatar", profile?.avatar_path ?? null),
    banner: url("banner", profile?.banner_path ?? null),
  };
}

export const useLocalProfile = create<LocalProfileState>((set, get) => ({
  loaded: false,
  name: "",
  accent: null,
  bio: null,
  avatar: null,
  banner: null,

  load: async () => {
    if (isWeb) {
      set({ loaded: true });
      return;
    }
    try {
      set({ loaded: true, ...shown(await backend.profileGet()) });
    } catch {
      set({ loaded: true });
    }
  },

  setName: async (raw) => {
    const { accent, bio } = get();
    await get().setFields({ name: raw, accent, bio });
  },

  setFields: async ({ name: raw, accent, bio }) => {
    const name = raw.trim().slice(0, 64);
    set({ name, accent, bio: bio?.trim() || null });
    if (isWeb) return;
    set(shown(await backend.profileUpdateFields({ displayName: name || null, accentColor: accent, bio: bio?.trim() || null })));
  },

  setImage: async (kind, file) => {
    if (isWeb) return;
    if (!file) {
      set(shown(await backend.profileClearImage(kind)));
      return;
    }
    // An avatar is drawn small; a banner spans a card.
    const picture = kind === "avatar" ? await shrinkImage(file, 512, "png") : await shrinkImage(file, 1600, "jpeg");
    set(shown(await backend.profileSetImage(kind, await picture.arrayBuffer())));
  },

  clear: async () => {
    if (!isWeb) await backend.profileDelete();
    set(shown(null));
  },
}));

void useLocalProfile.getState().load();

/** Your name for work made here: the server's, when one is saying; else
 *  the one you've given this device. */
export function authorName(sessionUser?: { display_name: string | null; username: string } | null): string | undefined {
  if (sessionUser) return sessionUser.display_name || sessionUser.username;
  return useLocalProfile.getState().name || undefined;
}
