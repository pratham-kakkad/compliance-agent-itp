"""Turns attendance tables into short natural-language Documents for the
semantic search index (app/chat/attendance_index.py).

Four document types, each with a stable id and metadata["type"]:
- "employee"   — one per AttendanceEmployee: profile + all-time presence stats
- "day"        — one per AttendanceDay in the last `index_days` days
- "department" — one per (company, department)
- "date"       — one per tracked date in the window: who had a punch that day

Texts stay short (well under ~500 characters) and carry both ISO and
DD-MM-YYYY dates, since that's how the punch-log exports write them. Punches
are stored in UTC; every time here is converted to the organization time
zone (app/org_settings/service.py), the same zone the days are dated in.
Plain presence only: no hours.
"""
import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, tzinfo

from langchain_core.documents import Document
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.attendance.models import AttendanceDay, AttendanceEmployee, ImportBatch
from app.org_settings.service import get_timezone, get_timezone_name, to_local

UNASSIGNED = "Unassigned"
MAX_NAMES = 40
# Name lists stop early (before MAX_NAMES) rather than push a text far past
# ~500 characters — long lists belong to the exact tools, not to search.
_NAME_LIST_BUDGET = 330


def label(value: str | None) -> str:
    value = (value or "").strip()
    return value or UNASSIGNED


def long_date(d: date) -> str:
    """Friday 25 September 2026 (2026-09-25, 25-09-2026)"""
    return f"{d:%A} {d.day} {d:%B %Y} ({d.isoformat()}, {d:%d-%m-%Y})"


def hhmm(value: datetime | time | None, tz: tzinfo | None = None) -> str:
    """HH:MM of a time of day, or of a stored (UTC) punch in `tz`."""
    if value is None:
        return "unknown"
    if isinstance(value, datetime) and tz is not None:
        value = to_local(value, tz)
    return value.strftime("%H:%M")


def short_date(d: date) -> str:
    """25 Sep 2026 (2026-09-25, 25-09-2026)"""
    return f"{d.day} {d:%b %Y} ({d.isoformat()}, {d:%d-%m-%Y})"


def plural(n: int, word: str) -> str:
    if n == 1:
        return f"1 {word}"
    return f"{n} {word}{'es' if word.endswith(('ch', 'sh', 's', 'x')) else 's'}"


def name_list(names: list[str], limit: int = MAX_NAMES, budget: int = _NAME_LIST_BUDGET) -> str:
    shown: list[str] = []
    used = 0
    for name in names:
        if len(shown) >= limit or (shown and used + len(name) + 2 > budget):
            break
        shown.append(name)
        used += len(name) + 2
    text = ", ".join(shown)
    rest = len(names) - len(shown)
    return f"{text}, and {rest} more" if rest else text


@dataclass
class _EmployeeStats:
    days: int = 0
    first: date | None = None
    last: date | None = None
    single_punch_days: int = 0
    median_first: time | None = None
    median_last: time | None = None


def _employee_stats(db: Session, tz: tzinfo) -> dict[str, _EmployeeStats]:
    """All-time per-employee aggregates from one query. Medians are the
    lower median of each punch's time of day in the organization zone
    (what percentile_disc(0.5) gives), computed here rather than in SQL so
    the zone conversion is Python's zoneinfo, whatever zone data the
    database server has."""
    rows = db.execute(
        select(
            AttendanceDay.emp_code,
            AttendanceDay.work_date,
            AttendanceDay.punch_count,
            AttendanceDay.first_punch,
            AttendanceDay.last_punch,
        )
    )
    stats: dict[str, _EmployeeStats] = {}
    firsts: dict[str, list[time]] = defaultdict(list)
    lasts: dict[str, list[time]] = defaultdict(list)
    for r in rows:
        s = stats.get(r.emp_code)
        if s is None:
            s = stats[r.emp_code] = _EmployeeStats(first=r.work_date, last=r.work_date)
        s.days += 1
        s.first = min(s.first, r.work_date)
        s.last = max(s.last, r.work_date)
        s.single_punch_days += 1 if r.punch_count == 1 else 0
        if r.first_punch is not None:
            firsts[r.emp_code].append(to_local(r.first_punch, tz).time())
        if r.last_punch is not None:
            lasts[r.emp_code].append(to_local(r.last_punch, tz).time())
    for code, s in stats.items():
        s.median_first = statistics.median_low(firsts[code]) if firsts[code] else None
        s.median_last = statistics.median_low(lasts[code]) if lasts[code] else None
    return stats


def _employee_doc(emp: AttendanceEmployee, stats: _EmployeeStats | None) -> Document:
    company, department = label(emp.company), label(emp.department)
    text = f"Employee profile: {emp.name} (emp code {emp.emp_code}), company {company}, department {department}. "
    if stats is None or stats.days == 0:
        text += "No attendance days recorded yet."
    else:
        text += (
            f"Attendance tracked on {plural(stats.days, 'day')} in total, "
            f"from {long_date(stats.first)} to {long_date(stats.last)}. "
            f"Typical (median) first punch {hhmm(stats.median_first)}, "
            f"typical last punch {hhmm(stats.median_last)}. "
            f"{plural(stats.single_punch_days, 'single-punch day')} (only one punch recorded)."
        )
    return Document(
        id=f"employee:{emp.emp_code}",
        page_content=text,
        metadata={
            "type": "employee",
            "emp_code": emp.emp_code,
            "name": emp.name,
            "company": company,
            "department": department,
        },
    )


