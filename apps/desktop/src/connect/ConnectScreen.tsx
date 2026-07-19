import { useEffect, useState } from "react";

import {
  backend,
  isCmdError,
  isMockBackend,
  type ProbeResult,
  type SavedServer,
} from "../lib/backend";
import { useSession } from "../stores/session";

type Step =
  | { kind: "pick" }
  | { kind: "probing"; addr: string }
  | { kind: "trust"; probe: ProbeResult }
  | { kind: "auth"; probe: ProbeResult; lastUsername: string | null };

export function ConnectScreen() {
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [error, setError] = useState<string | null>(null);

  const refresh = () => void backend.listServers().then(setServers);
  useEffect(refresh, []);

  const probe = async (addr: string) => {
    setError(null);
    setStep({ kind: "probing", addr });
    try {
      const result = await backend.probeServer(addr);
      if (result.trust.status === "trusted") {
        const saved = servers.find((s) => s.addr === result.addr);
        setStep({ kind: "auth", probe: result, lastUsername: saved?.last_username ?? null });
      } else {
        setStep({ kind: "trust", probe: result });
      }
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
      setStep({ kind: "pick" });
    }
  };

  const trust = async (probe: ProbeResult) => {
    setError(null);
    try {
      await backend.trustServer(probe.addr);
      refresh();
      setStep({ kind: "auth", probe, lastUsername: null });
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
      setStep({ kind: "pick" });
    }
  };

  return (
    <div className="wf-connect">
      <div className="wf-connect-card">
        <h1>WritForm</h1>
        {isMockBackend && (
          <p className="wf-connect-mock">Browser preview — mock backend, no real network.</p>
        )}
        {error && <p className="wf-connect-error">{error}</p>}

        {step.kind === "pick" && (
          <PickServer servers={servers} onProbe={probe} onRemove={(addr) => {
            void backend.removeServer(addr).then(refresh);
          }} />
        )}
        {step.kind === "probing" && <p className="wf-connect-dim">Contacting {step.addr}…</p>}
        {step.kind === "trust" && (
          <TrustPrompt probe={step.probe} onTrust={() => void trust(step.probe)}
            onCancel={() => setStep({ kind: "pick" })} />
        )}
        {step.kind === "auth" && (
          <AuthForm probe={step.probe} lastUsername={step.lastUsername}
            onBack={() => setStep({ kind: "pick" })} onError={setError} />
        )}
      </div>
    </div>
  );
}

function PickServer({
  servers,
  onProbe,
  onRemove,
}: {
  servers: SavedServer[];
  onProbe: (addr: string) => void;
  onRemove: (addr: string) => void;
}) {
  const [addr, setAddr] = useState("");
  return (
    <>
      {servers.length > 0 && (
        <ul className="wf-server-list">
          {servers.map((s) => (
            <li key={s.addr}>
              <button className="wf-server-item" onClick={() => onProbe(s.addr)}>
                <span className="wf-server-name">{s.server_name}</span>
                <span className="wf-server-addr">{s.addr}</span>
              </button>
              <button
                className="wf-server-remove"
                title="Forget this server"
                onClick={() => onRemove(s.addr)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (addr.trim()) onProbe(addr);
        }}
      >
        <label htmlFor="server-addr">Add a server</label>
        <div className="wf-connect-row">
          <input
            id="server-addr"
            placeholder="192.168.1.20:7311"
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            autoFocus
          />
          <button type="submit" disabled={!addr.trim()}>
            Connect
          </button>
        </div>
      </form>
    </>
  );
}

function TrustPrompt({
  probe,
  onTrust,
  onCancel,
}: {
  probe: ProbeResult;
  onTrust: () => void;
  onCancel: () => void;
}) {
  const changed = probe.trust.status === "identity_changed";
  return (
    <div className="wf-trust">
      {changed ? (
        <>
          <h2 className="wf-trust-danger">⚠ Server identity changed</h2>
          <p>
            <strong>{probe.server_name}</strong> at {probe.addr} presents a{" "}
            <strong>different identity key</strong> than the one you trusted before. This can mean
            the server was reinstalled — or that someone is intercepting the connection.
          </p>
          {probe.trust.status === "identity_changed" && (
            <p className="wf-connect-dim">
              previous: <code>{probe.trust.old_fingerprint}</code>
            </p>
          )}
        </>
      ) : (
        <>
          <h2>First connection</h2>
          <p>
            Verify this fingerprint matches the one shown by <strong>{probe.server_name}</strong>{" "}
            (printed in the server logs at startup):
          </p>
        </>
      )}
      {probe.trust.status !== "trusted" && (
        <div className="wf-fingerprint">{probe.trust.fingerprint}</div>
      )}
      <div className="wf-connect-row">
        <button onClick={onCancel}>Cancel</button>
        <button className={changed ? "wf-danger" : "wf-primary"} onClick={onTrust}>
          {changed ? "Trust new identity" : "Trust server"}
        </button>
      </div>
    </div>
  );
}

function AuthForm({
  probe,
  lastUsername,
  onBack,
  onError,
}: {
  probe: ProbeResult;
  lastUsername: string | null;
  onBack: () => void;
  onError: (msg: string | null) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState(lastUsername ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const setConnected = useSession((s) => s.setConnected);

  const submit = async () => {
    setBusy(true);
    onError(null);
    try {
      const session =
        mode === "login"
          ? await backend.login(probe.addr, username, password)
          : await backend.register(probe.addr, username, password);
      setConnected(session);
    } catch (e) {
      onError(isCmdError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="wf-auth"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="wf-connect-dim">
        {probe.server_name} · {probe.addr}
      </p>
      <div className="wf-auth-tabs">
        <button
          type="button"
          className={mode === "login" ? "active" : ""}
          onClick={() => setMode("login")}
        >
          Log in
        </button>
        <button
          type="button"
          className={mode === "register" ? "active" : ""}
          onClick={() => setMode("register")}
        >
          Create account
        </button>
      </div>
      <input
        placeholder="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoFocus={!lastUsername}
        autoCapitalize="off"
        autoCorrect="off"
      />
      <input
        placeholder={mode === "register" ? "password (8+ characters)" : "password"}
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus={!!lastUsername}
      />
      <div className="wf-connect-row">
        <button type="button" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button
          type="submit"
          className="wf-primary"
          disabled={busy || !username.trim() || !password}
        >
          {busy ? "…" : mode === "login" ? "Log in" : "Create account"}
        </button>
      </div>
    </form>
  );
}
