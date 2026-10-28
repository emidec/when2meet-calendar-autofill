// Turns busy intervals into a yes/no answer for every when2meet slot.

import { DAY, MINUTE, isValidTimeZone, localTimeZone, zonedParts, zonedToUtc } from './time.js';

/**
 * when2meet "days of the week" events store slots in a reference week in 1978, with the wall-clock time
 * written as if it were UTC: "Monday 9:00 AM" is a Monday in 1978 at 09:00 UTC.
 */
export const DAYS_OF_WEEK_CUTOFF_SEC = Date.UTC(1980, 0, 1) / 1000;

/** Slot length in seconds: the most common gap between consecutive slots (15 min on when2meet). */
export function detectSlotSeconds(slots) {
  const counts = new Map();
  for (let i = 1; i < slots.length; i++) {
    const d = slots[i] - slots[i - 1];
    if (d > 0 && d <= 3600) counts.set(d, (counts.get(d) || 0) + 1);
  }
  let best = 900;
  let bestCount = 0;
  for (const [d, c] of counts) {
    if (c > bestCount || (c === bestCount && d < best)) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

export function mergeIntervals(intervals) {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const { start, end } of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else out.push({ start, end });
  }
  return out;
}

/** True if [start, end) overlaps any of the merged, sorted intervals. */
function overlapsAny(merged, start, end) {
  let lo = 0;
  let hi = merged.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (merged[mid].start < end) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return candidate >= 0 && merged[candidate].end > start;
}

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Math.min(24 * 60, Number(m[1]) * 60 + Number(m[2])) : null;
}

/**
 * Real start times (UTC ms) for each when2meet slot. Specific-date events use the slot timestamps as is.
 * Days-of-the-week events are placed on the next 7 days (starting tomorrow) at the same weekday and
 * wall-clock time in the user's `timeZone`.
 */
export function slotStarts(slots, { timeZone, now = Date.now() } = {}) {
  const tz = isValidTimeZone(timeZone) ? timeZone : localTimeZone();
  const daysOfWeek = slots.length > 0 && Math.max(...slots) < DAYS_OF_WEEK_CUTOFF_SEC;
  if (!daysOfWeek) return { daysOfWeek, starts: slots.map((t) => t * 1000) };

  const today = zonedParts(now, tz);
  const tomorrow = Date.UTC(today.year, today.month - 1, today.day) + DAY;
  const tomorrowWeekday = (today.weekday + 1) % 7;
  const starts = slots.map((t) => {
    const wallClock = new Date(t * 1000); // read in UTC, see DAYS_OF_WEEK_CUTOFF_SEC
    const day = tomorrow + ((wallClock.getUTCDay() - tomorrowWeekday + 7) % 7) * DAY;
    return zonedToUtc(day + ((t * 1000) % DAY), tz);
  });
  return { daysOfWeek, starts };
}

/**
 * Decides availability for each slot.
 *   starts      real UTC start of each slot (ms)
 *   slotMs      slot length (ms)
 *   busy        [{ start, end }] in UTC ms
 *   settings    { bufferMinutes, minBlockMinutes, limitHours, dayStart, dayEnd, blockedWeekdays }
 *   timeZone    the user's zone, for the daily-hours and weekday preferences
 * Returns an array of booleans (true = available).
 */
export function computeAvailability({ starts, slotMs, busy, settings = {}, timeZone = localTimeZone() }) {
  const buffer = Math.max(0, Number(settings.bufferMinutes) || 0) * MINUTE;
  const merged = mergeIntervals(busy.map((b) => ({ start: b.start - buffer, end: b.end + buffer })));
  const dayStart = minutesOf(settings.dayStart);
  const dayEnd = minutesOf(settings.dayEnd);
  const limitHours = Boolean(settings.limitHours) && dayStart != null && dayEnd != null;
  const blocked = new Set(settings.blockedWeekdays || []);
  const slotMinutes = slotMs / MINUTE;

  const desired = starts.map((start) => {
    if (overlapsAny(merged, start, start + slotMs)) return false;
    if (limitHours || blocked.size) {
      const p = zonedParts(start, timeZone);
      if (blocked.has(p.weekday)) return false;
      if (limitHours) {
        const from = p.hour * 60 + p.minute;
        const to = from + slotMinutes;
        const inside = dayEnd > dayStart ? from >= dayStart && to <= dayEnd : from >= dayStart || to <= dayEnd;
        if (!inside) return false;
      }
    }
    return true;
  });

  const minBlock = Math.max(0, Number(settings.minBlockMinutes) || 0) * MINUTE;
  if (minBlock > slotMs) dropShortRuns(desired, starts, slotMs, minBlock);
  return desired;
}

function dropShortRuns(desired, starts, slotMs, minBlock) {
  // Walk the slots in time order: available slots that are exactly one slot apart form a free block.
  const order = starts.map((s, i) => i).sort((a, b) => starts[a] - starts[b]);
  let run = [];
  const flush = () => {
    if (run.length && run.length * slotMs < minBlock) run.forEach((i) => (desired[i] = false));
    run = [];
  };
  for (const i of order) {
    const prev = run[run.length - 1];
    if (!desired[i]) {
      flush();
      continue;
    }
    if (prev != null && starts[i] !== starts[prev] + slotMs) flush();
    run.push(i);
  }
  flush();
}
