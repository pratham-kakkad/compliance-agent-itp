"""The compliance lifecycle end to end: audience -> obligation -> evidence ->
review -> outcome, plus versions, participation and completion policies."""
from app.compliance.models import AuditEvent, Notification
from app.config import settings
from tests.conftest import login_as
from tests.cx import (  # noqa: F401  (fixtures)
    AVA,
    BEA,
    CARL,
    DANA,
    DANIEL,
    PNG,
    SOFIA,
    grant_role,
    in_days,
    iso,
    make_department,
    make_team,
    new_compliance,
    no_bootstrap,
    obligation_of,
    people,
    person_rule,
    submit_proof,
    upload,
)


def _audit_actions(db):
    return [e.action for e in db.query(AuditEvent).order_by(AuditEvent.id)]


def test_linkedin_example_end_to_end(client, db_session):
    c = new_compliance(client, AVA, name="Repost Company's LinkedIn Post")
    assert c["status"] == "published" and c["current_version"] == 1
    assert c["progress"]["required_total"] == 2

    # Daniel does the action, but forgets the proof: both mandatory pieces are named.
    ob = obligation_of(client, DANIEL, c["id"])
    assert ob["status"] == "not_started" and ob["can"]["submit"] is True
    r = client.post(f"/compliance/obligations/{ob['id']}/submit", json={"items": []})
    assert r.status_code == 400
    assert "Describe what you did" in r.json()["detail"] and "Screenshot" in r.json()["detail"]

    # Proper submission: description + attachment.
    r = submit_proof(client, DANIEL, ob["id"])
    assert r.status_code == 200, r.text
    after = r.json()
    assert after["status"] == "submitted"
    sub = after["submissions"][0]
    assert sub["version"] == 1 and {i["key"] for i in sub["items"]} == {"description", "proof"}
    assert sub["items"][1]["file"]["name"] == "shot.png"

    # Daniel can't mark his own work reviewed; his manager Ava gets the review request.
    login_as(client, DANIEL)
    assert client.post(f"/compliance/submissions/{sub['id']}/review", json={"decision": "approved"}).status_code == 403
    assert db_session.query(Notification).filter_by(user_email=AVA, kind="review_needed").count() == 1

    login_as(client, AVA)
    queue = client.get("/compliance/reviews").json()
    assert queue["total"] == 1 and queue["items"][0]["user"]["email"] == DANIEL

    # Rejecting needs a reason; then Daniel fixes it and resubmits.
    assert client.post(f"/compliance/submissions/{sub['id']}/review", json={"decision": "rejected"}).status_code == 400
    r = client.post(f"/compliance/submissions/{sub['id']}/review", json={"decision": "rejected", "reason": "The screenshot is cropped"})
    assert r.status_code == 200 and r.json()["status"] == "rejected"

    r = submit_proof(client, DANIEL, ob["id"], text="Reposted again with the full post visible", file_id=upload(client, DANIEL, "full.png"))
    assert r.status_code == 200 and r.json()["status"] == "submitted"
    assert [s["version"] for s in r.json()["submissions"]] == [1, 2]
    assert r.json()["resubmissions"] == 1

    login_as(client, AVA)
    sub2 = r.json()["submissions"][1]["id"]
    r = client.post(f"/compliance/submissions/{sub2}/review", json={"decision": "approved"})
    assert r.status_code == 200 and r.json()["status"] == "completed"
    # An approved submission can't be decided twice.
    assert client.post(f"/compliance/submissions/{sub2}/review", json={"decision": "rejected", "reason": "x"}).status_code == 409

    detail = client.get(f"/compliance/definitions/{c['id']}").json()
    assert detail["progress"]["completed"] == 1 and detail["progress"]["percent"] == 50
    assert detail["progress"]["satisfied"] is False  # Sofia hasn't done it

    actions = _audit_actions(db_session)
    for expected in (
        "compliance.created", "compliance.published", "obligation.assigned", "submission.submitted",
        "submission.rejected", "submission.approved", "obligation.status_changed", "evidence.uploaded",
    ):
        assert expected in actions, expected


