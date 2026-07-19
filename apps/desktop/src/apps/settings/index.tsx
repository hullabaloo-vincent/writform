import {
  ArrowDownToLine,
  Fingerprint,
  Mic,
  MonitorSmartphone,
  Settings as SettingsIcon,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AdminStats } from "../../bindings/proto/AdminStats";
import type { AdminUser } from "../../bindings/proto/AdminUser";
import type { DeviceSession } from "../../bindings/proto/DeviceSession";
import type { User } from "../../bindings/proto/User";
import {
  backend,
  isCmdError,
  type CmdError,
  type HostStatus,
  type Reachability,
  type SavedServer,
} from "../../lib/backend";
import { uploadBlob } from "../../lib/upload";
import {
  loadVoiceSettings,
  saveVoiceSettings,
  type VoiceSettings,
} from "../../lib/voiceSettings";
import { Avatar, confirmDialog } from "../../platform";
import type { WritformApp } from "../../platform";
import { useSession } from "../../stores/session";

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await backend.apiFetch(method, path, body);
  if (res.status >= 400) {
    const err = (res.body ?? {}) as Partial<CmdError>;
    throw {
      code: err.code ?? `http_${res.status}`,
      message: err.message ?? `request failed (${res.status})`,
    } satisfies CmdError;
  }
  return res.body as T;
}

type Tab = "profile" | "voice" | "devices" | "server" | "app" | "admin";

function SettingsView() {
  const me = useSession((s) => s.session?.user);
  const [tab, setTab] = useState<Tab>("profile");
  const [error, setError] = useState<string | null>(null);

  const tabs: { id: Tab; label: string; icon: React.ReactNode; show: boolean }[] = [
    { id: "profile", label: "Profile", icon: <UserRound size={15} />, show: true },
    { id: "voice", label: "Voice", icon: <Mic size={15} />, show: true },
    { id: "devices", label: "Devices", icon: <MonitorSmartphone size={15} />, show: true },
    { id: "server", label: "Server", icon: <Fingerprint size={15} />, show: true },
    { id: "app", label: "Application", icon: <ArrowDownToLine size={15} />, show: true },
    { id: "admin", label: "Admin", icon: <ShieldCheck size={15} />, show: !!me?.is_server_admin },
  ];

  return (
    <div className="wf-settings">
      <nav className="wf-settings-tabs">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => {
                setError(null);
                setTab(t.id);
              }}
            >
              {t.icon} {t.label}
            </button>
          ))}
      </nav>
      <div className="wf-settings-body">
        {error && <p className="wf-connect-error">{error}</p>}
        {tab === "profile" && <ProfileTab onError={setError} />}
        {tab === "voice" && <VoiceTab onError={setError} />}
        {tab === "devices" && <DevicesTab onError={setError} />}
        {tab === "server" && <ServerTab onError={setError} />}
        {tab === "app" && <AppTab onError={setError} />}
        {tab === "admin" && <AdminTab onError={setError} />}
      </div>
    </div>
  );
}

