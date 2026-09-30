"""Read-side queries shared by the dashboard, meetings, team and org-chart
endpoints, and by the chat agent's tools. Kept in one place so "what counts
as a compliance problem" (required + not attended; optional absences never
count) is defined exactly once.
"""
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models import Attendance, MeetingOccurrence, MeetingSeries, OrgUser
from app.org_settings.service import get_timezone_name


def _rate(attended: int, total: int) -> float | None:
    return round(attended / total, 4) if total else None


def person_attendance_summary(db: Session, email: str) -> dict:
    required = db.execute(
        select(
            func.count().label("total"),
            func.sum(case((Attendance.attended.is_(True), 1), else_=0)).label("attended"),
        )
        .where(Attendance.attendee_email == email, Attendance.required.is_(True))
    ).one()

    by_series = db.execute(
        select(
            MeetingSeries.id,
            MeetingSeries.title,
            func.count().label("total"),
            func.sum(case((Attendance.attended.is_(True), 1), else_=0)).label("attended"),
        )
        .join(MeetingOccurrence, MeetingOccurrence.id == Attendance.occurrence_id)
        .join(MeetingSeries, MeetingSeries.id == MeetingOccurrence.series_id)
        .where(Attendance.attendee_email == email, Attendance.required.is_(True))
        .group_by(MeetingSeries.id, MeetingSeries.title)
        .order_by(func.count().desc())
    ).all()

    return {
        "email": email,
        "required_total": required.total or 0,
        "required_attended": required.attended or 0,
        "attendance_rate": _rate(required.attended or 0, required.total or 0),
        "series": [
            {
                "series_id": str(row.id),
                "title": row.title,
                "total": row.total,
                "attended": row.attended,
                "attendance_rate": _rate(row.attended, row.total),
            }
            for row in by_series
        ],
    }


def top_concern_series(db: Session, emails: list[str] | None = None, limit: int = 5) -> list[dict]:
    """Series with the worst required-attendance rate, optionally scoped to
    a set of attendee emails (e.g. "me + my reports"). Optional-attendee
    rows never enter this query at all."""
    query = (
        select(
            MeetingSeries.id,
            MeetingSeries.title,
            MeetingSeries.organizer_email,
            MeetingSeries.recurrence,
            func.count().label("total"),
            func.sum(case((Attendance.attended.is_(True), 1), else_=0)).label("attended"),
        )
        .join(MeetingOccurrence, MeetingOccurrence.id == Attendance.occurrence_id)
        .join(MeetingSeries, MeetingSeries.id == MeetingOccurrence.series_id)
        .where(Attendance.required.is_(True))
        .group_by(MeetingSeries.id, MeetingSeries.title, MeetingSeries.organizer_email, MeetingSeries.recurrence)
    )
    if emails is not None:
        query = query.where(Attendance.attendee_email.in_(emails))

    rows = db.execute(query).all()
    scored = [
        {
            "series_id": str(row.id),
            "title": row.title,
            "organizer_email": row.organizer_email,
            "recurrence": row.recurrence,
            "total": row.total,
            "attended": row.attended,
            "missed": row.total - row.attended,
            "attendance_rate": _rate(row.attended, row.total),
        }
        for row in rows
        if row.attended < row.total
    ]
    scored.sort(key=lambda s: (s["attendance_rate"], -s["missed"]))
    return scored[:limit]


def top_members_to_focus(db: Session, emails: list[str] | None = None, limit: int = 5) -> list[dict]:
    """People with the most missed *required* meetings, worst rate first."""
    query = (
        select(
            Attendance.attendee_email,
            func.count().label("total"),
            func.sum(case((Attendance.attended.is_(True), 1), else_=0)).label("attended"),
        )
        .where(Attendance.required.is_(True))
        .group_by(Attendance.attendee_email)
    )
    if emails is not None:
        query = query.where(Attendance.attendee_email.in_(emails))

    rows = db.execute(query).all()
    scored = [
        {
            "email": row.attendee_email,
            "total": row.total,
            "attended": row.attended,
            "missed": row.total - row.attended,
            "attendance_rate": _rate(row.attended, row.total),
        }
        for row in rows
        if row.attended < row.total
    ]
    scored.sort(key=lambda s: (-s["missed"], s["attendance_rate"]))
    return scored[:limit]


def attendance_trend(db: Session, emails: list[str], weeks: int = 6) -> list[dict]:
    """Weekly required-attendance rate for the given scope, oldest first —
    powers the dashboard's trend chart. Weeks (Monday start) are taken in
    the organization time zone, not the database session's zone."""
    if not emails:
        return []
    tz_name = get_timezone_name(db)
    # timezone(zone, timestamptz) is the wall-clock time in `zone` (a naive
    # timestamp), so the week is truncated on local dates.
    week = func.date_trunc("week", func.timezone(tz_name, MeetingOccurrence.start_time)).label("week")
    rows = db.execute(
        select(
            week,
            func.count().label("total"),
            func.sum(case((Attendance.attended.is_(True), 1), else_=0)).label("attended"),
        )
        .join(MeetingOccurrence, MeetingOccurrence.id == Attendance.occurrence_id)
        .where(Attendance.required.is_(True), Attendance.attendee_email.in_(emails))
        .group_by(week)
        .order_by(week)
    ).all()
    trend = [
        {
            "week_start": row.week.date().isoformat(),
            "total": row.total,
            "attended": row.attended,
            "attendance_rate": _rate(row.attended, row.total),
        }
        for row in rows
    ]
    return trend[-weeks:]


def team_attendance_rate(db: Session, emails: list[str]) -> dict:
    if not emails:
        return {"total": 0, "attended": 0, "attendance_rate": None}
    row = db.execute(
        select(
            func.count().label("total"),
            func.sum(case((Attendance.attended.is_(True), 1), else_=0)).label("attended"),
        ).where(Attendance.required.is_(True), Attendance.attendee_email.in_(emails))
    ).one()
    return {
        "total": row.total or 0,
        "attended": row.attended or 0,
        "attendance_rate": _rate(row.attended or 0, row.total or 0),
    }
