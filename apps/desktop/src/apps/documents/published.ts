/**
 * Which server document each document on this device was published as, by
 * server and account. Publishing again then offers that one (to share with
 * more people) instead of putting another copy on the server: three groups
 * should see one document, not three that drift apart.
 *
 * Kept in this device's storage, like the documents it speaks of. Losing it
 * only means the next publish asks about a document of the same name.
 */

const KEY = "wf-published";

type Links = Record<string, Record<string, number>>;

function read(): Links {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Links = {};
    for (const [local, byScope] of Object.entries(raw as Record<string, unknown>)) {
      if (!byScope || typeof byScope !== "object") continue;
      for (const [scope, id] of Object.entries(byScope as Record<string, unknown>)) {
        if (typeof id === "number" && Number.isInteger(id) && id > 0) (out[local] ??= {})[scope] = id;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function write(links: Links): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(links));
  } catch {
    // A convenience: without it the next publish asks again.
  }
}

/** The server document this device's document was published as, on the
 *  server and account `scope` (`addr|userId`). */
export function publishedCopy(localId: string, scope: string): number | null {
  return read()[localId]?.[scope] ?? null;
}

export function notePublished(localId: string, scope: string, docId: number): void {
  const links = read();
  (links[localId] ??= {})[scope] = docId;
  write(links);
}

export function forgetPublished(localId: string, scope: string): void {
  const links = read();
  if (!links[localId]?.[scope]) return;
  delete links[localId][scope];
  if (Object.keys(links[localId]).length === 0) delete links[localId];
  write(links);
}
