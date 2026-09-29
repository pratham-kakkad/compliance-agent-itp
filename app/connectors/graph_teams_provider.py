"""Real Microsoft Graph-backed TeamsProvider. Replaces MockTeamsProvider
once the app registration's application permissions (OnlineMeetings.Read.All,
OnlineMeetingArtifact.Read.All, Calendars.Read — see HELPDESK_EMAIL_DRAFT.md)
are granted and admin-consented.

Two Graph APIs are stitched together here, because attendance and scheduling
live in different places:
  - Calendar events (`/users/{upn}/events`, `.../instances`) give us the
    *schedule*: who's expected, and the concrete occurrences of a recurring
    series in a date range.
  - Online meetings + attendance reports (`/users/{upn}/onlineMeetings`,
    `.../attendanceReports`, `.../attendanceRecords`) give us *who actually
    joined* — but reports are keyed by the meeting's join URL and a report
    timestamp, not by calendar occurrence id, so `get_attendance` has to
    resolve the calendar event -> join URL -> online meeting -> the one
    attendance report whose start time is closest to this occurrence.

series_id / occurrence_id are both opaque strings from the abstract
TeamsProvider's point of view, but here they're "{organizer_upn}::{event_id}"
composites — Graph addresses every calendar event through a specific
mailbox, so the organizer's UPN has to travel alongside the Graph event id
everywhere this provider hands one out.
"""
from datetime import datetime
from urllib.parse import quote

from app.connectors.graph_client import GraphClient
from app.connectors.teams_provider import (
    AttendanceRecord,
    MeetingAttendee,
    MeetingOccurrence,
    TeamsProvider,
)

_EVENT_FIELDS = "id,subject,type,recurrence,start,end,attendees,onlineMeeting,isOnlineMeeting"


def _parse_graph_dt(value: str) -> datetime:
    """Graph timestamps show up either as plain UTC ("2026-09-21T15:00:00.0000000",
    once GraphClient's Prefer header is honored) or absolute ISO8601 with a
    "Z" suffix (attendance report timestamps). Both can carry up to 7
    fractional digits, one more than datetime.fromisoformat accepts."""
    value = value[:-1] if value.endswith("Z") else value
    if "." in value:
        head, frac = value.split(".", 1)
        value = f"{head}.{frac[:6]}"
    return datetime.fromisoformat(value + "+00:00")


def _required(attendee_type: str) -> bool:
    return attendee_type != "optional"


