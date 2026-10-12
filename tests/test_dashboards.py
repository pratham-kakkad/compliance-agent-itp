"""Dashboard aggregation: the arithmetic of every KPI on small, hand-checkable fixtures,
the "no data is never 0" rule, and who sees what. Times are fixed (NOW) so the results do not
depend on the day the tests run."""
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app.attendance.models import AttendanceDay, AttendanceEmployee
from app.compliance.models import Compliance, Obligation
from app.compliance.policy import Ctx
from app.dashboards import biometric_kpis, compliance_kpis, meetings_kpis, overview
from app.dashboards.common import Period, kpi
from app.models import Attendance, MeetingOccurrence, MeetingSeries, OrgUser
from tests.conftest import login_as
from tests.cx import AVA, BEA, CARL, DANIEL, SOFIA, no_bootstrap, people  # noqa: F401  (fixtures)

NOW = datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc)  # a Friday


def dt(month: int, day: int, hour: int = 0, minute: int = 0, second: int = 0) -> datetime:
    return datetime(2026, month, day, hour, minute, second, tzinfo=timezone.utc)


# --------------------------------------------------------------------- common


def test_kpi_delta_and_no_data():
    k = kpi("x", "X", "def", "percent", 0.7, previous=0.75, good="up")
    assert k["delta"] == -0.05 and k["no_data"] is None
    empty = kpi("x", "X", "def", "percent", None, previous=0.5, tone="crit", no_data="because")
    assert empty["value"] is None and empty["delta"] is None
    assert empty["tone"] == "neutral" and empty["no_data"] == "because"


def test_period_is_whole_local_days_and_the_equal_window_before():
    p = Period.ending(NOW, 7)  # UTC: Oct 3 .. Oct 9 (today included), and Sep 26 .. Oct 2 before it
    assert p.start == dt(10, 3) and p.prev_start == dt(9, 26) and p.end == NOW
    ist = ZoneInfo("Asia/Kolkata")
    q = Period.ending(dt(10, 9, 22), 1, ist)  # 03:30 on Oct 10 in Kolkata: "today" there is Oct 10
    assert q.start == dt(10, 9, 18, 30) and q.prev_start == dt(10, 8, 18, 30)
    assert q.local_dates(ist) == (date(2026, 10, 10), date(2026, 10, 10))


# ------------------------------------------------------------------- meetings


def _meeting(db, title, organizer, when, required, attended, optional=(), hours=1):
    """One series of length one with a single occurrence at `when`; `required` / `attended` are emails."""
    s = db.query(MeetingSeries).filter_by(external_id=title).first()
    if s is None:
        s = MeetingSeries(external_id=title, title=title, organizer_email=organizer, recurrence="weekly")
        db.add(s)
        db.flush()
    occ = MeetingOccurrence(series_id=s.id, external_occurrence_id=when.isoformat(), start_time=when, end_time=when + timedelta(hours=hours))
    db.add(occ)
    db.flush()
    for email in required:
        db.add(Attendance(occurrence_id=occ.id, attendee_email=email, required=True, attended=email in attended))
    for email in optional:
        db.add(Attendance(occurrence_id=occ.id, attendee_email=email, required=False, attended=False))
    db.commit()


@pytest.fixture
def meetings(db_session):
    db = db_session
    both = [DANIEL, SOFIA]
    # current 7 days (Oct 2 12:00 - Oct 9 12:00): S1 "Standup" by Ava, S2 "Review" by Daniel
    _meeting(db, "Standup", AVA, dt(10, 5, 9), both, {DANIEL, SOFIA}, optional=[AVA])  # Mon: 2/2
    _meeting(db, "Standup", AVA, dt(10, 6, 9), both, {DANIEL})  # Tue: 1/2
    _meeting(db, "Standup", AVA, dt(10, 7, 9), both, set())  # Wed: 0/2
    _meeting(db, "Standup", AVA, dt(10, 8, 15), both, {DANIEL})  # Thu: 1/2
    _meeting(db, "Review", DANIEL, dt(10, 8, 10), both, {DANIEL, SOFIA})  # Thu: 2/2
    _meeting(db, "Review", DANIEL, dt(10, 3, 10), both, {DANIEL, SOFIA})  # Sat: 2/2
    # a meeting that has not ended yet never counts
    _meeting(db, "Standup", AVA, dt(10, 9, 15), both, set())
    # previous 7 days: Standup 2/2, Review 1/2
    _meeting(db, "Standup", AVA, dt(9, 28, 9), both, {DANIEL, SOFIA})
    _meeting(db, "Review", DANIEL, dt(9, 29, 9), both, {DANIEL})
    return db


