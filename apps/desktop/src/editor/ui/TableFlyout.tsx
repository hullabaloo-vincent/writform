import type { Editor } from "@tiptap/react";
import { Table as TableIcon } from "lucide-react";
import { useState } from "react";

import { insertTable } from "../tables/Table";
import { Flyout } from "./Flyout";

const ROWS = 6;
const COLS = 8;

/**
 * Insert ▸ Table: a grid to point at — the square you choose is the bottom
 * right corner of the table you get. (With a finger there is no hovering:
 * the square you touch is the size.)
 */
export function TableFlyout({ editor }: { editor: Editor }) {
  const [over, setOver] = useState<[number, number]>([2, 3]);
  return (
    <Flyout title="Table" icon={<TableIcon size={15} />} label="Table" panelClass="wf-table-pick">
      {(close) => (
        <>
          <div className="wf-table-grid" role="group" aria-label="Table size" style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)` }}>
            {Array.from({ length: ROWS * COLS }, (_, i) => {
              const r = Math.floor(i / COLS) + 1;
              const c = (i % COLS) + 1;
              return (
                <button
                  key={i}
                  type="button"
                  aria-label={`${r} by ${c}`}
                  className={r <= over[0] && c <= over[1] ? "on" : ""}
                  onPointerEnter={() => setOver([r, c])}
                  onFocus={() => setOver([r, c])}
                  onClick={() => {
                    insertTable(editor, r, c);
                    close();
                  }}
                />
              );
            })}
          </div>
          <p className="wf-table-size">
            {over[0]} {over[0] === 1 ? "row" : "rows"} × {over[1]} {over[1] === 1 ? "column" : "columns"}
          </p>
        </>
      )}
    </Flyout>
  );
}
