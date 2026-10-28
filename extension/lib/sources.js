// Collects busy times from every connected calendar.

import { NeedsReauthError, fetchBusy } from './google.js';
import { busyFromIcs } from './ical.js';
import { getGoogleAccounts, getSettings, normalizeFeedUrl, originPattern } from './settings.js';

const ICS_CACHE_MS = 5 * 60_000;
const icsCache = new Map(); // url -> { at, text }

export async function fetchIcsText(url, { fresh = false } = {}) {
  const feedUrl = normalizeFeedUrl(url);
  const hit = icsCache.get(feedUrl);
  if (!fresh && hit && Date.now() - hit.at < ICS_CACHE_MS) return hit.text;
  if (!(await chrome.permissions.contains({ origins: [originPattern(feedUrl)] }))) {
    throw new Error(`Allow access to ${new URL(feedUrl).hostname} in the extension settings.`);
  }
  const res = await fetch(feedUrl, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(`Feed returned HTTP ${res.status}`);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("That URL didn't return an iCal (.ics) calendar.");
  icsCache.set(feedUrl, { at: Date.now(), text });
  return text;
}

/** Enabled calendar sources, as { kind, id, name }. */
export async function listSources() {
  const [settings, accounts] = await Promise.all([getSettings(), getGoogleAccounts()]);
  const google = settings.googleClientId
    ? accounts
        .filter((a) => a.calendars.some((c) => c.selected))
        .map((a) => ({ kind: 'google', id: a.email, name: a.email }))
    : [];
  const ics = settings.icsFeeds.filter((f) => f.enabled).map((f) => ({ kind: 'ics', id: f.id, name: f.name }));
  return [...google, ...ics];
}

/**
 * Busy intervals from all enabled sources between timeMin and timeMax (UTC ms).
 * Returns { busy, sources: [{ kind, id, name, ok, count, error, warnings, needsReauth }] }.
 */
export async function collectBusy(timeMin, timeMax) {
  const [settings, accounts] = await Promise.all([getSettings(), getGoogleAccounts()]);
  const tasks = [];

  if (settings.googleClientId) {
    for (const account of accounts) {
      if (!account.calendars.some((c) => c.selected)) continue;
      tasks.push(
        fetchBusy(account, timeMin, timeMax).then(
          ({ busy, warnings }) => ({ kind: 'google', id: account.email, name: account.email, ok: true, busy, warnings }),
          (err) => ({
            kind: 'google',
            id: account.email,
            name: account.email,
            ok: false,
            error: err.message,
            needsReauth: err instanceof NeedsReauthError,
          }),
        ),
      );
    }
  }

  for (const feed of settings.icsFeeds) {
    if (!feed.enabled) continue;
    tasks.push(
      fetchIcsText(feed.url)
        .then((text) =>
          busyFromIcs(text, { rangeStart: timeMin, rangeEnd: timeMax, ignoreAllDay: settings.ignoreAllDay }),
        )
        .then(
          ({ busy }) => ({ kind: 'ics', id: feed.id, name: feed.name, ok: true, busy, warnings: [] }),
          (err) => ({ kind: 'ics', id: feed.id, name: feed.name, ok: false, error: err.message }),
        ),
    );
  }

  const results = await Promise.all(tasks);
  return {
    busy: results.flatMap((r) => r.busy || []),
    sources: results.map(({ busy, ...rest }) => ({ ...rest, count: busy ? busy.length : 0 })),
  };
}
