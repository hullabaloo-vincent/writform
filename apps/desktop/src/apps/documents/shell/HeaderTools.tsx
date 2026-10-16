import { MoreHorizontal } from "lucide-react";
import { createContext, type ReactNode } from "react";

import { Flyout, useIsPhone } from "../../../editor/ui/Flyout";

/** True inside the phone's sheet of header tools (ExportMenu lists its
 *  items there instead of opening a menu of its own). */
export const InHeaderSheet = createContext(false);

/**
 * The editor header's tools (comments, history, find, the panels, export,
 * share, delete). On a desktop they sit in the header as they always have.
 * On a phone, where a row of a dozen buttons wrapped into four rows over
 * the page, they go into one sheet, each with its name beside its icon
 * (`data-label`), and the header keeps the way back, the title and the save
 * state. `lead` goes at the top of the sheet (the format, on a phone).
 *
 * A button in the sheet closes it once it has done its work.
 */
export function HeaderTools({ lead, children }: { lead?: ReactNode; children: ReactNode }) {
  const phone = useIsPhone();
  if (!phone) return <>{children}</>;
  return (
    <Flyout title="More" icon={<MoreHorizontal size={18} />} caret={false} className="wf-doc-more" panelClass="wf-head-sheet">
      {(close) => (
        <InHeaderSheet.Provider value={true}>
          {lead}
          <div
            className="wf-head-tools"
            onClick={(e) => {
              if ((e.target as Element).closest("button")) close();
            }}
          >
            {children}
          </div>
        </InHeaderSheet.Provider>
      )}
    </Flyout>
  );
}
