import type { Tone } from "./format";

/* The shapes returned by GET /dashboards/{overview,meetings,biometric,compliance}?days=7|30|90 (see app/dashboards/). */

export type Hue = "indigo" | "violet" | "sky" | "teal" | "emerald" | "cyan" | "pink" | "amber";

export const PERIODS = [7, 30, 90] as const;
export type PeriodDays = (typeof PERIODS)[number];

export interface Kpi {
  key: string;
  label: string;
  /** One precise sentence, shown in the info tooltip. */
  definition: string;
  unit: "percent" | "count" | "hours" | "days";
  /** A fraction (0..1) for percent. null = nothing to measure: show a dash and `no_data`, never 0. */
  value: number | null;
  previous: number | null;
  delta: number | null;
  good_direction: "up" | "down" | null;
  target: number | null;
  tone: "good" | "warn" | "crit" | "neutral";
  numerator: number | null;
  denominator: number | null;
  detail: string | null;
  no_data: string | null;
  /** Wording for `previous` when it is not the previous equal period. */
  compare_label: string | null;
}

export interface PeriodInfo {
  days: number;
  start: string;
  end: string;
  previous_start: string;
  previous_end: string;
  working_days?: number;
  previous_working_days?: number;
}

export interface TrendPoint {
  start: string;
  previous_start: string;
  rate: number | null;
  previous_rate: number | null;
  total?: number;
  attended?: number;
  expected?: number;
  present?: number;
}

export interface RateTrend {
  daily: boolean;
  points: TrendPoint[];
  target: number;
}

interface DashboardBase {
  as_of: string;
  timezone: string;
}

/* ------------------------------------------------------------------ meetings */

export interface MeetingsDashboardData extends DashboardBase {
  area: "meetings";
  period: PeriodInfo;
  scope: { people: number };
  thresholds: { target: number; at_risk_below: number; min_slots: number; repeat_misses: number };
  kpis: { attendance: Kpi; series_at_risk: Kpi; repeat_absentees: Kpi; meetings_held: Kpi };
  trend: RateTrend;
  weekday: { day: string; total: number; attended: number; rate: number | null }[];
  turnout: { full: number; partial: number; none: number; total: number };
  series: {
    series_id: string;
    title: string;
    organizer_email: string;
    organizer_name: string;
    total: number;
    attended: number;
    missed: number;
    rate: number | null;
    previous_rate: number | null;
    delta: number | null;
    at_risk: boolean;
    low_volume: boolean;
  }[];
  series_total: number;
  organizers: { email: string; name: string; series_count: number; total: number; attended: number; rate: number | null; low_volume: boolean }[];
  people: {
    email: string;
    name: string;
    total: number;
    attended: number;
    missed: number;
    rate: number | null;
    repeat: boolean;
    worst_series: string;
    worst_series_id: string;
    worst_series_missed: number;
  }[];
  people_total: number;
  at_risk_series: MeetingsDashboardData["series"];
}

/* ----------------------------------------------------------------- biometric */

export interface BiometricPerson {
  emp_code: string;
  name: string;
  department: string | null;
}

export interface WorkHours {
  work_start: string;
  work_end: string;
  grace_minutes: number;
  /** false = nobody has saved work hours yet: the defaults are in use. */
  saved: boolean;
}

export interface BiometricDashboardData extends DashboardBase {
  area: "biometric";
  empty: boolean;
  period: PeriodInfo | null;
  work_hours: WorkHours;
  thresholds: { target: number; quiet_days: number; leaver_after_days: number };
  last_import: { at: string; file: string } | null;
  data_through: string | null;
  reference_day?: string;
  data_age_days: number | null;
  stale: boolean;
  headcount?: number;
  kpis: {
    attendance: Kpi;
    present_today: Kpi;
    late_arrivals: Kpi;
    early_exits: Kpi;
    avg_hours: Kpi;
    missed_punch: Kpi;
    not_seen: Kpi;
  };
  trend: RateTrend;
  weekday: { day: string; expected: number; present: number; rate: number | null }[];
  departments: {
    department: string;
    headcount: number;
    expected: number;
    present: number;
    rate: number | null;
    previous_rate: number | null;
    delta: number | null;
  }[];
  not_seen: (BiometricPerson & { last_seen: string; days_silent: number; assumed_left: boolean })[];
  not_seen_total: number;
  missed_punch_people: (BiometricPerson & { count: number; days_present: number; rate: number | null })[];
  late_people: (BiometricPerson & { count: number; days_present: number; rate: number | null })[];
  low_presence_people: (BiometricPerson & { expected: number; present: number; rate: number | null })[];
}

/* ---------------------------------------------------------------- compliance */

export interface ComplianceGroupRow {
  name: string;
  total: number;
  completed: number;
  rate: number | null;
  previous_rate: number | null;
  delta: number | null;
  overdue: number;
}