def test_meetings_kpi_arithmetic(meetings):
    ava = meetings.get(OrgUser, AVA)
    out = meetings_kpis.build(meetings, ava, 7, NOW)
    k = out["kpis"]

    # 12 required attendances, 8 attended (the optional invitee and the future meeting are not counted)
    assert (k["attendance"]["numerator"], k["attendance"]["denominator"]) == (8, 12)
    assert k["attendance"]["value"] == pytest.approx(0.6667, abs=1e-4)
    # previous period: 3 of 4 = 75%
    assert k["attendance"]["previous"] == 0.75
    assert k["attendance"]["delta"] == pytest.approx(-0.0833, abs=1e-4)
    assert k["attendance"]["tone"] == "crit" and k["attendance"]["target"] == 0.9

    # Standup 4/8 = 50% is below 75% (and has >= 3 slots); Review 4/4 is fine. Last week had < 3 slots each.
    assert k["series_at_risk"]["value"] == 1 and k["series_at_risk"]["denominator"] == 2
    assert k["series_at_risk"]["previous"] is None
    assert [s["title"] for s in out["at_risk_series"]] == ["Standup"]

    # Sofia missed Tue, Wed, Thu = 3 -> repeat; Daniel missed 1
    assert k["repeat_absentees"]["value"] == 1
    assert [(p["email"], p["missed"], p["total"], p["repeat"]) for p in out["people"]] == [(SOFIA, 3, 6, True), (DANIEL, 1, 6, False)]
    assert out["people"][0]["worst_series"] == "Standup"

    assert k["meetings_held"]["value"] == 6 and k["meetings_held"]["previous"] == 2


def test_meetings_weekday_turnout_and_rankings(meetings):
    out = meetings_kpis.build(meetings, meetings.get(OrgUser, AVA), 7, NOW)
    wd = {d["day"]: (d["attended"], d["total"]) for d in out["weekday"]}
    assert wd["Mon"] == (2, 2) and wd["Tue"] == (1, 2) and wd["Wed"] == (0, 2) and wd["Thu"] == (3, 4) and wd["Sat"] == (2, 2)
    assert wd["Fri"] == (0, 0) and next(d for d in out["weekday"] if d["day"] == "Fri")["rate"] is None

    # 3 meetings with everybody, 2 with some, 1 with nobody
    assert out["turnout"] == {"full": 3, "partial": 2, "none": 1, "total": 6}

    assert [(s["title"], s["attended"], s["total"], s["organizer_name"]) for s in out["series"]] == [
        ("Standup", 4, 8, "Ava Martinez"),
        ("Review", 4, 4, "Daniel Kim"),
    ]
    assert [(o["email"], o["rate"]) for o in out["organizers"]] == [(AVA, 0.5), (DANIEL, 1.0)]


def test_meetings_trend_buckets_are_daily_for_a_week(meetings):
    out = meetings_kpis.build(meetings, meetings.get(OrgUser, AVA), 7, NOW)
    t = out["trend"]
    assert t["daily"] is True and len(t["points"]) == 7  # Oct 3 .. Oct 9
    by_day = {p["start"]: (p["attended"], p["total"]) for p in t["points"]}
    assert by_day["2026-10-05"] == (2, 2) and by_day["2026-10-07"] == (0, 2)
    # the previous period lines up bucket for bucket (Oct 9 <-> Oct 2, Oct 5 <-> Sep 28)
    prev = {p["start"]: p["previous_rate"] for p in t["points"]}
    assert prev["2026-10-05"] == 1.0