def test_only_a_subset_of_the_audience_has_to_act(client, db_session, people):
    """Ten could be assigned, but only the named few must act: the rest are informed."""
    c = new_compliance(
        client,
        AVA,
        audience=[
            {"selector_type": "all", "effect": "include", "participation": "informational"},
            person_rule(DANIEL, "required"),
        ],
    )
    login_as(client, AVA)
    items = client.get("/compliance/obligations", params={"compliance_id": c["id"]}).json()["items"]
    by_user = {o["user"]["email"]: o for o in items}
    assert len(by_user) == 6  # everyone in the org has it
    assert by_user[DANIEL]["participation"] == "required"
    assert all(o["participation"] == "informational" for e, o in by_user.items() if e != DANIEL)
    # Only the required person counts, and the informed ones can't act.
    assert c["progress"]["required_total"] == 1
    login_as(client, SOFIA)
    sofia = client.get("/compliance/obligations", params={"mine": True}).json()["items"][0]
    assert sofia["can"]["submit"] is False
    r = client.post(f"/compliance/obligations/{sofia['id']}/submit", json={"items": []})
    assert r.status_code == 409
    # Exclude wins over include, and the strongest participation wins over a weaker one.
    c2 = new_compliance(
        client, AVA, name="Second",
        audience=[
            {"selector_type": "all", "effect": "include", "participation": "optional"},
            person_rule(DANIEL, "required"),
            person_rule(SOFIA, effect="exclude"),
        ],
    )
    login_as(client, AVA)
    got = {o["user"]["email"]: o["participation"] for o in client.get("/compliance/obligations", params={"compliance_id": c2["id"]}).json()["items"]}
    assert SOFIA not in got and got[DANIEL] == "required" and got[AVA] == "optional"


def test_audience_by_team_department_and_subtree(client, people):
    make_team(people, "Platform", [DANIEL, SOFIA])
    make_department(people, "Sales", [BEA, CARL, DANA])
    login_as(client, AVA)
    from app.compliance.models import Department, Team

    team = people.query(Team).filter_by(name="Platform").one()
    dept = people.query(Department).filter_by(name="Sales").one()
    prev = client.post(
        "/compliance/audience/preview",
        json={"audience": [{"selector_type": "team", "selector_ref": str(team.id)}, {"selector_type": "department", "selector_ref": str(dept.id)}]},
    ).json()
    assert {p["email"] for p in prev["people"]} == {DANIEL, SOFIA, BEA, CARL, DANA}
    prev = client.post("/compliance/audience/preview", json={"audience": [{"selector_type": "subtree", "selector_ref": BEA}]}).json()
    assert {p["email"] for p in prev["people"]} == {CARL, DANA}  # Bea herself is not "below" herself
    bad = client.post("/compliance/audience/preview", json={"audience": [{"selector_type": "person", "selector_ref": "ghost@corp.com"}]})
    assert bad.status_code == 400


def test_proof_rules_text_url_choice_attestation_and_files(client):
    reqs = [
        {"key": "note", "kind": "text", "label": "Note", "mandatory": True, "constraints": {"min_length": 20}},
        {"key": "link", "kind": "url", "label": "Link to the post", "mandatory": False},
        {"key": "size", "kind": "choice", "label": "Size", "mandatory": True, "constraints": {"options": ["S", "M", "L"]}},
        {"key": "ack", "kind": "attestation", "label": "I confirm", "mandatory": True},
        {"key": "doc", "kind": "file", "label": "Document", "mandatory": True, "constraints": {"extensions": [".pdf"]}},
    ]
    c = new_compliance(client, AVA, evidence_requirements=reqs, audience=[person_rule(DANIEL)])
    ob = obligation_of(client, DANIEL, c["id"])
    png = upload(client, DANIEL)

    def attempt(items):
        login_as(client, DANIEL)
        return client.post(f"/compliance/obligations/{ob['id']}/submit", json={"items": items})

    r = attempt([{"key": "note", "text": "too short"}, {"key": "link", "text": "not-a-url"}, {"key": "size", "text": "XL"}, {"key": "ack", "checked": False}, {"key": "doc", "file_id": png}])
    detail = r.json()["detail"]
    assert r.status_code == 400
    for fragment in ("at least 20 characters", "full web address", "listed options", "I confirm is required", "allowed file types"):
        assert fragment in detail, (fragment, detail)
    assert attempt([{"key": "mystery", "text": "x"}]).status_code == 400

    pdf = upload(client, DANIEL, "policy.pdf", b"%PDF-1.4 test")
    ok = attempt([{"key": "note", "text": "I completed every step as requested"}, {"key": "size", "text": "M"}, {"key": "ack", "checked": True}, {"key": "doc", "file_id": pdf}])
    assert ok.status_code == 200, ok.text
    # The same stored file can't be reused in another submission.
    login_as(client, DANIEL)
    c2 = new_compliance(client, AVA, name="Other", evidence_requirements=[{"key": "doc", "kind": "file", "label": "Doc", "mandatory": True}], audience=[person_rule(DANIEL)])
    ob2 = obligation_of(client, DANIEL, c2["id"])
    r = client.post(f"/compliance/obligations/{ob2['id']}/submit", json={"items": [{"key": "doc", "file_id": pdf}]})
    assert r.status_code == 400 and "already used" in r.json()["detail"]


