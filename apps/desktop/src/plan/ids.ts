/** Ids for what the story plan holds: 8 base36 characters, random. */

export const PLAN_ID = /^[0-9a-z]{8}$/;

export function newId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += (b % 36).toString(36);
  return out;
}

export const isPlanId = (value: unknown): value is string => typeof value === "string" && PLAN_ID.test(value);
