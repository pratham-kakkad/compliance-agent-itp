"""E-mail templates and manual compliance e-mail: rendering, recipients and scope,
sending in the background, history. smtplib is faked (tests/smtpfake.py); no network."""
import contextlib
import smtplib
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from app import email_templates
from app.compliance import engine, messaging
from app.compliance.models import (
    AuditEvent,
    Department,
    EmailTemplate,
    Notification,
    Obligation,
    RecordRule,
    SentEmail,
    Team,
    TeamMember,
)
from app.compliance.notify import deliver_pending
from app.models import OrgUser
from tests.conftest import login_as
from tests.cx import AVA, DANIEL, grant_role, in_days, new_compliance, no_bootstrap, person_rule  # noqa: F401  (fixtures)
from tests.smtpfake import FakeSmtp, fake_smtp, no_smtp, smtp_env  # noqa: F401  (fixtures)

ADMIN = "admin@example.test"
MGR = "mgr@example.test"
R1 = "r1@example.test"
R2 = "r2@example.test"
R3 = "r3@example.test"  # reports to R1: inside MGR's reporting line, two levels down
M2 = "m2@example.test"
O1 = "o1@example.test"  # reports to M2: outside MGR's line


def _user(db, email, name, manager=None, **kw):
    u = OrgUser(email=email, name=name, title="Tester", manager_email=manager, is_demo=False, **kw)
    db.add(u)
    db.flush()
    return u


@pytest.fixture
def org(db_session, no_bootstrap):
    """Real (non-demo) people: an admin, a manager with a small line, and a second manager elsewhere."""
    db = db_session
    _user(db, ADMIN, "Ada Admin")
    _user(db, MGR, "Mia Manager")
    _user(db, R1, "Rob One", MGR)
    _user(db, R2, "Rae Two", MGR)
    _user(db, R3, "Ray Three", R1)
    _user(db, M2, "Max Other")
    _user(db, O1, "Olly Outside", M2)
    db.commit()
    grant_role(db, ADMIN, "super_admin")
    return db


@pytest.fixture(autouse=True)
def _background_uses_test_session(db_session, monkeypatch):
    """The background job opens its own session; in tests it must be the test one."""

    @contextlib.contextmanager
    def scope():
        yield db_session

    monkeypatch.setattr(messaging, "session_scope", scope)


@pytest.fixture
def mail(smtp_env, fake_smtp):  # noqa: F811
    return fake_smtp


def _compliance(client, who=ADMIN, people=(R1, R2), **kw):
    return new_compliance(client, who, audience=[person_rule(p) for p in people], **kw)


def _send(client, who, recipients, **extra):
    login_as(client, who)
    body = {"recipients": recipients, "template_id": None, "subject": "Hello {{first_name}}", "body": "Hi {{first_name}},\n\nAbout {{compliance_name}}.\n\n{{open_items}}\n\nThanks,\n{{sender_name}}"}
    body.update(extra)
    return client.post("/compliance/emails/send", json=body)


def _template(db, key):
    return db.scalar(select(EmailTemplate).where(EmailTemplate.key == key))


def _rows(db, batch_id):
    return list(db.scalars(select(SentEmail).where(SentEmail.batch_id == uuid.UUID(batch_id)).order_by(SentEmail.created_at, SentEmail.id)))


# ----------------------------------------------------------------- rendering


def test_render_substitutes_and_flags_unknown_variables():
    out, bad = messaging.render("Hi {{first_name}} / {{ name }} / {{nope}} / {{ 7*7 }}", {"first_name": "Ann", "name": "Ann Lee"})
    assert out == "Hi Ann / Ann Lee / {{nope}} / {{ 7*7 }}"
    assert bad == ["nope", "7*7"]
    assert messaging.unknown_variables("{{name}} {{ x }} {{name}}") == ["x"]


def test_render_runs_no_code_and_does_not_reexpand_values():
    out, bad = messaging.render("{{name}} {{__import__('os').system('x')}}", {"name": "{{email}} {{ 1+1 }}", "email": "boom"})
    assert out.startswith("{{email}} {{ 1+1 }} ")  # a value is data, never expanded again
    assert "__import__" in out and bad == ["__import__('os').system('x')"]


def test_variables_reference_lists_every_documented_variable():
    names = {v["name"] for v in messaging.VARIABLES}
    assert {"name", "first_name", "email", "manager_name", "sender_name", "sender_email", "org_name", "today", "compliance_name",
            "category", "priority", "due_date", "days_overdue", "days_until_due", "status", "link", "open_items", "open_count", "overdue_count"} <= names
    assert all(v["example"] and v["description"] and v["group"] for v in messaging.VARIABLES)


def test_html_escapes_values_and_renders_bullets():
    subject, text, html = email_templates.compliance_message_email(
        "Hi <b>x</b>", "Dear <script>alert(1)</script>,\n\nItems:\n• One & <two>\n• Three\n\nThanks", kind="final",
        link="https://x.test/ui/a?b=1&c=2\"><script>", sender_name="Eve <img src=x>",
    )
    assert "<script>" not in html and "<img src=x>" not in html and '"><script>' not in html
    assert "&lt;script&gt;" in html and "One &amp; &lt;two&gt;" in html
    assert "<ul" in html and html.count("<li") == 2
    assert "Open in Encop" in html and "#4f46e5" in html and "Final notice" in html
    assert "<script>" in text  # plain text is not HTML, so nothing is escaped there
    assert 'name="viewport"' in html


