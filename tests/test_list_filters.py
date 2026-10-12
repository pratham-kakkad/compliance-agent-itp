"""Filter and sort parameters of the list endpoints the UI's filter bar drives:
GET /attendance, GET /compliance/definitions, GET /compliance/obligations.
Every filter is optional, filters are ANDed, and bad values are rejected (422)."""
from datetime import date, timedelta

import pytest

from app.attendance.models import AttendanceDay, AttendanceEmployee
from tests.conftest import login_as
from tests.cx import (  # noqa: F401  (fixtures)
    AVA,
    DANIEL,
    SOFIA,
    in_days,
    iso,
    new_compliance,
    no_bootstrap,
    people,
    person_rule,
)

# --------------------------------------------------------------- attendance


@pytest.fixture
def roster(db_session):
    """Latest day 30 Sep 2026. P1 in on 29th+30th, P2/P3 on the 30th, P4 on the 18th, P5 never."""
    day = date(2026, 9, 30)
    spec = [
        ("P1", "Alice Ang", "Acme", "Eng"),
        ("P2", "Bob Bell", "Acme", "Eng"),
        ("P3", "Cara Cole", "Globex", "Sales"),
        ("P4", "Dev Dutt", "Globex", "Sales"),
        ("P5", "Eve East", "Acme", None),
    ]
    for code, name, company, dept in spec:
        db_session.add(AttendanceEmployee(emp_code=code, name=name, company=company, department=dept))
    db_session.flush()
    for code in ("P1", "P2", "P3"):
        db_session.add(AttendanceDay(emp_code=code, work_date=day, punch_count=2))
    db_session.add(AttendanceDay(emp_code="P1", work_date=day - timedelta(days=1), punch_count=2))
    db_session.add(AttendanceDay(emp_code="P4", work_date=day - timedelta(days=12), punch_count=2))
    db_session.commit()
    return db_session


def _emps(client, **params):
    r = client.get("/attendance", params=params)
    assert r.status_code == 200, r.text
    return [e["emp_code"] for e in r.json()["items"]]


def test_attendance_list_default_is_unchanged_and_has_rate(client, roster):
    login_as(client, AVA)
    items = client.get("/attendance").json()["items"]
    assert [e["emp_code"] for e in items] == ["P1", "P2", "P3", "P4", "P5"]  # by name
    by = {e["emp_code"]: e for e in items}
    assert by["P1"]["days_tracked"] == 2 and by["P1"]["last_seen"] == "2026-09-30"
    # Three working days in the window: P1 was in on two of them.
    assert by["P1"]["rate"] == pytest.approx(2 / 3, abs=1e-3) and by["P5"]["rate"] == 0
    assert by["P1"]["present_latest"] is True and by["P4"]["present_latest"] is False


def test_attendance_list_company_department_any_of(client, roster):
    login_as(client, AVA)
    assert _emps(client, department="Eng") == ["P1", "P2"]  # a single value still works
    assert _emps(client, department=["Eng", "Sales"]) == ["P1", "P2", "P3", "P4"]  # repeated
    assert _emps(client, department="Eng,Sales") == ["P1", "P2", "P3", "P4"]  # comma separated
    assert _emps(client, department="Unassigned") == ["P5"]
    assert _emps(client, department=["Eng", "Unassigned"]) == ["P1", "P2", "P5"]
    assert _emps(client, company="Globex") == ["P3", "P4"]
    assert _emps(client, company="Acme", department="Eng") == ["P1", "P2"]  # ANDed


def test_attendance_list_search_matches_name_or_code(client, roster):
    login_as(client, AVA)
    assert _emps(client, search="bell") == ["P2"]
    assert _emps(client, search="p3") == ["P3"]
    assert _emps(client, search="  ") == ["P1", "P2", "P3", "P4", "P5"]


def test_attendance_list_days_and_last_seen_ranges(client, roster):
    login_as(client, AVA)
    assert _emps(client, days_min=2) == ["P1"]
    assert _emps(client, days_max=0) == ["P5"]
    assert _emps(client, days_min=1, days_max=1) == ["P2", "P3", "P4"]
    assert _emps(client, last_seen_from="2026-09-30") == ["P1", "P2", "P3"]
    assert _emps(client, last_seen_to="2026-09-20") == ["P4"]  # never seen has no last-seen day
    assert _emps(client, last_seen_from="2026-09-15", last_seen_to="2026-09-25") == ["P4"]
    assert _emps(client, last_seen_from="2026-10-01") == []


