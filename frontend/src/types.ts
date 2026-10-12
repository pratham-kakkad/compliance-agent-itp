export interface Me {
  email: string;
  name: string;
  title: string;
  manager_email: string | null;
  is_demo: boolean;
}

export interface AuthConfig {
  demo_login_enabled: boolean;
  microsoft_configured: boolean;
}

export interface DirectoryEntry {
  email: string;
  name: string;
  title: string;
}

export interface TrendPoint {
  week_start: string;
  total: number;
  attended: number;
  attendance_rate: number | null;
}

export interface ConcernSeries {
  series_id: string;
  title: string;
  organizer_email: string;
  recurrence: string;
  total: number;
  attended: number;
  missed: number;
  attendance_rate: number | null;
}

export interface FocusMember {
  email: string;
  total: number;
  attended: number;
  missed: number;
  attendance_rate: number | null;
}

export interface DashboardPayload {
  me: {
    email: string;
    name: string;
    attendance_rate: number | null;
    required_total: number;
    required_attended: number;
  };
  has_reports: boolean;
  direct_report_count: number;
  total_report_count: number;
  trend: TrendPoint[];
  top_concern_series: ConcernSeries[];
  top_members_to_focus: FocusMember[];
  team: { total: number; attended: number; attendance_rate: number | null } | null;
}

export interface MeetingListItem {
  series_id: string;
  title: string;
  organizer_email: string;
  recurrence: string;
  last_occurrence: string;
  required_total: number;
  attendance_rate: number | null;
}

export interface MeetingListResponse {
  grouped_by?: "organizer";
  items: MeetingListItem[];
  groups: Record<string, MeetingListItem[]>;
}

export interface Attendance {
  attendee_email: string;
  name: string;
  required: boolean;
  attended: boolean;
}

export interface Occurrence {
  id: string;
  start_time: string;
  end_time: string;
  attendances: Attendance[];
}

export interface MeetingDetail {
  series_id: string;
  title: string;
  organizer_email: string;
  recurrence: string;
  occurrences: Occurrence[];
}

export interface PersonListItem {
  email: string;
  name: string;
  title: string;
  manager_email: string | null;
  is_self: boolean;
  attendance_rate: number | null;
}

export interface PersonSeries {
  series_id: string;
  title: string;
  total: number;
  attended: number;
  attendance_rate: number | null;
}

export interface PersonDetail {
  email: string;
  name: string;
  title: string;
  manager_email: string | null;
  direct_reports: { email: string; name: string; title: string }[];
  required_total: number;
  required_attended: number;
  attendance_rate: number | null;
  series: PersonSeries[];
}