export interface ComplianceDashboardData extends DashboardBase {
  area: "compliance";
  period: PeriodInfo;
  thresholds: { target: number; warn_floor: number };
  kpis: {
    completion: Kpi;
    on_time: Kpi;
    overdue: Kpi;
    due_soon: Kpi;
    review_queue: Kpi;
    review_turnaround: Kpi;
    non_compliant: Kpi;
    repeat_defaulters: Kpi;
    time_to_complete: Kpi;
  };
  aging: { d1_7: number; d8_30: number; d30_plus: number; total: number };
  completions: {
    daily: boolean;
    total: number;
    previous_total: number;
    points: { start: string; previous_start: string; completed: number; previous_completed: number }[];
  };
  by_category: ComplianceGroupRow[];
  by_priority: ComplianceGroupRow[];
  by_department: ComplianceGroupRow[];
  overdue_items: {
    obligation_id: string;
    compliance: string;
    compliance_id: string;
    priority: string;
    user: { email: string; name: string };
    due_at: string;
    days_overdue: number;
    status: string;
  }[];
  overdue_total: number;
  overdue_by_compliance: { compliance_id: string; name: string; priority: string; overdue: number; oldest_days: number }[];
  due_soon: { obligation_id: string; compliance: string; priority: string; user: { email: string; name: string }; due_at: string; status: string }[];
  review_items: {
    obligation_id: string;
    compliance: string;
    priority: string;
    user: { email: string; name: string };
    submitted_at: string;
    waiting_days: number;
  }[];
  defaulters: {
    email: string;
    name: string;
    department: string | null;
    incidents: number;
    score: number;
    overdue: number;
    non_compliant: number;
    late: number;
    repeat: boolean;
  }[];
  escalations: { obligation_id: string; compliance: string; user: string; action: string; fired_at: string }[];
}

/* ------------------------------------------------------------------ overview */

export interface OverviewData extends DashboardBase {
  area: "overview";
  period: PeriodInfo;
  meetings: {
    available: true;
    kpis: Kpi[];
    attention: { series_id: string; title: string; organizer_name: string; rate: number | null; missed: number; total: number }[];
    attention_total: number;
    period: PeriodInfo;
  };
  biometric: {
    available: true;
    empty: boolean;
    kpis: Kpi[];
    data_through: string | null;
    data_age_days: number | null;
    stale: boolean;
    attention: { kind: "not_seen"; emp_code: string; name: string; department: string | null; days_silent: number }[];
    attention_total: number;
    missed_punch: { emp_code: string; name: string; department: string | null; count: number }[];
    period: PeriodInfo | null;
  };
  compliance:
    | { available: false; reason: string }
    | {
        available: true;
        kpis: Kpi[];
        attention: { compliance_id: string; name: string; priority: string; overdue: number; oldest_days: number }[];
        attention_total: number;
        aging: ComplianceDashboardData["aging"];
        period: PeriodInfo;
      };
}

/* ------------------------------------------------------------------ helpers */

export const toneOf = (t: Kpi["tone"]): Tone => t;

const nf = new Intl.NumberFormat("en-US");

/** The number as shown on a KPI card (the unit is carried by `unit`). */
export function fmtKpiValue(unit: Kpi["unit"], v: number): string {
  switch (unit) {
    case "percent":
      return `${Math.round(v * 100)}%`;
    case "count":
      return nf.format(Math.round(v));
    case "hours":
      if (v < 1) return `${Math.max(1, Math.round(v * 60))} min`;
      if (v < 48) return `${v < 10 ? v.toFixed(1) : Math.round(v)} h`;
      return `${(v / 24).toFixed(1)} d`;
    case "days":
      if (v < 1) return fmtKpiValue("hours", v * 24);
      return `${v < 10 ? v.toFixed(1) : Math.round(v)} d`;
  }
}

/** A change between two readings: "+4.2 pts", "−2", "+0.3 h". Percent deltas are in points. */
export function fmtDelta(unit: Kpi["unit"], d: number): string {
  const sign = d > 0 ? "+" : d < 0 ? "−" : "";
  const a = Math.abs(d);
  switch (unit) {
    case "percent": {
      const pts = a * 100;
      return `${sign}${pts >= 10 ? Math.round(pts) : pts.toFixed(1)} pts`;
    }
    case "count":
      return `${sign}${nf.format(Math.round(a))}`;
    case "hours":
      return `${sign}${a < 1 ? `${Math.round(a * 60)} min` : a < 48 ? `${a.toFixed(1)} h` : `${(a / 24).toFixed(1)} d`}`;
    case "days":
      return `${sign}${a.toFixed(1)} d`;
  }
}

/** Is a change too small to call? */
export function isFlat(unit: Kpi["unit"], d: number): boolean {
  return unit === "percent" ? Math.abs(d) < 0.0005 : unit === "count" ? d === 0 : Math.abs(d) < 0.05;
}

/** How bad is a worsening? Big drops earn the attention colour (red); small ones stay amber. */
export function isSevere(k: Pick<Kpi, "unit" | "previous">, d: number): boolean {
  if (k.unit === "percent") return Math.abs(d) >= 0.1;
  if (k.unit === "count") return Math.abs(d) >= 3 && (k.previous ? Math.abs(d) / Math.max(1, k.previous) >= 0.5 : true);
  return false;
}

export const WEEKDAY_LONG: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

const DAY = 86400000;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** The first and last calendar day of the i-th chart bucket (a day, or a 7-day block that may be shorter at the period's start). */
export function bucketRange(starts: string[], i: number, daily: boolean, periodEnd: string): [string, string] {
  const start = starts[i];
  if (daily) return [start, start];
  const end = i + 1 < starts.length ? addDays(starts[i + 1], -1) : periodEnd;
  return [start, end];
}
