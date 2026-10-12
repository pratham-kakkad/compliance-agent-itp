"""Meetings dashboard: required-attendance numbers for the signed-in person's
visible people (themselves and everyone who reports to them, the same scope as
GET /dashboard). Only REQUIRED attendances count, as everywhere else: an absent
optional invitee is never a problem. Only meetings that have already ended count.

Definitions (also shown to the user as tooltips):

- Required attendance rate  = attended required attendances / required
  attendances, over meetings that started in the period.
- Series at risk            = meeting series whose rate in the period is below
  AT_RISK_BELOW and that have at least MIN_SLOTS required attendances (a series
  with one or two slots says nothing yet).
- Repeat absentees          = people with at least REPEAT_MISSES required
  attendances missed in the period.
"""
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import access
from app.dashboards.common import (
    WEEKDAYS,
    Period,
    bucket_count,
    bucket_from_end,
    bucket_start,
    count_tone,
    kpi,
    rate_tone,
    ratio,
    trend_is_daily,
)
from app.models import Attendance, MeetingOccurrence, MeetingSeries, OrgUser
from app.org_settings.service import get_timezone

TARGET = 0.9
WARN_FLOOR = 0.75
AT_RISK_BELOW = 0.75
MIN_SLOTS = 3
REPEAT_MISSES = 3
LIST_LIMIT = 8


@dataclass(frozen=True)
class Row:
    """One required attendance slot of a meeting that has ended."""

    email: str
    series_id: str
    title: str
    organizer: str
    occurrence_id: str
    start: datetime
    attended: bool


def fetch_rows(db: Session, emails: list[str], start: datetime, end: datetime, now: datetime) -> list[Row]:
    if not emails:
        return []
    q = (
        select(
            Attendance.attendee_email,
            MeetingSeries.id,
            MeetingSeries.title,
            MeetingSeries.organizer_email,
            MeetingOccurrence.id,
            MeetingOccurrence.start_time,
            Attendance.attended,
        )
        .join(MeetingOccurrence, MeetingOccurrence.id == Attendance.occurrence_id)
        .join(MeetingSeries, MeetingSeries.id == MeetingOccurrence.series_id)
        .where(
            Attendance.required.is_(True),
            Attendance.attendee_email.in_(emails),
            MeetingOccurrence.start_time >= start,
            MeetingOccurrence.start_time < end,
            MeetingOccurrence.end_time <= now,
        )
    )
    return [Row(e, str(sid), t, o, str(oid), st, bool(a)) for e, sid, t, o, oid, st, a in db.execute(q).all()]


def _totals(rows: list[Row]) -> tuple[int, int]:
    return len(rows), sum(1 for r in rows if r.attended)


def _group(rows: list[Row], key) -> dict:
    out: dict = defaultdict(list)
    for r in rows:
        out[key(r)].append(r)
    return out


def _series_rates(rows: list[Row]) -> dict[str, tuple[int, int]]:
    return {k: _totals(v) for k, v in _group(rows, lambda r: r.series_id).items()}


def _at_risk_ids(rows: list[Row]) -> tuple[set[str], int]:
    """(ids of series below the threshold, number of series that had enough data to judge)."""
    measured = {k: v for k, v in _series_rates(rows).items() if v[0] >= MIN_SLOTS}
    return {k for k, (t, a) in measured.items() if a / t < AT_RISK_BELOW}, len(measured)


def _repeat_absentees(rows: list[Row]) -> set[str]:
    missed: dict[str, int] = defaultdict(int)
    for r in rows:
        if not r.attended:
            missed[r.email] += 1
    return {e for e, n in missed.items() if n >= REPEAT_MISSES}


