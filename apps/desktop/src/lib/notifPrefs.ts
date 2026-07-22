/** Per-event-type notification preferences, persisted locally. */

export interface NotifPrefs {
  /** Master switch — off silences every OS notification. */
  enabled: boolean;
  dms: boolean;
  mentions: boolean;
  /** Session created / prompt started / timer ended. */
  sessions: boolean;
  /** Notes and documents shared with you. */
  shares: boolean;
  /** Friend requests and acceptances. */
  friends: boolean;
}

const KEY = "wf-notif-prefs";
const DEFAULTS: NotifPrefs = {
  enabled: true,
  dms: true,
  mentions: true,
  sessions: true,
  shares: true,
  friends: true,
};

export function loadNotifPrefs(): NotifPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<NotifPrefs>;
    const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
    return {
      enabled: bool(parsed.enabled, true),
      dms: bool(parsed.dms, true),
      mentions: bool(parsed.mentions, true),
      sessions: bool(parsed.sessions, true),
      shares: bool(parsed.shares, true),
      friends: bool(parsed.friends, true),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveNotifPrefs(prefs: NotifPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // settings still apply this session
  }
}

/** Is this notification category currently allowed? */
export function notifAllowed(kind: keyof Omit<NotifPrefs, "enabled">): boolean {
  const prefs = loadNotifPrefs();
  return prefs.enabled && prefs[kind];
}