def test_meetings_scope_is_the_reporting_line(meetings):
    # Daniel has no reports: the dashboard is just his own 6 slots (attended 5)
    out = meetings_kpis.build(meetings, meetings.get(OrgUser, DANIEL), 7, NOW)
    assert (out["kpis"]["attendance"]["numerator"], out["kpis"]["attendance"]["denominator"]) == (5, 6)
    assert out["scope"]["people"] == 1


def test_meetings_without_data_is_not_zero(db_session):
    out = meetings_kpis.build(db_session, db_session.get(OrgUser, AVA), 30, NOW)
    for key in ("attendance", "series_at_risk", "repeat_absentees", "meetings_held"):
        assert out["kpis"][key]["value"] is None, key
        assert out["kpis"][key]["no_data"]
    assert out["series"] == [] and out["people"] == [] and out["turnout"]["total"] == 0


# ------------------------------------------------------------------ biometric


def _punch(db, emp, day: date, first=(9, 0), last=(18, 0), punches=2):
    f = datetime(day.year, day.month, day.day, first[0], first[1], first[2] if len(first) > 2 else 0, tzinfo=timezone.utc)
    if punches == 1:
        l = f
    else:
        l = datetime(day.year, day.month, day.day, last[0], last[1], last[2] if len(last) > 2 else 0, tzinfo=timezone.utc)
    db.add(AttendanceDay(emp_code=emp, work_date=day, first_punch=f, last_punch=l, punch_count=punches))


@pytest.fixture
def biometric(db_session):
    """E1, E2 (dept A), E3, E5 (dept B) are working; E4 (B) was last seen in August (assumed left).
    Working days: Mon-Fri Sep 28-Oct 2 (previous 7 days) and Mon-Fri Oct 5-9 (current 7 days)."""
    db = db_session
    for code, dept in (("E1", "A"), ("E2", "A"), ("E3", "B"), ("E4", "B"), ("E5", "B")):
        db.add(AttendanceEmployee(emp_code=code, name=f"Emp {code}", company="Acme", department=dept))
    db.flush()
    d = date
    # E4 left in August
    _punch(db, "E4", d(2026, 8, 1))
    # previous period: everyone plain, E5 absent only on Oct 2
    for day in [d(2026, 9, 28), d(2026, 9, 29), d(2026, 9, 30), d(2026, 10, 1), d(2026, 10, 2)]:
        for emp in ("E1", "E2", "E3"):
            _punch(db, emp, day)
        if day != d(2026, 10, 2):
            _punch(db, "E5", day)
    # a Saturday with one person on call is not a working day
    _punch(db, "E1", d(2026, 10, 3))
    # current period
    cur = [d(2026, 10, 5), d(2026, 10, 6), d(2026, 10, 7), d(2026, 10, 8), d(2026, 10, 9)]
    for i, day in enumerate(cur):
        if i == 2:  # Wed: E1 arrives 09:30 (late) and leaves 17:00 (early)
            _punch(db, "E1", day, first=(9, 30), last=(17, 0))
        else:
            _punch(db, "E1", day)
    _punch(db, "E2", cur[0], first=(8, 50), last=(18, 10))
    _punch(db, "E2", cur[1], first=(9, 15, 0), last=(17, 45, 0))  # exactly on the grace boundaries: not late, not early
    _punch(db, "E2", cur[2], first=(10, 0), punches=1)  # one punch, and late
    _punch(db, "E3", cur[0], first=(9, 16), last=(18, 0))  # late by a minute
    _punch(db, "E3", cur[1], first=(9, 0), punches=1)  # missed punch
    _punch(db, "E3", cur[3])
    _punch(db, "E3", cur[4], first=(9, 0), last=(16, 0))  # early
    db.commit()
    return db


