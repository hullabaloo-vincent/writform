import { Globe, HardDrive } from "lucide-react";
import { useEffect, useState } from "react";

import {
  backend,
  isCmdError,
  isDevPreview,
  type HostStatus,
  type ProbeResult,
  type SavedServer,
} from "../lib/backend";
import { discoverPublicIp } from "../lib/publicIp";
import { useSession } from "../stores/session";

type Step =
  | { kind: "loading" }
  | { kind: "welcome" }
  | { kind: "pick" }
  | { kind: "host-setup" }
  | { kind: "host-starting" }
  | { kind: "probing"; addr: string }
  | { kind: "trust"; probe: ProbeResult }
  | {
      kind: "auth";
      probe: ProbeResult;
      lastUsername: string | null;
      defaultMode: "login" | "register";
      freshHost: boolean;
    };

export function ConnectScreen() {
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [host, setHost] = useState<HostStatus | null>(null);
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([backend.listServers(), backend.hostStatus()]).then(([list, status]) => {
      setServers(list);
      setHost(status);
      return { list, status };
    });

  useEffect(() => {
    void refresh().then(({ list, status }) => {
      setStep(list.length === 0 && !status.configured ? { kind: "welcome" } : { kind: "pick" });
    });
     
  }, []);

  const probe = async (addr: string, opts?: { defaultMode?: "login" | "register"; freshHost?: boolean }) => {
    setError(null);
    setStep({ kind: "probing", addr });
    try {
      const result = await backend.probeServer(addr);
      if (result.trust.status === "trusted") {
        const saved = servers.find((s) => s.addr === result.addr);
        setStep({
          kind: "auth",
          probe: result,
          lastUsername: saved?.last_username ?? null,
          defaultMode: opts?.defaultMode ?? (saved?.last_username ? "login" : "register"),
          freshHost: opts?.freshHost ?? false,
        });
      } else {
        setStep({ kind: "trust", probe: result });
      }
    } catch (e) {
      let message = isCmdError(e) ? e.message : String(e);
      // Dialing your OWN public IP from inside the same network needs router
      // hairpinning, which many ISP boxes don't do — the classic way people
      // "test" a fresh port forward and wrongly conclude it's broken.
      const host = addr.split(":")[0];
      const ownIp = await discoverPublicIp().catch(() => null);
      if (ownIp !== null && host === ownIp) {
        message +=
          " — this is your own network's public address, and testing it from inside " +
          "the same network often fails (router hairpinning) even when the port " +
          "forward is correct. On this network use the LAN address instead; check " +
          "internet reachability from outside (a port-check website, or a phone on " +
          "cellular data).";
      }
      setError(message);
      setStep({ kind: "pick" });
    }
  };

  const trust = async (probe: ProbeResult) => {
    setError(null);
    try {
      await backend.trustServer(probe.addr);
      void refresh();
      setStep({
        kind: "auth",
        probe,
        lastUsername: null,
        defaultMode: "login",
        freshHost: false,
      });
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
      setStep({ kind: "pick" });
    }
  };

  const startHosting = async (port: number, serverName: string) => {
    setError(null);
    setStep({ kind: "host-starting" });
    try {
      const status = await backend.hostStart(port, serverName);
      await refresh();
      if (!status.addr) throw { code: "host", message: "server did not report an address" };
      // Our own server is pre-pinned; register-first for a fresh one.
      await probe(status.addr, { defaultMode: "register", freshHost: true });
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
      setStep({ kind: "host-setup" });
    }
  };

  /** Open the hosted server: start it if it isn't running, then connect. */
  const openHosted = async () => {
    if (!host) return;
    if (host.running && host.addr) {
      void probe(host.addr);
      return;
    }
    setError(null);
    setStep({ kind: "host-starting" });
    try {
      const status = await backend.hostStart(host.port, host.server_name);
      await refresh();
      if (status.addr) await probe(status.addr);
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
      setStep({ kind: "pick" });
    }
  };

  return (
    <div className="wf-connect">
      <div className="wf-connect-card">
        <h1>WritForm</h1>
        {isDevPreview && (
          <p className="wf-connect-preview">Development preview — in-memory data, no real network.</p>
        )}
        {error && <p className="wf-connect-error">{error}</p>}

        {step.kind === "loading" && <p className="wf-connect-dim">Starting…</p>}

        {step.kind === "welcome" && (
          <Welcome
            onHost={() => setStep({ kind: "host-setup" })}
            onJoin={() => setStep({ kind: "pick" })}
          />
        )}

        {step.kind === "pick" && (
          <PickServer
            servers={servers}
            host={host}
            onProbe={(addr) => void probe(addr)}
            onOpenHosted={() => void openHosted()}
            onHostSetup={() => setStep({ kind: "host-setup" })}
            onRemove={(addr) => {
              void backend.removeServer(addr).then(refresh);
            }}
          />
        )}

        {step.kind === "host-setup" && (
          <HostSetup
            defaults={host}
            onStart={(port, name) => void startHosting(port, name)}
            onBack={() =>
              setStep(servers.length === 0 && !host?.configured ? { kind: "welcome" } : { kind: "pick" })
            }
          />
        )}
        {step.kind === "host-starting" && (
          <p className="wf-connect-dim">Starting your server…</p>
        )}

        {step.kind === "probing" && <p className="wf-connect-dim">Contacting {step.addr}…</p>}
        {step.kind === "trust" && (
          <TrustPrompt probe={step.probe} onTrust={() => void trust(step.probe)}
            onCancel={() => setStep({ kind: "pick" })} />
        )}
        {step.kind === "auth" && (
          <AuthForm
            probe={step.probe}
            lastUsername={step.lastUsername}
            defaultMode={step.defaultMode}
            freshHost={step.freshHost}
            onBack={() => setStep({ kind: "pick" })}
            onError={setError}
          />
        )}
      </div>
    </div>
  );
}

