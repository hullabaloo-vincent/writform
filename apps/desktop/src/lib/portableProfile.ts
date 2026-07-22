import type { User } from "../bindings/proto/User";
import { backend, type CmdError } from "./backend";

/** Apply the locally saved portable profile to the CURRENT server:
 *  re-upload the stored images (attachment ids are per-server), PATCH
 *  `/auth/me`, and return the updated user. Resolves null when no portable
 *  profile is saved. Never called silently — callers gate on explicit user
 *  action. */
export async function applyPortableProfile(): Promise<User | null> {
  const profile = await backend.profileGet();
  if (!profile) return null;

  const uploadImage = async (path: string | null): Promise<number | null> => {
    if (!path) return null;
    const res = await backend.uploadAttachment({ filePath: path });
    if (res.status >= 400) {
      throw {
        code: "upload_failed",
        message: `profile image upload failed (${res.status})`,
      } satisfies CmdError;
    }
    return (res.body as { id: number }).id;
  };

  const avatarId = await uploadImage(profile.avatar_path);
  const bannerId = await uploadImage(profile.banner_path);

  const res = await backend.apiFetch("PATCH", "/api/v1/auth/me", {
    display_name: profile.display_name,
    avatar_attachment_id: avatarId,
    banner_attachment_id: bannerId,
    accent_color: profile.accent_color,
    bio: profile.bio,
  });
  if (res.status >= 400) {
    const err = (res.body ?? {}) as Partial<CmdError>;
    throw {
      code: err.code ?? "apply_failed",
      message: err.message ?? `applying the profile failed (${res.status})`,
    } satisfies CmdError;
  }
  return res.body as User;
}
