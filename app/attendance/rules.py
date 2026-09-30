"""Aggregation logic for the Attendance agent.

Deliberately simple for this pass: attendance is the main thing being
tracked, not hours or duration. For every (emp_code, work_date) touched by
an import, every punch that landed on that day is read back from
BiometricPunchLog and rolled into one AttendanceDay row — first punch time,
last punch time, and how many punches were seen. There's no Entry/Exit
direction logic and no worked-hours calculation here.

Punches are stored as UTC instants. A punch's day is its calendar date in
the organization time zone (app/org_settings/service.py), so e.g. with
Asia/Kolkata a punch at 20:00 UTC counts for the next day (01:30 local).
first_punch/last_punch stay UTC instants; only work_date is local.

No shift/roster calendar exists yet (the punch log has no "expected start
time" for anyone), and absence isn't tracked either: a day with zero
punches simply has no AttendanceDay row, since we have no roster telling us
who was actually expected to work that day.
"""
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone, tzinfo

from sqlalchemy import delete, insert, select, update
from sqlalchemy.orm import Session

from app.attendance.models import AttendanceDay, AttendanceEmployee, BiometricPunchLog
from app.org_settings.service import as_utc, get_timezone

_CHUNK = 5000


def local_work_date(instant: datetime, tz: tzinfo) -> date:
    """The calendar day a (UTC) punch belongs to in the organization zone."""
    return as_utc(instant).astimezone(tz).date()


def _summaries(rows, tz: tzinfo, wanted: set[tuple[str, date]] | None = None) -> dict[tuple[str, date], list]:
    """(emp_code, local date) -> [first, last, count] over (emp_code, log_date) rows."""
    out: dict[tuple[str, date], list] = {}
    for emp_code, log_date in rows:
        instant = as_utc(log_date)
        pair = (emp_code, instant.astimezone(tz).date())
        if wanted is not None and pair not in wanted:
            continue
        s = out.get(pair)
        if s is None:
            out[pair] = [instant, instant, 1]
        else:
            if instant < s[0]:
                s[0] = instant
            if instant > s[1]:
                s[1] = instant
            s[2] += 1
    return out


def recompute_days(
    db: Session,
    emp_codes_and_dates: set[tuple[str, date]],
    tz: tzinfo | None = None,
    *,
    commit: bool = True,
) -> None:
    """Recompute AttendanceDay for exactly the given (emp_code, work_date)
    pairs, work_date being a date in `tz` (default: the organization zone).
    Re-reads every punch of those days from BiometricPunchLog, so it's safe
    to call repeatedly (e.g. after a second import that adds a punch to an
    already-imported day). A pair with no punches left loses its
    AttendanceDay row. Commits, unless commit=False (then it only flushes and
    the caller commits, e.g. an import that must be all or nothing)."""
    if not emp_codes_and_dates:
        return
    tz = tz or get_timezone(db)

    wanted = set(emp_codes_and_dates)
    emp_codes = sorted({e for e, _ in wanted})
    first_day = min(d for _, d in wanted)
    last_day = max(d for _, d in wanted)
    # A local day spans at most UTC-12..UTC+14 around its UTC date, so one
    # spare day on each side covers every zone (exact filtering is below).
    lo = datetime.combine(first_day - timedelta(days=1), time.min, tzinfo=timezone.utc)
    hi = datetime.combine(last_day + timedelta(days=2), time.min, tzinfo=timezone.utc)

    punches = db.execute(
        select(BiometricPunchLog.emp_code, BiometricPunchLog.log_date).where(
            BiometricPunchLog.emp_code.in_(emp_codes),
            BiometricPunchLog.log_date >= lo,
            BiometricPunchLog.log_date < hi,
        )
    ).all()
    summaries = _summaries(punches, tz, wanted)

    existing = {
        (row.emp_code, row.work_date): row
        for row in db.execute(
            select(AttendanceDay).where(
                AttendanceDay.emp_code.in_(emp_codes),
                AttendanceDay.work_date >= first_day,
                AttendanceDay.work_date <= last_day,
            )
        ).scalars()
        if (row.emp_code, row.work_date) in wanted
    }

    for pair in wanted:
        emp_code, work_date = pair
        summary = summaries.get(pair)
        day = existing.get(pair)
        if summary is None:
            if day is not None:
                db.delete(day)  # its punches are gone (or now belong to another day)
            continue
        if day is None:
            day = AttendanceDay(emp_code=emp_code, work_date=work_date)
            db.add(day)
        day.first_punch, day.last_punch, day.punch_count = summary

    if commit:
        db.commit()
    else:
        db.flush()


def recompute_all_days(db: Session, tz: tzinfo) -> int:
    """Rebuild every AttendanceDay from BiometricPunchLog with days taken in
    `tz` — used when the organization zone changes. Rows are diffed rather
    than dropped: unchanged days keep their row (and id), changed ones are
    updated, days that no longer exist are deleted and new ones inserted, in
    bulk statements. Does not commit (the caller does, so a zone change is
    all or nothing). The caller holds the exclusive zone lock
    (org_settings.service.lock_zone_exclusive), so no import commits between
    the punch scan and the day diff below. Returns the number of
    AttendanceDay rows afterwards."""
    db.flush()  # pending ORM changes first: the bulk statements bypass the unit of work

    punches = (
        db.execute(
            select(BiometricPunchLog.emp_code, BiometricPunchLog.log_date).join(
                AttendanceEmployee, AttendanceEmployee.emp_code == BiometricPunchLog.emp_code
            )
        )
        .yield_per(_CHUNK)
    )
    computed = _summaries(punches, tz)

    existing = {
        (r.emp_code, r.work_date): r
        for r in db.execute(
            select(
                AttendanceDay.id,
                AttendanceDay.emp_code,
                AttendanceDay.work_date,
                AttendanceDay.first_punch,
                AttendanceDay.last_punch,
                AttendanceDay.punch_count,
            )
        )
    }

    stale_ids = [r.id for pair, r in existing.items() if pair not in computed]
    changed = []
    new = []
    for pair, (first, last, count) in computed.items():
        r = existing.get(pair)
        if r is None:
            new.append(
                {"emp_code": pair[0], "work_date": pair[1], "first_punch": first, "last_punch": last, "punch_count": count}
            )
        elif (r.first_punch, r.last_punch, r.punch_count) != (first, last, count):
            changed.append({"id": r.id, "first_punch": first, "last_punch": last, "punch_count": count})

    for i in range(0, len(stale_ids), _CHUNK):
        db.execute(
            delete(AttendanceDay).where(AttendanceDay.id.in_(stale_ids[i : i + _CHUNK])),
            execution_options={"synchronize_session": False},
        )
    for i in range(0, len(changed), _CHUNK):
        db.execute(update(AttendanceDay), changed[i : i + _CHUNK])
    for i in range(0, len(new), _CHUNK):
        db.execute(insert(AttendanceDay), new[i : i + _CHUNK])

    db.expire_all()  # ORM objects loaded earlier may describe rows changed above
    return len(computed)
