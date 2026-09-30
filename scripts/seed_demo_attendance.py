"""Seed realistic-looking demo biometric punch data for the 3 demo
employees, through the real import path (builds an in-memory CSV matching
the actual device export schema and runs it through
app.attendance.importer.import_punch_log) — so this also doubles as a
smoke test of the importer itself.

Idempotent: every run first removes the punches (and import batches) of
earlier runs of this script — only batches imported by
"seed_demo_attendance.py", never any other import — recomputes or removes
the attendance days those punches made, then imports a fresh sheet for the
last 14 days. It runs on every container start (docker-entrypoint.sh), so
demo punch counts no longer grow with each restart.

The sheet is imported in the organization time zone, so the demo punches
read 09:05, 18:10, ... on the clock whatever zone is set in Settings (they
are stored in UTC like every punch).

Usage: python scripts/seed_demo_attendance.py
"""
import csv
import io
import sys
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.attendance.importer import ImportResult, import_punch_log
from app.attendance.models import BiometricPunchLog, ImportBatch
from app.attendance.rules import local_work_date, recompute_days
from app.database import SessionLocal
from app.org_settings.service import get_timezone, get_timezone_name, lock_zone_shared, org_today

SEED_IMPORTED_BY = "seed_demo_attendance.py"
SEED_FILENAME = "demo_punch_log.csv"
COMPANY = "Acme Corp"
DEPARTMENT = "Engineering"
EMPLOYEES = [
    {"emp_code": "EMP001", "name": "Ava Martinez"},
    {"emp_code": "EMP002", "name": "Daniel Kim"},
    {"emp_code": "EMP003", "name": "Sofia Rossi"},
]

HEADER = ["Log Date", "Device", "Emp Code", "Name", "Company", "Department"]


def _row(day: date, hour: int, minute: int, device: str, emp: dict) -> list:
    return [
        datetime.combine(day, time(hour, minute)).strftime("%d-%m-%Y %H:%M"),
        device,
        emp["emp_code"],
        emp["name"],
        COMPANY,
        DEPARTMENT,
    ]


def build_rows(today: date) -> list[list]:
    """Wall-clock punches for the weekdays among the 14 days before `today`."""
    rows: list[list] = []

    workdays = []
    cursor = today - timedelta(days=14)
    while cursor < today:
        if cursor.weekday() < 5:
            workdays.append(cursor)
        cursor += timedelta(days=1)

    for i, day in enumerate(workdays):
        ava, daniel, sofia = EMPLOYEES

        # Ava: consistently present, in and out every day.
        rows.append(_row(day, 9, 5, "Entry", ava))
        rows.append(_row(day, 18, 10, "Exit", ava))

        # Daniel: mostly present, one day with just a single punch.
        rows.append(_row(day, 9, 15, "Entry", daniel))
        if i != 3:
            rows.append(_row(day, 18, 0, "Exit", daniel))

        # Sofia: present most days, a couple of early departures.
        rows.append(_row(day, 9, 30, "Entry", sofia))
        if i in (2, 9):
            rows.append(_row(day, 15, 45, "Exit", sofia))
        else:
            rows.append(_row(day, 18, 20, "Exit", sofia))

    return rows


def _csv_bytes(rows: list[list]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(HEADER)
    writer.writerows(rows)
    return buf.getvalue().encode("utf-8")


@dataclass
class SeedResult:
    removed_batches: int
    removed_punches: int
    import_result: ImportResult


def remove_previous_seed(db: Session) -> tuple[int, int]:
    """Delete the punches and import batches of earlier runs of this script
    (and only those), then recompute or remove the attendance days they
    made. Real imports on the same employees/days are recomputed, not lost.
    Commits. Returns (batches removed, punches removed)."""
    batch_ids = db.scalars(select(ImportBatch.id).where(ImportBatch.imported_by == SEED_IMPORTED_BY)).all()
    if not batch_ids:
        return 0, 0

    lock_zone_shared(db)  # like an import: the zone can't change until the commit
    tz = get_timezone(db)
    punches = db.execute(
        select(BiometricPunchLog.emp_code, BiometricPunchLog.log_date).where(
            BiometricPunchLog.import_batch_id.in_(batch_ids)
        )
    ).all()
    # Days in the organization zone, plus each punch's UTC date: days from
    # before time zones existed were grouped by UTC date and may not have
    # been recomputed yet.
    stale: set[tuple[str, date]] = set()
    for emp_code, log_date in punches:
        stale.add((emp_code, local_work_date(log_date, tz)))
        stale.add((emp_code, local_work_date(log_date, timezone.utc)))

    db.execute(
        delete(BiometricPunchLog)
        .where(BiometricPunchLog.import_batch_id.in_(batch_ids))
        .execution_options(synchronize_session=False)
    )
    db.execute(
        delete(ImportBatch).where(ImportBatch.id.in_(batch_ids)).execution_options(synchronize_session=False)
    )
    recompute_days(db, stale, tz)  # commits; days with no punches left are deleted
    return len(batch_ids), len(punches)


def seed(db: Session, today: date | None = None) -> SeedResult:
    removed_batches, removed_punches = remove_previous_seed(db)
    zone = get_timezone_name(db)
    raw = _csv_bytes(build_rows(today or org_today(db)))
    result = import_punch_log(db, SEED_FILENAME, raw, imported_by=SEED_IMPORTED_BY, source_timezone=zone)
    return SeedResult(removed_batches, removed_punches, result)


def main() -> None:
    db = SessionLocal()
    try:
        outcome = seed(db)
        result = outcome.import_result
        if outcome.removed_batches:
            print(
                f"Removed {outcome.removed_punches} punch rows from {outcome.removed_batches} earlier demo seed run(s)."
            )
        print(
            f"Imported {result.accepted}/{result.row_count} punch rows across {result.employees_affected} "
            f"employee(s), times in {result.source_timezone}."
        )
        if result.rejected:
            print(f"Rejected: {result.rejected}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
