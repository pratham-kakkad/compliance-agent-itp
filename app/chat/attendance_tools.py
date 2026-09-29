"""The assistant's attendance tools: six exact, SQL-backed tools for counts,
dates, lists and rankings, plus semantic search (search_attendance_records)
for fuzzy or descriptive questions. Vector search alone is unreliable for "how many"
and "on which date", which is why both kinds exist.

Scope matches the attendance REST API: any logged-in user sees all
attendance data. Every tool returns a JSON-serializable dict and never
raises (errors come back as {"error": ...}; see tool_utils.make_tool).
Plain presence only — there are no worked hours anywhere.
"""
import difflib
import statistics
from datetime import date as date_type
from datetime import datetime, timedelta
from typing import Literal

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.attendance import analytics as attendance_analytics
from app.attendance.models import AttendanceDay, AttendanceEmployee
from app.chat.attendance_docs import label
from app.chat.attendance_index import attendance_index, describe_error
from app.chat.tool_utils import contains, make_tool, parse_date_arg

FIND_LIMIT = 25
DAY_ROWS_LIMIT = 62
ON_DATE_LIST_LIMIT = 100
DEFAULT_RANGE_DAYS = 30
SEARCH_K = 8
# Long lists go out as compact rows (arrays) described by a columns string:
# about a third of the size of one dict per row, so a whole roster fits in a
# tool result.
PRESENT_COLUMNS = "[name, emp_code, department, first_punch, last_punch, punches]"
NO_RECORD_COLUMNS = "[name, emp_code, department]"
DAY_COLUMNS = "[date, weekday, first_punch, last_punch, punches]"
RANK_COLUMNS = "[rank, name, emp_code, department, value, days_present]"
SINGLE_PUNCH_COLUMNS = "[date, weekday, name, emp_code, department, punch_time]"
PER_EMPLOYEE_COLUMNS = "[name, emp_code, department, single_punch_days]"
RANK_LIMIT_DEFAULT = 10
RANK_LIMIT_MAX = 50
SINGLE_PUNCH_ROWS_LIMIT = 80
SINGLE_PUNCH_PER_EMPLOYEE_LIMIT = 50
RankMetric = Literal[
    "earliest_first_punch",
    "latest_first_punch",
    "earliest_last_punch",
    "latest_last_punch",
    "most_days_present",
    "fewest_days_present",
    "most_single_punch_days",
]
RANK_METRICS: tuple[str, ...] = RankMetric.__args__
NO_RECORD_NOTE = (
    "no_record means no punch was recorded that day — there is no shift roster, so it does not prove absence"
)


# --- argument schemas (Optional fields so a model sending null still validates) ---


class _NoArgs(BaseModel):
    pass


class _FindEmployeesArgs(BaseModel):
    query: str | None = Field(
        default=None,
        description="Part of a name or emp code, e.g. 'pratham' or 'ITPL59'. Leave empty to list everyone "
        "(optionally within a department).",
    )
    department: str | None = Field(
        default=None, description="Optional department name or part of it, case-insensitive, e.g. 'Data & AI'."
    )


class _EmployeeAttendanceArgs(BaseModel):
    employee: str = Field(
        description="The employee's name (full or partial, e.g. 'Pratham' or 'Pratham Kakkad') or emp code "
        "(e.g. 'ITPL593')."
    )
    start_date: str | None = Field(
        default=None,
        description="First day of the range, inclusive: YYYY-MM-DD or DD-MM-YYYY, or 'today'/'yesterday'. "
        "For a whole month give its first day (and its last day as end_date). Leave empty for the default "
        "(the 30 days ending today).",
    )
    end_date: str | None = Field(
        default=None,
        description="Last day of the range, inclusive: YYYY-MM-DD or DD-MM-YYYY, or 'today'/'yesterday'. "
        "Leave empty for today.",
    )


class _AttendanceOnDateArgs(BaseModel):
    date: str = Field(description="The date: YYYY-MM-DD or DD-MM-YYYY, or 'today'/'yesterday'.")
    department: str | None = Field(
        default=None, description="Optional department name or part of it, case-insensitive."
    )


