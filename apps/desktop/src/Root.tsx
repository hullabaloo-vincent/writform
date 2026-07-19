import { ConnectScreen } from "./connect/ConnectScreen";
import { AppShell, ConfirmHost, ProfileCardHost } from "./platform";
import { useSession } from "./stores/session";

/** Gate: connect + auth first, then the platform shell. */
export function Root() {
  const phase = useSession((s) => s.phase);
  if (phase === "loading") {
    return <div className="wf-boot" />;
  }
  return (
    <>
      {phase === "connected" ? <AppShell /> : <ConnectScreen />}
      <ConfirmHost />
      <ProfileCardHost />
    </>
  );
}