def test_biometric_attendance_rate_and_comparison(biometric):
    out = biometric_kpis.build(biometric, 7, NOW)
    assert out["empty"] is False
    assert out["reference_day"] == "2026-10-09" and out["period"]["working_days"] == 5
    a = out["kpis"]["attendance"]
    # expected: E1, E2, E3, E5 x 5 working days = 20 (E4 left); present 5 + 3 + 4 + 0 = 12
    assert (a["numerator"], a["denominator"], a["value"]) == (12, 20, 0.6)
    # previous: 20 expected, 15 + 4 = 19 present
    assert a["previous"] == 0.95 and a["delta"] == -0.35
    assert a["tone"] == "crit" and a["target"] == 0.85  # 60% is under the 70% floor


def test_biometric_present_late_early_missed_and_hours(biometric):
    k = biometric_kpis.build(biometric, 7, NOW)["kpis"]
    # latest day Oct 9: E1 and E3 present of 4 expected, against Oct 8 (E1, E3)
    assert (k["present_today"]["value"], k["present_today"]["denominator"], k["present_today"]["previous"]) == (2, 4, 2)
    # late: E1 Wed 09:30, E2 Wed 10:00, E3 Mon 09:16; E2's 09:15:00 is on the boundary so it is not late. 3 of 12
    assert (k["late_arrivals"]["numerator"], k["late_arrivals"]["denominator"], k["late_arrivals"]["value"]) == (3, 12, 0.25)
    assert k["late_arrivals"]["previous"] == 0.0
    # early exit among 10 days with an exit punch: E1 Wed 17:00 and E3 Fri 16:00; E2's 17:45:00 is on the boundary
    assert (k["early_exits"]["numerator"], k["early_exits"]["denominator"]) == (2, 10)
    # missed punch: E2 Wed, E3 Tue of 12 present days
    assert (k["missed_punch"]["numerator"], k["missed_punch"]["denominator"]) == (2, 12)
    assert k["missed_punch"]["value"] == pytest.approx(0.1667, abs=1e-4)
    # hours: 9,9,7.5,9,9 + 9.3333 + 8.5 + 8.7333 + 9 + 7 over 10 days
    assert k["avg_hours"]["value"] == pytest.approx((43.5 + 9.3333 + 8.5 + 8.7333 + 9 + 7) / 10, abs=1e-3)
    assert k["avg_hours"]["previous"] == 9.0 and k["avg_hours"]["target"] == 9.0


def test_biometric_not_seen_and_assumed_left(biometric):
    out = biometric_kpis.build(biometric, 7, NOW)
    k = out["kpis"]["not_seen"]
    # E5 last punched Oct 1: silent 8 days at Oct 9. E4 (last seen Aug 1) is assumed left, not counted.
    assert k["value"] == 1 and k["previous"] == 0
    assert "assumed left" in k["detail"]
    assert out["not_seen"][0]["emp_code"] == "E5" and out["not_seen"][0]["days_silent"] == 8
    assert [p["emp_code"] for p in out["not_seen"] if p["assumed_left"]] == ["E4"]
    assert out["not_seen_total"] == 2


def test_biometric_departments_weekdays_and_people(biometric):
    out = biometric_kpis.build(biometric, 7, NOW)
    deps = {d["department"]: d for d in out["departments"]}
    assert (deps["A"]["present"], deps["A"]["expected"], deps["A"]["rate"]) == (8, 10, 0.8)
    assert (deps["B"]["present"], deps["B"]["expected"], deps["B"]["rate"]) == (4, 10, 0.4)
    assert deps["B"]["previous_rate"] == 0.9 and deps["B"]["delta"] == -0.5
    assert [d["department"] for d in out["departments"]] == ["B", "A"]  # lowest first

    wd = {d["day"]: (d["present"], d["expected"]) for d in out["weekday"]}
    assert wd == {"Mon": (3, 4), "Tue": (3, 4), "Wed": (2, 4), "Thu": (2, 4), "Fri": (2, 4), "Sat": (0, 0), "Sun": (0, 0)}

    assert [(p["emp_code"], p["count"]) for p in out["missed_punch_people"]] == [("E2", 1), ("E3", 1)]
    assert {p["emp_code"] for p in out["late_people"]} == {"E1", "E2", "E3"}
    assert out["low_presence_people"][0]["emp_code"] == "E5" and out["low_presence_people"][0]["rate"] == 0.0


