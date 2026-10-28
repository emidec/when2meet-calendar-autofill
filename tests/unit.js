import { computeAvailability, detectSlotSeconds, mergeIntervals, slotStarts } from '../extension/lib/availability.js';
import { planFill } from '../extension/lib/fill.js';
import { busyFromIcs, expandRRule, parseDuration, parseRRule } from '../extension/lib/ical.js';
import { tzOffset, zonedToUtc } from '../extension/lib/time.js';

const results = [];
function test(name, fn) {
  results.push(
    Promise.resolve()
      .then(fn)
      .then(
        () => ({ name, ok: true }),
        (err) => ({ name, ok: false, error: err.message }),
      ),
  );
}
function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}\n  expected ${e}\n  actual   ${a}`);
}
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const utc = (s) => Date.parse(s);
const floating = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
const days = (list) => list.map((ms) => iso(ms).slice(0, 10));
const LA = 'America/Los_Angeles';

// ---- time zones ----

test('zonedToUtc: regular time', () => {
  eq(iso(zonedToUtc(floating(2026, 7, 1, 9), 'Europe/Berlin')), '2026-07-01T07:00:00Z');
  eq(iso(zonedToUtc(floating(2026, 11, 16, 9), LA)), '2026-11-16T17:00:00Z');
});
test('zonedToUtc: spring-forward gap shifts forward', () => {
  eq(iso(zonedToUtc(floating(2026, 3, 8, 2, 30), 'America/New_York')), '2026-03-08T07:30:00Z');
});
test('zonedToUtc: fall-back overlap picks the first occurrence', () => {
  eq(iso(zonedToUtc(floating(2026, 11, 1, 1, 30), 'America/New_York')), '2026-11-01T05:30:00Z');
});
test('tzOffset: half-hour zone', () => {
  eq(tzOffset(utc('2026-01-15T00:00:00Z'), 'Asia/Kolkata'), 5.5 * 3600_000);
});

// ---- recurrence rules ----

const expand = (dtstart, rrule, rangeStart, rangeEnd, isAfterUntil) =>
  expandRRule(dtstart, parseRRule(rrule), { rangeStart, rangeEnd, isAfterUntil });

test('RRULE monthly last Friday', () => {
  const out = expand(floating(2026, 1, 30, 10), 'FREQ=MONTHLY;BYDAY=-1FR;COUNT=6', 0, floating(2030, 1, 1));
  eq(days(out), ['2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24', '2026-05-29', '2026-06-26']);
});
test('RRULE monthly on the 31st skips short months', () => {
  const out = expand(floating(2026, 1, 31, 10), 'FREQ=MONTHLY;COUNT=4', 0, floating(2030, 1, 1));
  eq(days(out), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
});
test('RRULE every other week Mon/Thu until a date', () => {
  const rule = parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20260205T235959Z');
  const out = expandRRule(floating(2026, 1, 5, 9), rule, {
    rangeStart: 0,
    rangeEnd: floating(2027, 1, 1),
    isAfterUntil: (c) => c > rule.until.floating,
  });
  eq(days(out), ['2026-01-05', '2026-01-08', '2026-01-19', '2026-01-22', '2026-02-02', '2026-02-05']);
});
test('RRULE last weekday of the month (BYSETPOS)', () => {
  const out = expand(floating(2026, 1, 30, 10), 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3', 0, floating(2030, 1, 1));
  eq(days(out), ['2026-01-30', '2026-02-27', '2026-03-31']);
});
test('RRULE yearly on Feb 29 only in leap years', () => {
  const out = expand(floating(2024, 2, 29, 12), 'FREQ=YEARLY;COUNT=3', 0, floating(2040, 1, 1));
  eq(days(out), ['2024-02-29', '2028-02-29', '2032-02-29']);
});
test('RRULE yearly 4th Thursday of November', () => {
  const out = expand(floating(2020, 11, 26, 12), 'FREQ=YEARLY;BYMONTH=11;BYDAY=4TH', floating(2026, 1, 1), floating(2027, 1, 1));
  eq(days(out), ['2026-11-26']);
});
test('RRULE daily every 3 days from 2015 (skip-ahead)', () => {
  const out = expand(floating(2015, 3, 1, 8), 'FREQ=DAILY;INTERVAL=3', floating(2026, 1, 1), floating(2026, 1, 10));
  eq(out.map(iso), ['2026-01-02T08:00:00Z', '2026-01-05T08:00:00Z', '2026-01-08T08:00:00Z']);
});
test('RRULE WKST changes biweekly results (RFC 5545 example)', () => {
  const mo = expand(floating(1997, 8, 5, 9), 'FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO', 0, floating(1998, 1, 1));
  const su = expand(floating(1997, 8, 5, 9), 'FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU', 0, floating(1998, 1, 1));
  eq(days(mo), ['1997-08-05', '1997-08-10', '1997-08-19', '1997-08-24'], 'WKST=MO');
  eq(days(su), ['1997-08-05', '1997-08-17', '1997-08-19', '1997-08-31'], 'WKST=SU');
});
test('parseDuration', () => {
  eq(parseDuration('PT1H30M'), 5_400_000);
  eq(parseDuration('P1D'), 86_400_000);
  eq(parseDuration('P1W'), 7 * 86_400_000);
  eq(parseDuration('-PT15M'), -900_000);
});

// ---- iCal feeds ----

const fixture = fetch('./fixtures/sample.ics').then((r) => r.text());
const EVENT_START = utc('2026-11-16T17:00:00Z'); // Mon Nov 16, 9:00 PST
const EVENT_END = utc('2026-11-19T01:00:00Z'); // Wed Nov 18, 17:00 PST

test('busyFromIcs: fixture busy blocks', async () => {
  const { busy, name } = busyFromIcs(await fixture, { rangeStart: EVENT_START, rangeEnd: EVENT_END, localTz: LA });
  eq(name, 'me@example.com');
  eq(
    mergeIntervals(busy).map((b) => `${iso(b.start)}/${iso(b.end)}`),
    [
      '2026-11-16T17:00:00Z/2026-11-16T17:15:00Z', // Mon standup 9:00
      '2026-11-16T18:00:00Z/2026-11-16T19:00:00Z', // Mon team sync 10:00
      '2026-11-16T21:00:00Z/2026-11-16T22:00:00Z', // Mon lecture 13:00
      '2026-11-17T18:00:00Z/2026-11-17T19:30:00Z', // Tue dentist (UTC)
      '2026-11-18T00:00:00Z/2026-11-18T00:15:00Z', // Tue standup moved to 16:00
      '2026-11-18T00:30:00Z/2026-11-18T01:30:00Z', // Tue gym 16:30 (weekly since 2020)
      '2026-11-18T17:00:00Z/2026-11-18T17:15:00Z', // Wed standup
      '2026-11-18T23:00:00Z/2026-11-19T00:00:00Z', // Wed Outlook meeting (Windows TZID + VTIMEZONE)
    ],
  );
});
test('busyFromIcs: all-day events count when not ignored', async () => {
  const { busy } = busyFromIcs(await fixture, {
    rangeStart: EVENT_START,
    rangeEnd: EVENT_END,
    localTz: LA,
    ignoreAllDay: false,
  });
  eq(busy.some((b) => iso(b.start) === '2026-11-18T08:00:00Z' && iso(b.end) === '2026-11-19T08:00:00Z'), true);
});
test('busyFromIcs: Outlook VTIMEZONE handles daylight time', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VTIMEZONE',
    'TZID:(UTC-08:00) Pacific Time (US & Canada)',
    'BEGIN:STANDARD',
    'DTSTART:16010101T020000',
    'TZOFFSETFROM:-0700',
    'TZOFFSETTO:-0800',
    'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:16010101T020000',
    'TZOFFSETFROM:-0800',
    'TZOFFSETTO:-0700',
    'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:a',
    'DTSTART;TZID="(UTC-08:00) Pacific Time (US & Canada)":20260701T150000',
    'DTEND;TZID="(UTC-08:00) Pacific Time (US & Canada)":20260701T160000',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const { busy } = busyFromIcs(ics, { rangeStart: utc('2026-06-01T00:00:00Z'), rangeEnd: utc('2026-08-01T00:00:00Z') });
  eq(busy.map((b) => iso(b.start)), ['2026-07-01T22:00:00Z']);
});

// ---- availability ----

const nineAm = utc('2026-11-16T17:00:00Z'); // Monday 9:00 PST
const eight = Array.from({ length: 8 }, (_, i) => nineAm + i * 900_000);
const busy930 = [{ start: nineAm + 30 * 60_000, end: nineAm + 60 * 60_000 }];
const avail = (busy, settings) => computeAvailability({ starts: eight, slotMs: 900_000, busy, settings, timeZone: LA });

test('availability: busy block', () => eq(avail(busy930, {}), [true, true, false, false, true, true, true, true]));
test('availability: buffer', () => eq(avail(busy930, { bufferMinutes: 15 }), [true, false, false, false, false, true, true, true]));
test('availability: minimum free block', () =>
  eq(avail(busy930, { minBlockMinutes: 45 }), [false, false, false, false, true, true, true, true]));
test('availability: daily hours', () =>
  eq(avail([], { limitHours: true, dayStart: '09:30', dayEnd: '10:30' }), [false, false, true, true, true, true, false, false]));
test('availability: blocked weekday', () => eq(avail([], { blockedWeekdays: [1] }), Array(8).fill(false)));
test('detectSlotSeconds', () => eq(detectSlotSeconds([0, 900, 1800, 90000, 90900]), 900));

test('days-of-week events map onto the coming week in the user zone', () => {
  const now = utc('2026-10-22T20:00:00Z'); // Thursday afternoon in LA
  // when2meet's weekly slots: "Monday 9:00 AM" = 1978-11-13T09:00Z, "Thursday 9:00 AM" = 1978-11-16T09:00Z
  const { daysOfWeek, starts } = slotStarts([279795600, 280054800], { timeZone: LA, now });
  eq(daysOfWeek, true);
  eq(starts.map(iso), ['2026-10-26T16:00:00Z', '2026-10-29T16:00:00Z']); // 9:00 PDT
  const tokyo = slotStarts([279795600], { timeZone: 'Asia/Tokyo', now }).starts;
  eq(tokyo.map(iso), ['2026-10-26T00:00:00Z'], 'Tokyo'); // Monday 9:00 JST
});

test('planFill end to end with the fixture calendar', async () => {
  const text = await fixture;
  const slots = [];
  for (let day = 0; day < 3; day++) for (let i = 0; i < 32; i++) slots.push(1794848400 + day * 86400 + i * 900);
  const plan = await planFill({
    slots,
    settings: {},
    timeZone: LA,
    getBusy: async (min, max) => ({
      busy: busyFromIcs(text, { rangeStart: min, rangeEnd: max, localTz: LA }).busy,
      sources: [{ ok: true, name: 'fixture' }],
    }),
  });
  eq(plan.desired.filter(Boolean).length, 73, 'available slots');
  eq(plan.desired.slice(0, 8), [false, true, true, true, false, false, false, false], 'Monday 9:00-10:45');
});

const settled = await Promise.all(results);
const failed = settled.filter((r) => !r.ok);
window.__unitResults = { passed: settled.length - failed.length, failed };
const out = document.getElementById('out');
out.textContent =
  `${settled.length - failed.length}/${settled.length} passed\n\n` +
  settled.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error}`}`).join('\n');
document.body.dataset.status = failed.length ? 'fail' : 'pass';
