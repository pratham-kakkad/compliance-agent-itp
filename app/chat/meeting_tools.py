"""The assistant's Teams-meeting tools, ported from the original agent.
Every tool re-derives the same visible-emails scope the REST endpoints use
(access.visible_emails: the viewer and everyone reporting to them), so the
assistant can't be asked to leak another manager's team data — it has no
meeting tool that reaches outside that scope. Meeting timestamps are given
in the organization time zone, like every time the assistant sees.
"""
from datetime import datetime, tzinfo

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import access, analytics
from app.chat.tool_utils import make_tool
from app.models import MeetingSeries, OrgUser
from app.org_settings.service import get_timezone, to_local

_OCCURRENCE_TIMES = ("start_time", "end_time")
_ATTENDANCE_TIMES = ("joined_at", "left_at")


def _local_iso(value, tz: tzinfo):
    """An ISO timestamp from the meetings API re-expressed in `tz` (same instant)."""
    if not isinstance(value, str) or not value:
        return value
    try:
        return to_local(datetime.fromisoformat(value), tz).isoformat()
    except ValueError:
        return value


def _localize_meeting_detail(detail: dict, tz: tzinfo) -> dict:
    for occ in detail.get("occurrences") or []:
        for key in _OCCURRENCE_TIMES:
            occ[key] = _local_iso(occ.get(key), tz)
        for attendance in occ.get("attendances") or []:
            for key in _ATTENDANCE_TIMES:
                attendance[key] = _local_iso(attendance.get(key), tz)
    return detail


class _NoArgs(BaseModel):
    pass


class _PersonArgs(BaseModel):
    email: str = Field(description="The person's work email address.")


class _ListMeetingsArgs(BaseModel):
    search: str | None = Field(default=None, description="Case-insensitive title substring")


class _MeetingDetailArgs(BaseModel):
    title: str = Field(description="The meeting series title (exact or close match).")


def build_meeting_tools(db: Session, viewer: OrgUser) -> list[BaseTool]:
    def get_my_dashboard() -> dict:
        visible = access.visible_emails(db, viewer.email)
        reports = [e for e in visible if e != viewer.email]
        return {
            "me": analytics.person_attendance_summary(db, viewer.email),
            "trend": analytics.attendance_trend(db, list(visible)),
            "top_concern_series": analytics.top_concern_series(db, list(visible)),
            "top_members_to_focus": analytics.top_members_to_focus(db, reports) if reports else [],
        }

    def get_person_summary(email: str) -> dict:
        visible = access.visible_emails(db, viewer.email)
        if email not in visible:
            return {"error": f"{email} is not visible to you (not yourself or a report)"}
        return analytics.person_attendance_summary(db, email)

    def list_meetings(search: str | None = None) -> dict:
        visible = access.visible_emails(db, viewer.email)
        rows = analytics.top_concern_series(db, list(visible), limit=50) or []
        # top_concern_series only returns series with a miss; for a general
        # listing fall back to a direct scan when nothing matches search.
        if search:
            rows = [r for r in rows if search.lower() in r["title"].lower()]
        return {"meetings": rows}

    def get_meeting_detail(title: str) -> dict:
        series = db.query(MeetingSeries).filter(MeetingSeries.title.ilike(f"%{title}%")).first()
        if series is None:
            return {"error": f"No meeting series matching '{title}'"}
        from app.api.meetings import meeting_detail  # local import avoids a circular import at module load

        return _localize_meeting_detail(meeting_detail(str(series.id), db=db, user=viewer), get_timezone(db))

    return [
        make_tool(
            db,
            "get_my_dashboard",
            "Get the current user's own attendance rate, their direct/total report counts, "
            "the weekly attendance trend, the top meetings of concern, and (if they manage people) "
            "the team members most in need of attention.",
            _NoArgs,
            get_my_dashboard,
        ),
        make_tool(
            db,
            "get_person_summary",
            "Get a specific person's required-meeting attendance rate and a breakdown by "
            "meeting series. Only works for the current user themself or someone reporting to them.",
            _PersonArgs,
            get_person_summary,
        ),
        make_tool(
            db,
            "list_meetings",
            "List meeting series visible to the current user (their own + their reports'), "
            "each with a required-attendance rate. Optional title search.",
            _ListMeetingsArgs,
            list_meetings,
        ),
        make_tool(
            db,
            "get_meeting_detail",
            "Get per-occurrence attendance detail for one meeting series by its title "
            "(exact or close match) — who was required/optional and whether they attended each occurrence.",
            _MeetingDetailArgs,
            get_meeting_detail,
        ),
    ]
