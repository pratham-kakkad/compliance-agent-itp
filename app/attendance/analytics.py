"""Read-side queries for the Attendance agent. Plain presence tracking:
an AttendanceDay row means "this employee had activity that day" — there's
no hours/duration compliance rate here, just counts of tracked days.
"""
from datetime import date, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.attendance.models import AttendanceDay, AttendanceEmployee, ImportBatch
from app.org_settings.service import org_today


def overall_summary(db: Session) -> dict:
    total_days = db.scalar(select(func.count()).select_from(AttendanceDay)) or 0
    employee_count = db.scalar(select(func.count()).select_from(AttendanceEmployee)) or 0
    return {
        "total_days_tracked": total_days,
        "employee_count": employee_count,
    }


def attendance_trend(db: Session, weeks: int = 6) -> list[dict]:
    week = func.date_trunc("week", AttendanceDay.work_date).label("week")
    rows = db.execute(
        select(week, func.count().label("days_tracked"))
        .group_by(week)
        .order_by(week)
    ).all()
    trend = [
        {"week_start": row.week.date().isoformat(), "days_tracked": row.days_tracked}
        for row in rows
    ]
    return trend[-weeks:]


def department_breakdown(db: Session) -> list[dict]:
    rows = db.execute(
        select(
            AttendanceEmployee.department,
            func.count(AttendanceDay.id).label("days_tracked"),
        )
        .join(AttendanceDay, AttendanceDay.emp_code == AttendanceEmployee.emp_code)
        .group_by(AttendanceEmployee.department)
        .order_by(AttendanceEmployee.department)
    ).all()
    return [
        {"department": row.department or "Unassigned", "days_tracked": row.days_tracked}
        for row in rows
    ]


def _as_list(value: "str | list[str] | None") -> list[str]:
    """One value or a list of them (repeated query params, or a comma-separated string) -> clean list."""
    if value is None:
        return []
    items = [value] if isinstance(value, str) else list(value)
    return [p.strip() for item in items for p in str(item).split(",") if p.strip()]


EMPLOYEE_SORTS = ("name", "company", "department", "days", "last_seen", "rate")