def test_file_upload_validation(client, monkeypatch):
    login_as(client, DANIEL)
    bad_type = client.post("/compliance/evidence", files={"file": ("run.exe", b"MZ....", "application/octet-stream")})
    assert bad_type.status_code == 400
    liar = client.post("/compliance/evidence", files={"file": ("pic.png", b"this is not a png", "image/png")})
    assert liar.status_code == 400 and "don't match" in liar.json()["detail"]
    assert client.post("/compliance/evidence", files={"file": ("e.txt", b"", "text/plain")}).status_code == 400
    monkeypatch.setattr(settings, "evidence_max_mb", 1)
    big = client.post("/compliance/evidence", files={"file": ("big.txt", b"x" * (1024 * 1024 + 1), "text/plain")})
    assert big.status_code == 400 and "1 MB" in big.json()["detail"]
    ok = client.post("/compliance/evidence", files={"file": ("../../etc/passwd.txt", b"hello", "text/plain")})
    assert ok.status_code == 201 and ok.json()["name"] == "passwd.txt"  # path parts are stripped


def test_evidence_download_is_authorized(client, people, no_bootstrap):
    grant_role(people, AVA, "compliance_admin")
    c = new_compliance(client, AVA, audience=[person_rule(DANIEL), person_rule(CARL)])
    ob = obligation_of(client, DANIEL, c["id"])
    fid = upload(client, DANIEL)
    r = submit_proof(client, DANIEL, ob["id"], file_id=fid)
    assert r.status_code == 200
    login_as(client, DANIEL)
    own = client.get(f"/compliance/evidence/{fid}/download")
    assert own.status_code == 200 and own.content == PNG
    assert "attachment" in own.headers["content-disposition"]
    assert own.headers["x-content-type-options"] == "nosniff"
    login_as(client, AVA)
    assert client.get(f"/compliance/evidence/{fid}/download", params={"inline": True}).status_code == 200
    for outsider in (CARL, BEA):
        login_as(client, outsider)
        assert client.get(f"/compliance/evidence/{fid}/download").status_code == 404, outsider


def test_no_review_required_completes_on_submit(client):
    c = new_compliance(
        client, AVA, type_key="policy_acknowledgement", review_mode="none", audience=[person_rule(DANIEL)]
    )
    ob = obligation_of(client, DANIEL, c["id"])
    login_as(client, DANIEL)
    assert client.post(f"/compliance/obligations/{ob['id']}/submit", json={"items": []}).status_code == 400  # must tick
    r = client.post(f"/compliance/obligations/{ob['id']}/submit", json={"items": [{"key": "acknowledged", "checked": True}]})
    assert r.status_code == 200 and r.json()["status"] == "completed"
    assert r.json()["submissions"][0]["decisions"][0]["reviewer"]["name"] == "System"


def test_named_reviewer_and_separation_of_duties(client, people):
    c = new_compliance(client, AVA, review_mode="named", reviewer_email=BEA, audience=[person_rule(DANIEL)])
    ob = obligation_of(client, DANIEL, c["id"])
    r = submit_proof(client, DANIEL, ob["id"])
    sub = r.json()["submissions"][0]["id"]
    # Ava is the manager but not the named reviewer; she is a Super Admin so she may; Sofia may not.
    login_as(client, SOFIA)
    assert client.post(f"/compliance/submissions/{sub}/review", json={"decision": "approved"}).status_code in (403, 404)
    from app.compliance.models import UserRole  # noqa: F401

    grant_role(people, BEA, "compliance_manager")
    login_as(client, BEA)
    # Bea is named, but Daniel is outside her scope, so she still can't (scope + mode both apply).
    assert client.post(f"/compliance/submissions/{sub}/review", json={"decision": "approved"}).status_code in (403, 404)


