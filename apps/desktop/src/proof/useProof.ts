import type { Editor } from "@tiptap/core";
import { useEffect, useState, useSyncExternalStore } from "react";

import type * as Y from "yjs";

import { ProofSession } from "./session";

const never = () => () => {};

/**
 * A checker for as long as the component using it is mounted (the Check
 * panel). Nothing of it exists otherwise: no plugin in the editor, no
 * listener, no reading.
 */
export function useProofSession(editor: Editor | null, format: string, lang: string, ydoc: Y.Doc | null, canWrite: boolean): ProofSession | null {
  const [session, setSession] = useState<ProofSession | null>(null);
  useEffect(() => {
    if (!editor) return;
    const made = new ProofSession(editor, format, lang, { ydoc, canWrite });
    made.start();
    setSession(made);
    return () => {
      made.stop();
      setSession(null);
    };
  }, [editor, format, lang, ydoc, canWrite]);
  useSyncExternalStore(session ? session.subscribe : never, () => session?.version ?? 0);
  return session;
}
