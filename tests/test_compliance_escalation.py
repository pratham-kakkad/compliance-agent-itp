"""Deadlines, escalation rules, non-compliance, the scoreboard, dashboards and
notifications. The scheduler pass is called directly with a chosen "now"."""
from datetime import timedelta

from app.compliance import audit, escalation
from app.compliance.models import EscalationLog, Notification, Obligation
from tests.conftest import login_as
from tests.cx import (  # noqa: F401  (fixtures)
    AVA,
    BEA,
    CARL,
    DANIEL,
    SOFIA,
    grant_role,
    in_days,
    new_compliance,
    no_bootstrap,
    obligation_of,
    people,
    person_rule,
    submit_proof,
    upload,
)


def _notes(db, user, kind=None):
    q = db.query(Notification).filter_by(user_email=user)
    if kind:
        q = q.filter_by(kind=kind)
    return q.count()


def _due_in(db, compliance_id, user, days):
    """Move one person's deadline (so a test controls time without waiting)."""
    ob = db.query(Obligation).filter_by(compliance_id=compliance_id, user_email=user).one()
    ob.due_at = in_days(days)
    ob.due_overridden = True
    db.commit()
    return ob


def test_standard_ladder_reminder_manager_non_compliant(client, db_session):
    c = new_compliance(client, AVA, audience=[person_rule(DANIEL)], due_at=in_days(2).isoformat())
    ob = db_session.query(Obligation).filter_by(compliance_id=c["id"]).one()
    due = ob.due_at

    # 3 days before the deadline: reminder arrives once, however often the job runs.
    s1 = escalation.tick(db_session, at=due - timedelta(days=2.5))
    s2 = escalation.tick(db_session, at=due - timedelta(days=2.4))
    db_session.commit()
    assert s1["fired"] == 1 and s2["fired"] == 0
    assert _notes(db_session, DANIEL, "reminder") == 1

    # On the day: another reminder. Two days late: the assignee is nudged and the manager told.
    escalation.tick(db_session, at=due + timedelta(minutes=1))
    escalation.tick(db_session, at=due + timedelta(days=2, minutes=1))
    db_session.commit()
    assert _notes(db_session, DANIEL, "reminder") == 3
    assert _notes(db_session, AVA, "escalation") == 1
    db_session.refresh(ob)
    assert ob.non_compliant_at is None

    # A week late: non-compliant, flagged, manager chain told. Running again changes nothing.
    escalation.tick(db_session, at=due + timedelta(days=7, minutes=1))
    db_session.commit()
    again = escalation.tick(db_session, at=due + timedelta(days=8))
    db_session.commit()
    db_session.refresh(ob)
    assert ob.non_compliant_at is not None and ob.defaulter_flag is True
    assert again["fired"] == 0
    assert _notes(db_session, DANIEL, "non_compliant") == 1
    fired = db_session.query(EscalationLog).filter_by(obligation_id=ob.id).count()
    assert fired == len({(e.rule_id, e.action_idx) for e in db_session.query(EscalationLog).filter_by(obligation_id=ob.id)})
    actions = [e.action for e in db_session.query(audit.AuditEvent).order_by(audit.AuditEvent.id)]
    assert "obligation.non_compliant" in actions and "obligation.defaulter_flagged" in actions

    # The UI sees it.
    login_as(client, DANIEL)
    item = client.get(f"/compliance/obligations/{ob.id}").json()
    assert item["non_compliant"] is True and item["status"] == "not_started"


def test_completed_people_are_left_alone(client, db_session):
    c = new_compliance(client, AVA, type_key="policy_acknowledgement", review_mode="none", audience=[person_rule(DANIEL), person_rule(SOFIA)])
    ob = obligation_of(client, DANIEL, c["id"])
    login_as(client, DANIEL)
    client.post(f"/compliance/obligations/{ob['id']}/submit", json={"items": [{"key": "acknowledged", "checked": True}]})
    due = db_session.query(Obligation).filter_by(compliance_id=c["id"]).first().due_at
    escalation.tick(db_session, at=due + timedelta(days=30))
    db_session.commit()
    assert _notes(db_session, DANIEL, "reminder") == 0
    assert _notes(db_session, SOFIA, "reminder") >= 1


