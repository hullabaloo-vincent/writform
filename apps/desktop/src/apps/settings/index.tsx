import {
  ArrowDownToLine,
  Bell,
  Fingerprint,
  Mic,
  MonitorSmartphone,
  Settings as SettingsIcon,
  ShieldCheck,
  UserRound,
  PenLine,
  Type as TypeIcon,
} from "lucide-react";

import {
  setSmartPunctuationEnabled,
  smartPunctuationEnabled,
} from "../../editor/SmartPunctuation";
import { exactPageView, setExactPageView } from "../../doclayout/usePageMap";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import type { AdminStats } from "../../bindings/proto/AdminStats";
import type { AdminUser } from "../../bindings/proto/AdminUser";
import type { DeviceSession } from "../../bindings/proto/DeviceSession";
import type { User } from "../../bindings/proto/User";
import {
  attachmentUrl,
  backend,
  isCmdError,
  isMobileApp,
  isWeb,
  type CmdError,
  type HostStatus,
  type PortableProfile,
  type Reachability,
  type SavedServer,
} from "../../lib/backend";
import { applyPortableProfile } from "../../lib/portableProfile";
import { checkForUpdate, type AvailableUpdate } from "../../lib/updates";
import { CameraError, getCameraStream } from "../../lib/camera";
import { MicrophoneError, getMicrophoneStream } from "../../lib/microphone";
import { uploadBlob } from "../../lib/upload";
import { canPickAudioOutput } from "../../lib/voiceSettings";
import { loadNotifPrefs, saveNotifPrefs, type NotifPrefs } from "../../lib/notifPrefs";
import { discoverPublicIp } from "../../lib/publicIp";
import {
  loadVoiceSettings,
  saveVoiceSettings,
  type VoiceSettings,
} from "../../lib/voiceSettings";
import { Avatar, confirmDialog, toast } from "../../platform";
import type { WritformApp } from "../../platform";
import { FontSettings } from "../../fonts/ui/FontSettings";
import { AccountMenu } from "../../platform/AccountMenu";
import { SELECTION_TOOLS, useSelectionMenu } from "../../editor/ui/selectionMenu";
import { useLocalProfile } from "../../stores/localProfile";
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

type Tab =
  | "profile"
  | "writing"
  | "voice"
  | "notifications"
  | "devices"
  | "server"
  | "fonts"
  | "app"
  | "admin";

function SettingsView() {
  const me = useSession((s) => s.session?.user);
  const offline = useSession((s) => s.phase === "offline");
  const [tab, setTab] = useState<Tab>("profile");
  const [error, setError] = useState<string | null>(null);

  const tabs: { id: Tab; label: string; icon: React.ReactNode; show: boolean }[] = [
    { id: "profile", label: "Profile", icon: <UserRound size={15} />, show: true },
    { id: "writing", label: "Writing", icon: <PenLine size={15} />, show: true },
    // Devices, updates and which servers you know are this device's own.
    { id: "voice", label: "Voice & Video", icon: <Mic size={15} />, show: true },
    { id: "notifications", label: "Notifications", icon: <Bell size={15} />, show: true },
    { id: "devices", label: "Devices", icon: <MonitorSmartphone size={15} />, show: !offline },
    { id: "server", label: offline ? "Servers" : "Server", icon: <Fingerprint size={15} />, show: !isWeb || !offline },
    { id: "fonts", label: "Fonts", icon: <TypeIcon size={15} />, show: true },
    { id: "app", label: "Application", icon: <ArrowDownToLine size={15} />, show: !isWeb },
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
        {tab === "profile" &&
          (offline ? <OfflineProfileTab onError={setError} /> : <ProfileTab onError={setError} />)}
        {tab === "writing" && <WritingTab />}
        {tab === "voice" && <VoiceTab onError={setError} />}
        {tab === "notifications" && <NotificationsTab />}
        {tab === "devices" && <DevicesTab onError={setError} />}
        {tab === "server" && <ServerTab onError={setError} />}
        {tab === "app" && <AppTab onError={setError} />}
        {tab === "fonts" && <FontSettings />}
        {tab === "admin" && <AdminTab onError={setError} />}
      </div>
    </div>
  );
}

