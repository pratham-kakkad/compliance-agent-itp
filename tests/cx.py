"""Shared helpers for the compliance engine tests (not a test module)."""
from datetime import datetime, timedelta, timezone

import pytest

from app.compliance.models import Department, Role, Team, TeamMember, UserRole
from app.config import settings
from app.models import OrgUser
from tests.conftest import login_as

AVA = "ava.martinez@corp.com"  # demo manager of Daniel and Sofia; bootstrap Super Admin
DANIEL = "daniel.kim@corp.com"
SOFIA = "sofia.rossi@corp.com"
BEA = "bea.nguyen@corp.com"  # a second manager with her own reports
CARL = "carl.jones@corp.com"
DANA = "dana.lee@corp.com"

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def iso(dt: datetime) -> str:
    return dt.isoformat()


def in_days(n: float) -> datetime:
    return datetime.now(timezone.utc) + timedelta(days=n)


@pytest.fixture
def people(db_session):
    """Adds Bea (manager) with reports Carl and Dana, to sit beside Ava's team."""
    db = db_session
    db.add(OrgUser(email=BEA, name="Bea Nguyen", title="Sales Manager", manager_email=None, is_demo=True))
    db.flush()
    db.add(OrgUser(email=CARL, name="Carl Jones", title="Account Exec", manager_email=BEA, is_demo=True))
    db.add(OrgUser(email=DANA, name="Dana Lee", title="Account Exec", manager_email=BEA, is_demo=True))
    db.commit()
    return db


@pytest.fixture
def no_bootstrap(monkeypatch):
    """Nobody is an implicit Super Admin, so roles are what the test says they are."""
    monkeypatch.setattr(settings, "compliance_super_admins", "")


def grant_role(db, email: str, role_key: str) -> None:
    role = db.query(Role).filter_by(key=role_key).one()
    db.add(UserRole(user_email=email, role_id=role.id))
    db.commit()


def make_team(db, name: str, members: list[str], lead: str | None = None) -> Team:
    t = Team(name=name, lead_email=lead)
    db.add(t)
    db.flush()
    for m in members:
        db.add(TeamMember(team_id=t.id, user_email=m))
    db.commit()
    return t


def make_department(db, name: str, members: list[str]) -> Department:
    d = Department(name=name)
    db.add(d)
    db.flush()
    for e in members:
        db.get(OrgUser, e).department_id = d.id
    db.commit()
    return d


def person_rule(email: str, participation: str = "required", effect: str = "include") -> dict:
    return {"selector_type": "person", "selector_ref": email, "effect": effect, "participation": participation}


def new_compliance(client, who: str, audience=None, publish: bool = True, **fields) -> dict:
    """Create (and by default publish) a compliance as `who`; returns the compliance JSON."""
    login_as(client, who)
    body = {
        "name": "Repost the LinkedIn post",
        "type_key": "external_action",
        "due_at": iso(in_days(5)),
        "review_mode": "manager",
        "audience": audience if audience is not None else [person_rule(DANIEL), person_rule(SOFIA)],
    }
    body.update(fields)
    r = client.post("/compliance/definitions", json=body)
    assert r.status_code == 201, r.text
    c = r.json()
    if publish:
        p = client.post(f"/compliance/definitions/{c['id']}/publish")
        assert p.status_code == 200, p.text
        c = p.json()["compliance"]
    return c


def obligation_of(client, who: str, compliance_id: str) -> dict:
    login_as(client, who)
    r = client.get("/compliance/obligations", params={"mine": True, "compliance_id": compliance_id})
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert len(items) == 1, items
    return items[0]


def upload(client, who: str, name: str = "shot.png", data: bytes = PNG) -> str:
    login_as(client, who)
    r = client.post("/compliance/evidence", files={"file": (name, data, "image/png")})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def submit_proof(client, who: str, obligation_id: str, text: str = "I reposted it on my profile", file_id: str | None = None):
    fid = file_id or upload(client, who)
    login_as(client, who)
    return client.post(
        f"/compliance/obligations/{obligation_id}/submit",
        json={"items": [{"key": "description", "text": text}, {"key": "proof", "file_id": fid}]},
    )
