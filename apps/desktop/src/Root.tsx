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

/** Gate: connect + auth first, then the platform shell. */
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
      {phase === "connected" || phase === "offline" ? <AppShell /> : <ConnectScreen />}
      <ConfirmHost />
      <ProfileCardHost />
      <LightboxHost />
      <ToastHost />
    </>
  );
}
