"""Read-side queries for the Attendance agent. Plain presence tracking:
an AttendanceDay row means "this employee had activity that day" — there's
no hours/duration compliance rate here, just counts of tracked days.
"""
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.attendance.models import AttendanceDay, AttendanceEmployee
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


def employee_list(
    db: Session,
    company: str | None = None,
    department: str | None = None,
    search: str | None = None,
) -> list[dict]:
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
    if company:
        query = query.where(AttendanceEmployee.company == company)
    if department:
        query = query.where(AttendanceEmployee.department == department)
    if search:
        query = query.where(AttendanceEmployee.name.ilike(f"%{search}%"))

    rows = db.execute(query).all()
    return [
        {
            "emp_code": row.emp_code,
            "name": row.name,
            "company": row.company,
            "department": row.department,
            "days_tracked": row.days_tracked,
            "last_seen": row.last_seen.isoformat() if row.last_seen else None,
        }
        for row in rows
    ]


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
