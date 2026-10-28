// Minimal iCalendar (RFC 5545) reader: turns an .ics feed into busy intervals for a time range.
// Supports time zones (IANA, Windows names, embedded VTIMEZONE), all-day events, RRULE/RDATE/EXDATE,
// moved/cancelled instances (RECURRENCE-ID), and free/busy hints (TRANSP, STATUS, Outlook busy status).

import {
  DAY,
  isValidTimeZone,
  localTimeZone,
  normalizeTzid,
  windowsToIana,
  zonedToUtc,
} from './time.js';

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_PERIODS = 200_000;

// ---------------------------------------------------------------------------------------------
// Parsing

function unfold(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
}

function splitOutsideQuotes(s, sep) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const c of s) {
    if (c === '"') quoted = !quoted;
    if (c === sep && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseLine(line) {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ';');
  const params = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return { name: name.trim().toUpperCase(), params, value: line.slice(colon + 1) };
}

/** Parses iCalendar text into a tree of { name, props, children } components. */
export function parseComponents(text) {
  const root = { name: 'ROOT', props: [], children: [] };
  const stack = [root];
  for (const line of unfold(text).split('\n')) {
    if (!line.trim()) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN') {
      const comp = { name: prop.value.trim().toUpperCase(), props: [], children: [] };
      stack[stack.length - 1].children.push(comp);
      stack.push(comp);
    } else if (prop.name === 'END') {
      const name = prop.value.trim().toUpperCase();
      const idx = stack.map((c) => c.name).lastIndexOf(name);
      if (idx > 0) stack.length = idx;
    } else {
      stack[stack.length - 1].props.push(prop);
    }
  }
  return root;
}

const prop = (comp, name) => comp.props.find((p) => p.name === name);
const props = (comp, name) => comp.props.filter((p) => p.name === name);
const text = (comp, name) => (prop(comp, name)?.value ?? '').trim();

/** Parses DATE or DATE-TIME values into a floating time. */
export function parseDateValue(value) {
  const v = String(value).trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return { floating: Date.UTC(+m[1], +m[2] - 1, +m[3]), isDate: true, utc: false };
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(v);
  if (m) {
    return {
      floating: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)),
      isDate: false,
      utc: Boolean(m[7]),
    };
  }
  return null;
}

/** Parses an ISO 8601 duration such as P1D, PT1H30M, -PT15M. Returns ms or null. */
export function parseDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(
    String(value).trim(),
  );
  if (!m) return null;
  const seconds = ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 24 + +(m[4] || 0)) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0);
  return (m[1] === '-' ? -1 : 1) * seconds * 1000;
}

function parseOffset(value) {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(String(value).trim());
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * ((+m[2] * 60 + +m[3]) * 60 + +(m[4] || 0)) * 1000;
}

function parseByDay(s) {
  const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(s.trim());
  return m ? { n: m[1] ? parseInt(m[1], 10) : 0, wd: WEEKDAYS.indexOf(m[2].toUpperCase()) } : null;
}

/** Parses an RRULE value. UNTIL is returned as a parsed date value ({ floating, isDate, utc }). */
export function parseRRule(value) {
  const rule = {
    freq: null,
    interval: 1,
    count: null,
    until: null,
    byday: null,
    bymonthday: null,
    bymonth: null,
    byyearday: null,
    byweekno: null,
    bysetpos: null,
    byhour: null,
    byminute: null,
    wkst: 1,
  };
  for (const part of String(value).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    const val = part.slice(eq + 1).trim();
    const ints = () => val.split(',').map((x) => parseInt(x, 10)).filter(Number.isFinite);
    switch (key) {
      case 'FREQ': rule.freq = val.toUpperCase(); break;
      case 'INTERVAL': rule.interval = Math.max(1, parseInt(val, 10) || 1); break;
      case 'COUNT': rule.count = Math.max(0, parseInt(val, 10) || 0); break;
      case 'UNTIL': rule.until = parseDateValue(val); break;
      case 'BYDAY': rule.byday = val.split(',').map(parseByDay).filter(Boolean); break;
      case 'BYMONTHDAY': rule.bymonthday = ints(); break;
      case 'BYMONTH': rule.bymonth = ints(); break;
      case 'BYYEARDAY': rule.byyearday = ints(); break;
      case 'BYWEEKNO': rule.byweekno = ints(); break;
      case 'BYSETPOS': rule.bysetpos = ints(); break;
      case 'BYHOUR': rule.byhour = ints(); break;
      case 'BYMINUTE': rule.byminute = ints(); break;
      case 'WKST': {
        const i = WEEKDAYS.indexOf(val.toUpperCase());
        if (i >= 0) rule.wkst = i;
        break;
      }
      default: break;
    }
  }
  return rule.freq ? rule : null;
}

