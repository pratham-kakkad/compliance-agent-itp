from datetime import datetime, timedelta, timezone

from app import analytics
from app.connectors.mock_teams_provider import MockTeamsProvider
from app.connectors.sync_service import sync_occurrence
from app.connectors.teams_provider import MeetingAttendee
from app.models import Attendance, MeetingOccurrence, MeetingSeries


def _seed_standup(db_session):
    provider = MockTeamsProvider()
    start = datetime(2026, 9, 1, 8, 0, tzinfo=timezone.utc)
    attendees = [
        MeetingAttendee("alice@corp.com", required=True),
        MeetingAttendee("carol@corp.com", required=True),
        MeetingAttendee("dave@corp.com", required=False),
    ]
    provider.define_series("standup", "Daily Standup", "lead@corp.com", attendees, start, timedelta(minutes=15), "daily")
    occurrences = provider.get_occurrences("standup", start, start + timedelta(days=2))
    assert len(occurrences) == 3

    # Carol misses every occurrence; Dave (optional) never attends either.
    for occ in occurrences:
        provider.set_attendance(occ.occurrence_id, ["alice@corp.com"])
    for occ in occurrences:
        sync_occurrence(db_session, provider, occ)
    return occurrences


def test_sync_creates_series_occurrences_and_attendance(db_session):
    _seed_standup(db_session)
    assert db_session.query(MeetingSeries).count() == 1
    assert db_session.query(MeetingOccurrence).count() == 3
    assert db_session.query(Attendance).count() == 9  # 3 attendees x 3 occurrences


def test_syncing_twice_is_idempotent(db_session):
    occurrences = _seed_standup(db_session)
    from app.connectors.mock_teams_provider import MockTeamsProvider as _P  # noqa: F401

    provider = MockTeamsProvider()
    start = datetime(2026, 9, 1, 8, 0, tzinfo=timezone.utc)
    attendees = [
        MeetingAttendee("alice@corp.com", required=True),
        MeetingAttendee("carol@corp.com", required=True),
        MeetingAttendee("dave@corp.com", required=False),
    ]
    provider.define_series("standup", "Daily Standup", "lead@corp.com", attendees, start, timedelta(minutes=15), "daily")
    provider.set_attendance(occurrences[0].occurrence_id, ["alice@corp.com"])

    sync_occurrence(db_session, provider, occurrences[0])
    sync_occurrence(db_session, provider, occurrences[0])

    assert db_session.query(MeetingOccurrence).count() == 3
    assert db_session.query(Attendance).count() == 9


def test_optional_absence_excluded_from_concerns_and_focus_list(db_session):
    _seed_standup(db_session)

    concerns = analytics.top_concern_series(db_session, ["alice@corp.com", "carol@corp.com", "dave@corp.com"])
    assert len(concerns) == 1
    assert concerns[0]["title"] == "Daily Standup"
    assert concerns[0]["missed"] == 3  # only Carol's misses count, not Dave's

    focus = analytics.top_members_to_focus(db_session, ["alice@corp.com", "carol@corp.com", "dave@corp.com"])
    emails = [f["email"] for f in focus]
    assert "carol@corp.com" in emails
    assert "dave@corp.com" not in emails  # optional attendee never flagged

    carol_summary = analytics.person_attendance_summary(db_session, "carol@corp.com")
    assert carol_summary["attendance_rate"] == 0.0
    dave_summary = analytics.person_attendance_summary(db_session, "dave@corp.com")
    assert dave_summary["required_total"] == 0  # optional-only, never counted as "required"