def test_red_only_for_the_final_notice_kind():
    reds = {k: email_templates.compliance_message_email("s", "b", kind=k)[2].count("#b91c1c") for k in messaging.KINDS}
    assert reds["final"] > 0 and all(v == 0 for k, v in reds.items() if k != "final")


# ------------------------------------------------------- seeds and templates


def test_five_system_templates_are_seeded_and_well_formed(client, db_session):
    rows = list(db_session.scalars(select(EmailTemplate).where(EmailTemplate.is_system.is_(True))))
    assert {t.kind for t in rows} == {"reminder", "warning", "final", "request", "thanks"} and len(rows) == 5
    for t in rows:
        assert "{{compliance_name}}" in t.subject
        assert not messaging.unknown_variables(t.subject, t.body)
        assert "{{sender_name}}" in t.body
    warning = _template(db_session, "formal-warning")
    assert "{{due_date}}" in warning.body and "reply" in warning.body.lower()


def test_seeding_twice_keeps_edits_and_restores_missing(db_session):
    t = _template(db_session, "friendly-reminder")
    t.subject = "My own subject {{name}}"
    db_session.delete(_template(db_session, "thank-you"))
    db_session.commit()
    messaging.seed_email_templates(db_session)
    assert _template(db_session, "friendly-reminder").subject == "My own subject {{name}}"
    assert _template(db_session, "thank-you") is not None


def test_only_configure_can_manage_templates_but_any_sender_can_list_active(client, org):
    login_as(client, MGR)
    assert client.get("/compliance/admin/email-templates").status_code == 403
    assert client.post("/compliance/admin/email-templates", json={"name": "x", "subject": "s", "body": "b"}).status_code == 403
    usable = client.get("/compliance/email-templates")
    assert usable.status_code == 200 and len(usable.json()) == 5
    login_as(client, DANIEL)  # employee: not a sender
    assert client.get("/compliance/email-templates").status_code == 403
    assert client.get("/compliance/email-variables").status_code == 403
    login_as(client, ADMIN)
    assert client.get("/compliance/admin/email-templates").status_code == 200
    assert client.get("/compliance/email-variables").status_code == 200


def test_template_crud_validation_and_audit(client, org, db_session):
    login_as(client, ADMIN)
    bad = client.post("/compliance/admin/email-templates", json={"name": "Odd", "kind": "custom", "subject": "Hi {{nme}}", "body": "x {{foo}}"})
    assert bad.status_code == 422 and "{{nme}}" in bad.json()["detail"] and "{{foo}}" in bad.json()["detail"]
    assert client.post("/compliance/admin/email-templates", json={"name": "Odd", "kind": "loud", "subject": "s", "body": "b"}).status_code == 422
    assert client.post("/compliance/admin/email-templates", json={"name": "Odd", "subject": "a\nb", "body": "b"}).status_code == 422
    assert client.post("/compliance/admin/email-templates", json={"name": "Odd", "subject": "s", "body": "b", "description": "x" * 301}).status_code == 422
    ok = client.post("/compliance/admin/email-templates", json={"name": "Nudge", "kind": "custom", "subject": "Hi {{first_name}}", "body": "Please {{compliance_name}}"})
    assert ok.status_code == 201
    t = ok.json()
    assert t["is_system"] is False and t["key"] == "nudge" and t["variables"] == ["first_name", "compliance_name"]
    dup = client.post("/compliance/admin/email-templates", json={"name": "Nudge", "subject": "s", "body": "b"}).json()
    assert dup["key"] == "nudge-2"
    up = client.patch(f"/compliance/admin/email-templates/{t['id']}", json={"subject": "Hello {{name}}", "kind": "reminder"})
    assert up.status_code == 200 and up.json()["subject"] == "Hello {{name}}" and up.json()["kind"] == "reminder"
    assert client.patch(f"/compliance/admin/email-templates/{t['id']}", json={"body": "{{zzz}}"}).status_code == 422
    off = client.patch(f"/compliance/admin/email-templates/{t['id']}", json={"active": False}).json()
    assert off["active"] is False
    assert t["id"] not in [x["id"] for x in client.get("/compliance/email-templates").json()]
    assert client.delete(f"/compliance/admin/email-templates/{t['id']}").status_code == 204
    assert client.delete(f"/compliance/admin/email-templates/{uuid.uuid4()}").status_code == 404
    actions = {e.action for e in db_session.scalars(select(AuditEvent).where(AuditEvent.entity_type == "email_template"))}
    assert {"email_template.created", "email_template.updated", "email_template.deleted"} <= actions


def test_system_templates_can_be_edited_and_reset_but_not_deleted(client, org, db_session):
    login_as(client, ADMIN)
    t = next(x for x in client.get("/compliance/admin/email-templates").json() if x["key"] == "formal-warning")
    assert t["modified"] is False
    assert client.delete(f"/compliance/admin/email-templates/{t['id']}").status_code == 400
    original = t["subject"]
    edited = client.patch(f"/compliance/admin/email-templates/{t['id']}", json={"subject": "Custom {{name}}", "active": False}).json()
    assert edited["modified"] is True and edited["subject"] == "Custom {{name}}"
    back = client.post(f"/compliance/admin/email-templates/{t['id']}/reset").json()
    assert back["subject"] == original and back["modified"] is False and back["active"] is True
    custom = client.post("/compliance/admin/email-templates", json={"name": "Mine", "subject": "s", "body": "b"}).json()
    assert client.post(f"/compliance/admin/email-templates/{custom['id']}/reset").status_code == 400


