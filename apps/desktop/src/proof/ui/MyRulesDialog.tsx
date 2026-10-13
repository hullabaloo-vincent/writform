import { useMemo } from "react";

import { Modal } from "../../platform/Modal";
import { envFor } from "../session";
import { RulesEditor } from "./RulesEditor";

/**
 * The writer's own rules for the Check panel, away from any document
 * (Settings ▸ Writing). The same editor as the panel's Rules tab.
 */
export default function MyRulesDialog({ onClose }: { onClose: () => void }) {
  const env = useMemo(() => envFor("none", typeof navigator !== "undefined" ? navigator.language : "en"), []);
  return (
    <Modal onClose={onClose} className="wf-proof-dialog">
      <h3>Your rules for Check</h3>
      <p className="wf-proof-dim">These apply to every document you open on this device. A document can add rules of its own, and can ask that only its own be used.</p>
      <RulesEditor scope="yours" ydoc={null} canWrite env={env} title="My rules" />
      <div className="wf-connect-row">
        <button type="button" className="wf-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