def _day_doc(row, tz: tzinfo) -> Document:
    company, department = label(row.company), label(row.department)
    iso = row.work_date.isoformat()
    text = (
        f"{row.name} ({row.emp_code}, {company}, {department}) was present on {long_date(row.work_date)}: "
        f"first punch {hhmm(row.first_punch, tz)}, last punch {hhmm(row.last_punch, tz)}, "
        f"{plural(row.punch_count or 0, 'punch')}."
    )
    return Document(
        id=f"day:{row.emp_code}:{iso}",
        page_content=text,
        metadata={
            "type": "day",
            "emp_code": row.emp_code,
            "name": row.name,
            "company": company,
            "department": department,
            "work_date": iso,
        },
    )


def build_attendance_documents(
    db: Session, today: date, index_days: int, tz: tzinfo | None = None
) -> list[Document]:
    """Three queries in total: roster, per-employee aggregates, window days.
    Times are shown in `tz` (default: the organization zone)."""
    tz = tz or get_timezone(db)
    employees = db.execute(select(AttendanceEmployee).order_by(AttendanceEmployee.name)).scalars().all()
    stats = _employee_stats(db, tz)

    since = today - timedelta(days=max(0, index_days))
    window_rows = db.execute(
        select(
            AttendanceDay.emp_code,
            AttendanceDay.work_date,
            AttendanceDay.first_punch,
            AttendanceDay.last_punch,
            AttendanceDay.punch_count,
            AttendanceEmployee.name,
            AttendanceEmployee.company,
            AttendanceEmployee.department,
        )
        .join(AttendanceEmployee, AttendanceEmployee.emp_code == AttendanceDay.emp_code)
        .where(AttendanceDay.work_date >= since)
        .order_by(AttendanceDay.work_date, AttendanceEmployee.name)
    ).all()

    docs: list[Document] = [_employee_doc(emp, stats.get(emp.emp_code)) for emp in employees]
    docs.extend(_day_doc(row, tz) for row in window_rows)

    # Department docs, from the roster + all-time stats already loaded.
    departments: dict[tuple[str, str], list[AttendanceEmployee]] = defaultdict(list)
    for emp in employees:
        departments[(label(emp.company), label(emp.department))].append(emp)
    for (company, department), members in sorted(departments.items()):
        member_stats = [stats[e.emp_code] for e in members if e.emp_code in stats]
        days = sum(s.days for s in member_stats)
        text = (
            f"Department {department} at {company}: {plural(len(members), 'employee')} — "
            f"{name_list([e.name for e in members])}. "
        )
        if days:
            first = min(s.first for s in member_stats)
            last = max(s.last for s in member_stats)
            text += (
                f"{plural(days, 'attendance day')} tracked in total, "
                f"from {short_date(first)} to {short_date(last)}."
            )
        else:
            text += "No attendance days recorded yet."
        docs.append(
            Document(
                id=f"department:{company}|{department}",
                page_content=text,
                metadata={"type": "department", "company": company, "department": department},
            )
        )

    # Date docs: who had at least one punch on each tracked date in the window.
    by_date: dict[date, list] = defaultdict(list)
    for row in window_rows:
        by_date[row.work_date].append(row)
    for work_date, rows in sorted(by_date.items()):
        iso = work_date.isoformat()
        text = (
            f"Attendance on {long_date(work_date)}: {plural(len(rows), 'employee')} had at least one punch — "
            f"{name_list([r.name for r in rows])}."
        )
        docs.append(
            Document(
                id=f"date:{iso}",
                page_content=text,
                metadata={"type": "date", "work_date": iso, "present_count": len(rows)},
            )
        )

    return docs


def attendance_fingerprint(db: Session) -> tuple:
    """Cheap aggregates that change whenever an import (or any edit) changes
    what build_attendance_documents would produce — including the
    organization time zone, which every time in the texts is shown in. One
    round trip plus the (identity-mapped) zone setting."""
    row = db.execute(
        select(
            select(func.count()).select_from(AttendanceEmployee).scalar_subquery(),
            select(func.max(AttendanceEmployee.updated_at)).scalar_subquery(),
            select(func.count()).select_from(AttendanceDay).scalar_subquery(),
            select(func.max(AttendanceDay.work_date)).scalar_subquery(),
            select(func.coalesce(func.sum(AttendanceDay.punch_count), 0)).scalar_subquery(),
            select(func.max(AttendanceDay.last_punch)).scalar_subquery(),
            select(func.count()).select_from(ImportBatch).scalar_subquery(),
            select(func.max(ImportBatch.imported_at)).scalar_subquery(),
        )
    ).one()
    return (*tuple(row), get_timezone_name(db))