def employee_list(
    db: Session,
    company: "str | list[str] | None" = None,
    department: "str | list[str] | None" = None,
    search: str | None = None,
    *,
    days_min: int | None = None,
    days_max: int | None = None,
    last_seen_from: date | None = None,
    last_seen_to: date | None = None,
    not_seen_days: int | None = None,
    present_latest: bool | None = None,
    rate_min: float | None = None,
    rate_max: float | None = None,
    sort: str | None = None,
    direction: str = "asc",
) -> list[dict]:
    """The employee roster with filters, all ANDed (every one optional):

    - company / department: any of the given values (repeat the param or comma-separate),
    - search: name or employee code contains the text,
    - days_min / days_max: tracked days, inclusive,
    - last_seen_from / last_seen_to: last day with punches, inclusive (never seen = no match),
    - not_seen_days: not seen in the last N days of data, or never (same rule as the dashboard's "quiet" list),
    - present_latest: present (true) / not present (false) on the latest working day,
    - rate_min / rate_max: presence rate, 0..1, share of working days present in the last 30 working days,
    - sort: one of EMPLOYEE_SORTS (+ direction asc|desc, missing values last); default is by name.

    Each item also carries `rate` (0..1 or null) and `present_latest`.
    """
    companies = _as_list(company)
    departments = _as_list(department)
    query = (
        select(
            AttendanceEmployee.emp_code,
            AttendanceEmployee.name,
            AttendanceEmployee.company,
            AttendanceEmployee.department,
            func.count(AttendanceDay.id).label("days_tracked"),
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
    def _in_or_unassigned(column, values):
        # "Unassigned" is how the dashboard names a missing company/department.
        named = [v for v in values if v != "Unassigned"]
        cond = []
        if named:
            cond.append(column.in_(named))
        if len(named) != len(values):
            cond.append(column.is_(None))
        return or_(*cond)

    if companies:
        query = query.where(_in_or_unassigned(AttendanceEmployee.company, companies))
    if departments:
        query = query.where(_in_or_unassigned(AttendanceEmployee.department, departments))
    if search and search.strip():
        like = f"%{search.strip()}%"
        query = query.where(or_(AttendanceEmployee.name.ilike(like), AttendanceEmployee.emp_code.ilike(like)))

    rows = db.execute(query).all()

    # Presence over the last 30 working days, and who was in on the latest one:
    # the same notion of "working day" as the dashboard (see _working_dates).
    daily = {d: n for d, n in db.execute(select(AttendanceDay.work_date, func.count()).group_by(AttendanceDay.work_date)).all()}
    working = _working_dates(daily)
    ref_day = max(working) if working else None
    latest = max(daily) if daily else None
    window = {d for d in working if ref_day - timedelta(days=29) <= d <= ref_day} if ref_day else set()
    present_days: dict[str, int] = {}
    in_latest: set[str] = set()
    if window:
        present_days = dict(
            db.execute(
                select(AttendanceDay.emp_code, func.count()).where(AttendanceDay.work_date.in_(window)).group_by(AttendanceDay.emp_code)
            ).all()
        )
        in_latest = set(db.scalars(select(AttendanceDay.emp_code).where(AttendanceDay.work_date == ref_day)))

    items = []
    for row in rows:
        rate = min(1.0, present_days.get(row.emp_code, 0) / len(window)) if window else None
        items.append(
            {
                "emp_code": row.emp_code,
                "name": row.name,
                "company": row.company,
                "department": row.department,
                "days_tracked": row.days_tracked,
                "last_seen": row.last_seen.isoformat() if row.last_seen else None,
                "rate": round(rate, 4) if rate is not None else None,
                "present_latest": row.emp_code in in_latest,
                "_seen": row.last_seen,
            }
        )

    def keep(item: dict) -> bool:
        seen = item["_seen"]
        if days_min is not None and item["days_tracked"] < days_min:
            return False
        if days_max is not None and item["days_tracked"] > days_max:
            return False
        if last_seen_from is not None and (seen is None or seen < last_seen_from):
            return False
        if last_seen_to is not None and (seen is None or seen > last_seen_to):
            return False
        if not_seen_days is not None and seen is not None and latest is not None and seen >= latest - timedelta(days=not_seen_days - 1):
            return False
        if present_latest is not None and item["present_latest"] != present_latest:
            return False
        if rate_min is not None and (item["rate"] is None or item["rate"] < rate_min):
            return False
        if rate_max is not None and (item["rate"] is None or item["rate"] > rate_max):
            return False
        return True

    items = [i for i in items if keep(i)]

    if sort:
        key = {
            "name": lambda i: i["name"].lower(),
            "company": lambda i: (i["company"] or "").lower() or None,
            "department": lambda i: (i["department"] or "").lower() or None,
            "days": lambda i: i["days_tracked"],
            "last_seen": lambda i: i["_seen"],
            "rate": lambda i: i["rate"],
        }[sort]
        reverse = direction == "desc"
        # Missing values sink to the bottom in either direction; ties keep name order.
        items.sort(key=lambda i: i["name"].lower())
        present = [i for i in items if key(i) is not None]
        missing = [i for i in items if key(i) is None]
        present.sort(key=key, reverse=reverse)
        items = present + missing
    for i in items:
        del i["_seen"]
    return items


def employee_detail(db: Session, emp_code: str, days: int = 60) -> dict | None:
    employee = db.get(AttendanceEmployee, emp_code)
    if employee is None:
        return None

    since = org_today(db) - timedelta(days=days)
    day_rows = db.execute(
        select(AttendanceDay)
        .where(AttendanceDay.emp_code == emp_code, AttendanceDay.work_date >= since)
        .order_by(AttendanceDay.work_date.desc())
    ).scalars().all()

    return {
        "emp_code": employee.emp_code,
        "name": employee.name,
        "company": employee.company,
        "department": employee.department,
        "total_days_tracked": len(day_rows),
        "days": [
            {
                "work_date": d.work_date.isoformat(),
                "first_punch": d.first_punch.isoformat() if d.first_punch else None,
                "last_punch": d.last_punch.isoformat() if d.last_punch else None,
                "punch_count": d.punch_count,
            }
            for d in day_rows
        ],
    }


def _working_dates(daily: dict, lookback: int = 60, share: float = 0.5) -> set:
    """Dates that were a normal working day. `daily` maps date -> people present.
    A date counts if its headcount is at least `share` of the median over the last
    `lookback` dates, so a Sunday with two people on call is not a "working day"
    that makes everyone else look absent."""
    if not daily:
        return set()
    recent = sorted(daily)[-lookback:]
    counts = sorted(daily[d] for d in recent)
    median = counts[len(counts) // 2]
    threshold = max(1, share * median)
    return {d for d, n in daily.items() if n >= threshold}


def insights(db: Session, quiet_days: int = 7, window_days: int = 30, weeks: int = 6, quiet_limit: int = 10) -> dict:
    """What an administrator wants from the attendance data, as presence only:

    - who was present on the latest working day, out of the roster,
    - who has not been seen for `quiet_days` (counted back from the latest day
      of data, not from today, so a stale import doesn't flag everyone),
    - the presence rate by department and by week: the share of the roster
      present on an average working day (see `_working_dates`),
    - how fresh the data is (latest day, last import).
    """
    headcount = db.scalar(select(func.count()).select_from(AttendanceEmployee)) or 0
    daily = {d: n for d, n in db.execute(select(AttendanceDay.work_date, func.count()).group_by(AttendanceDay.work_date)).all()}
    latest = max(daily) if daily else None
    working = _working_dates(daily)
    ref_day = max(working) if working else latest
    last_import = db.execute(
        select(ImportBatch.imported_at, ImportBatch.filename).order_by(ImportBatch.imported_at.desc()).limit(1)
    ).first()
    out = {
        "headcount": headcount,
        "latest_day": ref_day.isoformat() if ref_day else None,
        "latest_data_day": latest.isoformat() if latest else None,
        "present_latest": 0,
        "present_rate": None,
        "quiet_days": quiet_days,
        "quiet_count": 0,
        "quiet": [],
        "by_department": [],
        "weekly_presence": [],
        "window_days": window_days,
        "last_import_at": last_import.imported_at.isoformat() if last_import else None,
        "last_import_file": last_import.filename if last_import else None,
    }
    if latest is None or headcount == 0:
        return out

    present = daily.get(ref_day, 0)
    out["present_latest"] = present
    out["present_rate"] = min(1.0, present / headcount)

    # Not seen recently: no day on or after the cutoff (or never seen at all).
    cutoff = latest - timedelta(days=quiet_days - 1)
    last_seen = func.max(AttendanceDay.work_date)
    quiet_rows = db.execute(
        select(AttendanceEmployee.emp_code, AttendanceEmployee.name, AttendanceEmployee.department, last_seen.label("last_seen"))
        .outerjoin(AttendanceDay, AttendanceDay.emp_code == AttendanceEmployee.emp_code)
        .group_by(AttendanceEmployee.emp_code, AttendanceEmployee.name, AttendanceEmployee.department)
        .having(or_(last_seen.is_(None), last_seen < cutoff))
        .order_by(last_seen.asc().nullsfirst(), AttendanceEmployee.name)
    ).all()
    out["quiet_count"] = len(quiet_rows)
    out["quiet"] = [
        {
            "emp_code": r.emp_code,
            "name": r.name,
            "department": r.department,
            "last_seen": r.last_seen.isoformat() if r.last_seen else None,
            "days_quiet": (latest - r.last_seen).days if r.last_seen else None,
        }
        for r in quiet_rows[:quiet_limit]
    ]

    # Presence by department over the recent window, on working days only.
    since = ref_day - timedelta(days=window_days - 1)
    window_days_set = {d for d in working if since <= d <= ref_day}
    if window_days_set:
        heads = dict(
            db.execute(select(AttendanceEmployee.department, func.count()).group_by(AttendanceEmployee.department)).all()
        )
        rows = dict(
            db.execute(
                select(AttendanceEmployee.department, func.count(AttendanceDay.id))
                .join(AttendanceDay, AttendanceDay.emp_code == AttendanceEmployee.emp_code)
                .where(AttendanceDay.work_date.in_(window_days_set))
                .group_by(AttendanceEmployee.department)
            ).all()
        )
        depts = [
            {
                "department": dept or "Unassigned",
                "headcount": n,
                "rate": min(1.0, rows.get(dept, 0) / (n * len(window_days_set))),
            }
            for dept, n in heads.items()
        ]
        out["by_department"] = sorted(depts, key=lambda d: (d["rate"], d["department"]))

    # Weekly presence rate: people-days on working days / (roster x working days that week).
    per_week: dict = {}
    for d in working:
        wk = d - timedelta(days=d.weekday())
        w = per_week.setdefault(wk, [0, 0])
        w[0] += daily[d]
        w[1] += 1
    out["weekly_presence"] = [
        {"week_start": wk.isoformat(), "rate": min(1.0, w[0] / (headcount * w[1]))} for wk, w in sorted(per_week.items())
    ][-weeks:]
    return out