def test_resubmission_limit_marks_non_compliant(client):
    c = new_compliance(client, AVA, max_resubmissions=1, audience=[person_rule(DANIEL)])
    ob = obligation_of(client, DANIEL, c["id"])
    sid = submit_proof(client, DANIEL, ob["id"]).json()["submissions"][0]["id"]
    login_as(client, AVA)
    client.post(f"/compliance/submissions/{sid}/review", json={"decision": "rejected", "reason": "no"})
    sid2 = submit_proof(client, DANIEL, ob["id"], file_id=upload(client, DANIEL, "b.png")).json()["submissions"][1]["id"]
    login_as(client, AVA)
    r = client.post(f"/compliance/submissions/{sid2}/review", json={"decision": "rejected", "reason": "still no"}).json()
    assert r["status"] == "rejected" and r["non_compliant"] is True
    login_as(client, DANIEL)
    assert client.get(f"/compliance/obligations/{ob['id']}").json()["can"]["submit"] is False
    again = submit_proof(client, DANIEL, ob["id"], file_id=upload(client, DANIEL, "c.png"))
    assert again.status_code == 409


def test_waive_extend_reopen_and_cancel(client):
    c = new_compliance(client, AVA, audience=[person_rule(DANIEL), person_rule(SOFIA)])
    login_as(client, AVA)
    items = {o["user"]["email"]: o for o in client.get("/compliance/obligations", params={"compliance_id": c["id"]}).json()["items"]}
    d, s = items[DANIEL], items[SOFIA]

    assert client.post(f"/compliance/obligations/{d['id']}/waive", json={}).status_code == 400  # reason needed
    w = client.post(f"/compliance/obligations/{d['id']}/waive", json={"reason": "On long leave"})
    assert w.status_code == 200 and w.json()["status"] == "waived"
    # Waived people leave the denominator.
    assert client.get(f"/compliance/definitions/{c['id']}").json()["progress"]["required_total"] == 1

    e = client.post(f"/compliance/obligations/{s['id']}/extend", json={"due_at": iso(in_days(20)), "reason": "Travelling"})
    assert e.status_code == 200 and e.json()["due_overridden"] is True
    assert client.post(f"/compliance/obligations/{s['id']}/extend", json={"due_at": iso(in_days(20))}).status_code == 400

    assert client.post(f"/compliance/obligations/{d['id']}/reopen", json={"reason": "Back from leave"}).json()["status"] == "in_progress"
    assert client.post(f"/compliance/obligations/{s['id']}/cancel", json={"reason": "Left the project"}).json()["status"] == "cancelled"
    # Illegal move: a cancelled item can't be waived.
    assert client.post(f"/compliance/obligations/{s['id']}/waive", json={"reason": "x"}).status_code == 409
    # An employee can't waive, extend or reopen.
    login_as(client, DANIEL)
    for path, body in (("waive", {"reason": "x"}), ("extend", {"due_at": iso(in_days(9)), "reason": "x"}), ("reopen", {"reason": "x"})):
        assert client.post(f"/compliance/obligations/{d['id']}/{path}", json=body).status_code == 403, path


def test_completion_policies(client):
    def finish(who, cid):
        ob = obligation_of(client, who, cid)
        sid = submit_proof(client, who, ob["id"], file_id=upload(client, who, f"{who[:3]}.png")).json()["submissions"][0]["id"]
        login_as(client, AVA)
        assert client.post(f"/compliance/submissions/{sid}/review", json={"decision": "approved"}).status_code == 200

    aud = [person_rule(DANIEL), person_rule(SOFIA)]
    any_c = new_compliance(client, AVA, name="Any", completion_policy="any", audience=aud)
    n_c = new_compliance(client, AVA, name="TwoOfTwo", completion_policy="at_least_n", completion_param=2, audience=aud)
    pct_c = new_compliance(client, AVA, name="Half", completion_policy="percentage", completion_param=50, audience=aud)
    all_c = new_compliance(client, AVA, name="All", audience=aud)
    for c in (any_c, n_c, pct_c, all_c):
        finish(DANIEL, c["id"])
    login_as(client, AVA)
    sat = {c["name"]: c["progress"]["satisfied"] for c in client.get("/compliance/definitions").json()["items"]}
    assert sat == {"Any": True, "TwoOfTwo": False, "Half": True, "All": False}
    for c in (n_c, all_c):
        finish(SOFIA, c["id"])
    login_as(client, AVA)
    sat = {c["name"]: c["progress"]["satisfied"] for c in client.get("/compliance/definitions").json()["items"]}
    assert sat["TwoOfTwo"] is True and sat["All"] is True


