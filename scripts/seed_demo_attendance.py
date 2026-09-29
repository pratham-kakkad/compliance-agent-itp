"""Seed realistic-looking demo biometric punch data for the 3 demo
employees, through the real import path (builds an in-memory CSV matching
the actual device export schema and runs it through
app.attendance.importer.import_punch_log) — so this also doubles as a
smoke test of the importer itself. Safe to re-run: recompute_days
overwrites AttendanceDay rows for whatever days are touched.

Usage: python scripts/seed_demo_attendance.py
"""
import csv
import io
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.attendance.importer import import_punch_log
from app.database import SessionLocal

COMPANY = "Acme Corp"
DEPARTMENT = "Engineering"
EMPLOYEES = [
    {"emp_code": "EMP001", "name": "Ava Martinez"},
    {"emp_code": "EMP002", "name": "Daniel Kim"},
    {"emp_code": "EMP003", "name": "Sofia Rossi"},
]

HEADER = ["Log Date", "Device", "Emp Code", "Name", "Company", "Department"]


def _row(log_date: datetime, device: str, emp: dict) -> list:
    return [
        log_date.strftime("%d-%m-%Y %H:%M"),
        device,
        emp["emp_code"],
        emp["name"],
        COMPANY,
        DEPARTMENT,
    ]


def build_rows() -> list[list]:
    rows: list[list] = []
    today = datetime.now().date()

    # Last 14 calendar days, weekdays only.
    workdays = []
    cursor = today - timedelta(days=14)
    while cursor < today:
        if cursor.weekday() < 5:
            workdays.append(cursor)
        cursor += timedelta(days=1)

    for i, day in enumerate(workdays):
        ava, daniel, sofia = EMPLOYEES

        # Ava: consistently present, in and out every day.
        rows.append(_row(datetime.combine(day, datetime.min.time()).replace(hour=9, minute=5), "Entry", ava))
        rows.append(_row(datetime.combine(day, datetime.min.time()).replace(hour=18, minute=10), "Exit", ava))

        # Daniel: mostly present, one day with just a single punch.
        rows.append(_row(datetime.combine(day, datetime.min.time()).replace(hour=9, minute=15), "Entry", daniel))
        if i != 3:
            rows.append(_row(datetime.combine(day, datetime.min.time()).replace(hour=18, minute=0), "Exit", daniel))

        # Sofia: present most days, a couple of early departures.
        rows.append(_row(datetime.combine(day, datetime.min.time()).replace(hour=9, minute=30), "Entry", sofia))
        if i in (2, 9):
            rows.append(_row(datetime.combine(day, datetime.min.time()).replace(hour=15, minute=45), "Exit", sofia))
        else:
            rows.append(_row(datetime.combine(day, datetime.min.time()).replace(hour=18, minute=20), "Exit", sofia))

    return rows


def main() -> None:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(HEADER)
    writer.writerows(build_rows())
    raw = buf.getvalue().encode("utf-8")

    db = SessionLocal()
    try:
        result = import_punch_log(db, "demo_punch_log.csv", raw, imported_by="seed_demo_attendance.py")
        print(f"Imported {result.accepted}/{result.row_count} punch rows across {result.employees_affected} employee(s).")
        if result.rejected:
            print(f"Rejected: {result.rejected}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
