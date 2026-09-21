from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime


@dataclass
class MeetingAttendee:
    email: str
    required: bool = True


@dataclass
class MeetingOccurrence:
    occurrence_id: str
    series_id: str
    title: str
    organizer: str
    recurrence: str
    start_time: datetime
    end_time: datetime
    expected_attendees: list[MeetingAttendee]


@dataclass
class AttendanceRecord:
    attendee: str
    joined_at: datetime
    left_at: datetime


class TeamsProvider(ABC):
    """Swap the Mock implementation for one backed by Microsoft Graph
    (OnlineMeetings.Read.All / OnlineMeetingArtifact.Read.All) once Azure AD
    app credentials exist — nothing above this interface changes."""

    @abstractmethod
    def get_occurrences(
        self, series_id: str, start: datetime, end: datetime
    ) -> list[MeetingOccurrence]: ...

    @abstractmethod
    def get_attendance(self, occurrence_id: str) -> list[AttendanceRecord]: ...