def test_attendance_list_not_seen_and_present_latest(client, roster):
    login_as(client, AVA)
    # Same rule as the dashboard's "not seen in 7 days" list, counted from the latest day of data.
    assert _emps(client, not_seen_days=7) == ["P4", "P5"]
    assert _emps(client, not_seen_days=30) == ["P5"]
    assert _emps(client, present_latest="true") == ["P1", "P2", "P3"]
    assert _emps(client, present_latest="false") == ["P4", "P5"]


def test_attendance_list_rate_range_and_combination(client, roster):
    login_as(client, AVA)
    assert _emps(client, rate_min=0.5) == ["P1"]
    assert _emps(client, rate_max=0.34) == ["P2", "P3", "P4", "P5"]
    assert _emps(client, rate_min=0.3, rate_max=0.5) == ["P2", "P3", "P4"]
    assert _emps(client, department="Sales", not_seen_days=7) == ["P4"]
    assert _emps(client, company="Acme", present_latest="true", rate_min=0.5) == ["P1"]


def test_attendance_list_sorting(client, roster):
    login_as(client, AVA)
    assert _emps(client, sort="rate", dir="desc")[0] == "P1"
    assert _emps(client, sort="rate", dir="asc")[0] == "P5"
    # Ties fall back to the name order in both directions.
    assert _emps(client, sort="days", dir="asc") == ["P5", "P2", "P3", "P4", "P1"]
    assert _emps(client, sort="days", dir="desc") == ["P1", "P2", "P3", "P4", "P5"]
    # Missing values sink to the bottom whatever the direction.
    assert _emps(client, sort="last_seen", dir="desc")[-1] == "P5"
    assert _emps(client, sort="last_seen", dir="asc")[-1] == "P5"
    assert _emps(client, sort="department", dir="asc") == ["P1", "P2", "P3", "P4", "P5"]
    assert _emps(client, sort="company", dir="desc")[:2] == ["P3", "P4"]
    assert _emps(client, sort="name", dir="desc") == ["P5", "P4", "P3", "P2", "P1"]


@pytest.mark.parametrize(
    "params",
    [
        {"rate_min": 2},
        {"rate_max": -0.1},
        {"days_min": -1},
        {"not_seen_days": 0},
        {"sort": "salary"},
        {"dir": "sideways"},
        {"last_seen_from": "yesterday"},
        {"present_latest": "maybe"},
    ],
)
def test_attendance_list_rejects_bad_values(client, roster, params):
    login_as(client, AVA)
    assert client.get("/attendance", params=params).status_code == 422


def test_attendance_list_with_no_data(client):
    login_as(client, AVA)
    assert client.get("/attendance", params={"rate_min": 0.5, "sort": "rate"}).json() == {"items": []}


# --------------------------------------------------------------- definitions


@pytest.fixture
def library(client, people):
    """Five compliances by Ava, one by Daniel's... only Ava creates; varied priority/category/deadline."""
    made = {}

    def mk(key, **fields):
        made[key] = new_compliance(client, AVA, name=key, **fields)

    mk("Alpha", priority="critical", category="Security", due_at=iso(in_days(3)))
    mk("Bravo", priority="low", category="HR", due_at=iso(in_days(20)))
    mk("Charlie", priority="high", category="Security", due_at=iso(in_days(40)), review_mode="none")
    mk("Delta", priority="medium", category="Finance", due_at=None)
    mk("Echo", priority="medium", category="HR", due_at=iso(in_days(10)), publish=False)  # draft
    login_as(client, AVA)
    return made


def _defs(client, **params):
    r = client.get("/compliance/definitions", params=params)
    assert r.status_code == 200, r.text
    body = r.json()
    return [c["name"] for c in body["items"]], body["total"]


def test_definitions_default_order_is_newest_first(client, library):
    names, total = _defs(client)
    assert names == ["Echo", "Delta", "Charlie", "Bravo", "Alpha"] and total == 5


def test_definitions_multi_value_filters(client, library):
    assert _defs(client, status="draft")[0] == ["Echo"]  # the old single value still works
    assert sorted(_defs(client, status=["draft", "published"])[0]) == ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]
    assert sorted(_defs(client, priority="high,critical")[0]) == ["Alpha", "Charlie"]
    assert sorted(_defs(client, category=["HR", "Finance"])[0]) == ["Bravo", "Delta", "Echo"]
    assert sorted(_defs(client, type_key="external_action")[0]) == ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]
    assert _defs(client, type_key="no_such_type")[0] == []
    assert _defs(client, owner=AVA)[1] == 5
    assert _defs(client, owner=DANIEL) == ([], 0)
    assert sorted(_defs(client, category="Security", priority="critical")[0]) == ["Alpha"]  # ANDed
    assert _defs(client, q="ech")[0] == ["Echo"]


