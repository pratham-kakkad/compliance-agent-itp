"""Helpers shared by the assistant's LangChain tools."""
import functools
import logging
import re
from collections.abc import Callable
from datetime import date, datetime, timedelta

from dateutil import parser as date_parser
from langchain_core.tools import StructuredTool
from pydantic import BaseModel
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.chat.embeddings import redact_secrets

logger = logging.getLogger("app.chat")


def escape_like(value: str) -> str:
    """Escape LIKE wildcards in user/model input (use with escape='\\\\')."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def contains(value: str) -> str:
    return f"%{escape_like(value)}%"


def make_tool(
    db: Session, name: str, description: str, args_schema: type[BaseModel], func: Callable[..., dict]
) -> StructuredTool:
    """A StructuredTool whose function never raises: a DB error rolls the
    session back (so later tools in the same chat turn still work) and any
    failure comes back to the model as {"error": ...}."""

    @functools.wraps(func)
    def safe(**kwargs) -> dict:
        try:
            return func(**kwargs)
        except SQLAlchemyError:
            db.rollback()
            logger.exception("Assistant tool %s hit a database error", name)
            return {"error": f"{name} hit a database error — try again or use another tool."}
        except Exception as exc:
            logger.exception("Assistant tool %s failed", name)
            return {"error": redact_secrets(f"{name} failed: {type(exc).__name__}: {exc}")[:400]}

    return StructuredTool.from_function(func=safe, name=name, description=description, args_schema=args_schema)


_RELATIVE_DAYS = {"today": 0, "yesterday": 1, "day before yesterday": 2, "tomorrow": -1}
_ISO = re.compile(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})")
_DAY_FIRST = re.compile(r"(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})")
_MONTH_NAME = re.compile(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b", re.IGNORECASE)
_TIME_SUFFIX = re.compile(r"[T ]\d{1,2}:\d{2}")


def parse_date_arg(value: str | None, today: date) -> date | None:
    """Dates as the model (or user) might write them: YYYY-MM-DD, day-first
    DD-MM-YYYY / DD/MM/YYYY (the punch-log format), "today"/"yesterday",
    or with a month name ("25 Sep 2026"). None/"" -> None. Anything else
    raises ValueError with a message meant for the model."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    low = " ".join(text.lower().split())
    if low in _RELATIVE_DAYS:
        return today - timedelta(days=_RELATIVE_DAYS[low])

    # An ISO datetime ("2026-09-25T09:00", "2026-09-25 09:00:00") — keep the
    # date part. Anything else after a date ("2026-09-25 to 2026-09-30") is
    # rejected below rather than silently cut to its first day.
    if len(text) > 10 and _ISO.fullmatch(text[:10]) and _TIME_SUFFIX.match(text, 10):
        text = text[:10]

    try:
        if m := _ISO.fullmatch(text):
            return date(int(m[1]), int(m[2]), int(m[3]))
        if m := _DAY_FIRST.fullmatch(text):
            return date(int(m[3]), int(m[2]), int(m[1]))
        if not _MONTH_NAME.search(text):
            raise LookupError  # not a date format we know
        # dateutil fills a missing field from `default`. Parsing with two
        # different default days tells whether the text gave a day at all
        # ("September 2026" doesn't, and would otherwise become today's day
        # of September).
        first = date_parser.parse(text, dayfirst=True, default=datetime(today.year, today.month, 1)).date()
        second = date_parser.parse(text, dayfirst=True, default=datetime(today.year, today.month, 2)).date()
    except LookupError:
        raise ValueError(f"Unrecognised date '{text}'. Use YYYY-MM-DD or DD-MM-YYYY.") from None
    except (ValueError, OverflowError):
        raise ValueError(f"'{text}' is not a valid date. Use YYYY-MM-DD or DD-MM-YYYY.") from None
    if first != second:
        raise ValueError(
            f"'{text}' has no day of the month. Give a full date; for a whole month use start_date=YYYY-MM-01 "
            "and end_date=the month's last day."
        )
    return first
