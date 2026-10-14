import { PdfImportHost } from "./apps/documents/import/PdfImportDialog";
import { ConnectScreen } from "./connect/ConnectScreen";
import {
  AppShell,
  ConfirmHost,
  LightboxHost,
  Loading,
  ProfileCardHost,
  ToastHost,
} from "./platform";
import { useSession } from "./stores/session";

/**
 * The apps open straight into the shell: what's on this device is always
 * there, and a server is something you connect from inside it. Only the
 * browser client — which has no device storage — signs in first.
 */
export function Root() {
  const phase = useSession((s) => s.phase);
  if (phase === "loading") {
    return (
      <div className="wf-boot">
        <Loading />
      </div>
    );
  }
  return (
    <>
      {phase === "disconnected" ? <ConnectScreen /> : <AppShell />}
      <ConfirmHost />
      <PdfImportHost />
      <ProfileCardHost />
      <LightboxHost />
      <ToastHost />
    </>
  );
}
