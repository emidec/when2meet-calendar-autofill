// Google Calendar: OAuth via chrome.identity.launchWebAuthFlow (works with any Google account, several
// accounts at once, and in any Chromium browser) and busy times from the FreeBusy API.

import { getGoogleAccounts, getSettings, saveGoogleAccounts } from './settings.js';
import { DAY } from './time.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://www.googleapis.com/calendar/v3';
export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
];

export class NeedsReauthError extends Error {
  constructor(email, cause) {
    super(`Google sign-in for ${email} expired. Reconnect it.`);
    this.email = email;
    this.cause = cause;
  }
}

export function redirectUrl() {
  return chrome.identity.getRedirectURL();
}

async function clientId() {
  const id = (await getSettings()).googleClientId.trim();
  if (!id) throw new Error('Add your Google OAuth client ID in the extension settings first.');
  return id;
}

async function authorize({ email, interactive }) {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: await clientId(),
    response_type: 'token',
    redirect_uri: redirectUrl(),
    scope: SCOPES.join(' '),
    include_granted_scopes: 'true',
    state,
  });
  if (email) params.set('login_hint', email);
  if (!interactive) params.set('prompt', 'none');
  else if (!email) params.set('prompt', 'select_account');

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: `${AUTH_URL}?${params}`,
    interactive,
    ...(interactive ? {} : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 10_000 }),
  });
  const result = new URLSearchParams(new URL(responseUrl).hash.slice(1));
  if (result.get('state') !== state) throw new Error('Google sign-in failed (state mismatch).');
  if (result.get('error')) throw new Error(`Google sign-in failed: ${result.get('error')}`);
  const granted = (result.get('scope') || '').split(' ');
  if (!SCOPES.every((s) => granted.includes(s))) {
    throw new Error('Please allow both calendar permissions when connecting your Google account.');
  }
  return {
    token: result.get('access_token'),
    expiresAt: Date.now() + (Number(result.get('expires_in')) || 3600) * 1000,
  };
}

async function readTokens() {
  const { googleTokens } = await chrome.storage.session.get('googleTokens');
  return googleTokens || {};
}

async function storeToken(email, token) {
  const tokens = await readTokens();
  if (token) tokens[email] = token;
  else delete tokens[email];
  await chrome.storage.session.set({ googleTokens: tokens });
}

/** Access token for an account; refreshes silently, or with a popup when `interactive` is true. */
export async function getToken(email, { interactive = false } = {}) {
  const cached = (await readTokens())[email];
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
  let auth;
  try {
    auth = await authorize({ email, interactive: false });
  } catch (err) {
    if (!interactive) throw new NeedsReauthError(email, err);
    auth = await authorize({ email, interactive: true });
  }
  await storeToken(email, auth);
  return auth.token;
}

async function api(path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    const err = new Error('Google access token expired');
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error?.message || '';
    } catch {}
    throw new Error(`Google Calendar API error ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

/** Runs an API call with a fresh token, retrying once if the token turns out to be expired. */
async function withToken(email, fn) {
  try {
    return await fn(await getToken(email));
  } catch (err) {
    if (err.status !== 401) throw err;
    await storeToken(email, null);
    return fn(await getToken(email));
  }
}

async function listCalendars(token) {
  const items = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ minAccessRole: 'freeBusyReader', maxResults: '250' });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await api(`/users/me/calendarList?${q}`, token);
    items.push(...(page.items || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return items;
}

// Holidays, birthdays, week numbers etc. live on "@group.v.calendar.google.com" and are off by default.
const isSpecialCalendar = (id) => /@group\.v\.calendar\.google\.com$/.test(id);

function mergeCalendars(items, previous = []) {
  const prev = new Map(previous.map((c) => [c.id, c]));
  return items
    .filter((c) => !c.deleted)
    .map((c) => ({
      id: c.id,
      summary: c.summaryOverride || c.summary || c.id,
      color: c.backgroundColor || '#4285f4',
      primary: Boolean(c.primary),
      accessRole: c.accessRole,
      selected: prev.has(c.id)
        ? prev.get(c.id).selected
        : Boolean(c.primary) || (c.accessRole === 'owner' && !isSpecialCalendar(c.id)),
    }))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.summary.localeCompare(b.summary));
}

/** Interactive: asks the user to pick a Google account and stores it with its calendar list. */
export async function connectAccount() {
  const auth = await authorize({ interactive: true });
  const items = await listCalendars(auth.token);
  const primary = items.find((c) => c.primary);
  if (!primary) throw new Error('Could not find the primary calendar for this Google account.');
  const email = primary.id;
  await storeToken(email, auth);
  const accounts = await getGoogleAccounts();
  const existing = accounts.find((a) => a.email === email);
  const account = { email, calendars: mergeCalendars(items, existing?.calendars) };
  await saveGoogleAccounts([...accounts.filter((a) => a.email !== email), account]);
  return account;
}

export async function refreshCalendars(email) {
  const items = await withToken(email, listCalendars);
  const accounts = await getGoogleAccounts();
  const updated = accounts.map((a) => (a.email === email ? { ...a, calendars: mergeCalendars(items, a.calendars) } : a));
  await saveGoogleAccounts(updated);
  return updated.find((a) => a.email === email);
}

export async function disconnectAccount(email) {
  const cached = (await readTokens())[email];
  if (cached?.token) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(cached.token)}`, { method: 'POST' }).catch(
      () => {},
    );
  }
  await storeToken(email, null);
  await saveGoogleAccounts((await getGoogleAccounts()).filter((a) => a.email !== email));
}

/**
 * Busy intervals for an account's selected calendars between timeMin and timeMax (UTC ms).
 * Returns { busy: [{ start, end }], warnings: [string] }.
 */
export async function fetchBusy(account, timeMin, timeMax) {
  const ids = account.calendars.filter((c) => c.selected).map((c) => c.id);
  const busy = [];
  const warnings = [];
  if (!ids.length) return { busy, warnings };
  const names = new Map(account.calendars.map((c) => [c.id, c.summary]));

  await withToken(account.email, async (token) => {
    busy.length = 0;
    warnings.length = 0;
    // FreeBusy takes at most 50 calendars per call; keep each window to a modest length too.
    for (let from = timeMin; from < timeMax; from += 60 * DAY) {
      const to = Math.min(timeMax, from + 60 * DAY);
      for (let i = 0; i < ids.length; i += 50) {
        const res = await api('/freeBusy', token, {
          timeMin: new Date(from).toISOString(),
          timeMax: new Date(to).toISOString(),
          items: ids.slice(i, i + 50).map((id) => ({ id })),
        });
        for (const [id, cal] of Object.entries(res.calendars || {})) {
          if (cal.errors?.length) {
            warnings.push(`${names.get(id) || id}: ${cal.errors.map((e) => e.reason).join(', ')}`);
          }
          for (const b of cal.busy || []) busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
        }
      }
    }
  });
  return { busy, warnings: [...new Set(warnings)] };
}
