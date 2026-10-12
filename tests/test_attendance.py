import csv
import io
from datetime import date

from app.attendance.importer import import_punch_log
from app.attendance.models import AttendanceDay, AttendanceEmployee, BiometricPunchLog
from tests.conftest import login_as

HEADER = ["Log Date", "Device", "Emp Code", "Name", "Company", "Department"]


def _csv(rows: list[list]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(HEADER)
    writer.writerows(rows)
    return buf.getvalue().encode("utf-8")


def test_import_creates_employee_and_tracked_day(db_session):
    raw = _csv([
        ["01-09-2026 09:05", "Entry", "E100", "Test One", "Acme", "Eng"],
        ["01-09-2026 18:10", "Exit", "E100", "Test One", "Acme", "Eng"],
    ])
    result = import_punch_log(db_session, "test.csv", raw, imported_by="tester@corp.com")

    assert result.accepted == 2
    assert result.rejected == []
    assert result.employees_affected == 1

    employee = db_session.get(AttendanceEmployee, "E100")
    assert employee is not None
    assert employee.name == "Test One"

    day = db_session.query(AttendanceDay).filter_by(emp_code="E100", work_date=date(2026, 9, 1)).one()
    assert day.punch_count == 2
    assert day.first_punch.hour == 9 and day.first_punch.minute == 5
    assert day.last_punch.hour == 18 and day.last_punch.minute == 10


def test_log_date_parsed_day_first(db_session):
    # 03-04-2026 is DD-MM-YYYY, so 3 April — not 4 March.
    raw = _csv([
        ["03-04-2026 09:00", "Entry", "E101", "Test Two", "Acme", "Eng"],
    ])
    import_punch_log(db_session, "test.csv", raw, imported_by="tester@corp.com")

    day = db_session.query(AttendanceDay).filter_by(emp_code="E101").one()
    assert day.work_date == date(2026, 4, 3)


def test_single_punch_still_tracks_the_day(db_session):
    raw = _csv([
        ["02-09-2026 09:00", "Entry", "E102", "Test Three", "Acme", "Eng"],
    ])
    import_punch_log(db_session, "test.csv", raw, imported_by="tester@corp.com")

    day = db_session.query(AttendanceDay).filter_by(emp_code="E102", work_date=date(2026, 9, 2)).one()
    assert day.punch_count == 1
    assert day.first_punch == day.last_punch


def test_extra_columns_are_ignored(db_session):
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Log Date", "Device", "Direction", "Emp Code", "Name", "Company", "Department", "Category", "Status", "EmploymentType"])
    writer.writerow(["04-09-2026 09:00", "Entry", "IN", "E103", "Test Four", "Acme", "Eng", "Staff", "Valid", "Full-Time"])
    raw = buf.getvalue().encode("utf-8")

    result = import_punch_log(db_session, "test.csv", raw, imported_by="tester@corp.com")

    assert result.accepted == 1
    day = db_session.query(AttendanceDay).filter_by(emp_code="E103", work_date=date(2026, 9, 4)).one()
    assert day.punch_count == 1


def test_missing_required_field_is_rejected(db_session):
    raw = _csv([
        ["05-09-2026 09:00", "Entry", "", "No Code", "Acme", "Eng"],
    ])
    result = import_punch_log(db_session, "test.csv", raw, imported_by="tester@corp.com")

    assert result.accepted == 0
    assert len(result.rejected) == 1
    assert "Emp Code" in result.rejected[0].reason


def test_attendance_endpoints_require_login_and_list_employees(client, db_session):
    raw = _csv([
        ["06-09-2026 09:00", "Entry", "E104", "Test Five", "Acme", "Eng"],
        ["06-09-2026 18:00", "Exit", "E104", "Test Five", "Acme", "Eng"],
    ])
    import_punch_log(db_session, "test.csv", raw, imported_by="tester@corp.com")

    assert client.get("/attendance").status_code == 401

    login_as(client, "ava.martinez@corp.com")
    body = client.get("/attendance").json()
    codes = [e["emp_code"] for e in body["items"]]
    assert "E104" in codes

    detail = client.get("/attendance/E104").json()
    assert detail["name"] == "Test Five"
    assert detail["total_days_tracked"] == 1
    assert detail["days"][0]["punch_count"] == 2
    assert client.get("/attendance/NOPE").status_code == 404


def test_dashboard_insights_for_admins(client, db_session):
    from datetime import timedelta

    from app.attendance.models import AttendanceEmployee

    day = date(2026, 9, 30)
    people = [("P1", "Eng"), ("P2", "Eng"), ("P3", "Sales"), ("P4", "Sales")]
    for code, dept in people:
        db_session.add(AttendanceEmployee(emp_code=code, name=f"Person {code}", company="Acme", department=dept))
    db_session.flush()
    # Latest day (30 Sep): P1, P2, P3 present. P4 was last seen 12 days earlier; P5 never.
    for code in ("P1", "P2", "P3"):
        db_session.add(AttendanceDay(emp_code=code, work_date=day, punch_count=2))
    db_session.add(AttendanceDay(emp_code="P1", work_date=day - timedelta(days=1), punch_count=2))
    db_session.add(AttendanceDay(emp_code="P4", work_date=day - timedelta(days=12), punch_count=2))
    db_session.add(AttendanceEmployee(emp_code="P5", name="Person P5", company="Acme", department=None))
    db_session.commit()

    login_as(client, "ava.martinez@corp.com")
    ins = client.get("/attendance/dashboard").json()["insights"]
    assert ins["headcount"] == 5 and ins["latest_day"] == "2026-09-30"
    assert ins["present_latest"] == 3 and round(ins["present_rate"], 2) == 0.6
    # Not seen in 7 days: P4 and P5 (never), never-seen first.
    assert ins["quiet_count"] == 2 and [q["emp_code"] for q in ins["quiet"]] == ["P5", "P4"]
    assert ins["quiet"][0]["last_seen"] is None and ins["quiet"][1]["days_quiet"] == 12
    # 4 working days in the window (29 Sep, 30 Sep, 18 Sep): Eng has 2 people.
    dept = {d["department"]: d for d in ins["by_department"]}
    assert dept["Eng"]["headcount"] == 2 and 0 < dept["Eng"]["rate"] <= 1
    assert dept["Unassigned"]["rate"] == 0
    assert ins["by_department"][0]["rate"] <= ins["by_department"][-1]["rate"]  # lowest first
    assert ins["weekly_presence"] and all(0 <= w["rate"] <= 1 for w in ins["weekly_presence"])


def test_dashboard_insights_with_no_data(client):
    login_as(client, "ava.martinez@corp.com")
    ins = client.get("/attendance/dashboard").json()["insights"]
    assert ins["latest_day"] is None and ins["present_rate"] is None and ins["quiet"] == [] and ins["by_department"] == []


def test_insights_ignore_weekends_when_picking_the_day_and_rates(client, db_session):
    from datetime import timedelta

    from app.attendance.models import AttendanceEmployee

    codes = [f"W{i}" for i in range(10)]
    for c in codes:
        db_session.add(AttendanceEmployee(emp_code=c, name=c, company="Acme", department="Eng"))
    db_session.flush()
    friday = date(2026, 9, 18)  # a Friday
    for back in range(0, 5):  # Mon 14 .. Fri 18: eight of ten people each day
        for c in codes[:8]:
            db_session.add(AttendanceDay(emp_code=c, work_date=friday - timedelta(days=back), punch_count=2))
    db_session.add(AttendanceDay(emp_code="W9", work_date=friday + timedelta(days=2), punch_count=1))  # Sunday: one person on call
    db_session.commit()

    login_as(client, "ava.martinez@corp.com")
    ins = client.get("/attendance/dashboard").json()["insights"]
    assert ins["latest_data_day"] == "2026-09-20"  # the Sunday has data...
    assert ins["latest_day"] == "2026-09-18"  # ...but the day we report on is the Friday
    assert ins["present_latest"] == 8 and round(ins["present_rate"], 2) == 0.8
    assert round(ins["by_department"][0]["rate"], 2) == 0.8  # the Sunday doesn't pull it down
    assert round(ins["weekly_presence"][-1]["rate"], 2) == 0.8