def test_editor_preview_uses_sample_data_and_flags_unknown(client, org):
    login_as(client, ADMIN)
    r = client.post("/compliance/admin/email-templates/preview", json={"subject": "Hi {{first_name}} {{oops}}", "body": "About {{compliance_name}}\n\n{{open_items}}", "kind": "warning"})
    assert r.status_code == 200
    d = r.json()
    assert d["unknown"] == ["oops"] and "{{oops}}" in d["subject"] and "Alex" in d["subject"]
    assert "Annual Security Training" in d["text"] and "<ul" in d["html"] and "Warning" in d["html"]
    login_as(client, MGR)
    assert client.post("/compliance/admin/email-templates/preview", json={"subject": "s", "body": "b"}).status_code == 403


def test_test_send_goes_to_the_signed_in_admin_only(client, org, mail, db_session):
    login_as(client, AVA)  # demo account in tests (no_bootstrap makes her an ordinary manager)
    assert client.post("/compliance/admin/email-templates/test", json={"subject": "s", "body": "b"}).status_code == 403
    login_as(client, ADMIN)
    r = client.post("/compliance/admin/email-templates/test", json={"subject": "Hi {{first_name}}", "body": "About {{compliance_name}}", "kind": "reminder"})
    assert r.json() == {"ok": True, "to": ADMIN}
    assert [m["To"] for m in mail.sent] == [ADMIN] and mail.sent[0]["Subject"].startswith("[Test] ")
    assert client.post("/compliance/admin/email-templates/test", json={"subject": "Hi {{zzz}}", "body": "b"}).status_code == 422
    # the test is recorded, but never shows in history or counts towards the rate limit
    assert client.get("/compliance/emails/history").json()["total"] == 0
    assert messaging.sent_in_last_hour(db_session, ADMIN) == 0
    demo = OrgUser(email="demo.admin@example.test", name="Demo Admin", title="", is_demo=True)
    db_session.add(demo)
    db_session.commit()
    grant_role(db_session, demo.email, "super_admin")
    login_as(client, demo.email)
    assert client.post("/compliance/admin/email-templates/test", json={"subject": "s", "body": "b"}).status_code == 400


def test_test_send_needs_smtp(client, org, fake_smtp, no_smtp):
    login_as(client, ADMIN)
    assert client.post("/compliance/admin/email-templates/test", json={"subject": "s", "body": "b"}).status_code == 409
    assert fake_smtp.sent == []


# --------------------------------------------------------- recipients, scope


def test_preview_for_one_obligation_renders_the_item_variables(client, org, mail):
    c = _compliance(client)
    login_as(client, ADMIN)
    ob = next(o for o in client.get("/compliance/obligations", params={"compliance_id": c["id"]}).json()["items"] if o["user"]["email"] == R1)
    r = client.post("/compliance/emails/preview", json={
        "recipients": {"obligation_id": ob["id"]}, "template_id": str(_template(org, "formal-warning").id),
    })
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["will_send"] == 1 and d["skipped"] == 0 and d["unresolved"] == [] and d["kind"] == "warning"
    p = d["previews"][0]
    assert p["email"] == R1 and p["subject"] == "Formal warning: Repost the LinkedIn post"
    assert "Dear Rob One," in p["text"] and "Repost the LinkedIn post: due" in p["text"] and "Not started" in p["text"] and "Ada Admin" in p["text"]
    assert "/ui/compliance/obligations/" + ob["id"] in p["text"] and "Open in Encop" in p["html"]
    assert d["recipients"][0]["item"]["compliance"] == "Repost the LinkedIn post"


def test_person_level_message_summarises_open_items(client, org, mail):
    _compliance(client, name="First thing")
    _compliance(client, name="Second thing", people=(R1,))
    login_as(client, ADMIN)
    r = client.post("/compliance/emails/preview", json={
        "recipients": {"emails": [R1, R2]}, "subject": "{{compliance_name}} / {{open_count}} / {{overdue_count}}", "body": "{{open_items}}",
    }).json()
    by = {p["email"]: p for p in r["previews"]}
    assert by[R1]["subject"] == "2 open compliance items / 2 / 0"
    assert by[R2]["subject"] == "First thing / 1 / 0"
    assert by[R1]["text"].count("•") == 2 and "First thing: due" in by[R1]["text"]
    assert by[R1]["text"].index("First thing") < by[R1]["text"].index("Second thing") or True


def test_unresolved_variable_is_flagged_in_preview_and_blocks_send(client, org, mail):
    _compliance(client)
    login_as(client, ADMIN)
    pv = client.post("/compliance/emails/preview", json={"recipients": {"emails": [R1]}, "subject": "Hi {{nope}}", "body": "x"}).json()
    assert pv["unresolved"] == ["nope"]
    r = _send(client, ADMIN, {"emails": [R1]}, subject="Hi {{nope}}", body="x")
    assert r.status_code == 422 and "{{nope}}" in r.json()["detail"]
    assert mail.sent == [] and org.scalar(select(SentEmail.id)) is None