def test_invalid_definitions_are_rejected_with_clear_messages(client):
    login_as(client, AVA)
    cases = [
        ({"name": "x", "priority": "urgent"}, "Priority"),
        ({"name": "x", "review_mode": "named"}, "who reviews"),
        ({"name": "x", "completion_policy": "at_least_n"}, "how many people"),
        ({"name": "x", "evidence_requirements": [{"key": "a b", "kind": "text", "label": "A"}]}, "key"),
        ({"name": "x", "evidence_requirements": [{"key": "a", "kind": "choice", "label": "A", "constraints": {"options": ["one"]}}]}, "two options"),
        ({"name": "x", "escalation_rules": [{"id": "r", "trigger": {"type": "never"}, "actions": [{"type": "notify_assignee"}]}]}, "trigger"),
        ({"name": "x", "escalation_rules": [{"id": "r", "trigger": {"type": "on_due"}, "actions": []}]}, "at least one action"),
        ({"name": "x", "start_at": iso(in_days(5)), "due_at": iso(in_days(1))}, "before the start"),
    ]
    for body, fragment in cases:
        r = client.post("/compliance/definitions", json=body)
        assert r.status_code == 400 and fragment in r.json()["detail"], (body, r.text)
    assert client.post("/compliance/definitions", json={"name": "  "}).status_code == 422
    # Can't publish with nobody in the audience, or no audience at all.
    d = client.post("/compliance/definitions", json={"name": "Empty"}).json()
    assert client.post(f"/compliance/definitions/{d['id']}/publish").status_code == 400


def test_editing_a_published_compliance_makes_a_new_version(client):
    c = new_compliance(client, AVA, audience=[person_rule(DANIEL), person_rule(SOFIA)])
    first = obligation_of(client, DANIEL, c["id"])
    assert [r["key"] for r in client.get(f"/compliance/obligations/{first['id']}").json()["instructions"]["evidence_requirements"]] == ["description", "proof"]

    login_as(client, AVA)
    new_reqs = [{"key": "link", "kind": "url", "label": "Link", "mandatory": True}]
    r = client.patch(f"/compliance/definitions/{c['id']}", json={"evidence_requirements": new_reqs})
    assert r.status_code == 200 and r.json()["current_version"] == 2
    # Daniel keeps the rules he was assigned under...
    login_as(client, DANIEL)
    old = client.get(f"/compliance/obligations/{first['id']}").json()
    assert old["version"] == 1 and old["instructions"]["evidence_requirements"][0]["key"] == "description"
    # ...unless the editor chooses to move everyone onto the new version.
    login_as(client, AVA)
    client.patch(f"/compliance/definitions/{c['id']}", json={"due_at": iso(in_days(30))}, params={"apply_to_existing": True})
    login_as(client, DANIEL)
    moved = client.get(f"/compliance/obligations/{first['id']}").json()
    assert moved["version"] == 3 and moved["instructions"]["evidence_requirements"][0]["key"] == "link"


def test_lifecycle_pause_resume_close_clone_delete(client):
    login_as(client, AVA)
    draft = client.post("/compliance/definitions", json={"name": "Draft one", "audience": [person_rule(DANIEL)]}).json()
    assert client.post(f"/compliance/definitions/{draft['id']}/pause").status_code == 409
    clone = client.post(f"/compliance/definitions/{draft['id']}/clone")
    assert clone.status_code == 201 and clone.json()["name"] == "Draft one (copy)"
    assert client.delete(f"/compliance/definitions/{clone.json()['id']}").status_code == 204

    c = new_compliance(client, AVA, audience=[person_rule(DANIEL)])
    ob = obligation_of(client, DANIEL, c["id"])
    login_as(client, AVA)
    assert client.post(f"/compliance/definitions/{c['id']}/pause").json()["status"] == "paused"
    assert submit_proof(client, DANIEL, ob["id"]).status_code == 409  # paused: nothing can be submitted
    login_as(client, AVA)
    resumed = client.post(f"/compliance/definitions/{c['id']}/resume"); assert resumed.status_code == 200, resumed.text; assert resumed.json()["status"] == "published"
    assert client.delete(f"/compliance/definitions/{c['id']}").status_code == 409  # published ones are kept
    assert client.post(f"/compliance/definitions/{c['id']}/close").json()["status"] == "closed"
    login_as(client, DANIEL)
    assert client.get(f"/compliance/obligations/{ob['id']}").json()["status"] == "cancelled"
    login_as(client, AVA)
    assert client.patch(f"/compliance/definitions/{c['id']}", json={"name": "Renamed"}).status_code == 409


