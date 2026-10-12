"""Shared pieces of the dashboard aggregations: the reporting period, the KPI
shape every dashboard returns, and the tone rules.

KPI shape (JSON), the same for every area:

    key, label        stable id and the name shown on the card
    definition        one precise sentence (the info tooltip)
    unit              "percent" (value is a 0..1 fraction) | "count" | "hours" | "days"
    value             the number, or null when there is nothing to measure
    previous, delta   the same measure over the previous equal period, and
                      value - previous (null when either side is missing);
                      for percent the delta is in fractions (0.05 = 5 points)
    good_direction    "up" | "down" | null: which way is an improvement
    target            the target value (same unit as value), when one is meaningful
    tone              "good" | "warn" | "crit" | "neutral" (neutral = no judgement)
    numerator, denominator   what a percent was computed from
    detail            a short plain-language context line ("171 of 262 ...")
    no_data           why value is null (never shown as 0)
    compare_label     wording for `previous` when it is not the previous equal period
"""
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ALLOWED_DAYS = (7, 30, 90)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def ratio(num: float, den: float) -> float | None:
    """num / den, or None when there is nothing to divide by (never 0 for "no data")."""
    return round(num / den, 4) if den else None


def mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 4) if values else None


@dataclass(frozen=True)
class Period:
    """`days` days ending at `end`, and the equal period just before it."""

    days: int
    end: datetime  # exclusive upper bound, an aware instant
    start: datetime
    prev_start: datetime

    @classmethod
    def ending(cls, end: datetime, days: int, tz: ZoneInfo = ZoneInfo("UTC")) -> "Period":
        """The last `days` calendar days in `tz`, today included (so it starts at local midnight), and the
        `days` calendar days before them. `end` is "now"; nothing in the future is ever counted."""
        today = end.astimezone(tz).date()

        def midnight(d: date) -> datetime:
            return datetime(d.year, d.month, d.day, tzinfo=tz).astimezone(timezone.utc)

        return cls(
            days=days,
            end=end,
            start=midnight(today - timedelta(days=days - 1)),
            prev_start=midnight(today - timedelta(days=2 * days - 1)),
        )

    def local_dates(self, tz: ZoneInfo) -> tuple[date, date]:
        """First and last calendar day of the period in `tz`."""
        return self.start.astimezone(tz).date(), (self.end - timedelta(microseconds=1)).astimezone(tz).date()

    def info(self, tz: ZoneInfo) -> dict:
        s, e = self.local_dates(tz)
        ps = self.prev_start.astimezone(tz).date()
        return {
            "days": self.days,
            "start": s.isoformat(),
            "end": e.isoformat(),
            "previous_start": ps.isoformat(),
            "previous_end": (s - timedelta(days=1)).isoformat(),
        }


def rate_tone(value: float | None, target: float, warn_floor: float) -> str:
    """good at or above the target, warn at or above the floor, crit below it."""
    if value is None:
        return "neutral"
    if value >= target:
        return "good"
    return "warn" if value >= warn_floor else "crit"


def count_tone(value: int | float | None, warn_at: float = 1, crit_at: float | None = None) -> str:
    """For counts where zero is the goal: good at 0, warn from `warn_at`, crit from `crit_at`."""
    if value is None:
        return "neutral"
    if crit_at is not None and value >= crit_at:
        return "crit"
    return "warn" if value >= warn_at else "good"


def kpi(
    key: str,
    label: str,
    definition: str,
    unit: str,
    value: float | int | None,
    *,
    previous: float | int | None = None,
    good: str | None = None,
    target: float | None = None,
    tone: str = "neutral",
    numerator: float | int | None = None,
    denominator: float | int | None = None,
    detail: str | None = None,
    no_data: str | None = None,
    compare_label: str | None = None,
) -> dict:
    delta = None
    if value is not None and previous is not None:
        delta = round(value - previous, 4)
    return {
        "key": key,
        "label": label,
        "definition": definition,
        "unit": unit,
        "value": value,
        "previous": previous,
        "delta": delta,
        "good_direction": good,
        "target": target,
        "tone": tone if value is not None else "neutral",
        "numerator": numerator,
        "denominator": denominator,
        "detail": detail,
        "no_data": None if value is not None else (no_data or "No data for this period"),
        # what `previous` is, when it is not "the previous equal period" (the UI's default wording)
        "compare_label": compare_label,
    }


def trend_is_daily(days: int) -> bool:
    """Short periods are charted per day, longer ones per 7-day block."""
    return days <= 14


def bucket_count(first: date, last: date, daily: bool) -> int:
    n = (last - first).days + 1
    return n if daily else -(-n // 7)


def bucket_from_end(d: date, last: date, daily: bool) -> int:
    """0 = the bucket that ends on `last`, 1 = the one before it, ... Blocks are anchored at the END of the
    period so the most recent block is always complete (a partial block, if any, is the oldest)."""
    back = (last - d).days
    return back if daily else back // 7


def bucket_start(idx_from_end: int, first: date, last: date, daily: bool) -> date:
    """First day of the bucket `idx_from_end` places before the end, clamped to the period start."""
    if daily:
        return last - timedelta(days=idx_from_end)
    return max(first, last - timedelta(days=7 * idx_from_end + 6))


WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
