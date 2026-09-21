from datetime import datetime, timedelta, timezone

from app.connectors.mock_teams_provider import MockTeamsProvider
from app.connectors.sync_service import sync_occurrence
from app.connectors.teams_provider import MeetingAttendee
from tests.conftest import login_as


def _seed_engineering_standup(db_session):
    provider = MockTeamsProvider()
    start = datetime(2026, 9, 1, 8, 0, tzinfo=timezone.utc)
    attendees = [
        MeetingAttendee("alice@corp.com", required=True),
        MeetingAttendee("bob@corp.com", required=True),
        MeetingAttendee("carol@corp.com", required=True),
    ]
    provider.define_series("standup", "Engineering Standup", "lead@corp.com", attendees, start, timedelta(minutes=15))
    occ = provider.get_occurrences("standup", start, start)[0]
    provider.set_attendance(occ.occurrence_id, ["alice@corp.com", "bob@corp.com"])  # carol absent
    sync_occurrence(db_session, provider, occ)


def test_dev_login_requires_known_user(client):
    resp = client.get("/auth/dev-login", params={"email": "nobody@corp.com"}, follow_redirects=False)
    assert resp.status_code == 404


def test_dev_login_sets_session(client):
    resp = client.get("/auth/dev-login", params={"email": "alice@corp.com"}, follow_redirects=False)
    assert resp.status_code == 307
    resp2 = client.get("/auth/me")
    assert resp2.status_code == 200
    assert resp2.json()["email"] == "alice@corp.com"


def test_protected_endpoint_requires_login(client):
    resp = client.get("/dashboard")
    assert resp.status_code == 401


def test_manager_can_see_report_peer_cannot(client, db_session):
    _seed_engineering_standup(db_session)

    login_as(client, "lead@corp.com")
    assert client.get("/people/alice@corp.com").status_code == 200

    login_as(client, "alice@corp.com")
    assert client.get("/people/bob@corp.com").status_code == 403  # peers, not manager/report
    assert client.get("/people/alice@corp.com").status_code == 200  # self always visible


def test_meetings_scoped_to_visible_people(client, db_session):
    _seed_engineering_standup(db_session)

    login_as(client, "lead@corp.com")
    titles = [m["title"] for m in client.get("/meetings").json()["items"]]
    assert "Engineering Standup" in titles

    login_as(client, "pm@corp.com")  # pm's reports (dave/erin) weren't invited
    titles = [m["title"] for m in client.get("/meetings").json()["items"]]
    assert "Engineering Standup" not in titles


def test_orgchart_nests_indirect_reports(client, db_session):
    login_as(client, "taylor@corp.com")
    tree = client.get("/orgchart").json()
    lead_node = next(c for c in tree["children"] if c["email"] == "lead@corp.com")
    grandchild_emails = {c["email"] for c in lead_node["children"]}
    assert {"alice@corp.com", "bob@corp.com", "carol@corp.com"} <= grandchild_emails


def test_dashboard_flags_required_absence_as_concern(client, db_session):
    _seed_engineering_standup(db_session)
    login_as(client, "lead@corp.com")
    body = client.get("/dashboard").json()
    assert body["top_concern_series"][0]["title"] == "Engineering Standup"
    focus_emails = [m["email"] for m in body["top_members_to_focus"]]
    assert "carol@corp.com" in focus_emails