function Welcome({ onHost, onJoin }: { onHost: () => void; onJoin: () => void }) {
  return (
    <div className="wf-welcome">
      <p className="wf-connect-dim">
        WritForm is self-hosted: your group's writing lives on a server one of you runs. How do
        you want to start?
      </p>
      <button className="wf-welcome-option" onClick={onHost}>
        <HardDrive size={22} />
        <span>
          <strong>Host on this computer</strong>
          <small>
            Create your server right here — no setup, no terminal. Friends connect to your
            address, and everything stays on your machine.
          </small>
        </span>
      </button>
      <button className="wf-welcome-option" onClick={onJoin}>
        <Globe size={22} />
        <span>
          <strong>Join a server</strong>
          <small>Someone already hosts WritForm? Connect with the address they gave you.</small>
        </span>
      </button>
    </div>
  );
}

function HostSetup({
  defaults,
  onStart,
  onBack,
}: {
  defaults: HostStatus | null;
  onStart: (port: number, serverName: string) => void;
  onBack: () => void;
}) {
  const [name, setName] = useState(defaults?.server_name ?? "My WritForm Server");
  const [port, setPort] = useState(String(defaults?.port ?? 7311));
  const portNum = Number(port);
  const portOk = Number.isInteger(portNum) && portNum >= 1024 && portNum <= 65535;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (portOk) onStart(portNum, name);
      }}
    >
      <h2>Host on this computer</h2>
      <p className="wf-connect-dim">
        Your server starts with the app and keeps running while WritForm is open. You can stop
        it or check who can reach it any time in Settings → Server.
      </p>
      <label htmlFor="host-name">Server name (what friends see)</label>
      <input
        id="host-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <label htmlFor="host-port" style={{ marginTop: 10 }}>
        Port
      </label>
      <input
        id="host-port"
        value={port}
        onChange={(e) => setPort(e.target.value)}
        inputMode="numeric"
      />
      {!portOk && port.trim() !== "" && (
        <p className="wf-connect-dim">Enter a port between 1024 and 65535.</p>
      )}
      <div className="wf-connect-row">
        <button type="button" onClick={onBack}>
          Back
        </button>
        <button type="submit" className="wf-primary" disabled={!portOk || !name.trim()}>
          Start hosting
        </button>
      </div>
    </form>
  );
}

