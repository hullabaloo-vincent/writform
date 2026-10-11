/**
 * What the connected server's documents can hold. A document may only use
 * vocabulary both this app and its server understand: the server's own web
 * client has to be able to open everything it stores.
 */

import { DOC_SCHEMA_LEVEL } from "../../../editor/schema/levels";
import { documentsApi, type ApiError } from "../api";
import { currentScope } from "./scope";

/** Per server and account. A server's level only changes when it is
 *  updated — so an answer that already covers this app is kept, and one
 *  that doesn't is asked again after a while (the update may have come). */
const known = new Map<string, { level: number; at: number }>();
const RECHECK_MS = 5 * 60_000;

async function serverLevel(): Promise<number> {
  const scope = currentScope();
  if (!scope) return 1;
  const hit = known.get(scope);
  if (hit && (hit.level >= DOC_SCHEMA_LEVEL || Date.now() - hit.at < RECHECK_MS)) return hit.level;
  try {
    const level = Math.max(1, (await documentsApi.capabilities()).max_schema_level);
    known.set(scope, { level, at: Date.now() });
    return level;
  } catch (e) {
    // No such route: a server from before levels. Anything else (offline)
    // isn't an answer — assume the least and ask again next time.
    const status = (e as Partial<ApiError>).status;
    if (status === 404 || status === 405) known.set(scope, { level: 1, at: Date.now() });
    return 1;
  }
}

/** Forget what servers have said (tests; a change of server asks anew). */
export function forgetCapabilities(): void {
  known.clear();
}

/** The schema level a document on the connected server may use from here. */
export async function featureLevel(): Promise<number> {
  // Nothing to ask while this app is at the level every server stores.
  if (DOC_SCHEMA_LEVEL <= 1) return 1;
  return Math.min(DOC_SCHEMA_LEVEL, await serverLevel());
}