def test_biometric_work_hours_setting_changes_lateness(biometric, client):
    login_as(client, AVA)
    assert client.get("/settings/work-hours").json() == {"work_start": "09:00", "work_end": "18:00", "grace_minutes": 15, "saved": False}
    assert client.put("/settings/work-hours", json={"work_start": "18:00", "work_end": "09:00"}).status_code == 422
    assert client.put("/settings/work-hours", json={"work_start": "9am", "work_end": "18:00"}).status_code == 422
    assert client.put("/settings/work-hours", json={"work_start": "09:00", "work_end": "18:00", "grace_minutes": 500}).status_code == 422
    r = client.put("/settings/work-hours", json={"work_start": "09:30", "work_end": "17:00", "grace_minutes": 0})
    assert r.json() == {"work_start": "09:30", "work_end": "17:00", "grace_minutes": 0, "saved": True}

    k = biometric_kpis.build(biometric, 7, NOW)["kpis"]
    # start 09:30, no grace: only E2 Wed 10:00 is late
    assert k["late_arrivals"]["numerator"] == 1
    # end 17:00: last punch before 17:00 is E3 Fri 16:00 only (E1 Wed 17:00 is not before 17:00; E2 17:45 is later)
    assert k["early_exits"]["numerator"] == 1


def test_biometric_stale_data_is_flagged(biometric):
    out = biometric_kpis.compute(
        days=7,
        employees={"E1": ("Emp E1", "A")},
        seen={"E1": (date(2026, 9, 1), date(2026, 9, 10))},
        seen_prev={},
        daily_counts={date(2026, 9, 7) + timedelta(days=i): 1 for i in range(4)},
        rows=[],
        work={"work_start": "09:00", "work_end": "18:00", "grace_minutes": 15, "saved": True},
        tz=biometric_kpis.get_timezone(biometric),
        today=date(2026, 9, 30),
        now=NOW,
        last_import=None,
    )
    assert out["data_through"] == "2026-09-10" and out["data_age_days"] == 20 and out["stale"] is True


def test_biometric_without_data_is_not_zero(db_session):
    out = biometric_kpis.build(db_session, 30, NOW)
    assert out["empty"] is True
    for k in out["kpis"].values():
        assert k["value"] is None and k["no_data"]
    assert out["departments"] == [] and out["not_seen"] == []


# ----------------------------------------------------------------- compliance


def _compliance(db, name, category, priority):
    c = Compliance(name=name, category=category, priority=priority, status="published", created_by=AVA)
    db.add(c)
    db.flush()
    return c


def _ob(db, c, email, status, due=None, completed=None, created=None, participation="required", non_compliant=False):
    db.add(
        Obligation(
            compliance_id=c.id,
            user_email=email,
            status=status,
            due_at=due,
            completed_at=completed,
            created_at=created or dt(9, 1),
            participation=participation,
            non_compliant_at=dt(10, 1) if non_compliant else None,
        )
    )