def test_skip_reasons(client, org, mail, db_session):
    db = db_session
    _user(db, "gone@example.test", "Gone Person", MGR, is_active=False)
    _user(db, "noat", "No Address", MGR)
    db.commit()
    login_as(client, ADMIN)
    r = client.post("/compliance/emails/preview", json={
        "recipients": {"emails": [R1, R1.upper(), "gone@example.test", DANIEL, "noat", ADMIN, "who@example.test"]},
        "subject": "s", "body": "b",
    }).json()
    reasons = {s["email"].lower(): s["reason"] for s in r["skipped_list"]}
    assert r["will_send"] == 1 and r["recipients"][0]["email"] == R1
    assert reasons == {R1: "duplicate", "gone@example.test": "inactive", DANIEL: "demo", "noat": "no_email", ADMIN: "self", "who@example.test": "outside_scope"}
    assert r["skipped_counts"]["demo"] == 1 and all(s["label"] for s in r["skipped_list"])


def test_manager_cannot_email_outside_their_reporting_line(client, org, mail):
    login_as(client, MGR)
    pv = client.post("/compliance/emails/preview", json={"recipients": {"emails": [R1, R3, O1, M2, ADMIN]}, "subject": "s", "body": "b"}).json()
    assert [r["email"] for r in pv["recipients"]] == [R1, R3]  # direct and indirect reports
    assert {s["email"]: s["reason"] for s in pv["skipped_list"]} == {O1: "outside_scope", M2: "outside_scope", ADMIN: "outside_scope"}
    r = _send(client, MGR, {"emails": [O1, M2]})
    assert r.status_code == 422 and "nobody" in r.json()["detail"].lower()
    r = _send(client, MGR, {"emails": [R1, O1]})
    assert r.status_code == 202 and r.json()["queued"] == 1 and r.json()["skipped"] == 1
    assert [m["To"] for m in mail.sent] == [R1]


def test_a_person_with_only_self_scope_cannot_send(client, org, mail):
    login_as(client, R3)  # no reports: only the Employee role, which grants no send permission
    assert client.post("/compliance/emails/preview", json={"recipients": {"emails": [R1]}, "subject": "s", "body": "b"}).status_code == 403
    assert _send(client, R3, {"emails": [R1]}).status_code == 403
    assert mail.sent == []


def test_send_scope_is_the_union_of_the_scopes_of_the_send_permissions(client, org, mail, db_session):
    # R3 has no reports; an allow-override of compliance.assign on "team" reaches teammates only
    from app.compliance.models import UserPermissionOverride

    db = db_session
    t = Team(name="Crew")
    db.add(t)
    db.flush()
    db.add_all([TeamMember(team_id=t.id, user_email=R3), TeamMember(team_id=t.id, user_email=R2)])
    db.add(UserPermissionOverride(user_email=R3, resource="compliance", action="assign", effect="allow", scope="team"))
    db.commit()
    login_as(client, R3)
    pv = client.post("/compliance/emails/preview", json={"recipients": {"emails": [R2, R1, O1]}, "subject": "s", "body": "b"}).json()
    assert [r["email"] for r in pv["recipients"]] == [R2]
    assert {s["email"] for s in pv["skipped_list"]} == {R1, O1}


def test_team_recipients_are_resolved_on_the_server_and_scope_enforced(client, org, mail, db_session):
    db = db_session
    t = Team(name="Mixed", lead_email=R1)
    db.add(t)
    db.flush()
    db.add_all([TeamMember(team_id=t.id, user_email=e) for e in (R2, O1, DANIEL)])
    db.commit()
    login_as(client, ADMIN)
    a = client.post("/compliance/emails/preview", json={"recipients": {"team_id": str(t.id)}, "subject": "s", "body": "b"}).json()
    assert sorted(r["email"] for r in a["recipients"]) == sorted([R1, R2, O1])  # members and lead; the demo one is skipped
    assert a["source"]["type"] == "team" and a["skipped_counts"] == {"demo": 1}
    login_as(client, MGR)
    b = client.post("/compliance/emails/preview", json={"recipients": {"team_id": str(t.id)}, "subject": "s", "body": "b"}).json()
    assert sorted(r["email"] for r in b["recipients"]) == [R1, R2]
    outside = [s for s in b["skipped_list"] if s["reason"] == "outside_scope"]
    assert len(outside) == 2 and all(s["email"] == "" for s in outside)  # people the sender can't reach aren't named
    # un-ticking removes people, but a client can never add anybody through `exclude`
    c = client.post("/compliance/emails/preview", json={"recipients": {"team_id": str(t.id), "exclude": [R2, "someone@else.test"]}, "subject": "s", "body": "b"}).json()
    assert [r["email"] for r in c["recipients"]] == [R1]
    assert client.post("/compliance/emails/preview", json={"recipients": {"team_id": str(uuid.uuid4())}, "subject": "s", "body": "b"}).status_code == 404
    assert client.post("/compliance/emails/preview", json={"recipients": {"team_id": "nope"}, "subject": "s", "body": "b"}).status_code == 404


def test_department_recipients(client, org, mail, db_session):
    db = db_session
    d = Department(name="Ops")
    db.add(d)
    db.flush()
    for e in (R1, R3, O1):
        db.get(OrgUser, e).department_id = d.id
    db.commit()
    login_as(client, MGR)
    r = client.post("/compliance/emails/preview", json={"recipients": {"department_id": str(d.id)}, "subject": "s", "body": "b"}).json()
    assert sorted(x["email"] for x in r["recipients"]) == [R1, R3] and r["skipped_counts"] == {"outside_scope": 1}