def test_informational_and_optional_people_are_not_chased(client, db_session):
    c = new_compliance(
        client, AVA,
        audience=[person_rule(DANIEL, "required"), person_rule(SOFIA, "informational")],
    )
    due = db_session.query(Obligation).filter_by(compliance_id=c["id"]).first().due_at
    escalation.tick(db_session, at=due + timedelta(days=10))
    db_session.commit()
    assert _notes(db_session, SOFIA, "reminder") == 0
    sofia = db_session.query(Obligation).filter_by(compliance_id=c["id"], user_email=SOFIA).one()
    assert sofia.non_compliant_at is None


def test_custom_rules_notify_named_people_and_pending_reviews(client, db_session, people):
    rules = [
        {
            "id": "tell-bea",
            "name": "Tell Bea the day after",
            "trigger": {"type": "after_due", "days": 1},
            "actions": [{"type": "notify_users", "emails": [BEA]}, {"type": "notify_manager_chain", "levels": 3}],
        },
        {
            "id": "review-late",
            "name": "Nag reviewers",
            "trigger": {"type": "review_pending", "days": 2},
            "actions": [{"type": "notify_reviewers"}],
        },
    ]
    c = new_compliance(client, AVA, escalation_rules=rules, audience=[person_rule(DANIEL), person_rule(SOFIA)])
    ob = obligation_of(client, SOFIA, c["id"])
    submit_proof(client, SOFIA, ob["id"])  # Sofia's proof sits waiting for Ava
    due = db_session.query(Obligation).filter_by(compliance_id=c["id"], user_email=DANIEL).one().due_at

    escalation.tick(db_session, at=due + timedelta(days=1, minutes=1))
    db_session.commit()
    assert _notes(db_session, BEA, "escalation") >= 1  # named person told (once per overdue person)
    assert _notes(db_session, AVA, "review_overdue") == 1  # waiting review nudged, Sofia's only
    escalation.tick(db_session, at=due + timedelta(days=1, minutes=2))
    db_session.commit()
    assert _notes(db_session, AVA, "review_overdue") == 1


def test_rules_that_fire_before_a_deadline_never_fire_after_it(client, db_session):
    c = new_compliance(client, AVA, audience=[person_rule(DANIEL)])
    ob = db_session.query(Obligation).filter_by(compliance_id=c["id"]).one()
    escalation.tick(db_session, at=ob.due_at + timedelta(hours=1))
    db_session.commit()
    kinds = {(e.rule_id) for e in db_session.query(EscalationLog).filter_by(obligation_id=ob.id)}
    assert "remind-before" not in kinds and "remind-due" in kinds


def test_scoreboard_ranks_repeat_defaulters_and_respects_scope(client, db_session, people, no_bootstrap):
    grant_role(people, AVA, "compliance_admin")
    for n in range(3):
        c = new_compliance(client, AVA, name=f"Policy {n}", priority="high", audience=[person_rule(DANIEL), person_rule(CARL)])
        _due_in(people, c["id"], DANIEL, -10)
        if n == 0:
            _due_in(people, c["id"], CARL, -10)
    escalation.tick(people)
    people.commit()
    login_as(client, AVA)
    board = client.get("/compliance/scoreboard").json()["people"]
    by = {p["email"]: p for p in board}
    assert by[DANIEL]["incidents"] == 3 and by[DANIEL]["repeat_offender"] is True
    assert by[DANIEL]["score"] == 9 and by[DANIEL]["rank"] == 1  # three "high" (weight 3)
    assert by[CARL]["incidents"] == 1 and by[CARL]["repeat_offender"] is False
    # A manager only ever sees their own reporting line on the board; employees get no board.
    login_as(client, BEA)
    assert {p["email"] for p in client.get("/compliance/scoreboard").json()["people"]} == {CARL}
    login_as(client, DANIEL)
    assert client.get("/compliance/scoreboard").status_code == 403