@pytest.fixture
def obligations(db_session):
    db = db_session
    c1 = _compliance(db, "Security policy", "Policy", "high")
    c2 = _compliance(db, "Annual training", "Training", "critical")
    c3 = _compliance(db, "Code of conduct", "Policy", "high")
    c4 = _compliance(db, "Data privacy", "Policy", "low")
    _ob(db, c1, DANIEL, "completed", due=dt(9, 20), completed=dt(9, 18))  # on time
    _ob(db, c1, SOFIA, "completed", due=dt(9, 25), completed=dt(9, 27))  # late
    _ob(db, c2, DANIEL, "in_progress", due=dt(9, 30))  # overdue 9 days
    _ob(db, c2, SOFIA, "not_started", due=dt(10, 5), non_compliant=True)  # overdue 4 days
    _ob(db, c2, AVA, "not_started", due=dt(8, 1), created=dt(7, 1))  # overdue 69 days, outside both periods
    _ob(db, c3, DANIEL, "in_progress", due=dt(10, 12))  # due in 3 days
    _ob(db, c3, SOFIA, "completed", due=dt(8, 20), completed=dt(8, 25), created=dt(8, 1))  # previous period, late
    _ob(db, c4, DANIEL, "not_started", due=dt(9, 25), participation="optional")  # never counted
    _ob(db, c4, SOFIA, "waived", due=dt(9, 25))  # never counted
    db.commit()
    return db


def _ctx(db, email):
    return Ctx(db, db.get(OrgUser, email))


def test_compliance_rates_and_comparison(obligations):
    out = compliance_kpis.build(obligations, _ctx(obligations, AVA), 30, NOW)
    k = out["kpis"]
    # due in the last 30 days: Daniel's and Sofia's policy items, Daniel's and Sofia's training: 2 of 4 completed
    assert (k["completion"]["numerator"], k["completion"]["denominator"], k["completion"]["value"]) == (2, 4, 0.5)
    # previous 30 days: 1 due, 1 completed
    assert k["completion"]["previous"] == 1.0 and k["completion"]["delta"] == -0.5
    # completed in the period: one on time (Sep 18 <= Sep 20), one late; previous: the one completed late on Aug 25
    assert (k["on_time"]["numerator"], k["on_time"]["denominator"], k["on_time"]["value"]) == (1, 2, 0.5)
    assert k["on_time"]["previous"] == 0.0 and k["on_time"]["delta"] == 0.5
    # average assignment -> completion: Sep 1 -> Sep 18 (17 d) and Sep 1 -> Sep 27 (26 d); previous Aug 1 -> Aug 25 (24 d)
    assert k["time_to_complete"]["value"] == 21.5 and k["time_to_complete"]["previous"] == 24.0


def test_compliance_overdue_aging_and_due_soon(obligations):
    out = compliance_kpis.build(obligations, _ctx(obligations, AVA), 30, NOW)
    k = out["kpis"]
    assert k["overdue"]["value"] == 3
    # at the start of the period (Sep 9 12:00) only Ava's August item was overdue and still open
    assert k["overdue"]["previous"] == 1 and k["overdue"]["delta"] == 2
    assert out["aging"] == {"d1_7": 1, "d8_30": 1, "d30_plus": 1, "total": 3}
    assert k["due_soon"]["value"] == 1
    # the critical-priority item that is overdue longest comes first
    assert [i["compliance"] for i in out["overdue_items"]] == ["Annual training"] * 3
    assert [i["days_overdue"] for i in out["overdue_items"]] == [69, 9, 4]
    assert out["overdue_by_compliance"][0]["name"] == "Annual training" and out["overdue_by_compliance"][0]["overdue"] == 3
    assert [d["compliance"] for d in out["due_soon"]] == ["Code of conduct"]


def test_compliance_non_compliant_and_groups(obligations):
    out = compliance_kpis.build(obligations, _ctx(obligations, AVA), 30, NOW)
    assert out["kpis"]["non_compliant"]["value"] == 1
    by_cat = {g["name"]: g for g in out["by_category"]}
    assert (by_cat["Policy"]["completed"], by_cat["Policy"]["total"], by_cat["Policy"]["overdue"]) == (2, 2, 0)
    assert (by_cat["Training"]["completed"], by_cat["Training"]["total"], by_cat["Training"]["overdue"]) == (0, 2, 3)
    assert [g["name"] for g in out["by_category"]] == ["Training", "Policy"]  # lowest rate first
    assert [g["name"] for g in out["by_priority"]] == ["critical", "high"]
    # completions per day/week in the chart add up to the KPI's completions
    assert out["completions"]["total"] == 2 and out["completions"]["previous_total"] == 1