function ProfileTab({ onError }: { onError: (e: string | null) => void }) {
  const session = useSession((s) => s.session);
  const setConnected = useSession((s) => s.setConnected);
  const [displayName, setDisplayName] = useState(session?.user.display_name ?? "");
  const [bio, setBio] = useState(session?.user.bio ?? "");
  const [avatarId, setAvatarId] = useState<number | null>(
    session?.user.avatar_attachment_id ?? null,
  );
  const [useColor, setUseColor] = useState(!!session?.user.accent_color);
  const [color, setColor] = useState(session?.user.accent_color ?? "#8ab6e8");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!session) return null;

  const save = () => {
    onError(null);
    setBusy(true);
    api<User>("PATCH", "/api/v1/auth/me", {
      display_name: displayName.trim() || null,
      avatar_attachment_id: avatarId,
      accent_color: useColor ? color : null,
      bio: bio.trim() || null,
    })
      .then((user) => {
        setConnected({ ...session, user });
        setSaved(true);
      })
      .catch((e) => onError(isCmdError(e) ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <section>
      <h3>Profile</h3>
      <p className="wf-session-meta">
        Signed in as <strong>@{session.user.username}</strong>
        {session.user.is_server_admin && " · server admin"}
      </p>
      <div className="wf-settings-field">
        Avatar
        <div className="wf-connect-row" style={{ alignItems: "center" }}>
          <Avatar
            name={displayName.trim() || session.user.username}
            attachmentId={avatarId}
            accentColor={useColor ? color : null}
            size={42}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                setBusy(true);
                uploadBlob(file, file.name)
                  .then((meta) => {
                    setAvatarId(meta.id);
                    setSaved(false);
                  })
                  .catch((err) => onError(isCmdError(err) ? err.message : String(err)))
                  .finally(() => setBusy(false));
              }
              e.target.value = "";
            }}
          />
          <button disabled={busy} onClick={() => fileRef.current?.click()}>
            Upload image
          </button>
          {avatarId !== null && (
            <button
              onClick={() => {
                setAvatarId(null);
                setSaved(false);
              }}
            >
              Remove
            </button>
          )}
        </div>
      </div>
      <label className="wf-settings-field wf-field-row">
        <input
          type="checkbox"
          checked={useColor}
          onChange={(e) => {
            setUseColor(e.target.checked);
            setSaved(false);
          }}
        />
        Accent color
        <input
          type="color"
          value={color}
          disabled={!useColor}
          onChange={(e) => {
            setColor(e.target.value);
            setSaved(false);
          }}
        />
      </label>
      <label className="wf-settings-field">
        About me (shown on your profile card)
        <textarea
          className="wf-bio-input"
          rows={3}
          maxLength={300}
          placeholder="Say something about yourself…"
          value={bio}
          onChange={(e) => {
            setBio(e.target.value);
            setSaved(false);
          }}
        />
      </label>
      <label className="wf-settings-field">
        Display name
        <div className="wf-connect-row">
          <input
            value={displayName}
            placeholder="(none — username is shown)"
            onChange={(e) => {
              setDisplayName(e.target.value);
              setSaved(false);
            }}
          />
          <button className="wf-primary" disabled={busy} onClick={save}>
            {saved ? "Saved ✓" : "Save profile"}
          </button>
        </div>
      </label>
    </section>
  );
}

function VoiceTab({ onError }: { onError: (e: string | null) => void }) {
  const [settings, setSettings] = useState<VoiceSettings>(() => loadVoiceSettings());
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const testStop = useRef<(() => void) | null>(null);

  const apply = (patch: Partial<VoiceSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveVoiceSettings(next);
  };

  const refreshDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setInputs(devices.filter((d) => d.kind === "audioinput"));
    } catch {
      // devices stay unknown until permission is granted
    }
  };
  useEffect(() => {
    void refreshDevices();
    return () => testStop.current?.();
  }, []);

  const stopTest = () => {
    testStop.current?.();
    testStop.current = null;
    setTesting(false);
    setLevel(0);
  };

  const startTest = async () => {
    onError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: settings.inputDeviceId
          ? { deviceId: { ideal: settings.inputDeviceId } }
          : true,
      });
      // Labels become available once permission is granted.
      void refreshDevices();
      const ctx = new AudioContext();
      if (ctx.state === "suspended") void ctx.resume();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(512);
      const gain = () => loadVoiceSettings().inputGain;
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3.5 * gain()));
      }, 80);
      testStop.current = () => {
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
      };
      setTesting(true);
    } catch (e) {
      onError(
        e instanceof DOMException
          ? "microphone access was denied"
          : isCmdError(e)
            ? e.message
            : String(e),
      );
    }
  };

  return (
    <section>
      <h3>Voice</h3>
      <label className="wf-settings-field">
        Microphone
        <select
          value={settings.inputDeviceId ?? ""}
          onChange={(e) => apply({ inputDeviceId: e.target.value || null })}
        >
          <option value="">System default</option>
          {inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Microphone ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>
        {inputs.every((d) => !d.label) && (
          <span className="wf-session-meta">
            Run a mic test once to grant access and see device names.
          </span>
        )}
      </label>
      <label className="wf-settings-field wf-field-row">
        Input volume
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={settings.inputGain}
          onChange={(e) => apply({ inputGain: Number(e.target.value) })}
        />
        <span className="wf-session-meta">{Math.round(settings.inputGain * 100)}%</span>
      </label>
      <label className="wf-settings-field wf-field-row">
        Speaker volume
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.outputVolume}
          onChange={(e) => apply({ outputVolume: Number(e.target.value) })}
        />
        <span className="wf-session-meta">{Math.round(settings.outputVolume * 100)}%</span>
      </label>
      <div className="wf-settings-field">
        <div className="wf-connect-row" style={{ alignItems: "center", justifyContent: "flex-start" }}>
          <button className={testing ? "" : "wf-primary"} onClick={() => (testing ? stopTest() : void startTest())}>
            {testing ? "Stop test" : "Mic test"}
          </button>
          <div className="wf-mic-meter">
            {Array.from({ length: 24 }, (_, i) => (
              <span key={i} className={level * 24 > i ? "lit" : ""} />
            ))}
          </div>
        </div>
        <span className="wf-session-meta">
          Speak — the meter shows your level after the input-volume setting.
          Device changes apply the next time you join a voice channel.
        </span>
      </div>
    </section>
  );
}