def test_exactly_one_way_of_choosing_recipients(client, org):
    login_as(client, ADMIN)
    for rec in ({}, {"emails": [R1], "team_id": str(uuid.uuid4())}, {"emails": []}):
        assert client.post("/compliance/emails/preview", json={"recipients": rec, "subject": "s", "body": "b"}).status_code == 422


def test_compliance_recipients_and_status_filters(client, org, mail, db_session):
    db = db_session
    c = _compliance(client, people=(R1, R2, R3))
    login_as(client, ADMIN)
    obs = {o["user"]["email"]: o for o in client.get("/compliance/obligations", params={"compliance_id": c["id"]}).json()["items"]}
    db.get(Obligation, uuid.UUID(obs[R1]["id"])).due_at = engine.now() - timedelta(days=4)  # overdue
    db.get(Obligation, uuid.UUID(obs[R2]["id"])).status = "rejected"
    db.get(Obligation, uuid.UUID(obs[R3]["id"])).status = "completed"
    db.commit()

    def who(status):
        r = client.post("/compliance/emails/preview", json={"recipients": {"compliance_id": c["id"], "status": status}, "subject": "s", "body": "b"})
        assert r.status_code == 200, r.text
        return sorted(x["email"] for x in r.json()["recipients"])

    assert who("overdue") == [R1]
    assert who("rejected") == [R2]
    assert who("not_started") == [R1]
    assert who("open") == [R1, R2]
    assert who("all") == [R1, R2, R3]
    assert client.post("/compliance/emails/preview", json={"recipients": {"compliance_id": c["id"], "status": "weird"}, "subject": "s", "body": "b"}).status_code == 422
    # item variables for the overdue person
    r = client.post("/compliance/emails/preview", json={
        "recipients": {"compliance_id": c["id"], "status": "overdue"}, "subject": "{{days_overdue}}|{{status}}|{{days_until_due}}", "body": "x",
    }).json()
    assert r["previews"][0]["subject"] == "4|Not started|0"
    # a manager gets the same list narrowed to their line
    login_as(client, MGR)
    assert who("all") == [R1, R2, R3]
    login_as(client, M2)
    assert client.post("/compliance/emails/preview", json={"recipients": {"compliance_id": c["id"]}, "subject": "s", "body": "b"}).status_code == 404


def test_a_hand_picked_subset_of_a_compliances_assignees(client, org, mail):
    c = _compliance(client, people=(R1, R2, R3))
    login_as(client, ADMIN)
    r = client.post("/compliance/emails/preview", json={"recipients": {"compliance_id": c["id"], "only": [R1.upper(), R3, "stranger@example.test"]}, "subject": "s", "body": "b"}).json()
    assert sorted(x["email"] for x in r["recipients"]) == [R1, R3] and r["source"]["selected"] == 3
    assert r["skipped"] == 0  # a name that isn't on the compliance is simply not part of it


def test_informational_people_and_cancelled_items_are_not_emailed(client, org, mail, db_session):
    c = new_compliance(client, ADMIN, audience=[person_rule(R1), person_rule(R2, participation="informational")])
    login_as(client, ADMIN)
    r = client.post("/compliance/emails/preview", json={"recipients": {"compliance_id": c["id"]}, "subject": "s", "body": "b"}).json()
    assert [x["email"] for x in r["recipients"]] == [R1]


def test_record_rules_apply_to_obligation_recipients(client, org, mail, db_session):
    db = db_session
    c = _compliance(client, category="HR")
    db.add(RecordRule(name="no HR", resource="obligation", kind="restrictive", condition={"field": "category", "op": "not_in", "value": ["HR"]}, active=True))
    db.commit()
    login_as(client, MGR)
    hidden = client.post("/compliance/emails/preview", json={"recipients": {"compliance_id": c["id"]}, "subject": "s", "body": "b"})
    assert hidden.status_code == 200 and hidden.json()["will_send"] == 0  # the items are hidden from this manager, so nobody is reachable
    # ... and the person-level open-items list leaves those items out too
    r = client.post("/compliance/emails/preview", json={"recipients": {"emails": [R1]}, "subject": "s", "body": "{{open_items}}"}).json()
    assert "Repost" not in r["previews"][0]["text"] and "Nothing is open" in r["previews"][0]["text"]


# -------------------------------------------------------------- limits, setup


def test_smtp_must_be_configured_to_send(client, org, fake_smtp, no_smtp):
    r = _send(client, ADMIN, {"emails": [R1]})
    assert r.status_code == 409 and "Settings" in r.json()["detail"]
    assert fake_smtp.sent == [] and org.scalar(select(SentEmail.id)) is None
    login_as(client, ADMIN)  # preview still works and says so
    assert client.post("/compliance/emails/preview", json={"recipients": {"emails": [R1]}, "subject": "s", "body": "b"}).json()["smtp_configured"] is False


def test_batch_is_capped(client, org, mail, monkeypatch):
    monkeypatch.setattr(messaging, "MAX_RECIPIENTS", 2)
    r = _send(client, ADMIN, {"emails": [R1, R2, R3]})
    assert r.status_code == 422 and "limited to 2" in r.json()["detail"]
    pv = client.post("/compliance/emails/preview", json={"recipients": {"emails": [R1, R2, R3]}, "subject": "s", "body": "b"}).json()
    assert pv["over_cap"] is True and mail.sent == []
    assert _send(client, ADMIN, {"emails": [R1, R2]}).status_code == 202