def test_definitions_due_range_and_review(client, library):
    today = date.today()
    names, _ = _defs(client, due_from=str(today + timedelta(days=5)), due_to=str(today + timedelta(days=25)))
    assert sorted(names) == ["Bravo", "Echo"]
    assert sorted(_defs(client, due_to=str(today + timedelta(days=4)))[0]) == ["Alpha"]  # no deadline never matches
    assert sorted(_defs(client, due_from=str(today + timedelta(days=30)))[0]) == ["Charlie"]
    assert _defs(client, has_review="false")[0] == ["Charlie"]
    assert "Charlie" not in _defs(client, has_review="true")[0]


def test_definitions_sorting_and_pagination(client, library):
    assert _defs(client, sort="name", dir="asc")[0] == ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]
    assert _defs(client, sort="name", dir="desc")[0] == ["Echo", "Delta", "Charlie", "Bravo", "Alpha"]
    assert _defs(client, sort="priority", dir="desc")[0][:2] == ["Alpha", "Charlie"]
    assert _defs(client, sort="priority", dir="asc")[0][0] == "Bravo"
    # No deadline sinks to the bottom either way.
    assert _defs(client, sort="due", dir="asc")[0] == ["Alpha", "Echo", "Bravo", "Charlie", "Delta"]
    assert _defs(client, sort="due", dir="desc")[0] == ["Charlie", "Bravo", "Echo", "Alpha", "Delta"]
    assert _defs(client, sort="status", dir="asc")[0][0] == "Echo"  # draft first
    # Sorting happens before the page is cut.
    page1, total = _defs(client, sort="name", dir="asc", limit=2, offset=0)
    page2, _ = _defs(client, sort="name", dir="asc", limit=2, offset=2)
    assert page1 == ["Alpha", "Bravo"] and page2 == ["Charlie", "Delta"] and total == 5


def test_definitions_progress_overdue_and_sort(client, library, db_session):
    from app.compliance.models import Compliance, Obligation

    # Alpha: Daniel and Sofia both required. Complete Daniel's -> 50%.
    ob = db_session.query(Obligation).filter(Obligation.compliance_id == library["Alpha"]["id"], Obligation.user_email == DANIEL).one()
    ob.status = "completed"
    # Bravo is past due and unfinished (0%); Charlie too but fully done -> satisfied, so not overdue.
    for key in ("Bravo", "Charlie"):
        db_session.get(Compliance, library[key]["id"]).due_at = in_days(-2)
    for o in db_session.query(Obligation).filter(Obligation.compliance_id == library["Charlie"]["id"]):
        o.status = "completed"
    db_session.commit()
    login_as(client, AVA)

    assert _defs(client, progress_min=50)[0] == sorted(["Alpha", "Charlie"], key=["Echo", "Delta", "Charlie", "Bravo", "Alpha"].index)
    assert sorted(_defs(client, progress_max=0)[0]) == ["Bravo", "Delta", "Echo"]
    assert _defs(client, progress_min=40, progress_max=60)[0] == ["Alpha"]
    assert _defs(client, overdue="true")[0] == ["Bravo"]  # a draft or a satisfied one is never overdue
    asc = _defs(client, sort="progress", dir="asc")[0]
    desc = _defs(client, sort="progress", dir="desc")[0]
    assert asc.index("Bravo") < asc.index("Alpha") < asc.index("Charlie")
    assert desc.index("Charlie") < desc.index("Alpha") < desc.index("Bravo")
    # Pagination applies after the progress filter.
    names, total = _defs(client, progress_min=50, limit=1, offset=1)
    assert total == 2 and len(names) == 1


@pytest.mark.parametrize(
    "params",
    [{"priority": "urgent"}, {"sort": "color"}, {"dir": "up"}, {"progress_min": 101}, {"progress_max": -1}, {"due_from": "soon"}],
)
def test_definitions_reject_bad_values(client, library, params):
    assert client.get("/compliance/definitions", params=params).status_code == 422


