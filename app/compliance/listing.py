"""Shared helpers for the list endpoints' filter and sort parameters
(definitions, obligations): parsing "any of" lists, org-zone day bounds, and
the sort orderings. The handlers in api.py stay in charge of access rules."""
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import case
from sqlalchemy.orm import Session

from app.org_settings.service import get_timezone_name


def as_list(values: "str | list[str] | None") -> list[str]:
    """Repeated query params (?a=1&a=2) and/or comma-separated ones (?a=1,2) -> ["1", "2"]."""
    if values is None:
        return []
    items = [values] if isinstance(values, str) else list(values)
    return [p.strip() for item in items for p in str(item).split(",") if p.strip()]


def day_bounds(db: Session, start: date | None, end: date | None) -> tuple[datetime | None, datetime | None]:
    """Inclusive calendar days in the organization's time zone -> [from, to) as aware datetimes."""
    if start is None and end is None:
        return None, None
    tz = ZoneInfo(get_timezone_name(db))
    lo = datetime.combine(start, time.min, tzinfo=tz) if start else None
    hi = datetime.combine(end + timedelta(days=1), time.min, tzinfo=tz) if end else None
    return lo, hi


def priority_rank(column, priorities: list[str]):
    """SQL expression ranking a priority column low(0) .. critical(3)."""
    return case({p: i for i, p in enumerate(priorities)}, value=column, else_=-1)
