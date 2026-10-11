import { Modal } from "../platform/Modal";
import { useSession } from "../stores/session";
import { ConnectFlow } from "./ConnectFlow";

/**
 * Joining or hosting a server, in a sheet over the app: whatever is open —
 * a document, a board, a note — stays open behind it, and is still there
 * whether you connect or change your mind.
 */
export function ConnectSheet() {
  const request = useSession((s) => s.connect);
  const close = useSession((s) => s.closeConnect);
  if (!request) return null;
  return (
    <Modal onClose={close} boxClass="wf-connect-card wf-connect-sheet">
      <header className="wf-connect-sheet-head">
        <h2>Write with others</h2>
        <button className="wf-icon" aria-label="Close" title="Close" onClick={close}>
          ×
        </button>
      </header>
      {/* Keyed by what was asked for: asking again starts the steps over. */}
      <ConnectFlow key={`${request.addr ?? ""}|${request.host ? "h" : ""}|${request.expired ? "x" : ""}`} request={request} />
    </Modal>
  );
}