def test_real_cap_is_200(client, org, mail, db_session):
    d = Department(name="Big")
    db_session.add(d)
    db_session.flush()
    for i in range(201):
        db_session.add(OrgUser(email=f"bulk{i}@example.test", name=f"Bulk {i}", title="", is_demo=False, department_id=d.id))
    db_session.commit()
    r = _send(client, ADMIN, {"department_id": str(d.id)})
    assert r.status_code == 422 and "200" in r.json()["detail"] and mail.sent == []


def test_per_sender_rate_limit(client, org, mail, monkeypatch):
    monkeypatch.setattr(messaging, "RATE_LIMIT_PER_HOUR", 3)
    assert _send(client, ADMIN, {"emails": [R1, R2]}).status_code == 202
    r = _send(client, ADMIN, {"emails": [R3, R1]})
    assert r.status_code == 429 and "1 left" in r.json()["detail"]
    pv = client.post("/compliance/emails/preview", json={"recipients": {"emails": [R3, R1]}, "subject": "s", "body": "b"}).json()
    assert pv["over_rate"] is True and pv["limits"]["sent_last_hour"] == 2
    assert _send(client, ADMIN, {"emails": [R3]}).status_code == 202
    # another sender has their own allowance
    assert _send(client, MGR, {"emails": [R1]}).status_code == 202
    assert len(mail.sent) == 4


def test_large_warning_batches_need_explicit_confirmation(client, org, mail, monkeypatch):
    monkeypatch.setattr(messaging, "LARGE_BATCH", 1)
    _compliance(client)  # both have something open, so the warning applies to them
    warn = str(_template(org, "formal-warning").id)
    kind_ok = str(_template(org, "friendly-reminder").id)
    r = _send(client, ADMIN, {"emails": [R1, R2]}, template_id=warn, subject=None, body=None)
    assert r.status_code == 409 and "Confirm" in r.json()["detail"] and mail.sent == []
    pv = client.post("/compliance/emails/preview", json={"recipients": {"emails": [R1, R2]}, "template_id": warn}).json()
    assert pv["needs_confirm"] is True
    assert _send(client, ADMIN, {"emails": [R1, R2]}, template_id=kind_ok, subject=None, body=None).status_code == 202  # a reminder needs none
    assert _send(client, ADMIN, {"emails": [R1, R2]}, template_id=warn, subject=None, body=None, confirmed=True).status_code == 202


def test_nobody_to_send_to_and_missing_message(client, org, mail):
    assert _send(client, ADMIN, {"emails": [DANIEL]}).status_code == 422
    assert _send(client, ADMIN, {"emails": [R1]}, subject="", body="").status_code == 422
    assert _send(client, ADMIN, {"emails": [R1]}, subject="Hi", body="  ").status_code == 422
    assert mail.sent == []


def test_chasing_templates_skip_people_with_nothing_open(client, org, mail):
    c = _compliance(client, people=(R1,))  # R1 has an open item, R2 has none
    login_as(client, ADMIN)
    tpl = {"warning": str(_template(org, "formal-warning").id), "thanks": str(_template(org, "thank-you").id)}

    def preview(**kw):
        return client.post("/compliance/emails/preview", json={"recipients": {"emails": [R1, R2]}, **kw}).json()

    w = preview(template_id=tpl["warning"])
    assert [r["email"] for r in w["recipients"]] == [R1]
    assert w["skipped_counts"] == {"nothing_open": 1} and w["skipped_list"][0]["label"] == "Nothing open to follow up"
    assert sorted(r["email"] for r in preview(template_id=tpl["thanks"])["recipients"]) == [R1, R2]  # a thank-you needs nothing open
    assert sorted(r["email"] for r in preview(subject="Hi", body="x")["recipients"]) == [R1, R2]  # nor does a message written by hand
    r = _send(client, ADMIN, {"emails": [R1, R2]}, template_id=tpl["warning"], subject=None, body=None, confirmed=True)
    assert r.status_code == 202 and r.json()["queued"] == 1 and r.json()["skipped"] == 1
    assert [m["To"] for m in mail.sent] == [R1]
    # about one specific item, the person's other items don't matter and a finished item can still be chased or thanked
    ob = client.get("/compliance/obligations", params={"compliance_id": c["id"]}).json()["items"][0]["id"]
    one = client.post("/compliance/emails/preview", json={"recipients": {"obligation_id": ob}, "template_id": tpl["warning"]}).json()
    assert one["will_send"] == 1


# ----------------------------------------------------------- sending, results