class GraphTeamsProvider(TeamsProvider):
    def __init__(self, client: GraphClient | None = None) -> None:
        self._client = client or GraphClient()

    @staticmethod
    def series_id_for(organizer_upn: str, event_id: str) -> str:
        return f"{organizer_upn}::{event_id}"

    @staticmethod
    def _split(composite_id: str) -> tuple[str, str]:
        organizer_upn, event_id = composite_id.split("::", 1)
        return organizer_upn, event_id

    def discover_series(self, organizer_upn: str, start: datetime, end: datetime) -> list[str]:
        """Series ids for everything `organizer_upn` organizes (not just
        attends) with an occurrence in [start, end). Not part of the
        abstract TeamsProvider — discovery is inherently provider-specific;
        MockTeamsProvider callers already know their series ids up front via
        `define_series`."""
        events = self._client.get_all_pages(
            f"/users/{quote(organizer_upn)}/calendarView",
            params={
                "startDateTime": start.isoformat(),
                "endDateTime": end.isoformat(),
                "$select": "id,seriesMasterId,organizer",
                "$top": "100",
            },
        )
        series_ids = set()
        for event in events:
            organizer_address = event.get("organizer", {}).get("emailAddress", {}).get("address", "")
            if organizer_address.lower() != organizer_upn.lower():
                continue  # calendarView also includes meetings they're only invited to
            master_or_own_id = event.get("seriesMasterId") or event["id"]
            series_ids.add(self.series_id_for(organizer_upn, master_or_own_id))
        return sorted(series_ids)

    def get_occurrences(self, series_id: str, start: datetime, end: datetime) -> list[MeetingOccurrence]:
        organizer_upn, event_id = self._split(series_id)
        master = self._client.get(f"/users/{quote(organizer_upn)}/events/{event_id}", params={"$select": _EVENT_FIELDS})

        if master.get("type") != "seriesMaster":
            occurrence_start = _parse_graph_dt(master["start"]["dateTime"])
            if not (start <= occurrence_start <= end):
                return []
            return [self._to_occurrence(organizer_upn, master, series_id, "once")]

        pattern_type = master.get("recurrence", {}).get("pattern", {}).get("type", "")
        recurrence_label = "daily" if pattern_type == "daily" else "weekly"

        instances = self._client.get_all_pages(
            f"/users/{quote(organizer_upn)}/events/{event_id}/instances",
            params={
                "startDateTime": start.isoformat(),
                "endDateTime": end.isoformat(),
                "$select": _EVENT_FIELDS,
            },
        )
        return [self._to_occurrence(organizer_upn, instance, series_id, recurrence_label) for instance in instances]

    def _to_occurrence(
        self, organizer_upn: str, event: dict, series_id: str, recurrence_label: str
    ) -> MeetingOccurrence:
        attendees = [
            MeetingAttendee(
                email=a["emailAddress"]["address"],
                required=_required(a.get("type", "required")),
            )
            for a in event.get("attendees", [])
        ]
        return MeetingOccurrence(
            occurrence_id=self.series_id_for(organizer_upn, event["id"]),
            series_id=series_id,
            title=event.get("subject") or "(no subject)",
            organizer=organizer_upn,
            recurrence=recurrence_label,
            start_time=_parse_graph_dt(event["start"]["dateTime"]),
            end_time=_parse_graph_dt(event["end"]["dateTime"]),
            expected_attendees=attendees,
        )

    def get_attendance(self, occurrence_id: str) -> list[AttendanceRecord]:
        organizer_upn, event_id = self._split(occurrence_id)
        event = self._client.get(
            f"/users/{quote(organizer_upn)}/events/{event_id}",
            params={"$select": "isOnlineMeeting,onlineMeeting,start"},
        )
        if not event.get("isOnlineMeeting") or not (event.get("onlineMeeting") or {}).get("joinUrl"):
            return []  # not a Teams meeting — nothing Graph can report on

        join_url = event["onlineMeeting"]["joinUrl"]
        meetings = self._client.get_all_pages(
            f"/users/{quote(organizer_upn)}/onlineMeetings",
            params={"$filter": f"JoinWebUrl eq '{join_url}'"},
        )
        if not meetings:
            return []
        meeting_id = meetings[0]["id"]

        reports = self._client.get_all_pages(
            f"/users/{quote(organizer_upn)}/onlineMeetings/{meeting_id}/attendanceReports",
            params={"$select": "id,meetingStartDateTime"},
        )
        if not reports:
            return []  # meeting hasn't happened / report not generated yet

        # Recurring online meetings accumulate one report per real session;
        # match this occurrence to the report whose start is closest to it.
        occurrence_start = _parse_graph_dt(event["start"]["dateTime"])
        report = min(
            reports,
            key=lambda r: abs((_parse_graph_dt(r["meetingStartDateTime"]) - occurrence_start).total_seconds()),
        )

        records = self._client.get_all_pages(
            f"/users/{quote(organizer_upn)}/onlineMeetings/{meeting_id}/attendanceReports/{report['id']}/attendanceRecords",
            params={"$select": "emailAddress,attendanceIntervals"},
        )

        results = []
        for record in records:
            email = record.get("emailAddress")
            intervals = record.get("attendanceIntervals") or []
            if not email or not intervals:
                continue
            results.append(
                AttendanceRecord(
                    attendee=email,
                    joined_at=min(_parse_graph_dt(i["joinDateTime"]) for i in intervals),
                    left_at=max(_parse_graph_dt(i["leaveDateTime"]) for i in intervals),
                )
            )
        return results
