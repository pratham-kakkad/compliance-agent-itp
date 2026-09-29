"""Aggregation logic for the Attendance agent.

Deliberately simple for this pass: attendance is the main thing being
tracked, not hours or duration. For every (emp_code, work_date) touched by
an import, every punch that landed on that day is read back from
BiometricPunchLog and rolled into one AttendanceDay row — first punch time,
last punch time, and how many punches were seen. There's no Entry/Exit
direction logic and no worked-hours calculation here.

No shift/roster calendar exists yet (the punch log has no "expected start
time" for anyone), and absence isn't tracked either: a day with zero
punches simply has no AttendanceDay row, since we have no roster telling us
who was actually expected to work that day.
"""
from collections import defaultdict
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.attendance.models import AttendanceDay, BiometricPunchLog


def recompute_days(db: Session, emp_codes_and_dates: set[tuple[str, date]]) -> None:
    """Recompute AttendanceDay for exactly the (emp_code, work_date) pairs
    touched by an import batch. Re-reads every punch for those pairs from
    BiometricPunchLog, so it's safe to call repeatedly (e.g. after a second
    import that adds a punch to an already-imported day)."""
    if not emp_codes_and_dates:
        return

    emp_codes = {e for e, _ in emp_codes_and_dates}
    rows = db.execute(
        select(BiometricPunchLog).where(BiometricPunchLog.emp_code.in_(emp_codes))
    ).scalars().all()

    by_pair: dict[tuple[str, date], list[BiometricPunchLog]] = defaultdict(list)
    for row in rows:
        pair = (row.emp_code, row.log_date.date())
        if pair in emp_codes_and_dates:
            by_pair[pair].append(row)

    for pair in emp_codes_and_dates:
        emp_code, work_date = pair
        punches = sorted(p.log_date for p in by_pair.get(pair, []))

        if not punches:
            continue  # nothing for this day — no row, per the module docstring

        existing = db.scalar(
            select(AttendanceDay).where(
                AttendanceDay.emp_code == emp_code, AttendanceDay.work_date == work_date
            )
        )
        if existing is None:
            existing = AttendanceDay(emp_code=emp_code, work_date=work_date)
            db.add(existing)
        existing.first_punch = punches[0]
        existing.last_punch = punches[-1]
        existing.punch_count = len(punches)

    db.commit()
