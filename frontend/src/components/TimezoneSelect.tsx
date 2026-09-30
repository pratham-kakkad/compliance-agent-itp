import { forwardRef, useMemo } from "react";
import { fmtOffset, isSupportedTimeZone, zoneOffsetMinutes } from "../lib/format";
import type { TimezoneOption } from "../types";
import { Select } from "./ui";

export interface TimezoneGroup {
  region: string;
  options: TimezoneOption[];
}

/** "Asia/Kolkata" → "Asia"; zones without a slash ("UTC", "Japan") → "Other". */
export function timezoneRegion(name: string): string {
  const i = name.indexOf("/");
  return i > 0 ? name.slice(0, i) : "Other";
}

/** A list entry for a zone the server list doesn't have (offset computed here). */
export function describeTimezone(name: string): TimezoneOption {
  const offset = isSupportedTimeZone(name) ? fmtOffset(zoneOffsetMinutes(name)) : "+00:00";
  return { name, offset, label: `(UTC${offset}) ${name}` };
}

/** Regions A–Z with "Other" last; zones keep the server's order (by offset, then name). */
export function groupTimezones(options: TimezoneOption[]): TimezoneGroup[] {
  const byRegion = new Map<string, TimezoneOption[]>();
  for (const o of options) {
    const region = timezoneRegion(o.name);
    const list = byRegion.get(region);
    if (list) list.push(o);
    else byRegion.set(region, [o]);
  }
  return [...byRegion.entries()]
    .sort(([a], [b]) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)))
    .map(([region, opts]) => ({ region, options: opts }));
}

const normalize = (s: string) => s.toLowerCase().replace(/[\s_/]+/g, " ").trim();

/** Every word of `query` appears in the zone's name or label — "new york", "kolkata", "+05:30" all work. */
export function matchesTimezone(option: TimezoneOption, query: string): boolean {
  const q = normalize(query);
  if (!q) return true;
  const hay = normalize(`${option.name} ${option.label} UTC${option.offset}`);
  return q.split(" ").every((word) => hay.includes(word));
}

/**
 * The options a picker shows: the server list narrowed by `query`, always
 * including `value` so the native select never silently shows another zone.
 */
export function visibleTimezoneGroups(timezones: TimezoneOption[] | null | undefined, value: string, query = ""): TimezoneGroup[] {
  const all = timezones ?? [];
  const shown = query ? all.filter((o) => matchesTimezone(o, query)) : all.slice();
  if (value && !shown.some((o) => o.name === value)) {
    shown.push(all.find((o) => o.name === value) ?? describeTimezone(value));
  }
  return groupTimezones(shown);
}

type TimezoneSelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange" | "size"> & {
  value: string;
  onChange: (timeZone: string) => void;
  /** GET /settings/timezones list; null while loading (only `value` is offered). */
  timezones: TimezoneOption[] | null | undefined;
  /** Narrow the options to zones matching this text. */
  query?: string;
  size?: "sm" | "md";
};

/**
 * Native select of IANA zones grouped by region. Options read name first,
 * "Asia/Kolkata (UTC+05:30)", so the browser's type-to-select works ("asia/k",
 * "america/new"); a label starting "(UTC" would make every option match alike.
 */
export const TimezoneSelect = forwardRef<HTMLSelectElement, TimezoneSelectProps>(function TimezoneSelect(
  { value, onChange, timezones, query = "", ...rest },
  ref
) {
  const groups = useMemo(() => visibleTimezoneGroups(timezones, value, query), [timezones, value, query]);
  return (
    <Select ref={ref} value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
      {groups.map((g) => (
        <optgroup key={g.region} label={g.region}>
          {g.options.map((o) => (
            <option key={o.name} value={o.name}>
              {`${o.name} (UTC${o.offset})`}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
});
