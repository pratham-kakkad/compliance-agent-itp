from datetime import datetime, timedelta, timezone

from app.connectors.mock_teams_provider import MockTeamsProvider
from app.connectors.sync_service import sync_occurrence
from app.connectors.teams_provider import MeetingAttendee
from app.models import OrgUser
from tests.conftest import login_as

AVA = "ava.martinez@corp.com"
DANIEL = "daniel.kim@corp.com"
SOFIA = "sofia.rossi@corp.com"


def _seed_engineering_standup(db_session):
    provider = MockTeamsProvider()
    start = datetime(2026, 9, 1, 8, 0, tzinfo=timezone.utc)
    attendees = [
        MeetingAttendee(DANIEL, required=True),
        MeetingAttendee(SOFIA, required=True),
    ]
    provider.define_series("standup", "Engineering Standup", AVA, attendees, start, timedelta(minutes=15))
    occ = provider.get_occurrences("standup", start, start)[0]
    provider.set_attendance(occ.occurrence_id, [DANIEL])  # sofia absent
    sync_occurrence(db_session, provider, occ)


def test_dev_login_requires_known_user(client):
    resp = client.get("/auth/dev-login", params={"email": "nobody@corp.com"}, follow_redirects=False)
    assert resp.status_code == 404


def test_dev_login_rejects_real_non_demo_account(client, db_session):
    db_session.add(
        OrgUser(email="real.user@tenant.com", name="Real User", title="Engineer", is_demo=False)
    )
    db_session.commit()
    resp = client.get("/auth/dev-login", params={"email": "real.user@tenant.com"}, follow_redirects=False)
    assert resp.status_code == 404


def test_dev_login_sets_session(client):
    resp = client.get("/auth/dev-login", params={"email": DANIEL}, follow_redirects=False)
    assert resp.status_code == 307
    resp2 = client.get("/auth/me")
    assert resp2.status_code == 200
    body = resp2.json()
    assert body["email"] == DANIEL
    assert body["is_demo"] is True


def test_protected_endpoint_requires_login(client):
    resp = client.get("/dashboard")
    assert resp.status_code == 401


def test_manager_can_see_report_peer_cannot(client, db_session):
    _seed_engineering_standup(db_session)

    login_as(client, AVA)
    assert client.get(f"/people/{DANIEL}").status_code == 200

    login_as(client, DANIEL)
    assert client.get(f"/people/{SOFIA}").status_code == 403  # peers, not manager/report
    assert client.get(f"/people/{DANIEL}").status_code == 200  # self always visible


def test_meetings_scoped_to_visible_people(client, db_session):
    _seed_engineering_standup(db_session)

    provider = MockTeamsProvider()
    start = datetime(2026, 9, 2, 9, 0, tzinfo=timezone.utc)
    provider.define_series(
        "1-1", "1:1: Ava & Daniel", AVA,
        [MeetingAttendee(DANIEL, required=True)], start, timedelta(minutes=30), "once",
    )
    occ = provider.get_occurrences("1-1", start, start)[0]
    provider.set_attendance(occ.occurrence_id, [DANIEL])
    sync_occurrence(db_session, provider, occ)

    login_as(client, AVA)
    titles = [m["title"] for m in client.get("/meetings").json()["items"]]
    assert "Engineering Standup" in titles
    assert "1:1: Ava & Daniel" in titles

    login_as(client, SOFIA)  # not invited to the 1:1
    titles = [m["title"] for m in client.get("/meetings").json()["items"]]
    assert "Engineering Standup" in titles
    assert "1:1: Ava & Daniel" not in titles


def test_orgchart_nests_direct_reports(client, db_session):
    login_as(client, AVA)
    tree = client.get("/orgchart").json()
    child_emails = {c["email"] for c in tree["children"]}
    assert {DANIEL, SOFIA} <= child_emails


def test_dashboard_flags_required_absence_as_concern(client, db_session):
    _seed_engineering_standup(db_session)
    login_as(client, AVA)
    body = client.get("/dashboard").json()
    assert body["top_concern_series"][0]["title"] == "Engineering Standup"
    focus_emails = [m["email"] for m in body["top_members_to_focus"]]
    assert SOFIA in focus_emails