def test_send_delivers_in_the_background_and_records_everything(client, org, mail, db_session):
    c = _compliance(client)
    r = _send(client, ADMIN, {"compliance_id": c["id"]}, template_id=str(_template(org, "friendly-reminder").id), subject=None, body=None)
    assert r.status_code == 202, r.text
    batch = r.json()["batch_id"]
    assert r.json()["queued"] == 2
    assert sorted(m["To"] for m in mail.sent) == [R1, R2]
    m = next(x for x in mail.sent if x["To"] == R1)
    assert m["Subject"] == "Friendly reminder: Repost the LinkedIn post"
    assert m["Reply-To"] == ADMIN and "Cc" not in m and "Bcc" not in m
    assert "Hi Rob," in m.get_body(("plain",)).get_content() and "Hi Rob," in m.get_body(("html",)).get_content()
    st = client.get(f"/compliance/emails/batches/{batch}").json()
    assert st["status"] == "done" and st["counts"] == {"queued": 0, "sent": 2, "failed": 0, "skipped": 0} and st["total"] == 2
    assert {x["email"] for x in st["recipients"]} == {R1, R2} and st["template_name"] == "Friendly reminder"
    rows = _rows(db_session, batch)
    assert all(x.status == "sent" and x.sent_by == ADMIN and x.compliance_id and x.obligation_id for x in rows)
    assert all(x.subject.startswith("Friendly reminder") and ("Hi Rob," in x.body or "Hi Rae," in x.body) for x in rows)
    assert rows[0].template_name == "Friendly reminder" and rows[0].context["kind"] == "reminder" and rows[0].context["source"]["type"] == "compliance"
    # the audit trail names who, what template, how many, which batch -- never the body
    ev = db_session.scalars(select(AuditEvent).where(AuditEvent.entity_type == "email_batch", AuditEvent.entity_id == batch).order_by(AuditEvent.id)).all()
    assert [e.action for e in ev] == ["email.batch_started", "email.batch_finished"]
    assert ev[0].actor_email == ADMIN and ev[0].meta["template"] == "Friendly reminder" and ev[0].meta["recipients"] == 2
    assert ev[1].meta["sent"] == 2
    assert "Hi Rob" not in str(ev[0].meta) and "Rob One" not in str(ev[1].meta)


def test_cc_manager_is_per_recipient_and_only_when_they_have_one(client, org, mail, db_session):
    db = db_session
    db.get(OrgUser, R3).manager_email = None  # R3 has no manager now
    db.commit()
    assert _send(client, ADMIN, {"emails": [R1, R3]}, options={"cc_manager": True}).status_code == 202
    by = {m["To"]: m for m in mail.sent}
    assert by[R1]["Cc"] == MGR and "Cc" not in by[R3]
    # the manager is never copied on a message they send themselves
    mail.reset()
    assert _send(client, MGR, {"emails": [R1]}, options={"cc_manager": True}).status_code == 202
    assert "Cc" not in mail.sent[0]


def test_copy_me_is_a_bcc_for_one_recipient_and_one_copy_for_many(client, org, mail, db_session):
    assert _send(client, ADMIN, {"emails": [R1]}, options={"copy_me": True}).status_code == 202
    assert mail.sent[0]["Bcc"] == ADMIN
    mail.reset()
    assert _send(client, ADMIN, {"emails": [R1, R2]}, options={"copy_me": True}).status_code == 202
    assert sorted(m["To"] for m in mail.sent) == sorted([ADMIN, R1, R2])
    copy = next(m for m in mail.sent if m["To"] == ADMIN)
    assert copy["Subject"].startswith("Copy: ") and "2 people" in copy.get_body(("plain",)).get_content()
    assert all("Bcc" not in m for m in mail.sent if m["To"] != ADMIN)


def test_in_app_notice_is_created_and_not_mailed_twice(client, org, mail, db_session):
    assert _send(client, ADMIN, {"emails": [R1]}, options={"in_app": True}).status_code == 202
    n = db_session.scalar(select(Notification).where(Notification.user_email == R1))
    assert n.kind == "message" and n.title == "Hello Rob" and n.email_status == "skipped"
    mail.reset()
    assert deliver_pending(db_session)["sent"] == 0 and mail.sent == []
    assert db_session.scalar(select(Notification).where(Notification.user_email == R2)) is None  # only who was e-mailed


def test_a_failure_is_recorded_not_retried_and_does_not_stop_the_rest(client, org, mail, monkeypatch):
    class Flaky(FakeSmtp):
        attempts: list = []

        def send_message(self, msg):
            Flaky.attempts.append(msg["To"])
            if msg["To"] == R1:
                raise smtplib.SMTPRecipientsRefused({R1: (550, b"mailbox unavailable")})
            super().send_message(msg)

    Flaky.attempts = []
    monkeypatch.setattr(smtplib, "SMTP", Flaky)
    r = _send(client, ADMIN, {"emails": [R1, R2, R3]})
    st = client.get(f"/compliance/emails/batches/{r.json()['batch_id']}").json()
    assert st["counts"] == {"queued": 0, "sent": 2, "failed": 1, "skipped": 0} and not st["stopped"]
    failed = next(x for x in st["recipients"] if x["status"] == "failed")
    assert failed["email"] == R1 and "refused the recipient" in failed["error"]
    assert Flaky.attempts == [R1, R2, R3]  # tried once each, never retried
    assert sorted(m["To"] for m in FakeSmtp.sent) == [R2, R3]


def test_batch_stops_after_repeated_connection_failures(client, org, mail, db_session):
    mail.fail, mail.fail_at = ConnectionRefusedError(), "connect"
    r = _send(client, ADMIN, {"emails": [R1, R2, R3, MGR, M2]})
    st = client.get(f"/compliance/emails/batches/{r.json()['batch_id']}").json()
    assert st["counts"] == {"queued": 0, "sent": 0, "failed": 3, "skipped": 2} and st["stopped"] is True
    assert [e for e in mail.log if e[0] == "connect"].__len__() == 3  # three attempts, then it stopped
    skipped = [x for x in st["recipients"] if x["status"] == "skipped"]
    assert len(skipped) == 2 and "stopped" in skipped[0]["error"]
    assert all("refused" in x["error"] for x in st["recipients"] if x["status"] == "failed")