def test_compliance_scope_follows_permissions(obligations, no_bootstrap):
    # An employee only sees their own obligations: Daniel's policy item (on time) and training item (overdue)
    out = compliance_kpis.build(obligations, _ctx(obligations, DANIEL), 30, NOW)
    k = out["kpis"]
    assert (k["completion"]["numerator"], k["completion"]["denominator"]) == (1, 2)
    assert k["overdue"]["value"] == 1 and k["due_soon"]["value"] == 1
    assert k["review_queue"]["value"] is None  # employees do not review
    assert k["repeat_defaulters"]["value"] is None and "scoreboard" in k["repeat_defaulters"]["no_data"]
    # a manager sees her reporting line (Daniel and Sofia), and not Ava's own item
    mgr = compliance_kpis.build(obligations, _ctx(obligations, AVA), 30, NOW)  # Ava is manager of both
    assert mgr["kpis"]["completion"]["denominator"] == 4


def test_compliance_scope_excludes_other_teams(obligations, people, no_bootstrap):
    # Bea manages Carl and Dana only: nothing of Ava's team is in her numbers
    out = compliance_kpis.build(obligations, _ctx(obligations, BEA), 30, NOW)
    k = out["kpis"]
    assert k["completion"]["value"] is None and k["completion"]["no_data"]
    assert k["overdue"]["value"] == 0 and out["overdue_items"] == []


def test_compliance_without_data_is_not_zero(db_session):
    out = compliance_kpis.build(db_session, _ctx(db_session, AVA), 7, NOW)
    for key in ("completion", "on_time", "time_to_complete", "review_turnaround"):
        assert out["kpis"][key]["value"] is None, key
    assert out["kpis"]["overdue"]["value"] == 0  # a real zero: nothing is late


# ------------------------------------------------------------------------- API


def test_overview_composes_the_areas(meetings, obligations):
    out = overview.build(obligations, obligations.get(OrgUser, AVA), 7, NOW)
    assert [k["key"] for k in out["meetings"]["kpis"]] == ["attendance", "series_at_risk", "repeat_absentees"]
    assert out["meetings"]["attention"][0]["title"] == "Standup"
    assert out["biometric"]["empty"] is True  # no punches in these fixtures
    assert [k["key"] for k in out["compliance"]["kpis"]] == ["completion", "overdue", "due_soon"]
    assert out["compliance"]["attention"][0]["name"] == "Annual training"
    assert out["compliance"]["attention_total"] == 3


def test_endpoints_need_login_and_a_valid_period(client, monkeypatch):
    for area in ("overview", "meetings", "biometric", "compliance"):
        assert client.get(f"/dashboards/{area}").status_code == 401
    login_as(client, AVA)
    for area in ("overview", "meetings", "biometric", "compliance"):
        r = client.get(f"/dashboards/{area}?days=30")
        assert r.status_code == 200, (area, r.text)
        assert r.json()["area"] == area
        assert client.get(f"/dashboards/{area}?days=5").status_code == 422
    # the default period is 30 days
    assert client.get("/dashboards/meetings").json()["period"]["days"] == 30


def test_compliance_endpoint_respects_dashboard_permission(client, db_session, no_bootstrap):
    from app.compliance.models import UserPermissionOverride

    db_session.add(UserPermissionOverride(user_email=DANIEL, resource="dashboard", action="view", effect="deny"))
    db_session.commit()
    login_as(client, DANIEL)
    assert client.get("/dashboards/compliance").status_code == 403
    ov = client.get("/dashboards/overview").json()
    assert ov["compliance"]["available"] is False
    assert ov["meetings"]["available"] is True