def _trend(cur: list[Row], prev: list[Row], period: Period, tz: ZoneInfo) -> dict:
    daily = trend_is_daily(period.days)
    first, last = period.local_dates(tz)
    n = bucket_count(first, last, daily)
    pfirst = period.prev_start.astimezone(tz).date()
    plast = first - timedelta(days=1)

    def fold(rows: list[Row], lst):
        acc = [[0, 0] for _ in range(n)]
        for r in rows:
            i = bucket_from_end(r.start.astimezone(tz).date(), lst, daily)
            if 0 <= i < n:
                acc[i][0] += 1
                acc[i][1] += 1 if r.attended else 0
        return acc

    c, p = fold(cur, last), fold(prev, plast)
    pts = []
    for i in range(n - 1, -1, -1):  # oldest first
        total, att = c[i]
        ptotal, patt = p[i]
        pts.append(
            {
                "start": bucket_start(i, first, last, daily).isoformat(),
                "total": total,
                "attended": att,
                "rate": ratio(att, total),
                "previous_start": bucket_start(i, pfirst, plast, daily).isoformat(),
                "previous_rate": ratio(patt, ptotal),
            }
        )
    return {"daily": daily, "points": pts, "target": TARGET}


def compute(
    cur: list[Row],
    prev: list[Row],
    names: dict[str, str],
    period: Period,
    tz: ZoneInfo,
    now: datetime,
    people_in_scope: int,
) -> dict:
    days = period.days
    total, att = _totals(cur)
    ptotal, patt = _totals(prev)
    rate, prate = ratio(att, total), ratio(patt, ptotal)
    quiet = f"No required meetings were held in the last {days} days"

    risk_ids, measured = _at_risk_ids(cur)
    prisk_ids, pmeasured = _at_risk_ids(prev)
    repeat = _repeat_absentees(cur)
    prepeat = _repeat_absentees(prev)
    held = len({r.occurrence_id for r in cur})
    pheld = len({r.occurrence_id for r in prev})
    people_with_slots = len({r.email for r in cur})

    kpis = {
        "attendance": kpi(
            "attendance",
            "Required attendance",
            "Required attendances that were attended, divided by all required attendances, for meetings that ended in the period. Optional invitees are never counted.",
            "percent",
            rate,
            previous=prate,
            good="up",
            target=TARGET,
            tone=rate_tone(rate, TARGET, WARN_FLOOR),
            numerator=att,
            denominator=total,
            detail=f"{att} of {total} required attendances",
            no_data=quiet,
        ),
        "series_at_risk": kpi(
            "series_at_risk",
            "Series at risk",
            f"Meeting series whose required attendance in the period is below {round(AT_RISK_BELOW * 100)}%, counting only series with at least {MIN_SLOTS} required attendances.",
            "count",
            len(risk_ids) if measured else None,
            previous=len(prisk_ids) if pmeasured else None,
            good="down",
            tone=count_tone(len(risk_ids), 1, max(2, measured / 4) if measured else 2),
            denominator=measured,
            detail=f"of {measured} series measured",
            no_data=f"No series had {MIN_SLOTS}+ required attendances in the last {days} days",
        ),
        "repeat_absentees": kpi(
            "repeat_absentees",
            "Repeat absentees",
            f"People who missed at least {REPEAT_MISSES} required meetings in the period.",
            "count",
            len(repeat) if total else None,
            previous=len(prepeat) if ptotal else None,
            good="down",
            tone=count_tone(len(repeat), 1, 3),
            denominator=people_with_slots,
            detail=f"of {people_with_slots} people with required meetings",
            no_data=quiet,
        ),
        "meetings_held": kpi(
            "meetings_held",
            "Meetings held",
            "Meetings that ended in the period and had at least one required attendee among the people you can see.",
            "count",
            held if held else None,
            previous=pheld if pheld else None,
            detail=f"{total} required attendances",
            no_data=quiet,
        ),
    }

    # --- weekday pattern (the day the meeting started, in the organization time zone)
    by_wd = _group(cur, lambda r: r.start.astimezone(tz).weekday())
    weekday = []
    for i, name in enumerate(WEEKDAYS):
        t, a = _totals(by_wd.get(i, []))
        weekday.append({"day": name, "total": t, "attended": a, "rate": ratio(a, t)})

    # --- turnout per meeting: everyone required came / some did / none did
    turnout = {"full": 0, "partial": 0, "none": 0, "total": held}
    for occ_rows in _group(cur, lambda r: r.occurrence_id).values():
        t, a = _totals(occ_rows)
        turnout["full" if a == t else "none" if a == 0 else "partial"] += 1

    # --- series ranking (lowest first)
    prev_rates = _series_rates(prev)
    series = []
    for sid, rows in _group(cur, lambda r: r.series_id).items():
        t, a = _totals(rows)
        pt, pa = prev_rates.get(sid, (0, 0))
        pr = ratio(pa, pt) if pt >= MIN_SLOTS else None
        r = ratio(a, t)
        series.append(
            {
                "series_id": sid,
                "title": rows[0].title,
                "organizer_email": rows[0].organizer,
                "organizer_name": names.get(rows[0].organizer, rows[0].organizer),
                "total": t,
                "attended": a,
                "missed": t - a,
                "rate": r,
                "previous_rate": pr,
                "delta": round(r - pr, 4) if r is not None and pr is not None else None,
                "at_risk": sid in risk_ids,
                "low_volume": t < MIN_SLOTS,
            }
        )
    series.sort(key=lambda s: (s["low_volume"], s["rate"], -s["missed"], s["title"]))

    # --- organizers (the rate of everything they organized)
    organizers = []
    for org, rows in _group(cur, lambda r: r.organizer).items():
        t, a = _totals(rows)
        organizers.append(
            {
                "email": org,
                "name": names.get(org, org),
                "series_count": len({r.series_id for r in rows}),
                "total": t,
                "attended": a,
                "rate": ratio(a, t),
                "low_volume": t < MIN_SLOTS,
            }
        )
    organizers.sort(key=lambda o: (o["low_volume"], o["rate"], o["name"]))

    # --- people to focus on: the most required meetings missed
    people = []
    for email, rows in _group(cur, lambda r: r.email).items():
        t, a = _totals(rows)
        if a == t:
            continue
        miss_by_series: dict[str, int] = defaultdict(int)
        titles = {}
        for r in rows:
            if not r.attended:
                miss_by_series[r.series_id] += 1
                titles[r.series_id] = r.title
        worst = max(miss_by_series, key=lambda s: miss_by_series[s])
        people.append(
            {
                "email": email,
                "name": names.get(email, email),
                "total": t,
                "attended": a,
                "missed": t - a,
                "rate": ratio(a, t),
                "repeat": email in repeat,
                "worst_series": titles[worst],
                "worst_series_id": worst,
                "worst_series_missed": miss_by_series[worst],
            }
        )
    people.sort(key=lambda p: (-p["missed"], p["rate"], p["name"]))

    return {
        "area": "meetings",
        "as_of": now.isoformat(),
        "timezone": str(tz),
        "period": period.info(tz),
        "scope": {"people": people_in_scope},
        "thresholds": {
            "target": TARGET,
            "at_risk_below": AT_RISK_BELOW,
            "min_slots": MIN_SLOTS,
            "repeat_misses": REPEAT_MISSES,
        },
        "kpis": kpis,
        "trend": _trend(cur, prev, period, tz),
        "weekday": weekday,
        "turnout": turnout,
        "series": series[:LIST_LIMIT],
        "series_total": len(series),
        "organizers": organizers[:LIST_LIMIT],
        "people": people[:LIST_LIMIT],
        "people_total": len(people),
        "at_risk_series": [s for s in series if s["at_risk"]][:LIST_LIMIT],
    }


def build(db: Session, viewer: OrgUser, days: int, now: datetime) -> dict:
    tz = get_timezone(db)
    visible = sorted(access.visible_emails(db, viewer.email))
    period = Period.ending(now, days, tz)
    cur = fetch_rows(db, visible, period.start, period.end, now)
    prev = fetch_rows(db, visible, period.prev_start, period.start, now)
    wanted = {r.email for r in cur} | {r.organizer for r in cur} | {viewer.email}
    names = {e: n for e, n in db.execute(select(OrgUser.email, OrgUser.name).where(OrgUser.email.in_(wanted))).all()}
    return compute(cur, prev, names, period, tz, now, len(visible))
