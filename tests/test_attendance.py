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
