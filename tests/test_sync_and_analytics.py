from datetime import datetime, timedelta, timezone

from app import analytics
from app.connectors.mock_teams_provider import MockTeamsProvider
from app.connectors.sync_service import sync_occurrence
from app.connectors.teams_provider import MeetingAttendee
from app.models import Attendance, MeetingOccurrence, MeetingSeries

AVA = "ava.martinez@corp.com"
DANIEL = "daniel.kim@corp.com"
SOFIA = "sofia.rossi@corp.com"


def _seed_standup(db_session):
    provider = MockTeamsProvider()
    start = datetime(2026, 9, 1, 8, 0, tzinfo=timezone.utc)
    attendees = [
        MeetingAttendee(SOFIA, required=True),
        MeetingAttendee(DANIEL, required=False),
    ]
    provider.define_series("standup", "Daily Standup", AVA, attendees, start, timedelta(minutes=15), "daily")
    occurrences = provider.get_occurrences("standup", start, start + timedelta(days=2))
    assert len(occurrences) == 3

    # Sofia misses every occurrence; Daniel (optional) never attends either.
    for occ in occurrences:
        provider.set_attendance(occ.occurrence_id, [])
    for occ in occurrences:
        sync_occurrence(db_session, provider, occ)
    return occurrences


def test_sync_creates_series_occurrences_and_attendance(db_session):
    _seed_standup(db_session)
    assert db_session.query(MeetingSeries).count() == 1
    assert db_session.query(MeetingOccurrence).count() == 3
    assert db_session.query(Attendance).count() == 6  # 2 attendees x 3 occurrences


def test_syncing_twice_is_idempotent(db_session):
    occurrences = _seed_standup(db_session)

    provider = MockTeamsProvider()
    start = datetime(2026, 9, 1, 8, 0, tzinfo=timezone.utc)
    attendees = [
        MeetingAttendee(SOFIA, required=True),
        MeetingAttendee(DANIEL, required=False),
    ]
    provider.define_series("standup", "Daily Standup", AVA, attendees, start, timedelta(minutes=15), "daily")
    provider.set_attendance(occurrences[0].occurrence_id, [])

    sync_occurrence(db_session, provider, occurrences[0])
    sync_occurrence(db_session, provider, occurrences[0])

    assert db_session.query(MeetingOccurrence).count() == 3
    assert db_session.query(Attendance).count() == 6


def test_optional_absence_excluded_from_concerns_and_focus_list(db_session):
    _seed_standup(db_session)

    concerns = analytics.top_concern_series(db_session, [SOFIA, DANIEL])
    assert len(concerns) == 1
    assert concerns[0]["title"] == "Daily Standup"
    assert concerns[0]["missed"] == 3  # only Sofia's misses count, not Daniel's

    focus = analytics.top_members_to_focus(db_session, [SOFIA, DANIEL])
    emails = [f["email"] for f in focus]
    assert SOFIA in emails
    assert DANIEL not in emails  # optional attendee never flagged

    sofia_summary = analytics.person_attendance_summary(db_session, SOFIA)
    assert sofia_summary["attendance_rate"] == 0.0
    daniel_summary = analytics.person_attendance_summary(db_session, DANIEL)
    assert daniel_summary["required_total"] == 0  # optional-only, never counted as "required"