/**
 * Not connected: who you are on this device — the name on your work, your
 * picture, the colour and words that go with them. The same profile can be
 * applied to a server you join, in one step.
 */
function OfflineProfileTab({ onError }: { onError: (e: string | null) => void }) {
  const loaded = useLocalProfile((s) => s.loaded);
  const profile = useLocalProfile();
  const [displayName, setDisplayName] = useState(profile.name);
  const [bio, setBio] = useState(profile.bio ?? "");
  const [useColor, setUseColor] = useState(!!profile.accent);
  const [color, setColor] = useState(profile.accent ?? "#8ab6e8");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const avatarRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLInputElement>(null);

  // The saved profile arrives a moment after the app starts.
  useEffect(() => {
    if (!loaded) return;
    const p = useLocalProfile.getState();
    setDisplayName(p.name);
    setBio(p.bio ?? "");
    setUseColor(!!p.accent);
    if (p.accent) setColor(p.accent);
  }, [loaded]);

  if (!loaded) return null;

  const fail = (e: unknown) => onError(isCmdError(e) ? e.message : String(e));
  const run = (work: Promise<unknown>) => {
    onError(null);
    setBusy(true);
    return work.catch(fail).finally(() => setBusy(false));
  };
  const save = () =>
    void run(
      profile
        .setFields({ name: displayName, accent: useColor ? color : null, bio: bio.trim() || null })
        .then(() => setSaved(true)),
    );
  const pick = (kind: "avatar" | "banner") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void run(profile.setImage(kind, file));
  };
  const anything = !!(profile.name || profile.bio || profile.accent || profile.avatar || profile.banner);

  return (
    <section>
      <h3>Your profile</h3>
      <p className="wf-session-meta">
        Who you are on this device: the name on what you write and export, and the picture beside it. When you
        join a server you can apply it there in one step. It isn’t sent anywhere until you do.
      </p>
      <div className="wf-settings-field">
        Picture
        <div className="wf-connect-row" style={{ alignItems: "center" }}>
          <Avatar name={displayName.trim() || "You"} src={profile.avatar} accentColor={useColor ? color : null} size={42} />
          <input ref={avatarRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={pick("avatar")} />
          <button disabled={busy} onClick={() => avatarRef.current?.click()}>
            {profile.avatar ? "Change picture" : "Choose a picture"}
          </button>
          {profile.avatar && (
            <button disabled={busy} onClick={() => void run(profile.setImage("avatar", null))}>
              Remove
            </button>
          )}
        </div>
      </div>
      <div className="wf-settings-field">
        Banner (behind your picture on a profile card)
        <div className="wf-banner-preview" style={{ background: useColor ? color : "var(--wf-accent)" }}>
          {profile.banner && <img className="wf-profile-banner-img" src={profile.banner} alt="" draggable={false} />}
        </div>
        <div className="wf-connect-row" style={{ alignItems: "center" }}>
          <input ref={bannerRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={pick("banner")} />
          <button disabled={busy} onClick={() => bannerRef.current?.click()}>
            {profile.banner ? "Change banner" : "Choose a banner"}
          </button>
          {profile.banner && (
            <button disabled={busy} onClick={() => void run(profile.setImage("banner", null))}>
              Remove
            </button>
          )}
        </div>
      </div>
      <label className="wf-settings-field">
        Name
        <input
          value={displayName}
          maxLength={64}
          placeholder="Your name as an author"
          onChange={(e) => {
            setDisplayName(e.target.value);
            setSaved(false);
          }}
        />
      </label>
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
        About me
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
      <div className="wf-connect-row" style={{ justifyContent: "flex-start" }}>
        <button className="wf-primary" disabled={busy} onClick={save}>
          {saved ? "Saved ✓" : "Save"}
        </button>
        {anything && (
          <button
            disabled={busy}
            onClick={() =>
              void confirmDialog(
                "Clear the profile saved on this device, including its name and pictures? Your profiles on servers are not affected.",
                { title: "Clear profile", confirmLabel: "Clear", danger: true },
              ).then((ok) => {
                if (!ok) return;
                void run(
                  profile.clear().then(() => {
                    setDisplayName("");
                    setBio("");
                    setUseColor(false);
                    setSaved(false);
                  }),
                );
              })
            }
          >
            Clear
          </button>
        )}
      </div>
    </section>
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
  const [bannerId, setBannerId] = useState<number | null>(
    session?.user.banner_attachment_id ?? null,
  );
  const [useColor, setUseColor] = useState(!!session?.user.accent_color);
  const [color, setColor] = useState(session?.user.accent_color ?? "#8ab6e8");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [portable, setPortable] = useState<PortableProfile | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void backend.profileGet().then(setPortable).catch(() => {});
  }, []);

  if (!session) return null;

  const save = () => {
    onError(null);
    setBusy(true);
    api<User>("PATCH", "/api/v1/auth/me", {
      display_name: displayName.trim() || null,
      avatar_attachment_id: avatarId,
      banner_attachment_id: bannerId,
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
      <div className="wf-settings-field">
        Banner (behind your avatar on the profile card)
        <div
          className="wf-banner-preview"
          style={{ background: useColor ? color : "var(--wf-accent)" }}
        >
          {bannerId !== null && (
            <img
              className="wf-profile-banner-img"
              src={attachmentUrl(bannerId)}
              alt=""
              draggable={false}
            />
          )}
        </div>
        <div className="wf-connect-row" style={{ alignItems: "center" }}>
          <input
            ref={bannerRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                setBusy(true);
                uploadBlob(file, file.name)
                  .then((meta) => {
                    setBannerId(meta.id);
                    setSaved(false);
                  })
                  .catch((err) => onError(isCmdError(err) ? err.message : String(err)))
                  .finally(() => setBusy(false));
              }
              e.target.value = "";
            }}
          />
          <button disabled={busy} onClick={() => bannerRef.current?.click()}>
            Upload image
          </button>
          {bannerId !== null && (
            <button
              onClick={() => {
                setBannerId(null);
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
            placeholder="(none, so the username is shown)"
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

      {!isWeb && (
      <>
      <h4>Portable profile</h4>
      <p className="wf-session-meta">
        Keep a copy of this look (name, colors, bio, avatar, banner) on this computer and apply
        it to any server you join. Profiles are otherwise per-server. Usernames stay
        per-server and are not included.
      </p>
      <div className="wf-connect-row" style={{ justifyContent: "flex-start" }}>
        <button
          disabled={busy}
          onClick={() => {
            onError(null);
            setBusy(true);
            backend
              .profileSave({
                displayName: displayName.trim() || null,
                accentColor: useColor ? color : null,
                bio: bio.trim() || null,
                avatarAttachmentId: avatarId,
                bannerAttachmentId: bannerId,
              })
              .then((p) => {
                setPortable(p);
                // It is also who you are here when no server is connected.
                void useLocalProfile.getState().load();
                toast("Portable profile saved on this computer.", "success");
              })
              .catch((e) => onError(isCmdError(e) ? e.message : String(e)))
              .finally(() => setBusy(false));
          }}
        >
          Save current as portable
        </button>
        {portable && (
          <button
            disabled={busy}
            onClick={() => {
              onError(null);
              setBusy(true);
              applyPortableProfile()
                .then((user) => {
                  if (!user) return;
                  setConnected({ ...session, user });
                  setDisplayName(user.display_name ?? "");
                  setBio(user.bio ?? "");
                  setAvatarId(user.avatar_attachment_id ?? null);
                  setBannerId(user.banner_attachment_id ?? null);
                  setUseColor(!!user.accent_color);
                  if (user.accent_color) setColor(user.accent_color);
                  setSaved(true);
                  toast("Portable profile applied to this server.", "success");
                })
                .catch((e) => onError(isCmdError(e) ? e.message : String(e)))
                .finally(() => setBusy(false));
            }}
          >
            Apply to this server
          </button>
        )}
        {portable && (
          <button
            disabled={busy}
            onClick={() =>
              void confirmDialog(
                "Delete the portable profile saved on this computer? Server profiles are not affected.",
                { title: "Delete portable profile", confirmLabel: "Delete", danger: true },
              ).then((ok) => {
                if (!ok) return;
                backend
                  .profileDelete()
                  .then(() => {
                    setPortable(null);
                    void useLocalProfile.getState().load();
                  })
                  .catch((e) => onError(isCmdError(e) ? e.message : String(e)));
              })
            }
          >
            Delete
          </button>
        )}
      </div>
      {portable && (
        <p className="wf-session-meta">
          Saved {new Date(portable.saved_at).toLocaleString()}. You’ll also be offered it when
          registering on a new server.
        </p>
      )}
      </>
      )}
    </section>
  );
}

function VoiceTab({ onError }: { onError: (e: string | null) => void }) {
  const [settings, setSettings] = useState<VoiceSettings>(() => loadVoiceSettings());
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [cameraTesting, setCameraTesting] = useState(false);
  const testStop = useRef<(() => void) | null>(null);
  const cameraStop = useRef<(() => void) | null>(null);
  const cameraPreview = useRef<MediaStream | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);

  const apply = (patch: Partial<VoiceSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveVoiceSettings(next);
  };

  const refreshDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setInputs(devices.filter((d) => d.kind === "audioinput"));
      setOutputs(devices.filter((d) => d.kind === "audiooutput"));
      setCameras(devices.filter((d) => d.kind === "videoinput"));
    } catch {
      // devices stay unknown until permission is granted
    }
  };
  useEffect(() => {
    void refreshDevices();
    return () => {
      testStop.current?.();
      cameraStop.current?.();
    };
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
      const stream = await getMicrophoneStream(settings.inputDeviceId);
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
      // MicrophoneError already carries the actionable wording (e.g. how to
      // re-enable access in System Settings).
      onError(
        e instanceof MicrophoneError
          ? e.message
          : isCmdError(e)
            ? e.message
            : String(e),
      );
    }
  };

  const stopCameraTest = () => {
    cameraStop.current?.();
    cameraStop.current = null;
    setCameraTesting(false);
  };

  const startCameraTest = async () => {
    onError(null);
    try {
      const stream = await getCameraStream(settings.videoInputDeviceId, settings.videoQuality);
      // Labels become available once permission is granted.
      void refreshDevices();
      cameraPreview.current = stream;
      cameraStop.current = () => {
        stream.getTracks().forEach((t) => t.stop());
        cameraPreview.current = null;
      };
      setCameraTesting(true);
    } catch (e) {
      onError(e instanceof CameraError ? e.message : isCmdError(e) ? e.message : String(e));
    }
  };

  // The preview <video> mounts only after cameraTesting flips, so the stream
  // attaches here rather than inside startCameraTest.
  useEffect(() => {
    if (cameraTesting && previewRef.current && cameraPreview.current) {
      previewRef.current.srcObject = cameraPreview.current;
    }
  }, [cameraTesting]);

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
      {canPickAudioOutput() ? (
        <label className="wf-settings-field">
          Output device (speakers / headphones)
          <select
            value={settings.outputDeviceId ?? ""}
            onChange={(e) => apply({ outputDeviceId: e.target.value || null })}
          >
            <option value="">System default</option>
            {outputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Output ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
        </label>
      ) : (
        // Android Chrome and macOS WKWebView have no setSinkId — better to
        // say why the picker is missing than to silently omit it.
        <div className="wf-settings-field">
          Output device (speakers / headphones)
          <span className="wf-session-meta">
            Audio output follows the device's own routing on this platform.
          </span>
        </div>
      )}
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
          Speak and the meter shows your level after the input-volume setting.
          Device changes apply immediately even mid-call.
        </span>
      </div>
      <label className="wf-settings-field wf-field-row">
        <input
          type="checkbox"
          checked={settings.sounds}
          onChange={(e) => apply({ sounds: e.target.checked })}
        />
        Play a short sound when someone joins or leaves your voice channel
      </label>

      <h3>Video</h3>
      <label className="wf-settings-field">
        Camera
        <select
          value={settings.videoInputDeviceId ?? ""}
          onChange={(e) => apply({ videoInputDeviceId: e.target.value || null })}
        >
          <option value="">System default</option>
          {cameras.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Camera ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>
        {cameras.every((d) => !d.label) && (
          <span className="wf-session-meta">
            Run a camera test once to grant access and see device names.
          </span>
        )}
      </label>
      <label className="wf-settings-field">
        Quality
        <select
          value={settings.videoQuality}
          onChange={(e) => apply({ videoQuality: e.target.value === "720p" ? "720p" : "360p" })}
        >
          <option value="360p">360p: easier on bandwidth (recommended)</option>
          <option value="720p">720p: sharper but several times the bandwidth</option>
        </select>
      </label>
      <div className="wf-settings-field">
        <div className="wf-connect-row" style={{ alignItems: "center", justifyContent: "flex-start" }}>
          <button
            className={cameraTesting ? "" : "wf-primary"}
            onClick={() => (cameraTesting ? stopCameraTest() : void startCameraTest())}
          >
            {cameraTesting ? "Stop test" : "Camera test"}
          </button>
        </div>
        {cameraTesting && <video ref={previewRef} autoPlay playsInline muted className="wf-camera-preview" />}
        <span className="wf-session-meta">
          The preview is mirrored, but others see you unmirrored.
          Device and quality changes apply immediately even while your camera is on.
        </span>
      </div>
    </section>
  );
}

/** Per-device writing preferences. */
// (Fetched when asked for: the checker is not part of opening Settings.)
const MyRulesDialog = lazy(() => import("../../proof/ui/MyRulesDialog"));

function WritingTab() {
  const [smart, setSmart] = useState(smartPunctuationEnabled);
  const [exact, setExact] = useState(exactPageView);
  const [rulesOpen, setRulesOpen] = useState(false);
  const menu = useSelectionMenu();
  return (
    <section>
      <h3>Writing</h3>
      <label className="wf-settings-field wf-field-row">
        <input
          type="checkbox"
          checked={smart}
          onChange={(e) => {
            setSmartPunctuationEnabled(e.target.checked);
            setSmart(e.target.checked);
          }}
        />
        Smart quotes and dashes
      </label>
      <p className="wf-session-meta">
        As you type: “curly” quotes and apostrophes, -- becomes an em dash, and ...
        becomes an ellipsis (…). Press Backspace right after a change to undo it. Quotes follow
        the book’s language in a manuscript. This applies on this device only.
      </p>
      <label className="wf-settings-field wf-field-row">
        <input
          type="checkbox"
          checked={exact}
          onChange={(e) => {
            setExactPageView(e.target.checked);
            setExact(e.target.checked);
          }}
        />
        Page view shows the pages as they print
      </label>
      <p className="wf-session-meta">
        With this on, page view breaks the text where the printed page does (in the middle of a
        paragraph, between the rows of a table) and counts the same pages as the preview and the
        PDF. Turn it off for the simpler view, which only moves whole paragraphs to the next page
        and is an approximation. Takes effect the next time a document is opened. On this device
        only.
      </p>
      <label className="wf-settings-field wf-field-row">
        <input type="checkbox" checked={!menu.off} onChange={(e) => menu.setOff(!e.target.checked)} />
        Show a quick menu over selected words
      </label>
      <p className="wf-session-meta">
        Select words with the mouse and a small menu appears above them. Choose what it holds here, or
        from the sliders button at its end. (Colours, sub- and superscript and clear formatting show
        in the Document format only.) On this device only.
      </p>
      <div className="wf-settings-ticks" role="group" aria-label="What the selection menu holds">
        {SELECTION_TOOLS.map((tool) => (
          <label key={tool.id}>
            <input type="checkbox" disabled={menu.off} checked={menu.tools.includes(tool.id)} onChange={() => menu.toggle(tool.id)} />
            {tool.label}
          </label>
        ))}
        <button className="wf-link-button" disabled={menu.off} onClick={menu.reset}>
          Back to the usual set
        </button>
      </div>
      <div className="wf-settings-field">
        <button onClick={() => setRulesOpen(true)}>Your rules for Check…</button>
      </div>
      <p className="wf-session-meta">
        The Check panel reads a document for slips and for things written two ways. Your rules say which checks run, which
        words you write one way and not another, and which words to point out. They apply to every document on this device.
      </p>
      {rulesOpen && (
        <Suspense fallback={null}>
          <MyRulesDialog onClose={() => setRulesOpen(false)} />
        </Suspense>
      )}
    </section>
  );
}

function NotificationsTab() {
  const [prefs, setPrefs] = useState<NotifPrefs>(() => loadNotifPrefs());
  const apply = (patch: Partial<NotifPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveNotifPrefs(next);
  };
  const rows: { key: keyof Omit<NotifPrefs, "enabled">; label: string }[] = [
    { key: "dms", label: "Direct messages" },
    { key: "mentions", label: "@mentions in group chat" },
    { key: "sessions", label: "Writing sessions (created, prompt started, timer ended)" },
    { key: "shares", label: "Notes and documents shared with you" },
    { key: "friends", label: "Friend requests" },
  ];
  return (
    <section>
      <h3>Notifications</h3>
      <label className="wf-settings-field wf-field-row">
        <input
          type="checkbox"
          checked={prefs.enabled}
          onChange={(e) => apply({ enabled: e.target.checked })}
        />
        Enable system notifications
      </label>
      {rows.map((r) => (
        <label key={r.key} className="wf-settings-field wf-field-row">
          <input
            type="checkbox"
            checked={prefs[r.key]}
            disabled={!prefs.enabled}
            onChange={(e) => apply({ [r.key]: e.target.checked })}
          />
          {r.label}
        </label>
      ))}
      <p className="wf-session-meta">
        Notifications for a conversation you're actively viewing are always suppressed.
        Voice join/leave sounds live in the Voice tab.
      </p>
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

  if (!session) {
    return (
      <section>
        <h3>Servers</h3>
        <p className="wf-session-meta">
          A server is where you write with others. The ones you’ve joined are remembered here. Your work on this
          device doesn’t need one.
        </p>
        <AccountMenu inline />
        <HostingSection onError={onError} />
      </section>
    );
  }

  return (
    <section>
      <h3>Server</h3>
      {current ? (
        <>
          <p>
            Connected to <strong>{current.server_name}</strong> at <code>{current.addr}</code>
          </p>
          <p className="wf-session-meta">
            Pinned identity fingerprint (the host sees the same value here, and a standalone server
            prints it at startup):
          </p>
          <div className="wf-fingerprint">{current.fingerprint}</div>
          <p className="wf-session-meta">
            If this ever changes unexpectedly, the app will warn loudly before connecting. A change
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

/** LAN addresses aren't all equal — flag ranges that are usually virtual. */
function lanNote(addr: string): string {
  const [a, b] = addr.split(":")[0].split(".").map(Number);
  if (a === 172 && b >= 16 && b <= 31) {
    return "same network, but likely a virtual adapter (WSL / VM) and usually not the one to share";
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return "carrier-grade NAT range (probably not shareable)";
  }
  return "same network (home / office Wi-Fi)";
}

function HostingSection({ onError }: { onError: (e: string | null) => void }) {
  const [host, setHost] = useState<HostStatus | null>(null);
  const [reach, setReach] = useState<Reachability | null>(null);
  const [testing, setTesting] = useState(false);
  const [publicIp, setPublicIp] = useState<string | null>(null);

  const refresh = () => void backend.hostStatus().then(setHost).catch(() => {});
  useEffect(refresh, []);

  const running = host?.running ?? false;
  useEffect(() => {
    if (!running) return;
    let live = true;
    void discoverPublicIp().then((ip) => {
      if (live) setPublicIp(ip);
    });
    return () => {
      live = false;
    };
  }, [running]);

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
      <h4>Hosting · {host.server_name}</h4>
      <p className="wf-session-meta">
        This computer hosts the server ({host.running ? `running on port ${host.port}` : "stopped"}).
        It runs while subScribe is open and starts again with the app.
      </p>

      {host.running && (
        <>
          <p className="wf-session-meta">Share an address with friends. They add it via “Add a server”:</p>
          <ul className="wf-device-list">
            {host.lan_addrs.map((a) => (
              <CopyableAddr key={a} addr={a} note={lanNote(a)} />
            ))}
            {reach?.upnp.status === "mapped" ? (
              <CopyableAddr addr={reach.upnp.external_addr} note="internet (router port mapped via UPnP)" />
            ) : publicIp ? (
              <CopyableAddr
                addr={`${publicIp}:${host.port}`}
                note={`over the internet (works once TCP port ${host.port} is forwarded to this computer)`}
              />
            ) : null}
          </ul>
          <p className="wf-session-meta">
            When a friend connects for the first time, they are shown the server fingerprint above.
            Read it to them so they can verify it.
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
              Couldn’t map the port automatically ({reach.upnp.message}). This only means the
              automatic method failed. If you’ve already forwarded TCP port {host.port} to
              this computer in your router, you’re done: friends use the “over the internet”
              address listed above. Otherwise, add that forward in your router settings, or
              put everyone on a shared VPN like Tailscale and share your Tailscale address
              instead, which needs no router changes. To confirm it worked, keep hosting running
              and test port {host.port} from a port-checking website (from outside your own
              network). If it still fails with the forward in place, your ISP may put you
              behind carrier-grade NAT, and Tailscale is the way around that.
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
  const updateRef = useRef<AvailableUpdate | null>(null);
  const [notes, setNotes] = useState<string | null>(null);

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
      const update = await checkForUpdate();
      if (!update) {
        setStatus("up_to_date");
        return;
      }
      updateRef.current = update;
      setNotes(update.body);
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
      const restart = await confirmDialog("Update installed. Restart subScribe now?", {
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
        subScribe {version ?? ""}. Updates are downloaded from GitHub Releases and verified
        against the app's signing key before installing.
      </p>
      {!inTauri || isMobileApp ? (
        <p className="wf-session-meta">
          {isMobileApp
            ? "On iPhone and iPad, updates arrive as new builds through the App Store, TestFlight, or Xcode."
            : "Updates are only available in the desktop app."}
        </p>
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
            <span className="wf-session-meta">Installed. Restart to finish.</span>
          )}
        </div>
      )}
      {status === "available" && notes && (
        <div className="wf-release-notes-wrap">
          <h4>What's new in {updateRef.current?.version}</h4>
          <ReleaseNotes markdown={notes} />
        </div>
      )}
    </section>
  );
}

/** Release notes from the GitHub release body — sanitized before rendering
 *  (the body is repo-authored markdown, but it still goes through DOMPurify). */
function ReleaseNotes({ markdown }: { markdown: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(markdown, { async: false })),
    [markdown],
  );
  return <div className="wf-release-notes" dangerouslySetInnerHTML={{ __html: html }} />;
}

function AdminTab({ onError }: { onError: (e: string | null) => void }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [resetCode, setResetCode] = useState<{ username: string; code: string } | null>(null);

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
              title="Generate a one-time password reset code for this user"
              onClick={() =>
                void api<{ code: string }>(
                  "POST",
                  `/api/v1/admin/users/${u.user.id}/reset-code`,
                )
                  .then((r) => setResetCode({ username: u.user.username, code: r.code }))
                  .catch((e) => onError(isCmdError(e) ? e.message : String(e)))
              }
            >
              Reset code
            </button>
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
      {resetCode && (
        <div className="wf-reset-code">
          <p>
            One-time password reset code for <strong>@{resetCode.username}</strong> (valid for
            1 hour, shown only now):
          </p>
          <code>{resetCode.code}</code>
          <div className="wf-connect-row">
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(resetCode.code).catch(() => {});
              }}
            >
              Copy
            </button>
            <button onClick={() => setResetCode(null)}>Done</button>
          </div>
          <p className="wf-session-meta">
            Hand it to them out of band. They enter it under “Forgot password?” on the login
            screen.
          </p>
        </div>
      )}
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
    offline: true,
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
