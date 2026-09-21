from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app import access
from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models import Attendance, MeetingOccurrence, MeetingSeries, OrgUser

router = APIRouter(prefix="/meetings", tags=["meetings"])


@router.get("")
def list_meetings(
    organizer_email: str | None = None,
    recurrence: str | None = None,
    search: str | None = None,
    group_by: str | None = Query(None, pattern="^(organizer)$"),
    db: Session = Depends(get_db),
    user: OrgUser = Depends(get_current_user),
):
    """Every series with at least one occurrence a visible person (you or
    your reports) was expected at, with an aggregate required-attendance
    rate. Filter by organizer/recurrence/title search; group_by=organizer
    nests the flat list under each organizer for the Meetings tab's
    group-by control."""
    visible = access.visible_emails(db, user.email)

    query = (
        select(
            MeetingSeries.id,
            MeetingSeries.title,
            MeetingSeries.organizer_email,
            MeetingSeries.recurrence,
            func.count().label("total"),
            func.sum(case((Attendance.attended.is_(True), 1), else_=0)).label("attended"),
            func.min(MeetingOccurrence.start_time).label("first_occurrence"),
            func.max(MeetingOccurrence.start_time).label("last_occurrence"),
        )
        .join(MeetingOccurrence, MeetingOccurrence.series_id == MeetingSeries.id)
        .join(Attendance, Attendance.occurrence_id == MeetingOccurrence.id)
        .where(Attendance.required.is_(True), Attendance.attendee_email.in_(visible))
        .group_by(MeetingSeries.id, MeetingSeries.title, MeetingSeries.organizer_email, MeetingSeries.recurrence)
    )
    if organizer_email:
        query = query.where(MeetingSeries.organizer_email == organizer_email)
    if recurrence:
        query = query.where(MeetingSeries.recurrence == recurrence)
    if search:
        query = query.where(MeetingSeries.title.ilike(f"%{search}%"))

    rows = db.execute(query.order_by(MeetingSeries.title)).all()
    items = [
        {
            "series_id": str(r.id),
            "title": r.title,
            "organizer_email": r.organizer_email,
            "recurrence": r.recurrence,
            "required_total": r.total,
            "required_attended": r.attended,
            "attendance_rate": round(r.attended / r.total, 4) if r.total else None,
            "first_occurrence": r.first_occurrence.isoformat(),
            "last_occurrence": r.last_occurrence.isoformat(),
        }
        for r in rows
    ]

    if group_by == "organizer":
        grouped: dict[str, list[dict]] = {}
        for item in items:
            grouped.setdefault(item["organizer_email"], []).append(item)
        return {"grouped_by": "organizer", "groups": grouped}

    return {"grouped_by": None, "items": items}


@router.get("/{series_id}")
def meeting_detail(series_id: str, db: Session = Depends(get_db), user: OrgUser = Depends(get_current_user)):
    series = db.get(MeetingSeries, series_id)
    if series is None:
        raise HTTPException(status_code=404, detail="No such meeting series")

    visible = access.visible_emails(db, user.email)
    occurrences = (
        db.execute(
            select(MeetingOccurrence)
            .where(MeetingOccurrence.series_id == series.id)
            .order_by(MeetingOccurrence.start_time)
        )
        .scalars()
        .all()
    )

    occurrence_payload = []
    for occ in occurrences:
        attendances = db.execute(
            select(Attendance, OrgUser)
            .join(OrgUser, OrgUser.email == Attendance.attendee_email)
            .where(Attendance.occurrence_id == occ.id, Attendance.attendee_email.in_(visible))
            .order_by(Attendance.required.desc(), Attendance.attended.asc())
        ).all()
        occurrence_payload.append(
            {
                "occurrence_id": str(occ.id),
                "start_time": occ.start_time.isoformat(),
                "end_time": occ.end_time.isoformat(),
                "attendances": [
                    {
                        "email": a.attendee_email,
                        "name": person.name,
                        "required": a.required,
                        "attended": a.attended,
                        "joined_at": a.joined_at.isoformat() if a.joined_at else None,
                        "left_at": a.left_at.isoformat() if a.left_at else None,
                    }
                    for a, person in attendances
                ],
            }
        )

    return {
        "series_id": str(series.id),
        "title": series.title,
        "organizer_email": series.organizer_email,
        "recurrence": series.recurrence,
        "occurrences": occurrence_payload,
    }
