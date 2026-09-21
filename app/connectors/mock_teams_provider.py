from dataclasses import dataclass, field
from datetime import datetime, timedelta

from app.connectors.teams_provider import (
    AttendanceRecord,
    MeetingAttendee,
    MeetingOccurrence,
    TeamsProvider,
)


@dataclass
class _SeriesDefinition:
    title: str
    organizer: str
    expected_attendees: list[MeetingAttendee]
    start_time: datetime
    duration: timedelta
    recurrence: str  # "once" | "daily"


class MockTeamsProvider(TeamsProvider):
    """In-memory stand-in for Microsoft Graph. Define series, mark who
    actually joined each occurrence, then read it back exactly like the real
    Graph-backed provider will expose it."""

    def __init__(self) -> None:
        self._series: dict[str, _SeriesDefinition] = {}
        self._attendance: dict[str, list[str]] = {}  # occurrence_id -> emails who joined

    def define_series(
        self,
        series_id: str,
        title: str,
        organizer: str,
        expected_attendees: list[MeetingAttendee],
        start_time: datetime,
        duration: timedelta,
        recurrence: str = "once",
    ) -> None:
        self._series[series_id] = _SeriesDefinition(
            title, organizer, expected_attendees, start_time, duration, recurrence
        )

    def set_attendance(self, occurrence_id: str, attendees_who_joined: list[str]) -> None:
        self._attendance[occurrence_id] = attendees_who_joined

    def _build_occurrence(self, series_id: str, series: _SeriesDefinition, start: datetime) -> MeetingOccurrence:
        occurrence_id = f"{series_id}::{start.isoformat()}"
        return MeetingOccurrence(
            occurrence_id=occurrence_id,
            series_id=series_id,
            title=series.title,
            organizer=series.organizer,
            recurrence=series.recurrence,
            start_time=start,
            end_time=start + series.duration,
            expected_attendees=series.expected_attendees,
        )

    def get_occurrences(self, series_id: str, start: datetime, end: datetime) -> list[MeetingOccurrence]:
        series = self._series[series_id]
        if series.recurrence == "once":
            if start <= series.start_time <= end:
                return [self._build_occurrence(series_id, series, series.start_time)]
            return []

        if series.recurrence == "daily":
            occurrences = []
            cursor = series.start_time
            while cursor <= end:
                if cursor >= start:
                    occurrences.append(self._build_occurrence(series_id, series, cursor))
                cursor += timedelta(days=1)
            return occurrences

        raise ValueError(f"unsupported recurrence: {series.recurrence}")

    def get_attendance(self, occurrence_id: str) -> list[AttendanceRecord]:
        series_id = occurrence_id.split("::", 1)[0]
        series = self._series[series_id]
        start = datetime.fromisoformat(occurrence_id.split("::", 1)[1])
        joined_emails = self._attendance.get(
            occurrence_id, [a.email for a in series.expected_attendees]
        )
        return [
            AttendanceRecord(
                attendee=email,
                joined_at=start + timedelta(minutes=1),
                left_at=start + series.duration - timedelta(minutes=1),
            )
            for email in joined_emails
        ]