_RANGE_START_DESCRIPTION = (
    "First day of the range, inclusive: YYYY-MM-DD or DD-MM-YYYY, or 'today'/'yesterday'. For a whole month "
    "give its first day (and its last day as end_date). Leave empty for the default (the 30 days ending today, "
    "or the 30 days ending on the latest tracked date when today's window has no data)."
)
_RANGE_END_DESCRIPTION = "Last day of the range, inclusive: YYYY-MM-DD or DD-MM-YYYY. Leave empty for the default."


class _RankArgs(BaseModel):
    metric: RankMetric = Field(
        description="What to rank by. earliest_first_punch / latest_first_punch: each person's median first punch "
        "time (who arrives earliest / latest). earliest_last_punch / latest_last_punch: median last punch time (who "
        "leaves earliest / latest). most_days_present / fewest_days_present: days with at least one punch. "
        "most_single_punch_days: days with exactly one punch."
    )
    start_date: str | None = Field(default=None, description=_RANGE_START_DESCRIPTION)
    end_date: str | None = Field(default=None, description=_RANGE_END_DESCRIPTION)
    department: str | None = Field(default=None, description="Optional department name or part of it.")
    limit: str | None = Field(default=None, description="How many employees to return: default 10, at most 50.")


class _SinglePunchArgs(BaseModel):
    start_date: str | None = Field(default=None, description=_RANGE_START_DESCRIPTION)
    end_date: str | None = Field(default=None, description=_RANGE_END_DESCRIPTION)
    department: str | None = Field(default=None, description="Optional department name or part of it.")
    employee: str | None = Field(default=None, description="Optional employee name or emp code to limit the list to.")


class _SearchArgs(BaseModel):
    # Strings only: Groq validates tool-call arguments against the schema, and
    # Llama models often quote numbers, which fails an integer parameter.
    query: str = Field(description="What to look for, in natural language.")


# --- helpers ---


def _hhmm(value: datetime | None) -> str | None:
    return value.strftime("%H:%M") if value is not None else None


def _median_hhmm(values: list[datetime | None]) -> str | None:
    minutes = sorted(v.hour * 60 + v.minute for v in values if v is not None)
    if not minutes:
        return None
    m = statistics.median_low(minutes)
    return f"{m // 60:02d}:{m % 60:02d}"


def _iso(value: date_type | None) -> str | None:
    return value.isoformat() if value is not None else None


def _department_condition(department: str):
    if department.strip().lower() == "unassigned":
        return or_(AttendanceEmployee.department.is_(None), AttendanceEmployee.department == "")
    return AttendanceEmployee.department.ilike(contains(department.strip()), escape="\\")


def _name_condition(query: str):
    """Every word of the query appears in the name, in any order."""
    return and_(*[AttendanceEmployee.name.ilike(contains(tok), escape="\\") for tok in query.split()])


def _similar_names(db: Session, query: str, limit: int = 5) -> list[str]:
    q = query.strip().lower()
    if not q:
        return []
    scored = []
    for name in db.scalars(select(AttendanceEmployee.name)).all():
        low = name.lower()
        score = max(
            [difflib.SequenceMatcher(None, q, low).ratio()]
            + [difflib.SequenceMatcher(None, q, part).ratio() for part in low.split()]
        )
        if score >= 0.6:
            scored.append((score, name))
    scored.sort(key=lambda s: (-s[0], s[1]))
    return [name for _, name in scored[:limit]]


def _minutes(value: datetime | None) -> int | None:
    return value.hour * 60 + value.minute if value is not None else None