// ---------------------------------------------------------------------------------------------
// Recurrence expansion (all in floating time)

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayMs = (y, m, d) => Date.UTC(y, m - 1, d);
const weekdayOf = (ms) => new Date(ms).getUTCDay();
const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function nth(list, n) {
  return n > 0 ? list[n - 1] : list[list.length + n];
}

function monthDays(y, m, rule, defaultDay) {
  const len = daysInMonth(y, m);
  let days = null;
  if (rule.bymonthday) {
    days = new Set(rule.bymonthday.map((d) => (d < 0 ? len + 1 + d : d)).filter((d) => d >= 1 && d <= len));
  }
  if (rule.byday) {
    const matches = new Set();
    const firstWeekday = weekdayOf(dayMs(y, m, 1));
    for (const { n, wd } of rule.byday) {
      const all = [];
      for (let d = ((wd - firstWeekday + 7) % 7) + 1; d <= len; d += 7) all.push(d);
      if (n === 0) all.forEach((d) => matches.add(d));
      else if (nth(all, n) != null) matches.add(nth(all, n));
    }
    days = days ? new Set([...days].filter((d) => matches.has(d))) : matches;
  }
  if (!days) days = new Set(defaultDay <= len ? [defaultDay] : []);
  return [...days].sort((a, b) => a - b);
}

