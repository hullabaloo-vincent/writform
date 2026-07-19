import { Fragment } from "react";

import { usePlatform } from "./registry";
import type { SlotName } from "./types";

/** Renders every contribution registered for a named slot, in order. */
export function Slot({ name }: { name: SlotName }) {
  const contributions = usePlatform((s) => s.slots[name]);
  if (!contributions?.length) return null;
  return (
    <>
      {contributions.map((c) => (
        <Fragment key={c.id}>{c.render()}</Fragment>
      ))}
    </>
  );
}