def _hhmm_from_minutes(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


def _parse_limit(value: str | None) -> int:
    try:
        n = int(str(value).strip()) if value not in (None, "") else RANK_LIMIT_DEFAULT
    except ValueError:
        n = RANK_LIMIT_DEFAULT
    return max(1, min(RANK_LIMIT_MAX, n))


def _resolve_range(
    db: Session, start_date: str | None, end_date: str | None, today: date_type
) -> tuple[date_type, date_type, str | None] | dict:
    """(start, end, note) for a date-range tool, or an {"error"} dict.

    With no dates given, the range is the 30 days ending today — unless nobody
    has any punch in that window (e.g. the latest import is older), in which
    case it's the 30 days ending on the latest tracked date, with a note."""
    try:
        start = parse_date_arg(start_date, today)
        end = parse_date_arg(end_date, today)
    except ValueError as exc:
        return {"error": str(exc)}
    note = None
    if start is None and end is None:
        end = today
        start = end - timedelta(days=DEFAULT_RANGE_DAYS - 1)
        in_window = db.scalar(
            select(func.count())
            .select_from(AttendanceDay)
            .where(AttendanceDay.work_date >= start, AttendanceDay.work_date <= end)
        )
        if not in_window:
            last = db.scalar(select(func.max(AttendanceDay.work_date)))
            if last is not None:
                end = last
                start = end - timedelta(days=DEFAULT_RANGE_DAYS - 1)
                note = (
                    f"No punches in the {DEFAULT_RANGE_DAYS} days ending {today.isoformat()}; used the "
                    f"{DEFAULT_RANGE_DAYS} days ending on the latest tracked date ({end.isoformat()}) instead."
                )
    else:
        end = end or today
        start = start or end - timedelta(days=DEFAULT_RANGE_DAYS - 1)
    if start > end:
        return {"error": f"start_date {start.isoformat()} is after end_date {end.isoformat()}."}
    return start, end, note


def _brief(emp: AttendanceEmployee) -> dict:
    return {
        "emp_code": emp.emp_code,
        "name": emp.name,
        "company": label(emp.company),
        "department": label(emp.department),
    }


def _resolve_employee(db: Session, text: str) -> tuple[AttendanceEmployee | None, dict | None]:
    """Exact emp code (case-insensitive) first, then name words, then a
    partial emp code. Returns (employee, None) or (None, response)."""
    text = (text or "").strip()
    if not text:
        return None, {"error": "Give an employee name or emp code."}

    emp = db.scalars(
        select(AttendanceEmployee).where(func.lower(AttendanceEmployee.emp_code) == text.lower())
    ).first()
    if emp is not None:
        return emp, None

    candidates = db.scalars(
        select(AttendanceEmployee).where(_name_condition(text)).order_by(AttendanceEmployee.name)
    ).all()
    if not candidates:
        candidates = db.scalars(
            select(AttendanceEmployee)
            .where(AttendanceEmployee.emp_code.ilike(contains(text), escape="\\"))
            .order_by(AttendanceEmployee.name)
        ).all()

    if len(candidates) == 1:
        return candidates[0], None
    if len(candidates) > 1:
        wanted = " ".join(text.lower().split())  # roster names can contain non-breaking spaces
        exact = [c for c in candidates if " ".join(c.name.lower().split()) == wanted]
        if len(exact) == 1:
            return exact[0], None
        return None, {
            "ambiguous": True,
            "query": text,
            "candidates": [_brief(c) for c in candidates[:FIND_LIMIT]],
            "total_candidates": len(candidates),
            "message": "Several employees match — ask the user which one they mean.",
        }
    return None, {
        "error": f"No employee matches '{text}'.",
        "suggestions": _similar_names(db, text),
    }


def build_attendance_tools(db: Session, today: date_type | None = None) -> list[BaseTool]:
    def current_day() -> date_type:
        return today or date_type.today()

    def attendance_overview() -> dict:
        totals = db.execute(
            select(func.count(), func.min(AttendanceDay.work_date), func.max(AttendanceDay.work_date)).select_from(
                AttendanceDay
            )
        ).one()
        employee_count = db.scalar(select(func.count()).select_from(AttendanceEmployee)) or 0

        groups: dict[tuple[str, str], dict] = {}

        def group(company, department) -> dict:
            key = (label(company), label(department))
            return groups.setdefault(key, {"employees": 0, "days_tracked": 0})

        for company, department, n in db.execute(
            select(AttendanceEmployee.company, AttendanceEmployee.department, func.count()).group_by(
                AttendanceEmployee.company, AttendanceEmployee.department
            )
        ).all():
            group(company, department)["employees"] += n
        for company, department, n in db.execute(
            select(AttendanceEmployee.company, AttendanceEmployee.department, func.count(AttendanceDay.id))
            .join(AttendanceDay, AttendanceDay.emp_code == AttendanceEmployee.emp_code)
            .group_by(AttendanceEmployee.company, AttendanceEmployee.department)
        ).all():
            group(company, department)["days_tracked"] += n

        companies: dict[str, dict] = {}
        for (company, _), g in groups.items():
            c = companies.setdefault(company, {"company": company, "employees": 0, "days_tracked": 0})
            c["employees"] += g["employees"]
            c["days_tracked"] += g["days_tracked"]

        last_date = totals[2]
        latest_count = (
            db.scalar(select(func.count()).select_from(AttendanceDay).where(AttendanceDay.work_date == last_date))
            if last_date
            else 0
        )
        return {
            "today": current_day().isoformat(),
            "employees": employee_count,
            "days_tracked": totals[0],
            "first_tracked_date": _iso(totals[1]),
            "last_tracked_date": _iso(last_date),
            "present_on_last_tracked_date": latest_count,
            "companies": sorted(companies.values(), key=lambda c: c["company"]),
            "departments": [
                {"company": company, "department": department, **g}
                for (company, department), g in sorted(groups.items())
            ],
            "weekly_trend": attendance_analytics.attendance_trend(db, weeks=6),
            "note": "days_tracked counts employee-days with at least one punch. No worked hours are tracked.",
        }

    def find_employees(query: str | None = None, department: str | None = None) -> dict:
        query = (query or "").strip()
        department = (department or "").strip()
        stmt = (
            select(
                AttendanceEmployee.emp_code,
                AttendanceEmployee.name,
                AttendanceEmployee.company,
                AttendanceEmployee.department,
                func.count(AttendanceDay.id).label("days_tracked"),
                func.min(AttendanceDay.work_date).label("first_seen"),
                func.max(AttendanceDay.work_date).label("last_seen"),
            )
            .outerjoin(AttendanceDay, AttendanceDay.emp_code == AttendanceEmployee.emp_code)
            .group_by(
                AttendanceEmployee.emp_code,
                AttendanceEmployee.name,
                AttendanceEmployee.company,
                AttendanceEmployee.department,
            )
            .order_by(AttendanceEmployee.name)
        )
        if query:
            stmt = stmt.where(
                or_(_name_condition(query), AttendanceEmployee.emp_code.ilike(contains(query), escape="\\"))
            )
        if department:
            stmt = stmt.where(_department_condition(department))

        rows = db.execute(stmt).all()
        result: dict = {
            "total_matches": len(rows),
            "employees": [
                {
                    "emp_code": r.emp_code,
                    "name": r.name,
                    "company": label(r.company),
                    "department": label(r.department),
                    "days_tracked": r.days_tracked,
                    "first_seen": _iso(r.first_seen),
                    "last_seen": _iso(r.last_seen),
                }
                for r in rows[:FIND_LIMIT]
            ],
        }
        if len(rows) > FIND_LIMIT:
            result["note"] = f"Showing the first {FIND_LIMIT} of {len(rows)} matches (by name); narrow the search."
        if not rows and query:
            result["suggestions"] = _similar_names(db, query)
        return result

    def employee_attendance(employee: str, start_date: str | None = None, end_date: str | None = None) -> dict:
        today_ = current_day()
        try:
            start = parse_date_arg(start_date, today_)
            end = parse_date_arg(end_date, today_)
        except ValueError as exc:
            return {"error": str(exc)}

        emp, problem = _resolve_employee(db, employee)
        if problem is not None:
            return problem

        explicit = start is not None or end is not None
        end = end or today_
        start = start or end - timedelta(days=DEFAULT_RANGE_DAYS - 1)
        if start > end:
            return {"error": f"start_date {start.isoformat()} is after end_date {end.isoformat()}."}

        all_time = db.execute(
            select(func.count(), func.min(AttendanceDay.work_date), func.max(AttendanceDay.work_date)).where(
                AttendanceDay.emp_code == emp.emp_code
            )
        ).one()

        rows = db.scalars(
            select(AttendanceDay)
            .where(
                AttendanceDay.emp_code == emp.emp_code,
                AttendanceDay.work_date >= start,
                AttendanceDay.work_date <= end,
            )
            .order_by(AttendanceDay.work_date.desc())
        ).all()

        note = None
        range_start, range_end = start, end
        if not rows and not explicit:
            rows = db.scalars(
                select(AttendanceDay)
                .where(AttendanceDay.emp_code == emp.emp_code)
                .order_by(AttendanceDay.work_date.desc())
                .limit(DEFAULT_RANGE_DAYS)
            ).all()
            if rows:
                range_start, range_end = rows[-1].work_date, rows[0].work_date
                note = (
                    f"No attendance recorded in the {DEFAULT_RANGE_DAYS} days ending {today_.isoformat()}; "
                    f"showing the {len(rows)} most recent tracked days instead."
                )
            else:
                note = "No attendance days are recorded for this employee."
        elif not rows:
            note = f"No punches recorded for {emp.name} between {start.isoformat()} and {end.isoformat()}."

        days = [
            [
                r.work_date.isoformat(),
                r.work_date.strftime("%a"),
                _hhmm(r.first_punch),
                _hhmm(r.last_punch),
                r.punch_count,
            ]
            for r in rows[:DAY_ROWS_LIMIT]
        ]
        result = {
            "employee": {
                **_brief(emp),
                "days_tracked_all_time": all_time[0],
                "first_seen": _iso(all_time[1]),
                "last_seen": _iso(all_time[2]),
            },
            "summary": {
                "days_present": len(rows),
                "range_start": range_start.isoformat(),
                "range_end": range_end.isoformat(),
                "calendar_days_in_range": (range_end - range_start).days + 1,
                "single_punch_days": sum(1 for r in rows if r.punch_count == 1),
                "median_first_punch": _median_hhmm([r.first_punch for r in rows]),
                "median_last_punch": _median_hhmm([r.last_punch for r in rows]),
            },
            # The agent may shrink "days" further to fit its budget; it then
            # updates truncated and days_shown to match.
            "truncated": len(days) < len(rows),
            "days_shown": len(days),
            **({"note": note} if note else {}),
            "day_columns": DAY_COLUMNS,
            "days": days,  # newest first
        }
        return result

    def attendance_on_date(date: str, department: str | None = None) -> dict:  # noqa: A002 - tool arg name
        today_ = current_day()
        try:
            day = parse_date_arg(date, today_)
        except ValueError as exc:
            return {"error": str(exc)}
        if day is None:
            return {"error": "Give a date: YYYY-MM-DD or DD-MM-YYYY."}
        department = (department or "").strip()

        present_stmt = (
            select(
                AttendanceDay.emp_code,
                AttendanceDay.first_punch,
                AttendanceDay.last_punch,
                AttendanceDay.punch_count,
                AttendanceEmployee.name,
                AttendanceEmployee.department,
            )
            .join(AttendanceEmployee, AttendanceEmployee.emp_code == AttendanceDay.emp_code)
            .where(AttendanceDay.work_date == day)
            .order_by(AttendanceEmployee.name)
        )
        roster_stmt = (
            select(
                AttendanceEmployee.emp_code,
                AttendanceEmployee.name,
                AttendanceEmployee.department,
                func.min(AttendanceDay.work_date).label("first_seen"),
            )
            .outerjoin(AttendanceDay, AttendanceDay.emp_code == AttendanceEmployee.emp_code)
            .group_by(AttendanceEmployee.emp_code, AttendanceEmployee.name, AttendanceEmployee.department)
            .order_by(AttendanceEmployee.name)
        )
        if department:
            present_stmt = present_stmt.where(_department_condition(department))
            roster_stmt = roster_stmt.where(_department_condition(department))

        present = db.execute(present_stmt).all()
        present_codes = {r.emp_code for r in present}
        # Someone whose first tracked day is after this date wasn't in the data yet.
        no_record = [
            r
            for r in db.execute(roster_stmt).all()
            if r.emp_code not in present_codes and r.first_seen is not None and r.first_seen <= day
        ]

        data_note = None
        if not present:
            anyone = db.scalar(select(func.count()).select_from(AttendanceDay).where(AttendanceDay.work_date == day))
            if not anyone:
                last = db.scalar(select(func.max(AttendanceDay.work_date)))
                data_note = (
                    "Nobody at all has a punch recorded on this date — the data may not be imported yet, "
                    f"or it was a weekend/holiday. Latest tracked date: {_iso(last) or 'none'}."
                )

        present_rows = [
            [r.name, r.emp_code, label(r.department), _hhmm(r.first_punch), _hhmm(r.last_punch), r.punch_count]
            for r in present[:ON_DATE_LIST_LIMIT]
        ]
        no_record_rows = [[r.name, r.emp_code, label(r.department)] for r in no_record[:ON_DATE_LIST_LIMIT]]

        result: dict = {
            "date": day.isoformat(),
            "weekday": day.strftime("%A"),
            "present_count": len(present),
            "no_record_count": len(no_record),
            "note": NO_RECORD_NOTE,
            "no_record_excludes": "employees whose first tracked day is after this date",
        }
        if data_note:
            result["data_note"] = data_note
        if department:
            result["department_filter"] = department
        # The agent may shrink the lists further to fit its budget; it then
        # updates truncated and the *_shown counts to match.
        result["truncated"] = len(present_rows) < len(present) or len(no_record_rows) < len(no_record)
        result["no_record_shown"] = len(no_record_rows)
        result["present_shown"] = len(present_rows)
        # no_record first: it is usually the short list, and the one that
        # answers "who didn't punch in".
        result["no_record_columns"] = NO_RECORD_COLUMNS
        result["no_record"] = no_record_rows
        result["present_columns"] = PRESENT_COLUMNS
        result["present"] = present_rows
        return result

    def rank_employees(
        metric: str,
        start_date: str | None = None,
        end_date: str | None = None,
        department: str | None = None,
        limit: str | None = None,
    ) -> dict:
        if metric not in RANK_METRICS:
            return {"error": f"Unknown metric '{metric}'. Use one of: {', '.join(RANK_METRICS)}."}
        rng = _resolve_range(db, start_date, end_date, current_day())
        if isinstance(rng, dict):
            return rng
        start, end, note = rng
        department = (department or "").strip()
        n = _parse_limit(limit)

        stmt = (
            select(
                AttendanceDay.emp_code,
                AttendanceDay.first_punch,
                AttendanceDay.last_punch,
                AttendanceDay.punch_count,
                AttendanceEmployee.name,
                AttendanceEmployee.department,
            )
            .join(AttendanceEmployee, AttendanceEmployee.emp_code == AttendanceDay.emp_code)
            .where(AttendanceDay.work_date >= start, AttendanceDay.work_date <= end)
        )
        if department:
            stmt = stmt.where(_department_condition(department))

        def blank(name, dept) -> dict:
            return {"name": name, "department": label(dept), "days": 0, "single": 0, "first": [], "last": []}

        people: dict[str, dict] = {}
        for r in db.execute(stmt).all():
            p = people.setdefault(r.emp_code, blank(r.name, r.department))
            p["days"] += 1
            p["single"] += 1 if r.punch_count == 1 else 0
            first, last = _minutes(r.first_punch), _minutes(r.last_punch)
            if first is not None:
                p["first"].append(first)
            if last is not None:
                p["last"].append(last)

        if metric == "fewest_days_present":
            # People with no punch at all in the range rank lowest, but only
            # those already in the data by then (first tracked day <= end).
            roster = (
                select(
                    AttendanceEmployee.emp_code,
                    AttendanceEmployee.name,
                    AttendanceEmployee.department,
                    func.min(AttendanceDay.work_date).label("first_seen"),
                )
                .join(AttendanceDay, AttendanceDay.emp_code == AttendanceEmployee.emp_code)
                .group_by(AttendanceEmployee.emp_code, AttendanceEmployee.name, AttendanceEmployee.department)
            )
            if department:
                roster = roster.where(_department_condition(department))
            for r in db.execute(roster).all():
                if r.emp_code not in people and r.first_seen <= end:
                    people[r.emp_code] = blank(r.name, r.department)

        if metric.endswith("_punch") and metric != "most_single_punch_days":
            key = "first" if "first_punch" in metric else "last"
            latest = metric.startswith("latest")
            scored = [(statistics.median_low(sorted(p[key])), code, p) for code, p in people.items() if p[key]]
            scored.sort(key=lambda t: ((-t[0] if latest else t[0]), t[2]["name"]))
            ranked = [(_hhmm_from_minutes(v), code, p) for v, code, p in scored]
            value_note = f"value = median {key} punch time (HH:MM) over the employee's tracked days in the range"
        elif metric in ("most_days_present", "fewest_days_present"):
            sign = -1 if metric == "most_days_present" else 1
            ranked = [(p["days"], code, p) for code, p in people.items()]
            ranked.sort(key=lambda t: (sign * t[0], t[2]["name"]))
            value_note = "value = days with at least one punch in the range"
        else:  # most_single_punch_days
            ranked = [(p["single"], code, p) for code, p in people.items() if p["single"]]
            ranked.sort(key=lambda t: (-t[0], t[2]["name"]))
            value_note = "value = days with exactly one punch in the range"

        rows = [[i + 1, p["name"], code, p["department"], value, p["days"]] for i, (value, code, p) in enumerate(ranked[:n])]
        result: dict = {
            "metric": metric,
            "range_start": start.isoformat(),
            "range_end": end.isoformat(),
            "employees_ranked": len(ranked),
            "shown": len(rows),
            "value": value_note,
        }
        if department:
            result["department_filter"] = department
        notes = [x for x in (note, None if ranked else "Nobody in the range qualifies for this metric.") if x]
        if notes:
            result["note"] = " ".join(notes)
        result["ranking_columns"] = RANK_COLUMNS
        result["ranking"] = rows
        return result

    def single_punch_days(
        start_date: str | None = None,
        end_date: str | None = None,
        department: str | None = None,
        employee: str | None = None,
    ) -> dict:
        rng = _resolve_range(db, start_date, end_date, current_day())
        if isinstance(rng, dict):
            return rng
        start, end, note = rng
        department = (department or "").strip()

        stmt = (
            select(
                AttendanceDay.work_date,
                AttendanceDay.first_punch,
                AttendanceDay.emp_code,
                AttendanceEmployee.name,
                AttendanceEmployee.department,
            )
            .join(AttendanceEmployee, AttendanceEmployee.emp_code == AttendanceDay.emp_code)
            .where(
                AttendanceDay.punch_count == 1,
                AttendanceDay.work_date >= start,
                AttendanceDay.work_date <= end,
            )
            .order_by(AttendanceDay.work_date.desc(), AttendanceEmployee.name)
        )
        if department:
            stmt = stmt.where(_department_condition(department))
        emp = None
        if (employee or "").strip():
            emp, problem = _resolve_employee(db, employee)
            if problem is not None:
                return problem
            stmt = stmt.where(AttendanceDay.emp_code == emp.emp_code)

        found = db.execute(stmt).all()
        per_employee: dict[str, list] = {}
        for r in found:
            entry = per_employee.setdefault(r.emp_code, [r.name, r.emp_code, label(r.department), 0])
            entry[3] += 1
        per_employee_rows = sorted(per_employee.values(), key=lambda e: (-e[3], e[0]))

        rows = [
            [r.work_date.isoformat(), r.work_date.strftime("%a"), r.name, r.emp_code, label(r.department), _hhmm(r.first_punch)]
            for r in found[:SINGLE_PUNCH_ROWS_LIMIT]
        ]
        result: dict = {
            "range_start": start.isoformat(),
            "range_end": end.isoformat(),
            "single_punch_days_total": len(found),
            "employees_affected": len(per_employee_rows),
            "meaning": "Exactly one punch was recorded that day (for example a missed entry or exit punch). "
            "The device's Entry/Exit field is not interpreted.",
        }
        if department:
            result["department_filter"] = department
        if emp is not None:
            result["employee"] = _brief(emp)
        if note:
            result["note"] = note
        # The agent may shrink the lists further to fit its budget; it then
        # updates truncated and the *_shown counts to match.
        result["truncated"] = len(rows) < len(found) or len(per_employee_rows) > SINGLE_PUNCH_PER_EMPLOYEE_LIMIT
        result["per_employee_shown"] = min(len(per_employee_rows), SINGLE_PUNCH_PER_EMPLOYEE_LIMIT)
        result["days_shown"] = len(rows)
        # Per-employee counts first: they stay complete even when the day list is cut.
        result["per_employee_columns"] = PER_EMPLOYEE_COLUMNS
        result["per_employee"] = per_employee_rows[:SINGLE_PUNCH_PER_EMPLOYEE_LIMIT]
        result["day_columns"] = SINGLE_PUNCH_COLUMNS
        result["days"] = rows  # newest first
        return result

    def search_attendance_records(query: str) -> dict:
        query = (query or "").strip()
        if not query:
            return {"error": "Give a search query."}
        try:
            hits = attendance_index.search(db, query, k=SEARCH_K)
        except Exception as exc:  # EmbeddingsNotConfigured, HF HTTP errors, bad vectors, ...
            if isinstance(exc, SQLAlchemyError):
                db.rollback()
            reason = describe_error(exc).rstrip(".")
            return {"error": f"Semantic search is unavailable: {reason}. Use the other attendance tools instead."}

        results = []
        for doc, score in hits:
            item = {"text": doc.page_content, "type": doc.metadata.get("type"), "score": round(float(score), 3)}
            for key in ("emp_code", "work_date"):
                if doc.metadata.get(key):
                    item[key] = doc.metadata[key]
            results.append(item)
        return {
            "results": results,
            "note": "Closest matches by meaning, not a complete list — use the structured tools for exact counts.",
        }

    return [
        make_tool(
            db,
            "attendance_overview",
            "Overall biometric attendance picture: number of employees and tracked attendance days, the first and "
            "last tracked dates (and how many people had a punch on the last one), employees and days tracked per "
            "company and per department, and the weekly trend for the last 6 weeks. Use for general questions "
            "('how is attendance overall', 'which departments are there', 'what period does the data cover').",
            _NoArgs,
            attendance_overview,
        ),
        make_tool(
            db,
            "find_employees",
            "Look up employees in the attendance roster by (part of) their name or emp code, optionally within a "
            "department. Returns up to 25 matches with emp code, company, department, total days tracked and "
            "first/last tracked date. Use to find out who someone is, list the people in a department, or check "
            "a name exists before other calls.",
            _FindEmployeesArgs,
            find_employees,
        ),
        make_tool(
            db,
            "employee_attendance",
            "One employee's day-by-day attendance: each date they had punches with first punch time, last punch "
            "time and punch count, plus a summary (days present, single-punch days, median first/last punch). Use "
            "for any question about a specific person ('when did X come in last week', 'how many days was X "
            "present in September'). Defaults to the 30 days ending today.",
            _EmployeeAttendanceArgs,
            employee_attendance,
        ),
        make_tool(
            db,
            "attendance_on_date",
            "Who had attendance on one date: everyone with at least one punch (with first/last punch time) and "
            "everyone on the roster with no punch recorded that day, with counts. Optional department filter. Use "
            "for 'who came in on <date>', 'who didn't punch in yesterday', 'how many people were in on <date>'.",
            _AttendanceOnDateArgs,
            attendance_on_date,
        ),
        make_tool(
            db,
            "rank_employees",
            "Rank employees across the whole roster (or one department) over a date range: who arrives earliest "
            "or latest (median first punch), who leaves earliest or latest (median last punch), most or fewest "
            "days present, most single-punch days. Use for any 'who ... the most / earliest / latest / fewest' "
            "question instead of searching.",
            _RankArgs,
            rank_employees,
        ),
        make_tool(
            db,
            "single_punch_days",
            "Every day in a date range on which an employee had exactly one punch (a likely missed punch), with "
            "the punch time, plus a complete count per employee. Optional department or employee filter. Use for "
            "'who had only one punch', 'missed punches last week', 'did X miss a punch this month'.",
            _SinglePunchArgs,
            single_punch_days,
        ),
        make_tool(
            db,
            "search_attendance_records",
            "Semantic (meaning-based) search over attendance records: employee profiles, per-day records from "
            "recent months, department summaries and per-date summaries. Returns the 8 closest matches. Only for "
            "fuzzy or descriptive questions no other tool can express. Not for rankings or 'who ... most' "
            "questions (use rank_employees) or single punches (use single_punch_days). Results are the closest "
            "matches, not complete lists — never count from them.",
            _SearchArgs,
            search_attendance_records,
        ),
    ]