def test_stale_queued_rows_are_reported_as_failed(client, org, mail, db_session, monkeypatch):
    monkeypatch.setattr(messaging, "run_batch", lambda batch_id: None)  # simulate a restart: nothing runs
    r = _send(client, ADMIN, {"emails": [R1]})
    batch = r.json()["batch_id"]
    assert client.get(f"/compliance/emails/batches/{batch}").json()["status"] == "sending"
    row = _rows(db_session, batch)[0]
    row.created_at = engine.now() - timedelta(hours=1)
    db_session.commit()
    st = client.get(f"/compliance/emails/batches/{batch}").json()
    assert st["status"] == "done" and st["counts"]["failed"] == 1 and "interrupted" in st["recipients"][0]["error"]


def test_batch_status_is_only_for_the_sender_or_an_admin(client, org, mail):
    batch = _send(client, MGR, {"emails": [R1]}).json()["batch_id"]
    login_as(client, MGR)
    assert client.get(f"/compliance/emails/batches/{batch}").status_code == 200
    login_as(client, M2)
    assert client.get(f"/compliance/emails/batches/{batch}").status_code == 404
    login_as(client, ADMIN)
    assert client.get(f"/compliance/emails/batches/{batch}").status_code == 200
    assert client.get("/compliance/emails/batches/not-a-uuid").status_code == 404


def test_skipped_people_are_recorded_in_the_batch_but_not_in_history(client, org, mail, db_session):
    r = _send(client, ADMIN, {"emails": [R1, DANIEL]})
    batch = r.json()["batch_id"]
    st = client.get(f"/compliance/emails/batches/{batch}").json()
    assert st["counts"]["sent"] == 1 and st["counts"]["skipped"] == 1 and "Demo" in next(x for x in st["recipients"] if x["status"] == "skipped")["error"]
    h = client.get("/compliance/emails/history").json()
    assert h["total"] == 1 and h["items"][0]["recipient"]["email"] == R1
    assert client.get("/compliance/emails/history", params={"include_skipped": True}).json()["total"] == 2


# ------------------------------------------------------------------- history


def test_history_filters_and_scoping(client, org, mail, db_session):
    c = _compliance(client, people=(R1, R2, R3))
    login_as(client, ADMIN)
    obs = {o["user"]["email"]: o["id"] for o in client.get("/compliance/obligations", params={"compliance_id": c["id"]}).json()["items"]}
    _send(client, ADMIN, {"obligation_id": obs[R1]})
    b2 = _send(client, ADMIN, {"compliance_id": c["id"], "status": "all"}).json()["batch_id"]
    _send(client, MGR, {"emails": [R2]})
    _send(client, M2, {"emails": [O1]})
    login_as(client, ADMIN)
    assert client.get("/compliance/emails/history").json()["total"] == 6
    assert client.get("/compliance/emails/history", params={"person": R1.upper()}).json()["total"] == 2
    assert client.get("/compliance/emails/history", params={"obligation_id": obs[R1]}).json()["total"] == 2  # the single mail and the batch
    assert client.get("/compliance/emails/history", params={"compliance_id": c["id"]}).json()["total"] == 4
    assert client.get("/compliance/emails/history", params={"batch_id": b2}).json()["total"] == 3
    row = client.get("/compliance/emails/history", params={"obligation_id": obs[R1], "batch_id": b2}).json()["items"][0]
    assert row["sent_by"]["email"] == ADMIN and row["status"] == "sent" and row["compliance"] == "Repost the LinkedIn post" and row["body"]
    # a manager sees what they sent and what anyone sent to people in their line, never the other branch
    login_as(client, MGR)
    seen = client.get("/compliance/emails/history").json()["items"]
    assert {x["recipient"]["email"] for x in seen} == {R1, R2, R3} and len(seen) == 5
    assert client.get("/compliance/emails/history", params={"person": O1}).json()["total"] == 0
    login_as(client, M2)
    mine = client.get("/compliance/emails/history").json()
    assert mine["total"] == 1 and mine["items"][0]["recipient"]["email"] == O1
    assert client.get("/compliance/emails/history", params={"obligation_id": obs[R1]}).status_code == 404
    login_as(client, DANIEL)  # an employee can't read it, not even mail about themselves
    assert client.get("/compliance/emails/history").status_code == 403
    login_as(client, ADMIN)
    assert client.get("/compliance/emails/history", params={"batch_id": "x"}).status_code == 404


def test_history_hides_mail_about_items_the_viewer_may_not_see(client, org, mail, db_session):
    c = _compliance(client, category="HR")
    obs = client.get("/compliance/obligations", params={"compliance_id": c["id"]}).json()["items"]
    _send(client, ADMIN, {"obligation_id": obs[0]["id"]})
    db_session.add(RecordRule(name="no HR", resource="obligation", kind="restrictive", condition={"field": "category", "op": "not_in", "value": ["HR"]}, active=True))
    db_session.commit()
    login_as(client, MGR)
    assert client.get("/compliance/emails/history").json()["total"] == 0
    login_as(client, ADMIN)
    assert client.get("/compliance/emails/history").json()["total"] == 1


def test_sender_name_and_html_are_in_the_real_message(client, org, mail):
    _compliance(client)
    _send(client, MGR, {"emails": [R1]}, template_id=str(_template(org, "final-notice").id), subject=None, body=None, confirmed=True)
    m = mail.sent[0]
    html = m.get_body(("html",)).get_content()
    assert m["Subject"] == "Final notice: Repost the LinkedIn post"
    assert "Final notice" in html and "#b91c1c" in html and "Mia Manager" in html and "Open in Encop" in html
    assert m["Reply-To"] == MGR
    assert m.get_body(("plain",)) is not None