export interface OrgNode {
  email: string;
  name: string;
  title: string;
  attendance_rate: number | null;
  required_total: number;
  children: OrgNode[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** GET /chat/status — what the assistant can do right now. Never contains secret values. */
export interface ChatStatus {
  llm: {
    configured: boolean;
    provider: "groq";
    model: string;
  };
  embeddings: {
    configured: boolean;
    /** "api" = HuggingFace Inference API (needs a token), "local" = sentence-transformers on the server. */
    mode: string;
    model: string;
    error: string | null;
  };
  index: {
    built: boolean;
    documents: number;
    built_at: string | null;
    last_error: string | null;
    embedding_namespace: string;
  };
}

// --- Attendance agent ---

export interface AttendanceSummary {
  total_days_tracked: number;
  employee_count: number;
}

export interface AttendanceTrendPoint {
  week_start: string;
  days_tracked: number;
}

export interface AttendanceDeptStat {
  department: string;
  days_tracked: number;
}

export interface AttendanceInsights {
  headcount: number;
  /** The latest normal working day in the data (a weekend with a couple of punches doesn't count); null before the first import. */
  latest_day: string | null;
  /** The very latest date that has any punches. */
  latest_data_day: string | null;
  present_latest: number;
  present_rate: number | null;
  quiet_days: number;
  quiet_count: number;
  quiet: { emp_code: string; name: string; department: string | null; last_seen: string | null; days_quiet: number | null }[];
  /** Lowest first. rate = share of the department present on an average working day. */
  by_department: { department: string; headcount: number; rate: number }[];
  weekly_presence: { week_start: string; rate: number | null }[];
  window_days: number;
  last_import_at: string | null;
  last_import_file: string | null;
}

export interface AttendanceDashboardPayload {
  summary: AttendanceSummary;
  trend: AttendanceTrendPoint[];
  by_department: AttendanceDeptStat[];
  insights: AttendanceInsights;
}

export interface AttendanceListItem {
  emp_code: string;
  name: string;
  company: string | null;
  department: string | null;
  days_tracked: number;
  last_seen: string | null;
}

export interface AttendanceListResponse {
  items: AttendanceListItem[];
}

export interface AttendanceDay {
  work_date: string;
  first_punch: string | null;
  last_punch: string | null;
  punch_count: number;
}

export interface AttendanceEmployeeDetail {
  emp_code: string;
  name: string;
  company: string | null;
  department: string | null;
  total_days_tracked: number;
  days: AttendanceDay[];
}

export interface AttendanceImportRejected {
  row: number;
  reason: string;
}

export interface AttendanceImportResult {
  batch_id: string;
  row_count: number;
  accepted: number;
  employees_affected: number;
  rejected: AttendanceImportRejected[];
  /** IANA zone the file's naive timestamps were read in (then stored as UTC). */
  source_timezone: string;
  /** Organization zone used to assign punches to attendance days. */
  timezone: string;
}

// --- Organization settings ---

/** GET /settings — organization-wide preferences. */
export interface OrgSettings {
  /** IANA zone every time is displayed in; also decides which day a punch counts toward. */
  timezone: string;
  /** Current UTC offset of `timezone`, e.g. "+05:30". */
  timezone_offset: string;
  /** Server default (DEFAULT_TIMEZONE) used until someone saves a zone. */
  default_timezone: string;
  updated_at: string | null;
  updated_by: string | null;
}

/** PUT /settings body — partial update; omitted or null fields are left untouched. */
export interface OrgSettingsPatch {
  timezone?: string | null;
}

/** PUT /settings response. */
export interface OrgSettingsUpdateResult extends OrgSettings {
  changed: boolean;
  /** AttendanceDay rows rebuilt in the new zone (0 when nothing changed). */
  recomputed_days: number;
}

export interface TimezoneOption {
  name: string;
  /** Current UTC offset, e.g. "+05:30". */
  offset: string;
  /** e.g. "(UTC+05:30) Asia/Kolkata". */
  label: string;
}

/** GET /settings/timezones — sorted by current offset, then name. */
export interface TimezoneList {
  timezones: TimezoneOption[];
  default: string;
}

/** A row of GET /attendance: the roster entry plus its recent presence. */
export interface AttendanceEmployeeRow extends AttendanceListItem {
  /** Share of the last 30 working days the person was present (0..1); null before any data. */
  rate: number | null;
  /** Present on the latest working day. */
  present_latest: boolean;
}

// --- Local sign-in and e-mail (appended: declaration merging extends the interfaces above) ---
export interface AuthConfig {
  /** E-mail + password sign-in is always on. */
  password_login_enabled?: boolean;
  /** Outgoing e-mail (SMTP) is set up, so invite / reset mails are really sent. */
  smtp_configured?: boolean;
}

export interface Me {
  has_password?: boolean;
}

export interface SmtpSettings {
  host: string;
  port: number;
  security: "none" | "starttls" | "ssl";
  username: string;
  from_email: string;
  from_name: string;
  /** The password itself is never returned, only whether one is saved. */
  password_set: boolean;
  password_unreadable: boolean;
  configured: boolean;
  source: "saved" | "environment" | "none";
  updated_at: string | null;
  updated_by: string | null;
}
