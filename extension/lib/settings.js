// Settings and connected-account storage (chrome.storage.local).

export const DEFAULT_SETTINGS = {
  autoFillOnSignIn: true,
  prefillName: '',
  bufferMinutes: 0,
  minBlockMinutes: 0,
  limitHours: false,
  dayStart: '09:00',
  dayEnd: '21:00',
  blockedWeekdays: [],
  ignoreAllDay: true,
  googleClientId: '',
  icsFeeds: [], // [{ id, name, url, enabled }]
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** Connected Google accounts: [{ email, calendars: [{ id, summary, color, primary, selected }] }] */
export async function getGoogleAccounts() {
  const { googleAccounts } = await chrome.storage.local.get('googleAccounts');
  return googleAccounts || [];
}

export async function saveGoogleAccounts(accounts) {
  await chrome.storage.local.set({ googleAccounts: accounts });
}

/** "webcal://…" links are plain https feeds. */
export function normalizeFeedUrl(url) {
  const trimmed = String(url || '').trim();
  return trimmed.replace(/^webcals?:\/\//i, 'https://');
}

/** Host permission pattern needed to fetch a feed URL. */
export function originPattern(url) {
  const u = new URL(normalizeFeedUrl(url));
  return `${u.protocol}//${u.hostname}/*`;
}