function yearDays(y, rule, m0, d0) {
  const out = [];
  if (rule.bymonth) {
    for (const m of [...rule.bymonth].sort((a, b) => a - b)) {
      if (m < 1 || m > 12) continue;
      const days = rule.bymonthday || rule.byday ? monthDays(y, m, rule, d0) : monthDays(y, m, {}, d0);
      for (const d of days) out.push(dayMs(y, m, d));
    }
    return out;
  }
  if (rule.byyearday) {
    const len = isLeapYear(y) ? 366 : 365;
    for (const n of rule.byyearday) {
      const k = n < 0 ? len + 1 + n : n;
      if (k >= 1 && k <= len) out.push(Date.UTC(y, 0, k));
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }
  if (rule.byday && !rule.byweekno) {
    const start = Date.UTC(y, 0, 1);
    const end = Date.UTC(y + 1, 0, 1);
    for (const { n, wd } of rule.byday) {
      const all = [];
      for (let d = start + ((wd - weekdayOf(start) + 7) % 7) * DAY; d < end; d += 7 * DAY) all.push(d);
      if (n === 0) out.push(...all);
      else if (nth(all, n) != null) out.push(nth(all, n));
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }
  if (rule.bymonthday) {
    for (let m = 1; m <= 12; m++) for (const d of monthDays(y, m, rule, d0)) out.push(dayMs(y, m, d));
    return out;
  }
  // Plain anniversary (BYWEEKNO is not supported and falls back to this too).
  if (d0 <= daysInMonth(y, m0)) out.push(dayMs(y, m0, d0));
  return out;
}

function applySetPos(items, bysetpos) {
  if (!bysetpos || !items.length) return items;
  const picked = new Set();
  for (const pos of bysetpos) {
    const v = nth(items, pos);
    if (v != null) picked.add(v);
  }
  return [...picked].sort((a, b) => a - b);
}

function makeContext(dtstart, rule) {
  const s = new Date(dtstart);
  const y0 = s.getUTCFullYear();
  const m0 = s.getUTCMonth() + 1;
  const d0 = s.getUTCDate();
  const startDay = dayMs(y0, m0, d0);
  const h0 = s.getUTCHours();
  const mi0 = s.getUTCMinutes();
  const s0 = s.getUTCSeconds();
  const hours = rule.byhour ? [...rule.byhour].sort((a, b) => a - b) : [h0];
  const minutes = rule.byminute ? [...rule.byminute].sort((a, b) => a - b) : [mi0];
  const times = [];
  for (const h of hours) for (const mi of minutes) times.push(((h * 60 + mi) * 60 + s0) * 1000);
  const startWeek = startDay - ((weekdayOf(startDay) - rule.wkst + 7) % 7) * DAY;
  return { y0, m0, d0, startDay, startWeek, times, wd0: weekdayOf(startDay) };
}

const UNIT = { HOURLY: 3_600_000, MINUTELY: 60_000, SECONDLY: 1000 };

function dayPasses(day, rule) {
  const d = new Date(day);
  const m = d.getUTCMonth() + 1;
  if (rule.bymonth && !rule.bymonth.includes(m)) return false;
  if (rule.bymonthday) {
    const len = daysInMonth(d.getUTCFullYear(), m);
    if (!rule.bymonthday.some((x) => (x < 0 ? len + 1 + x : x) === d.getUTCDate())) return false;
  }
  if (rule.byday && !rule.byday.some(({ wd }) => wd === d.getUTCDay())) return false;
  return true;
}

/** Candidate occurrences for recurrence period k: { start, items } (items sorted, floating ms). */
function period(k, rule, ctx, dtstart) {
  const withTimes = (days) => {
    const out = [];
    for (const day of days) for (const t of ctx.times) out.push(day + t);
    return out;
  };
  switch (rule.freq) {
    case 'DAILY': {
      const day = ctx.startDay + k * rule.interval * DAY;
      return { start: day, items: dayPasses(day, rule) ? withTimes([day]) : [] };
    }
    case 'WEEKLY': {
      const week = ctx.startWeek + k * rule.interval * 7 * DAY;
      const wds = rule.byday ? [...new Set(rule.byday.map((b) => b.wd))] : [ctx.wd0];
      const days = wds
        .map((wd) => week + ((wd - rule.wkst + 7) % 7) * DAY)
        .sort((a, b) => a - b)
        .filter((day) => !rule.bymonth || rule.bymonth.includes(new Date(day).getUTCMonth() + 1));
      return { start: week, items: withTimes(days) };
    }
    case 'MONTHLY': {
      const idx = ctx.y0 * 12 + (ctx.m0 - 1) + k * rule.interval;
      const y = Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      const start = dayMs(y, m, 1);
      if (rule.bymonth && !rule.bymonth.includes(m)) return { start, items: [] };
      return { start, items: withTimes(monthDays(y, m, rule, ctx.d0).map((d) => dayMs(y, m, d))) };
    }
    case 'YEARLY': {
      const y = ctx.y0 + k * rule.interval;
      return { start: Date.UTC(y, 0, 1), items: withTimes(yearDays(y, rule, ctx.m0, ctx.d0)) };
    }
    default: {
      const unit = UNIT[rule.freq];
      if (!unit) return null;
      const t = dtstart + k * rule.interval * unit;
      const ok =
        dayPasses(Math.floor(t / DAY) * DAY, rule) && (!rule.byhour || rule.byhour.includes(new Date(t).getUTCHours()));
      return { start: t, items: ok ? [t] : [] };
    }
  }
}

/** Number of whole periods that can be skipped before `rangeStart` (only valid without COUNT). */
function skippablePeriods(rule, ctx, dtstart, rangeStart) {
  if (rangeStart <= dtstart) return 0;
  const r = new Date(rangeStart);
  let k;
  switch (rule.freq) {
    case 'DAILY': k = Math.floor((rangeStart - ctx.startDay) / (rule.interval * DAY)); break;
    case 'WEEKLY': k = Math.floor((rangeStart - ctx.startWeek) / (rule.interval * 7 * DAY)); break;
    case 'MONTHLY':
      k = Math.floor((r.getUTCFullYear() * 12 + r.getUTCMonth() - (ctx.y0 * 12 + ctx.m0 - 1)) / rule.interval);
      break;
    case 'YEARLY': k = Math.floor((r.getUTCFullYear() - ctx.y0) / rule.interval); break;
    default: k = UNIT[rule.freq] ? Math.floor((rangeStart - dtstart) / (rule.interval * UNIT[rule.freq])) : 0;
  }
  return Math.max(0, k - 1);
}

/**
 * Expands a recurrence rule into occurrence starts (floating ms) within [rangeStart, rangeEnd).
 * `isAfterUntil(floating)` decides whether a candidate is past the rule's UNTIL.
 * DTSTART always counts as the first occurrence, as RFC 5545 specifies.
 */
export function expandRRule(dtstart, rule, { rangeStart, rangeEnd, isAfterUntil = () => false }) {
  const out = [];
  const ctx = makeContext(dtstart, rule);
  const first = rule.count == null ? skippablePeriods(rule, ctx, dtstart, rangeStart) : 0;
  let count = 0;
  const take = (c) => {
    if (isAfterUntil(c)) return false;
    count += 1;
    if (rule.count != null && count > rule.count) return false;
    if (c >= rangeEnd) return false;
    if (c >= rangeStart) out.push(c);
    return true;
  };
  if (first === 0 && !take(dtstart)) return out;
  for (let k = first, n = 0; n < MAX_PERIODS; k++, n++) {
    const p = period(k, rule, ctx, dtstart);
    if (!p || p.start >= rangeEnd) break;
    for (const c of applySetPos(p.items, rule.bysetpos)) {
      if (c <= dtstart) continue;
      if (!take(c)) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Time zones

function vtimezoneResolver(vtz) {
  const observances = vtz.children
    .filter((c) => c.name === 'STANDARD' || c.name === 'DAYLIGHT')
    .map((c) => {
      const start = parseDateValue(text(c, 'DTSTART'));
      return {
        start: start?.floating ?? 0,
        from: parseOffset(text(c, 'TZOFFSETFROM')),
        to: parseOffset(text(c, 'TZOFFSETTO')),
        rule: prop(c, 'RRULE') ? parseRRule(text(c, 'RRULE')) : null,
        rdates: props(c, 'RDATE')
          .flatMap((p) => p.value.split(','))
          .map((v) => parseDateValue(v)?.floating)
          .filter((v) => v != null),
      };
    })
    .filter((o) => o.to != null);
  if (!observances.length) return null;

  const byYear = new Map();
  const transitions = (year) => {
    if (!byYear.has(year)) {
      const rangeStart = Date.UTC(year - 1, 0, 1);
      const rangeEnd = Date.UTC(year + 1, 0, 1);
      const list = [];
      for (const o of observances) {
        const starts = o.rule
          ? expandRRule(o.start, o.rule, {
              rangeStart,
              rangeEnd,
              isAfterUntil: (c) => o.rule.until != null && c - (o.from ?? 0) > o.rule.until.floating,
            })
          : [o.start, ...o.rdates].filter((t) => t >= rangeStart && t < rangeEnd);
        for (const at of starts) list.push({ at, to: o.to });
      }
      byYear.set(year, list.sort((a, b) => a.at - b.at));
    }
    return byYear.get(year);
  };
  const fallback = [...observances].sort((a, b) => a.start - b.start)[0];

  return (floating) => {
    let offset = null;
    for (const t of transitions(new Date(floating).getUTCFullYear())) {
      if (t.at <= floating) offset = t.to;
      else break;
    }
    if (offset == null) offset = fallback.from ?? fallback.to;
    return floating - offset;
  };
}

function makeZoneContext(calendar, localTz) {
  const vtimezones = new Map();
  for (const c of calendar.children) {
    if (c.name === 'VTIMEZONE') vtimezones.set(text(c, 'TZID'), c);
  }
  const calendarTz = normalizeTzid(text(calendar, 'X-WR-TIMEZONE'));
  const floatingTz = calendarTz || localTz;
  const cache = new Map();

  const forTzid = (tzid) => {
    if (cache.has(tzid)) return cache.get(tzid);
    let fn = null;
    const iana = normalizeTzid(tzid);
    if (iana) fn = (f) => zonedToUtc(f, iana);
    if (!fn && vtimezones.has(tzid)) fn = vtimezoneResolver(vtimezones.get(tzid));
    if (!fn && windowsToIana(tzid)) {
      const w = windowsToIana(tzid);
      fn = (f) => zonedToUtc(f, w);
    }
    if (!fn) fn = (f) => zonedToUtc(f, floatingTz);
    cache.set(tzid, fn);
    return fn;
  };

  return {
    /** Returns a floating→UTC converter for a parsed value + its TZID parameter. */
    resolver(parsed, tzid) {
      if (parsed.isDate) return (f) => zonedToUtc(f, localTz);
      if (parsed.utc) return (f) => f;
      if (tzid) return forTzid(tzid);
      return (f) => zonedToUtc(f, floatingTz);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Events → busy intervals

function readEvent(comp, zones, ownerEmails) {
  const dtstartProp = prop(comp, 'DTSTART');
  if (!dtstartProp) return null;
  const start = parseDateValue(dtstartProp.value);
  if (!start) return null;
  const toUtc = zones.resolver(start, dtstartProp.params.TZID);

  let duration = null;
  const dtendProp = prop(comp, 'DTEND');
  const end = dtendProp ? parseDateValue(dtendProp.value) : null;
  if (end) {
    if (start.isDate || end.isDate) duration = end.floating - start.floating;
    else {
      // Floating duration: convert DTEND into DTSTART's zone so DST-spanning events keep their length.
      const endUtc = zones.resolver(end, dtendProp.params.TZID)(end.floating);
      duration = endUtc - toUtc(start.floating);
    }
  } else if (prop(comp, 'DURATION')) {
    duration = parseDuration(text(comp, 'DURATION'));
  }
  if (duration == null) duration = start.isDate ? DAY : 0;

  const declined = props(comp, 'ATTENDEE').some((a) => {
    const email = a.value.replace(/^mailto:/i, '').trim().toLowerCase();
    return ownerEmails.has(email) && (a.params.PARTSTAT || '').toUpperCase() === 'DECLINED';
  });

  const instanceKey = (parsed, tzid) =>
    parsed.isDate ? parsed.floating : zones.resolver(parsed, tzid)(parsed.floating);

  const exdates = new Set();
  for (const p of props(comp, 'EXDATE')) {
    for (const v of p.value.split(',')) {
      const parsed = parseDateValue(v);
      if (parsed) exdates.add(instanceKey(parsed, p.params.TZID || dtstartProp.params.TZID));
    }
  }
  const rdates = [];
  for (const p of props(comp, 'RDATE')) {
    if ((p.params.VALUE || '').toUpperCase() === 'PERIOD') continue;
    for (const v of p.value.split(',')) {
      const parsed = parseDateValue(v);
      if (parsed) rdates.push(parsed.floating);
    }
  }
  const ridProp = prop(comp, 'RECURRENCE-ID');
  const rid = ridProp ? parseDateValue(ridProp.value) : null;

  return {
    uid: text(comp, 'UID'),
    start,
    toUtc,
    duration,
    rule: prop(comp, 'RRULE') ? parseRRule(text(comp, 'RRULE')) : null,
    exdates,
    rdates,
    recurrenceKey: rid ? instanceKey(rid, ridProp.params.TZID || dtstartProp.params.TZID) : null,
    instanceKey: (floating) => (start.isDate ? floating : toUtc(floating)),
    status: text(comp, 'STATUS').toUpperCase(),
    transp: text(comp, 'TRANSP').toUpperCase(),
    busyStatus: text(comp, 'X-MICROSOFT-CDO-BUSYSTATUS').toUpperCase(),
    declined,
  };
}

function isBusy(ev, { ignoreAllDay }) {
  if (ev.status === 'CANCELLED') return false;
  if (ev.transp === 'TRANSPARENT') return false;
  if (ev.busyStatus === 'FREE' || ev.busyStatus === 'WORKINGELSEWHERE') return false;
  if (ev.declined) return false;
  if (ev.start.isDate && ignoreAllDay) return false;
  return true;
}

function occurrenceStarts(ev, rangeStartUtc, rangeEndUtc) {
  if (!ev.rule) return [ev.start.floating, ...ev.rdates];
  // Expand in floating time with generous margins, then filter precisely in UTC.
  const rangeStart = rangeStartUtc - Math.max(ev.duration, 0) - 2 * DAY;
  const rangeEnd = rangeEndUtc + 2 * DAY;
  const until = ev.rule.until;
  let isAfterUntil = () => false;
  if (until) {
    if (until.utc) isAfterUntil = (c) => ev.toUtc(c) > until.floating;
    else if (until.isDate && !ev.start.isDate) isAfterUntil = (c) => c >= until.floating + DAY;
    else isAfterUntil = (c) => c > until.floating;
  }
  const starts = expandRRule(ev.start.floating, ev.rule, { rangeStart, rangeEnd, isAfterUntil });
  return [...starts, ...ev.rdates.filter((r) => r >= rangeStart && r < rangeEnd)];
}

/**
 * Busy intervals ({ start, end } in UTC ms) from an iCalendar feed that overlap [rangeStart, rangeEnd).
 * Options: ignoreAllDay (default true) skips all-day events; localTz is the zone for all-day/floating times.
 */
export function busyFromIcs(icsText, { rangeStart, rangeEnd, ignoreAllDay = true, localTz = localTimeZone() }) {
  const root = parseComponents(icsText);
  const calendar = root.children.find((c) => c.name === 'VCALENDAR');
  if (!calendar) throw new Error('Not an iCalendar (.ics) file');
  const tz = isValidTimeZone(localTz) ? localTz : 'UTC';
  const zones = makeZoneContext(calendar, tz);

  const calName = text(calendar, 'X-WR-CALNAME');
  const ownerEmails = new Set(/^[^\s@]+@[^\s@]+$/.test(calName) ? [calName.toLowerCase()] : []);

  const events = calendar.children
    .filter((c) => c.name === 'VEVENT')
    .map((c) => readEvent(c, zones, ownerEmails))
    .filter(Boolean);

  // Instances replaced by a RECURRENCE-ID override are skipped when expanding their master.
  const overridden = new Map();
  for (const ev of events) {
    if (ev.recurrenceKey == null) continue;
    if (!overridden.has(ev.uid)) overridden.set(ev.uid, new Set());
    overridden.get(ev.uid).add(ev.recurrenceKey);
  }

  const busy = [];
  for (const ev of events) {
    if (!isBusy(ev, { ignoreAllDay }) || ev.duration <= 0) continue;
    const skip = ev.recurrenceKey == null ? overridden.get(ev.uid) : null;
    for (const floating of occurrenceStarts(ev, rangeStart, rangeEnd)) {
      const key = ev.instanceKey(floating);
      if (ev.exdates.has(key) || skip?.has(key)) continue;
      const start = ev.toUtc(floating);
      const end = ev.start.isDate ? ev.toUtc(floating + ev.duration) : start + ev.duration;
      if (end > rangeStart && start < rangeEnd) busy.push({ start, end });
    }
  }
  return { busy: busy.sort((a, b) => a.start - b.start), name: calName, eventCount: events.length };
}
