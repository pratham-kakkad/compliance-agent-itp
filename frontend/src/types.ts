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

export interface AttendanceDashboardPayload {
  summary: AttendanceSummary;
  trend: AttendanceTrendPoint[];
  by_department: AttendanceDeptStat[];
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
}
