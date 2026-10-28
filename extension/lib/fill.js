// Plans an autofill: maps when2meet slots to real times, gathers busy time, and decides each slot.

import { computeAvailability, detectSlotSeconds, slotStarts } from './availability.js';
import { MINUTE, localTimeZone } from './time.js';

/**
 * slots      TimeOfSlot from the when2meet page (unix seconds)
 * getBusy    async (timeMin, timeMax) => { busy, sources }
 * timeZone   the user's zone (weekly events, daily-hours and weekday preferences)
 * Returns { desired, daysOfWeek, range, sources, busyCount } or { failed: [source], sources } when a
 * calendar could not be read (filling with partial data would mark busy times as free).
 */
export async function planFill({ slots, settings, getBusy, now = Date.now(), timeZone = localTimeZone() }) {
  if (!Array.isArray(slots) || !slots.length) throw new Error('No time slots found on this when2meet page.');
  const slotMs = detectSlotSeconds(slots) * 1000;
  const { daysOfWeek, starts } = slotStarts(slots, { timeZone, now });
  const first = Math.min(...starts);
  const last = Math.max(...starts) + slotMs;
  const pad = Math.max(0, Number(settings.bufferMinutes) || 0) * MINUTE;

  const { busy, sources } = await getBusy(first - pad, last + pad);
  const failed = sources.filter((s) => !s.ok);
  if (failed.length) return { failed, sources };

  const desired = computeAvailability({ starts, slotMs, busy, settings, timeZone });
  const busyCount = busy.filter((b) => b.end > first && b.start < last).length;
  return { desired, daysOfWeek, range: { start: first, end: last }, sources, busyCount };
}