function DevicesTab({ onError }: { onError: (e: string | null) => void }) {
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const refresh = () =>
    void api<DeviceSession[]>("GET", "/api/v1/auth/devices").then(setDevices).catch(() => {});
  useEffect(refresh, []);

  return (
    <section>
      <h3>Devices</h3>
      <p className="wf-session-meta">
        Every logged-in session for your account on this server. Revoking one logs that device
        out immediately.
      </p>
      <ul className="wf-device-list">
        {devices.map((d) => (
          <li key={d.id}>
            <div className="wf-plugin-info">
              <strong>
                {d.device_label ?? "unnamed device"}
                {d.current && <span className="wf-member-badge"> this device</span>}
              </strong>
              <span className="wf-session-meta">
                signed in {new Date(d.created_at).toLocaleString()} · last seen{" "}
                {new Date(d.last_seen_at).toLocaleString()}
              </span>
            </div>
            {!d.current && (
              <button
                onClick={() =>
                  void api("DELETE", `/api/v1/auth/devices/${d.id}`)
                    .then(refresh)
                    .catch((e) => onError(isCmdError(e) ? e.message : String(e)))
                }
              >
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ServerTab({ onError }: { onError: (e: string | null) => void }) {
  const session = useSession((s) => s.session);
  const [servers, setServers] = useState<SavedServer[]>([]);
  useEffect(() => {
    void backend.listServers().then(setServers).catch(() => {});
  }, []);
  const current = servers.find((s) => s.addr === session?.addr);

  return (
    <section>
      <h3>Server</h3>
      {current ? (
        <>
          <p>
            Connected to <strong>{current.server_name}</strong> at <code>{current.addr}</code>
          </p>
          <p className="wf-session-meta">
            Pinned identity fingerprint (the host sees the same value here; a standalone server
            prints it at startup):
          </p>
          <div className="wf-fingerprint">{current.fingerprint}</div>
          <p className="wf-session-meta">
            If this ever changes unexpectedly, the app will warn loudly before connecting — that
            can mean a reinstalled server, or someone intercepting the connection.
          </p>
        </>
      ) : (
        <p className="wf-session-meta">Connected to {session?.addr}</p>
      )}
      <HostingSection onError={onError} />
    </section>
  );
}

function CopyableAddr({ addr, note }: { addr: string; note: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <li>
      <div className="wf-plugin-info">
        <strong>
          <code>{addr}</code>
        </strong>
        <span className="wf-session-meta">{note}</span>
      </div>
      <button
        onClick={() => {
          navigator.clipboard
            .writeText(addr)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {});
        }}
      >
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </li>
  );
}

function HostingSection({ onError }: { onError: (e: string | null) => void }) {
  const [host, setHost] = useState<HostStatus | null>(null);
  const [reach, setReach] = useState<Reachability | null>(null);
  const [testing, setTesting] = useState(false);

  const refresh = () => void backend.hostStatus().then(setHost).catch(() => {});
  useEffect(refresh, []);

  if (!host?.configured) return null;

  const testReachability = () => {
    setTesting(true);
    onError(null);
    backend
      .hostReachability()
      .then(setReach)
      .catch((e) => onError(isCmdError(e) ? e.message : String(e)))
      .finally(() => setTesting(false));
  };

  return (
    <>
      <h4>Hosting — {host.server_name}</h4>
      <p className="wf-session-meta">
        This computer hosts the server ({host.running ? `running on port ${host.port}` : "stopped"}).
        It runs while WritForm is open and starts again with the app.
      </p>

      {host.running && (
        <>
          <p className="wf-session-meta">Share an address with friends — they add it via “Add a server”:</p>
          <ul className="wf-device-list">
            {host.lan_addrs.map((a) => (
              <CopyableAddr key={a} addr={a} note="same network (home / office Wi-Fi)" />
            ))}
            {reach?.upnp.status === "mapped" && (
              <CopyableAddr addr={reach.upnp.external_addr} note="internet (router port mapped via UPnP)" />
            )}
          </ul>
          <p className="wf-session-meta">
            When a friend connects for the first time, they are shown the server fingerprint above
            — read it to them so they can verify it.
          </p>

          <div className="wf-connect-row" style={{ justifyContent: "flex-start" }}>
            <button onClick={testReachability} disabled={testing}>
              {testing ? "Asking your router…" : "Make reachable from the internet"}
            </button>
            <button
              onClick={() =>
                void confirmDialog(
                  "Stop hosting? Everyone connected to your server will be disconnected, and it will no longer start with the app.",
                  { title: "Stop hosting", confirmLabel: "Stop hosting", danger: true },
                ).then((ok) => {
                  if (!ok) return;
                  backend
                    .hostStop()
                    .then(setHost)
                    .catch((e) => onError(isCmdError(e) ? e.message : String(e)));
                })
              }
            >
              Stop hosting
            </button>
          </div>
          {reach?.upnp.status === "failed" && (
            <p className="wf-session-meta">
              Couldn’t map the port automatically ({reach.upnp.message}). To let friends connect
              over the internet, either forward TCP port {host.port} to this computer in your
              router settings, or put everyone on a shared VPN like Tailscale and share your
              Tailscale address instead — no router changes needed.
            </p>
          )}
        </>
      )}
      {!host.running && (
        <div className="wf-connect-row" style={{ justifyContent: "flex-start" }}>
          <button
            onClick={() =>
              void backend
                .hostStart(host.port, host.server_name)
                .then(setHost)
                .catch((e) => onError(isCmdError(e) ? e.message : String(e)))
            }
          >
            Start hosting again
          </button>
        </div>
      )}
    </>
  );
}

function AppTab({ onError }: { onError: (e: string | null) => void }) {
  const inTauri = "__TAURI_INTERNALS__" in window;
  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<
    "idle" | "checking" | "up_to_date" | "available" | "installing" | "installed"
  >("idle");
  const updateRef = useRef<{ version: string; downloadAndInstall: () => Promise<void> } | null>(
    null,
  );

  useEffect(() => {
    if (!inTauri) return;
    void import("@tauri-apps/api/app").then(({ getVersion }) =>
      getVersion().then(setVersion).catch(() => {}),
    );
  }, [inTauri]);

  const check = async () => {
    setStatus("checking");
    onError(null);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        setStatus("up_to_date");
        return;
      }
      updateRef.current = update;
      setStatus("available");
    } catch (e) {
      onError(`update check failed: ${isCmdError(e) ? e.message : String(e)}`);
      setStatus("idle");
    }
  };

  const install = async () => {
    const update = updateRef.current;
    if (!update) return;
    setStatus("installing");
    onError(null);
    try {
      await update.downloadAndInstall();
      setStatus("installed");
      const restart = await confirmDialog("Update installed. Restart WritForm now?", {
        title: "Update ready",
        confirmLabel: "Restart now",
      });
      if (restart) {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      }
    } catch (e) {
      onError(`update failed: ${isCmdError(e) ? e.message : String(e)}`);
      setStatus("available");
    }
  };

  return (
    <section>
      <h3>Application</h3>
      <p className="wf-session-meta">
        WritForm {version ?? ""} — updates are downloaded from GitHub Releases and verified
        against the app's signing key before installing.
      </p>
      {!inTauri ? (
        <p className="wf-session-meta">Updates are only available in the desktop app.</p>
      ) : (
        <div className="wf-connect-row" style={{ justifyContent: "flex-start" }}>
          {status === "available" ? (
            <button className="wf-primary" onClick={() => void install()}>
              Install {updateRef.current?.version}
            </button>
          ) : (
            <button onClick={() => void check()} disabled={status === "checking" || status === "installing"}>
              {status === "checking"
                ? "Checking…"
                : status === "installing"
                  ? "Installing…"
                  : "Check for updates"}
            </button>
          )}
          {status === "up_to_date" && <span className="wf-session-meta">You're up to date.</span>}
          {status === "installed" && (
            <span className="wf-session-meta">Installed — restart to finish.</span>
          )}
        </div>
      )}
    </section>
  );
}

function AdminTab({ onError }: { onError: (e: string | null) => void }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);

  const refresh = () => {
    void api<AdminStats>("GET", "/api/v1/admin/stats").then(setStats).catch(() => {});
    void api<AdminUser[]>("GET", "/api/v1/admin/users").then(setUsers).catch(() => {});
  };
  useEffect(refresh, []);

  const fmtBytes = (n: number) =>
    n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;

  return (
    <section>
      <h3>Server admin</h3>
      {stats && (
        <div className="wf-admin-stats">
          <Stat label="users" value={stats.users} />
          <Stat label="online" value={stats.online_users} />
          <Stat label="groups" value={stats.groups} />
          <Stat label="messages" value={stats.messages} />
          <Stat label="sessions" value={stats.sessions} />
          <Stat label="attachments" value={fmtBytes(stats.attachments_bytes)} />
        </div>
      )}
      <h4>Users</h4>
      <ul className="wf-device-list">
        {users.map((u) => (
          <li key={u.user.id}>
            <span className={`wf-presence-dot ${u.online ? "" : "off"}`} />
            <div className="wf-plugin-info">
              <strong>
                {u.user.display_name ?? u.user.username}
                {u.user.is_server_admin && <span className="wf-member-badge"> admin</span>}
              </strong>
              <span className="wf-session-meta">
                @{u.user.username} · joined {new Date(u.user.created_at).toLocaleDateString()} ·{" "}
                {u.device_count} device{u.device_count === 1 ? "" : "s"}
              </span>
            </div>
            <button
              onClick={() =>
                void confirmDialog(`Log @${u.user.username} out of every device?`, {
                  title: "Force logout",
                  confirmLabel: "Log out everywhere",
                  danger: true,
                }).then((ok) => {
                  if (!ok) return;
                  void api("POST", `/api/v1/admin/users/${u.user.id}/logout`)
                    .then(refresh)
                    .catch((e) => onError(isCmdError(e) ? e.message : String(e)));
                })
              }
            >
              Force logout
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="wf-admin-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export const settingsApp: WritformApp = {
  manifest: {
    id: "writform.settings",
    name: "Settings",
    icon: <SettingsIcon size={20} />,
    permissions: ["ui", "commands", "net"],
  },
  activate(ctx) {
    ctx.ui.registerMainView(() => <SettingsView />);
    ctx.commands.register({
      id: "settings.open",
      title: "Settings: Open",
      run: () => {
        void import("../../platform").then(({ usePlatform }) =>
          usePlatform.getState().setActiveApp("writform.settings"),
        );
      },
    });
  },
};
