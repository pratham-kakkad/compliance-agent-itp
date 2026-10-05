/**
 * Date-time handling for the deadline fields. An <input type="datetime-local"> holds a wall-clock
 * time with no zone; the people using it think in the organization's time zone, so that is the
 * zone we read it in. We always send the server an ISO string with an explicit offset: a bare
 * timestamp would be taken as UTC.
 */
import { fmtOffset, parseInstant, zoneOffsetMinutes } from "../../../lib/format";

const pad = (n: number) => String(n).padStart(2, "0");

/** An instant (API string) as "YYYY-MM-DDTHH:mm" wall-clock time in `timeZone`. */
export function isoToZonedInput(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  const at = parseInstant(iso);
  if (Number.isNaN(at.getTime())) return "";
  const shifted = new Date(at.getTime() + zoneOffsetMinutes(timeZone, at) * 60_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

/** The instant for a wall-clock "YYYY-MM-DDTHH:mm" in `timeZone` (DST-aware), or null if it can't be read. */
export function zonedInputToInstant(value: string, timeZone: string): { at: Date; offset: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // The offset depends on the instant, which depends on the offset: two passes settle it except inside a DST gap.
  let offset = zoneOffsetMinutes(timeZone, new Date(wall));
  offset = zoneOffsetMinutes(timeZone, new Date(wall - offset * 60_000));
  const at = new Date(wall - offset * 60_000);
  return Number.isNaN(at.getTime()) ? null : { at, offset };
}

/** ISO string with an explicit offset ("2026-10-12T17:00:00+05:30"), or null when empty/unreadable. */
export function zonedInputToIso(value: string, timeZone: string): string | null {
  if (!value) return null;
  const r = zonedInputToInstant(value, timeZone);
  if (!r) return null;
  return `${value.slice(0, 16)}:00${fmtOffset(r.offset)}`;
}

/** The wall-clock "YYYY-MM-DDTHH:mm" in `timeZone`, `days` from now at the same time of day (or 17:00 if none). */
export function inDaysInput(days: number, timeZone: string, fromValue?: string): string {
  const now = isoToZonedInput(new Date().toISOString(), timeZone);
  const time = fromValue && fromValue.length >= 16 ? fromValue.slice(11, 16) : "17:00";
  const base = new Date(`${now.slice(0, 10)}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}T${time}`;
}