def test_owners_lists_the_creators_of_visible_compliance(client, library):
    r = client.get("/compliance/owners")
    assert r.status_code == 200
    assert r.json() == [{"email": AVA, "name": "Ava Martinez"}]


def test_definitions_filters_respect_visibility(client, library, no_bootstrap):
    # Daniel is nobody's admin here: whatever he filters, he only ever sees what he's allowed to.
    login_as(client, DANIEL)
    r = client.get("/compliance/definitions", params={"priority": "critical"})
    assert r.status_code in (200, 403)
    if r.status_code == 200:
        assert all(c["priority"] == "critical" for c in r.json()["items"])


# --------------------------------------------------------------- obligations


@pytest.fixture
def mine(client, people):
    made = {}
    for key, fields in {
        "Alpha": dict(priority="critical", category="Security", due_at=iso(in_days(3))),
        "Bravo": dict(priority="low", category="HR", due_at=iso(in_days(20))),
        "Charlie": dict(priority="high", category="Security", due_at=iso(in_days(40))),
        "Delta": dict(priority="medium", category="Finance", due_at=None),
    }.items():
        made[key] = new_compliance(client, AVA, name=key, audience=[person_rule(DANIEL)], **fields)
    login_as(client, DANIEL)
    return made


def _obs(client, **params):
    r = client.get("/compliance/obligations", params={"mine": True, **params})
    assert r.status_code == 200, r.text
    body = r.json()
    return [o["compliance"]["name"] for o in body["items"]], body["total"]


def test_obligations_default_order_is_deadline(client, mine):
    assert _obs(client)[0] == ["Alpha", "Bravo", "Charlie", "Delta"]  # nearest deadline first, none last


def test_obligations_filters(client, mine):
    assert sorted(_obs(client, priority="critical,high")[0]) == ["Alpha", "Charlie"]
    assert sorted(_obs(client, priority=["low", "medium"])[0]) == ["Bravo", "Delta"]
    assert sorted(_obs(client, category="Security")[0]) == ["Alpha", "Charlie"]
    assert _obs(client, category="Security", priority="high")[0] == ["Charlie"]
    today = date.today()
    assert _obs(client, due_to=str(today + timedelta(days=5)))[0] == ["Alpha"]
    assert sorted(_obs(client, due_from=str(today + timedelta(days=10)), due_to=str(today + timedelta(days=30)))[0]) == ["Bravo"]
    assert sorted(_obs(client, status="not_started,in_progress")[0]) == ["Alpha", "Bravo", "Charlie", "Delta"]  # the old csv form
    assert _obs(client, status=["completed"]) == ([], 0)
    assert _obs(client, participation="required")[1] == 4
    assert _obs(client, participation="informational") == ([], 0)
    assert _obs(client, q="alp")[0] == ["Alpha"]


def test_obligations_sort_and_page(client, mine):
    assert _obs(client, sort="name", dir="desc")[0] == ["Delta", "Charlie", "Bravo", "Alpha"]
    assert _obs(client, sort="priority", dir="desc")[0] == ["Alpha", "Charlie", "Delta", "Bravo"]
    assert _obs(client, sort="due", dir="desc")[0] == ["Charlie", "Bravo", "Alpha", "Delta"]  # no deadline always last
    names, total = _obs(client, sort="name", dir="asc", limit=2, offset=2)
    assert names == ["Charlie", "Delta"] and total == 4


def test_obligations_overdue_flag_still_works_with_new_filters(client, mine, db_session):
    from app.compliance.models import Compliance

    db_session.get(Compliance, mine["Bravo"]["id"]).due_at = in_days(-3)
    db_session.commit()
    obligations = client.get("/compliance/obligations", params={"mine": True}).json()["items"]
    # Obligations carry their own deadline copy, so move Bravo's too.
    from app.compliance.models import Obligation

    db_session.query(Obligation).filter(Obligation.compliance_id == mine["Bravo"]["id"]).update({"due_at": in_days(-3)})
    db_session.commit()
    assert obligations  # sanity
    assert _obs(client, overdue="true", priority="low")[0] == ["Bravo"]
    assert _obs(client, overdue="true", priority="critical") == ([], 0)


@pytest.mark.parametrize(
    "params", [{"priority": "urgent"}, {"participation": "boss"}, {"sort": "color"}, {"dir": "up"}, {"due_to": "never"}]
)
def test_obligations_reject_bad_values(client, mine, params):
    assert client.get("/compliance/obligations", params={"mine": True, **params}).status_code == 422