def test_dashboard_numbers_and_scope(client, db_session, people, no_bootstrap):
    grant_role(people, AVA, "compliance_admin")
    c = new_compliance(client, AVA, name="Dash", type_key="policy_acknowledgement", review_mode="none", audience=[person_rule(DANIEL), person_rule(SOFIA), person_rule(CARL)])
    ob = obligation_of(client, DANIEL, c["id"])
    login_as(client, DANIEL)
    client.post(f"/compliance/obligations/{ob['id']}/submit", json={"items": [{"key": "acknowledged", "checked": True}]})
    _due_in(people, c["id"], SOFIA, -2)

    login_as(client, AVA)
    k = client.get("/compliance/dashboard").json()["kpis"]
    assert k["obligations"] == 3 and k["completed"] == 1 and k["pending"] == 2
    assert k["overdue"] == 1 and k["compliance_percent"] == 33
    assert k["active_compliances"] == 1 and k["total_compliances"] == 1

    # Bea (manager) only counts Carl; Daniel only himself.
    login_as(client, BEA)
    kb = client.get("/compliance/dashboard").json()["kpis"]
    assert kb["obligations"] == 1 and kb["completed"] == 0
    login_as(client, DANIEL)
    kd = client.get("/compliance/dashboard").json()
    assert kd["kpis"]["obligations"] == 1 and kd["kpis"]["completed"] == 1 and kd["kpis"]["compliance_percent"] == 100
    login_as(client, AVA)
    full = client.get("/compliance/dashboard").json()
    assert full["by_category"] and full["attention"][0]["email"] == SOFIA
    assert len(full["trend"]) == 30 and sum(t["completed"] for t in full["trend"]) == 1


def test_notifications_inbox(client, db_session):
    c = new_compliance(client, AVA, audience=[person_rule(DANIEL)])
    login_as(client, DANIEL)
    me = client.get("/compliance/me").json()
    assert me["unread_notifications"] == 1
    inbox = client.get("/compliance/notifications").json()
    n = inbox["items"][0]
    assert n["kind"] == "assigned" and "Repost" in n["title"] and n["link"].startswith("/compliance/obligations/")
    # Someone else's notification can't be touched.
    login_as(client, SOFIA)
    assert client.post(f"/compliance/notifications/{n['id']}/read").status_code == 404
    login_as(client, DANIEL)
    assert client.post(f"/compliance/notifications/{n['id']}/read").status_code == 200
    assert client.get("/compliance/notifications", params={"unread": True}).json()["items"] == []
    assert client.post("/compliance/notifications/read-all").status_code == 200
    assert c["id"]


def test_run_tick_endpoint_needs_settings_permission(client, no_bootstrap, people):
    login_as(client, DANIEL)
    assert client.post("/compliance/admin/run-tick").status_code == 403
    grant_role(people, BEA, "super_admin")
    login_as(client, BEA)
    r = client.post("/compliance/admin/run-tick")
    assert r.status_code == 200 and {"fired", "resynced", "obligations_checked"} <= set(r.json())


def test_demo_seed_is_idempotent_and_shows_the_example(db_session):
    from app.compliance.models import Compliance
    from app.compliance.seed import seed_demo

    seed_demo(db_session)
    names = {c.name for c in db_session.query(Compliance)}
    assert "Repost the Company's LinkedIn Post" in names and len(names) == 3
    seed_demo(db_session)
    assert db_session.query(Compliance).count() == 3
    linked = db_session.query(Compliance).filter_by(name="Repost the Company's LinkedIn Post").one()
    parts = {o.user_email: o.participation for o in db_session.query(Obligation).filter_by(compliance_id=linked.id)}
    assert parts[DANIEL] == "required" and parts[SOFIA] == "required" and parts[AVA] == "informational"