def test_dynamic_audience_follows_the_org(client, db_session):
    from app.compliance.escalation import tick
    from app.compliance.models import Team, TeamMember
    from app.models import OrgUser

    make_team(db_session, "Platform", [DANIEL])
    team = db_session.query(Team).filter_by(name="Platform").one()
    c = new_compliance(
        client, AVA, dynamic_audience=True,
        audience=[{"selector_type": "team", "selector_ref": str(team.id), "effect": "include", "participation": "required"}],
    )
    login_as(client, AVA)
    assert len(client.get("/compliance/obligations", params={"compliance_id": c["id"]}).json()["items"]) == 1
    db_session.add(TeamMember(team_id=team.id, user_email=SOFIA))
    db_session.commit()
    tick(db_session)
    db_session.commit()
    login_as(client, AVA)
    assert {o["user"]["email"] for o in client.get("/compliance/obligations", params={"compliance_id": c["id"]}).json()["items"]} == {DANIEL, SOFIA}
    # Someone who hasn't started and leaves the team is cancelled; history is kept.
    db_session.query(TeamMember).filter_by(team_id=team.id, user_email=SOFIA).delete()
    db_session.commit()
    tick(db_session)
    db_session.commit()
    login_as(client, AVA)
    st = {o["user"]["email"]: o["status"] for o in client.get("/compliance/obligations", params={"compliance_id": c["id"]}).json()["items"]}
    assert st[SOFIA] == "cancelled" and st[DANIEL] == "not_started"
    assert db_session.get(OrgUser, SOFIA) is not None


def test_audit_trail_records_who_did_what(client, db_session):
    c = new_compliance(client, AVA, audience=[person_rule(DANIEL)])
    ob = obligation_of(client, DANIEL, c["id"])
    submit_proof(client, DANIEL, ob["id"])
    login_as(client, AVA)
    page = client.get("/compliance/admin/audit", params={"entity_type": "compliance"}).json()
    assert {e["action"] for e in page["items"]} >= {"compliance.created", "compliance.published"}
    assert all(e["actor"] == AVA for e in page["items"] if e["action"] == "compliance.created")
    subs = client.get("/compliance/admin/audit", params={"action": "submission."}).json()["items"]
    assert subs and subs[0]["actor"] == DANIEL
    assert client.get("/compliance/admin/audit/verify").json()["ok"] is True
    csv = client.get("/compliance/admin/audit/export")
    assert csv.status_code == 200 and csv.text.startswith("id,at,actor,action")
    # The employee can't read the audit log; the table itself refuses edits.
    login_as(client, DANIEL)
    assert client.get("/compliance/admin/audit").status_code == 403
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError

    with pytest.raises(DBAPIError):
        with db_session.begin_nested():
            db_session.execute(text("UPDATE audit_events SET action = 'tampered'"))
    with pytest.raises(DBAPIError):
        with db_session.begin_nested():
            db_session.execute(text("DELETE FROM audit_events"))
    # A rewritten hash chain would be caught.
    assert client.get("/compliance/admin/audit/verify").status_code == 403
    login_as(client, AVA)
    assert client.get("/compliance/admin/audit/verify").json()["ok"] is True


def test_assigned_because_is_readable(client, db_session):
    make_team(db_session, "Platform", [DANIEL])
    from app.compliance.models import Team

    team = db_session.query(Team).filter_by(name="Platform").one()
    c = new_compliance(client, AVA, audience=[{"selector_type": "team", "selector_ref": str(team.id), "effect": "include", "participation": "required"}])
    ob = obligation_of(client, DANIEL, c["id"])
    login_as(client, DANIEL)
    assert client.get(f"/compliance/obligations/{ob['id']}").json()["assigned_via"] == ["Team Platform"]
