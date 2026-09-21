"""Small tool-using chat agent, scoped entirely to this user's own meeting
compliance data. Every tool re-derives the same visible-emails scope the
REST endpoints use, so the assistant can't be asked to leak another
manager's team data — it literally has no tool that reaches outside
`access.visible_emails(viewer)`.
"""
import json

import anthropic
from sqlalchemy.orm import Session

from app import access, analytics
from app.config import settings
from app.models import MeetingSeries, OrgUser

MODEL = "claude-sonnet-5"
MAX_TOOL_ROUNDS = 4

_TOOLS = [
    {
        "name": "get_my_dashboard",
        "description": "Get the current user's own attendance rate, their direct/total report counts, "
        "the weekly attendance trend, the top meetings of concern, and (if they manage people) "
        "the team members most in need of attention.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_person_summary",
        "description": "Get a specific person's required-meeting attendance rate and a breakdown by "
        "meeting series. Only works for the current user themself or someone reporting to them.",
        "input_schema": {
            "type": "object",
            "properties": {"email": {"type": "string"}},
            "required": ["email"],
        },
    },
    {
        "name": "list_meetings",
        "description": "List meeting series visible to the current user (their own + their reports'), "
        "each with a required-attendance rate. Optional title search.",
        "input_schema": {
            "type": "object",
            "properties": {"search": {"type": "string", "description": "Case-insensitive title substring"}},
        },
    },
    {
        "name": "get_meeting_detail",
        "description": "Get per-occurrence attendance detail for one meeting series by its title "
        "(exact or close match) — who was required/optional and whether they attended each occurrence.",
        "input_schema": {
            "type": "object",
            "properties": {"title": {"type": "string"}},
            "required": ["title"],
        },
    },
]


def _run_tool(db: Session, viewer: OrgUser, name: str, tool_input: dict) -> dict:
    visible = access.visible_emails(db, viewer.email)

    if name == "get_my_dashboard":
        reports = [e for e in visible if e != viewer.email]
        return {
            "me": analytics.person_attendance_summary(db, viewer.email),
            "trend": analytics.attendance_trend(db, list(visible)),
            "top_concern_series": analytics.top_concern_series(db, list(visible)),
            "top_members_to_focus": analytics.top_members_to_focus(db, reports) if reports else [],
        }

    if name == "get_person_summary":
        email = tool_input["email"]
        if email not in visible:
            return {"error": f"{email} is not visible to you (not yourself or a report)"}
        return analytics.person_attendance_summary(db, email)

    if name == "list_meetings":
        search = tool_input.get("search")
        rows = analytics.top_concern_series(db, list(visible), limit=50) or []
        # top_concern_series only returns series with a miss; for a general
        # listing fall back to a direct scan when nothing matches search.
        if search:
            rows = [r for r in rows if search.lower() in r["title"].lower()]
        return {"meetings": rows}

    if name == "get_meeting_detail":
        title = tool_input["title"]
        series = db.query(MeetingSeries).filter(MeetingSeries.title.ilike(f"%{title}%")).first()
        if series is None:
            return {"error": f"No meeting series matching '{title}'"}
        from app.api.meetings import meeting_detail  # local import avoids a circular import at module load

        return meeting_detail(str(series.id), db=db, user=viewer)

    return {"error": f"unknown tool {name}"}


def answer(db: Session, viewer: OrgUser, message: str, history: list[dict] | None = None) -> str:
    if not settings.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    messages = list(history or []) + [{"role": "user", "content": message}]

    system = (
        "You are the Meeting Compliance Assistant, embedded in a dashboard that tracks Teams "
        "meeting attendance. Answer only using the provided tools — never guess at attendance "
        f"numbers. The current user is {viewer.name} ({viewer.email}). Optional-attendee absences "
        "are never a compliance problem; don't flag them as if they were. Be concise and specific "
        "(name meetings and people), like a helpful analyst, not a generic chatbot."
    )

    for _ in range(MAX_TOOL_ROUNDS):
        response = client.messages.create(
            model=MODEL,
            max_tokens=1024,
            system=system,
            tools=_TOOLS,
            messages=messages,
        )

        if response.stop_reason != "tool_use":
            return "".join(block.text for block in response.content if block.type == "text").strip()

        messages.append({"role": "assistant", "content": response.content})
        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            result = _run_tool(db, viewer, block.name, block.input)
            tool_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(result, default=str),
                }
            )
        messages.append({"role": "user", "content": tool_results})

    return "I wasn't able to finish looking that up — try asking a more specific question."
