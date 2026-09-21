from sqlalchemy import select
from sqlalchemy.orm import Session

from app.connectors.teams_provider import MeetingOccurrence, TeamsProvider
from app.models import Attendance, MeetingOccurrence as DbOccurrence, MeetingSeries


def _get_or_create_series(db: Session, occurrence: MeetingOccurrence) -> MeetingSeries:
    series = db.scalar(
        select(MeetingSeries).where(MeetingSeries.external_id == occurrence.series_id)
    )
    if series is None:
        series = MeetingSeries(
            external_id=occurrence.series_id,
            title=occurrence.title,
            organizer_email=occurrence.organizer,
            recurrence=occurrence.recurrence,
        )
        db.add(series)
        db.flush()
    return series


def sync_occurrence(db: Session, provider: TeamsProvider, occurrence: MeetingOccurrence) -> DbOccurrence:
    """Upsert one occurrence and its attendance rows. Safe to call repeatedly
    for the same occurrence (a real poller will do this) — matched by the
    (series, external_occurrence_id) and (occurrence, attendee) unique
    constraints, so re-syncing updates rather than duplicates."""
    series = _get_or_create_series(db, occurrence)

    db_occurrence = db.scalar(
        select(DbOccurrence).where(
            DbOccurrence.series_id == series.id,
            DbOccurrence.external_occurrence_id == occurrence.occurrence_id,
        )
    )
    if db_occurrence is None:
        db_occurrence = DbOccurrence(
            series_id=series.id,
            external_occurrence_id=occurrence.occurrence_id,
            start_time=occurrence.start_time,
            end_time=occurrence.end_time,
        )
        db.add(db_occurrence)
        db.flush()

    attendance_records = {r.attendee: r for r in provider.get_attendance(occurrence.occurrence_id)}

    for expected in occurrence.expected_attendees:
        row = db.scalar(
            select(Attendance).where(
                Attendance.occurrence_id == db_occurrence.id,
                Attendance.attendee_email == expected.email,
            )
        )
        record = attendance_records.get(expected.email)
        if row is None:
            row = Attendance(occurrence_id=db_occurrence.id, attendee_email=expected.email)
            db.add(row)
        row.required = expected.required
        row.attended = record is not None
        row.joined_at = record.joined_at if record else None
        row.left_at = record.left_at if record else None

    db.commit()
    db.refresh(db_occurrence)
    return db_occurrence