function PickServer({
  servers,
  host,
  onProbe,
  onOpenHosted,
  onHostSetup,
  onRemove,
}: {
  servers: SavedServer[];
  host: HostStatus | null;
  onProbe: (addr: string) => void;
  onOpenHosted: () => void;
  onHostSetup: () => void;
  onRemove: (addr: string) => void;
}) {
  const [addr, setAddr] = useState("");
  const hostedAddr = host?.configured ? `127.0.0.1:${host.port}` : null;
  const remoteServers = servers.filter((s) => s.addr !== hostedAddr);

  return (
    <>
      {host?.configured && (
        <ul className="wf-server-list">
          <li>
            <button className="wf-server-item" onClick={onOpenHosted}>
              <span className="wf-server-name">
                {host.server_name}{" "}
                <span className="wf-server-badge">this computer</span>
              </span>
              <span className="wf-server-status">
                {host.running ? `running · port ${host.port}` : "stopped — click to start"}
              </span>
            </button>
          </li>
        </ul>
      )}
      {remoteServers.length > 0 && (
        <ul className="wf-server-list">
          {remoteServers.map((s) => (
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
      {!host?.configured && (
        <button className="wf-link" onClick={onHostSetup}>
          …or host a new server on this computer
        </button>
      )}
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
            (the host finds it in Settings → Server; a standalone server prints it at startup):
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
  defaultMode,
  freshHost,
  onBack,
  onError,
}: {
  probe: ProbeResult;
  lastUsername: string | null;
  defaultMode: "login" | "register";
  freshHost: boolean;
  onBack: () => void;
  onError: (msg: string | null) => void;
}) {
  const [mode, setMode] = useState<"login" | "register" | "reset">(defaultMode);
  const [username, setUsername] = useState(lastUsername ?? "");
  const [password, setPassword] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetDone, setResetDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const setConnected = useSession((s) => s.setConnected);

  const submit = async () => {
    setBusy(true);
    onError(null);
    try {
      if (mode === "reset") {
        await backend.resetPassword(probe.addr, username.trim(), resetCode, password);
        setResetDone(true);
        setPassword("");
        setResetCode("");
        setMode("login");
      } else {
        const session =
          mode === "login"
            ? await backend.login(probe.addr, username, password)
            : await backend.register(probe.addr, username, password);
        setConnected(session);
      }
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
      {freshHost && mode === "register" && (
        <p className="wf-connect-dim">
          Your server is live. Create your account — the first account becomes the server admin.
        </p>
      )}
      {resetDone && mode === "login" && (
        <p className="wf-connect-dim">Password changed — log in with your new password.</p>
      )}
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
      {mode === "reset" && (
        <p className="wf-connect-dim">
          Ask your server admin for a one-time reset code, then set a new password here.
        </p>
      )}
      <input
        placeholder="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoFocus={!lastUsername}
        autoCapitalize="off"
        autoCorrect="off"
      />
      {mode === "reset" && (
        <input
          placeholder="reset code (e.g. ABCDE-FGHJK)"
          value={resetCode}
          onChange={(e) => setResetCode(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
        />
      )}
      <input
        placeholder={
          mode === "login" ? "password" : "new password (8+ characters)"
        }
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus={!!lastUsername}
      />
      <div className="wf-connect-row">
        <button type="button" onClick={onBack} disabled={busy}>
          Back
        </button>
        {mode === "login" && (
          <button
            type="button"
            className="wf-linklike"
            onClick={() => {
              setMode("reset");
              setPassword("");
              onError(null);
            }}
          >
            Forgot password?
          </button>
        )}
        {mode === "reset" && (
          <button type="button" className="wf-linklike" onClick={() => setMode("login")}>
            Back to log in
          </button>
        )}
        <button
          type="submit"
          className="wf-primary"
          disabled={
            busy || !username.trim() || !password || (mode === "reset" && !resetCode.trim())
          }
        >
          {busy
            ? "…"
            : mode === "login"
              ? "Log in"
              : mode === "register"
                ? "Create account"
                : "Set new password"}
        </button>
      </div>
    </form>
  );
}
