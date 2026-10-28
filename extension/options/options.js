import { mergeIntervals } from '../lib/availability.js';
import { connectAccount, disconnectAccount, getToken, redirectUrl, refreshCalendars } from '../lib/google.js';
import { busyFromIcs } from '../lib/ical.js';
import {
  getGoogleAccounts,
  getSettings,
  normalizeFeedUrl,
  originPattern,
  saveGoogleAccounts,
  saveSettings,
} from '../lib/settings.js';
import { collectBusy, fetchIcsText } from '../lib/sources.js';
import { DAY } from '../lib/time.js';

const $ = (sel) => document.querySelector(sel);

/** Tiny element builder; children are nodes or text (never parsed as HTML). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (typeof v === 'boolean') el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

function setMessage(el, text, tone = '') {
  el.textContent = text;
  el.className = `message ${tone}`;
}

const errorText = (err) => err?.message || String(err);

// ---- Google Calendar --------------------------------------------------------------------------

async function renderGoogle() {
  const settings = await getSettings();
  $('#redirect-uri').textContent = redirectUrl();
  $('#client-id').value = settings.googleClientId;
  $('#google-setup').open = !settings.googleClientId;
  $('#connect-google').disabled = !settings.googleClientId;
  const accounts = await getGoogleAccounts();
  $('#google-accounts').replaceChildren(...accounts.map(renderAccount));
}

function renderAccount(account) {
  const message = h('span', { class: 'message', role: 'status' });

  const toggle = async (id, selected) => {
    const accounts = await getGoogleAccounts();
    const target = accounts.find((a) => a.email === account.email);
    const cal = target?.calendars.find((c) => c.id === id);
    if (cal) cal.selected = selected;
    await saveGoogleAccounts(accounts);
  };

  const calendars = h(
    'ul',
    { class: 'calendars' },
    account.calendars.map((cal) =>
      h(
        'li',
        {},
        h(
          'label',
          { title: cal.id },
          h('input', { type: 'checkbox', checked: cal.selected, onchange: (e) => toggle(cal.id, e.target.checked) }),
          h('span', { class: 'dot', style: `background:${/^#[0-9a-f]{3,8}$/i.test(cal.color) ? cal.color : '#4285f4'}` }),
          h('span', { class: 'cal-name' }, cal.summary + (cal.primary ? ' (primary)' : '')),
        ),
      ),
    ),
  );

  return h(
    'div',
    { class: 'account' },
    h(
      'div',
      { class: 'account-head' },
      h('strong', {}, account.email),
      message,
      h(
        'button',
        {
          type: 'button',
          class: 'secondary small',
          onclick: async () => {
            setMessage(message, 'Refreshing…');
            try {
              await refreshCalendars(account.email);
              await renderGoogle();
            } catch (err) {
              setMessage(message, errorText(err), 'error');
            }
          },
        },
        'Refresh list',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'secondary small danger',
          onclick: async () => {
            await disconnectAccount(account.email);
            await renderGoogle();
          },
        },
        'Disconnect',
      ),
    ),
    h('p', { class: 'hint' }, 'Busy time on the checked calendars blocks you out on when2meet.'),
    calendars,
  );
}

$('#client-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#client-id').value.trim();
  if (id && !/\.apps\.googleusercontent\.com$/.test(id)) {
    setMessage($('#google-message'), 'That doesn\'t look like a client ID (it ends in ".apps.googleusercontent.com").', 'error');
    return;
  }
  await saveSettings({ googleClientId: id });
  setMessage($('#google-message'), id ? 'Client ID saved. Now connect your account.' : 'Client ID removed.', 'ok');
  await renderGoogle();
});

$('#copy-redirect').addEventListener('click', async () => {
  await navigator.clipboard.writeText(redirectUrl());
  $('#copy-redirect').textContent = 'Copied';
  setTimeout(() => ($('#copy-redirect').textContent = 'Copy'), 1500);
});

$('#connect-google').addEventListener('click', async () => {
  const msg = $('#google-message');
  setMessage(msg, 'Waiting for Google sign-in…');
  try {
    const account = await connectAccount();
    setMessage(msg, `Connected ${account.email}.`, 'ok');
    await renderGoogle();
  } catch (err) {
    setMessage(msg, errorText(err), 'error');
  }
});

// ---- iCal feeds ---------------------------------------------------------------------------------

async function renderFeeds() {
  const { icsFeeds } = await getSettings();
  $('#ics-list').replaceChildren(...icsFeeds.map(renderFeed));
}

function renderFeed(feed) {
  const message = h('span', { class: 'message', role: 'status' });
  let host = feed.url;
  try {
    host = new URL(feed.url).hostname;
  } catch {}

  const update = async (patch) => {
    const { icsFeeds } = await getSettings();
    await saveSettings({ icsFeeds: icsFeeds.map((f) => (f.id === feed.id ? { ...f, ...patch } : f)) });
  };

  return h(
    'li',
    {},
    h(
      'label',
      { class: 'check', title: 'Use this calendar' },
      h('input', { type: 'checkbox', checked: feed.enabled, onchange: (e) => update({ enabled: e.target.checked }) }),
      h('span', { class: 'feed-name' }, feed.name),
    ),
    h('span', { class: 'feed-host' }, host),
    message,
    h(
      'button',
      {
        type: 'button',
        class: 'secondary small',
        onclick: async () => {
          setMessage(message, 'Checking…');
          try {
            setMessage(message, (await describeFeed(feed.url)).summary, 'ok');
          } catch (err) {
            setMessage(message, errorText(err), 'error');
          }
        },
      },
      'Test',
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'secondary small danger',
        onclick: async () => {
          const { icsFeeds } = await getSettings();
          const rest = icsFeeds.filter((f) => f.id !== feed.id);
          await saveSettings({ icsFeeds: rest });
          const pattern = originPattern(feed.url);
          if (!rest.some((f) => originPattern(f.url) === pattern)) {
            chrome.permissions.remove({ origins: [pattern] }).catch(() => {});
          }
          await renderFeeds();
        },
      },
      'Remove',
    ),
  );
}

async function describeFeed(url) {
  const settings = await getSettings();
  const text = await fetchIcsText(url, { fresh: true });
  const now = Date.now();
  const { busy, eventCount, name } = busyFromIcs(text, {
    rangeStart: now,
    rangeEnd: now + 7 * DAY,
    ignoreAllDay: settings.ignoreAllDay,
  });
  return {
    name,
    summary: `Works${name ? ` ("${name}")` : ''}: ${eventCount} events, ${busy.length} busy in the next 7 days.`,
  };
}

$('#ics-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#ics-message');
  let url;
  try {
    url = normalizeFeedUrl($('#ics-url').value);
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error();
  } catch {
    setMessage(msg, 'Enter a valid https:// or webcal:// link.', 'error');
    return;
  }
  // Ask for access to this one host (must happen directly in the submit gesture).
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [originPattern(url)] });
  } catch (err) {
    setMessage(msg, errorText(err), 'error');
    return;
  }
  if (!granted) {
    setMessage(msg, `The extension needs permission to read ${new URL(url).hostname}.`, 'error');
    return;
  }
  setMessage(msg, 'Checking the link…');
  try {
    const { summary, name: calName } = await describeFeed(url);
    const { icsFeeds } = await getSettings();
    const name = $('#ics-name').value.trim() || calName || new URL(url).hostname;
    await saveSettings({ icsFeeds: [...icsFeeds, { id: crypto.randomUUID(), name, url, enabled: true }] });
    $('#ics-form').reset();
    setMessage(msg, `Added. ${summary}`, 'ok');
    await renderFeeds();
  } catch (err) {
    setMessage(msg, `Couldn't use that link: ${errorText(err)}`, 'error');
  }
});

// ---- Preferences ---------------------------------------------------------------------------------

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function renderPrefs() {
  const s = await getSettings();
  const form = $('#prefs');
  form.autoFillOnSignIn.checked = s.autoFillOnSignIn;
  form.prefillName.value = s.prefillName;
  form.bufferMinutes.value = String(s.bufferMinutes);
  form.minBlockMinutes.value = String(s.minBlockMinutes);
  form.limitHours.checked = s.limitHours;
  form.dayStart.value = s.dayStart;
  form.dayEnd.value = s.dayEnd;
  form.ignoreAllDay.checked = s.ignoreAllDay;
  $('#weekdays').replaceChildren(
    ...WEEKDAY_NAMES.map((name, i) =>
      h('label', {}, h('input', { type: 'checkbox', name: 'blockedWeekday', value: String(i), checked: s.blockedWeekdays.includes(i) }), name),
    ),
  );
}

let saveTimer = null;
$('#prefs').addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const form = $('#prefs');
    await saveSettings({
      autoFillOnSignIn: form.autoFillOnSignIn.checked,
      prefillName: form.prefillName.value.trim(),
      bufferMinutes: Number(form.bufferMinutes.value),
      minBlockMinutes: Number(form.minBlockMinutes.value),
      limitHours: form.limitHours.checked,
      dayStart: form.dayStart.value || '09:00',
      dayEnd: form.dayEnd.value || '21:00',
      ignoreAllDay: form.ignoreAllDay.checked,
      blockedWeekdays: [...form.querySelectorAll('input[name="blockedWeekday"]:checked')].map((c) => Number(c.value)),
    });
    setMessage($('#prefs-message'), 'Saved.', 'ok');
  }, 300);
});
$('#prefs').addEventListener('submit', (e) => e.preventDefault());

// ---- Busy-time check -----------------------------------------------------------------------------

$('#check-busy').addEventListener('click', async () => {
  const out = $('#check-result');
  out.replaceChildren(h('p', {}, 'Reading your calendars…'));
  const now = Date.now();
  try {
    const { busy, sources } = await collectBusy(now, now + 7 * DAY);
    if (!sources.length) {
      out.replaceChildren(h('p', {}, 'No calendars connected yet.'));
      return;
    }
    const sourceLines = sources.map((s) =>
      h(
        'li',
        { class: s.ok ? '' : 'error' },
        s.ok ? `${s.name}: ${s.count} busy` : `${s.name}: ${s.error}`,
        s.needsReauth
          ? h(
              'button',
              {
                type: 'button',
                class: 'link',
                style: 'margin-left:8px',
                onclick: async () => {
                  await getToken(s.id, { interactive: true });
                  $('#check-busy').click();
                },
              },
              'Reconnect',
            )
          : null,
        ...(s.warnings || []).map((w) => h('div', {}, w)),
      ),
    );
    const byDay = new Map();
    const time = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    for (const b of mergeIntervals(busy)) {
      const day = new Date(Math.max(b.start, now)).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(`${time(b.start)} – ${time(b.end)}`);
    }
    out.replaceChildren(
      h('h3', {}, 'Calendars'),
      h('ul', {}, sourceLines),
      h('h3', {}, 'Busy (next 7 days)'),
      byDay.size
        ? h('ul', {}, [...byDay].map(([day, ranges]) => h('li', {}, `${day}: ${ranges.join(', ')}`)))
        : h('p', {}, 'Nothing busy — you are wide open.'),
    );
  } catch (err) {
    out.replaceChildren(h('p', { class: 'error' }, errorText(err)));
  }
});

// ---- Init ----------------------------------------------------------------------------------------

renderGoogle();
renderFeeds();
renderPrefs();
