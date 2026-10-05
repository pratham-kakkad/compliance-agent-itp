"""Access control: permissions, scopes, record rules, overrides, admin guards."""
from app.compliance.models import RecordRule, Role
from tests.conftest import login_as
from tests.cx import (  # noqa: F401  (fixtures)
    AVA,
    BEA,
    CARL,
    DANA,
    DANIEL,
    SOFIA,
    grant_role,
    new_compliance,
    no_bootstrap,
    obligation_of,
    people,
    person_rule,
)


def test_employee_can_see_own_data_but_not_create(client, no_bootstrap):
    login_as(client, DANIEL)
    me = client.get("/compliance/me").json()
    assert [r["key"] for r in me["roles"]] == ["employee"]
    assert "compliance" in me["permissions"] and "create" not in me["permissions"]["compliance"]
    r = client.post("/compliance/definitions", json={"name": "Nope"})
    assert r.status_code == 403


def test_manager_role_is_implicit_for_people_with_reports(client, no_bootstrap):
    login_as(client, AVA)
    keys = {r["key"] for r in client.get("/compliance/me").json()["roles"]}
    assert keys == {"employee", "manager"}


def test_bootstrap_super_admin_can_do_everything(client):
    login_as(client, AVA)
    me = client.get("/compliance/me").json()
    assert me["is_super"] is True
    assert client.get("/compliance/admin/roles").status_code == 200


def test_admin_endpoints_need_permission(client, no_bootstrap):
    login_as(client, DANIEL)
    for path in ("/compliance/admin/users", "/compliance/admin/roles", "/compliance/admin/audit"):
        assert client.get(path).status_code == 403, path


def test_manager_sees_only_their_own_reporting_line(client, people, no_bootstrap):
    # One compliance for Ava's people, one for Bea's.
    grant_role(people, AVA, "compliance_admin")
    c1 = new_compliance(client, AVA, name="For Ava's team", audience=[person_rule(DANIEL), person_rule(SOFIA)])
    c2 = new_compliance(client, AVA, name="For Bea's team", audience=[person_rule(CARL), person_rule(DANA)])

    login_as(client, BEA)
    seen = client.get("/compliance/obligations").json()["items"]
    assert {o["user"]["email"] for o in seen} == {CARL, DANA}
    assert {o["compliance"]["name"] for o in seen} == {"For Bea's team"}
    # Bea can't open Ava's report's item, nor the compliance that only covers them.
    ava_item = obligation_of(client, DANIEL, c1["id"])
    login_as(client, BEA)
    assert client.get(f"/compliance/obligations/{ava_item['id']}").status_code == 404
    assert client.get(f"/compliance/definitions/{c1['id']}").status_code == 404
    assert client.get(f"/compliance/definitions/{c2['id']}").status_code == 200

    login_as(client, AVA)  # Ava sees her own reports, not Bea's reports' items (compliance_admin has org scope though)
    ava_view = client.get("/compliance/obligations").json()["items"]
    assert len(ava_view) == 4  # compliance_admin sees the whole org


def test_employee_sees_only_themselves(client, people, no_bootstrap):
    grant_role(people, AVA, "compliance_admin")
    new_compliance(client, AVA, audience=[person_rule(DANIEL), person_rule(SOFIA)])
    login_as(client, DANIEL)
    items = client.get("/compliance/obligations").json()["items"]
    assert [o["user"]["email"] for o in items] == [DANIEL]
    dash = client.get("/compliance/dashboard").json()
    assert dash["kpis"]["obligations"] == 1


def test_manager_scope_follows_the_reporting_line(client, people, no_bootstrap):
    grant_role(people, AVA, "compliance_admin")
    c = new_compliance(client, AVA, audience=[person_rule(DANIEL), person_rule(SOFIA), person_rule(CARL)])
    login_as(client, AVA)
    # Re-log in as the plain manager role of Bea / Ava: Bea (manager only) sees Carl but not Daniel.
    login_as(client, BEA)
    items = client.get("/compliance/obligations").json()["items"]
    assert {o["user"]["email"] for o in items} == {CARL}
    assert c["id"]


def test_deny_override_beats_role_grant(client, people, no_bootstrap):
    login_as(client, AVA)  # Ava is a plain manager here
    grant_role(people, AVA, "compliance_admin")
    login_as(client, AVA)
    assert client.get("/compliance/definitions").status_code == 200
    # Super admin (set up below) denies Ava the right to view compliance.
    grant_role(people, BEA, "super_admin")
    login_as(client, BEA)
    r = client.put(
        f"/compliance/admin/users/{AVA}/overrides",
        json={"overrides": [{"resource": "compliance", "action": "view", "effect": "deny"}]},
    )
    # Bea can't see Ava (outside her scope... but she is super_admin: org scope)
    assert r.status_code == 200, r.text
    login_as(client, AVA)
    assert client.get("/compliance/definitions").status_code == 403


def test_allow_override_grants_a_single_action(client, no_bootstrap, people):
    grant_role(people, BEA, "super_admin")
    login_as(client, BEA)
    r = client.put(
        f"/compliance/admin/users/{DANIEL}/overrides",
        json={"overrides": [{"resource": "compliance", "action": "create", "effect": "allow", "scope": "self"}]},
    )
    assert r.status_code == 200
    login_as(client, DANIEL)
    assert client.post("/compliance/definitions", json={"name": "Mine", "audience": [person_rule(DANIEL)]}).status_code == 201
    # ...but only create: no assign right, so publishing is refused.
    cid = client.get("/compliance/definitions").json()["items"][0]["id"]
    assert client.post(f"/compliance/definitions/{cid}/publish").status_code == 403


def test_assigning_outside_your_scope_is_refused(client, people, no_bootstrap):
    # Bea is a compliance manager: she can assign inside her reporting line only.
    grant_role(people, BEA, "compliance_manager")
    login_as(client, BEA)
    ok = client.post(
        "/compliance/definitions",
        json={"name": "Inside", "type_key": "general", "audience": [person_rule(CARL)]},
    )
    assert ok.status_code == 201
    assert client.post(f"/compliance/definitions/{ok.json()['id']}/publish").status_code == 200

    bad = client.post(
        "/compliance/definitions",
        json={"name": "Outside", "type_key": "general", "audience": [person_rule(CARL), person_rule(DANIEL)]},
    )
    assert bad.status_code == 201
    r = client.post(f"/compliance/definitions/{bad.json()['id']}/publish")
    assert r.status_code == 403
    assert DANIEL in r.json()["detail"]
    # The refusal didn't leave a half-published compliance behind.
    cid = bad.json()["id"]
    assert client.get(f"/compliance/definitions/{cid}").json()["status"] == "draft"


def test_restrictive_record_rule_hides_a_category(client, people, no_bootstrap):
    grant_role(people, AVA, "compliance_admin")
    new_compliance(client, AVA, name="HR matter", category="HR", audience=[person_rule(CARL)])
    new_compliance(client, AVA, name="Ordinary", category="General", audience=[person_rule(CARL)])

    login_as(client, BEA)
    assert {o["compliance"]["name"] for o in client.get("/compliance/obligations").json()["items"]} == {"HR matter", "Ordinary"}

    manager = people.query(Role).filter_by(key="manager").one()
    people.add(
        RecordRule(
            name="Managers never see HR",
            resource="obligation",
            kind="restrictive",
            role_id=manager.id,
            condition={"field": "category", "op": "not_in", "value": ["HR"]},
        )
    )
    people.commit()
    login_as(client, BEA)
    names = {o["compliance"]["name"] for o in client.get("/compliance/obligations").json()["items"]}
    assert names == {"Ordinary"}
    # Carl himself is not a manager, so the rule doesn't apply to him.
    login_as(client, CARL)
    assert len(client.get("/compliance/obligations").json()["items"]) == 2


def test_allow_record_rule_widens_visibility(client, people, no_bootstrap):
    grant_role(people, AVA, "compliance_admin")
    new_compliance(client, AVA, name="Safety drill", category="Safety", audience=[person_rule(DANIEL)])
    login_as(client, BEA)
    assert client.get("/compliance/obligations").json()["items"] == []
    people.add(
        RecordRule(name="Everyone sees Safety", resource="obligation", kind="allow", role_id=None, condition={"field": "category", "op": "in", "value": ["Safety"]})
    )
    people.commit()
    login_as(client, BEA)
    assert len(client.get("/compliance/obligations").json()["items"]) == 1


def test_record_rule_admin_api_validates_conditions(client):
    login_as(client, AVA)
    bad = client.post(
        "/compliance/admin/record-rules",
        json={"name": "x", "resource": "obligation", "kind": "restrictive", "condition": {"field": "salary", "op": "in", "value": [1]}},
    )
    assert bad.status_code == 400
    good = client.post(
        "/compliance/admin/record-rules",
        json={"name": "x", "resource": "compliance", "kind": "restrictive", "condition": {"all": [{"field": "priority", "op": "ne", "value": "low"}]}},
    )
    assert good.status_code == 201


def test_role_grants_are_validated_and_super_role_is_locked(client):
    login_as(client, AVA)
    roles = {r["key"]: r for r in client.get("/compliance/admin/roles").json()}
    emp = roles["employee"]
    bad = client.put(f"/compliance/admin/roles/{emp['id']}/grants", json={"grants": [{"resource": "compliance", "action": "teleport", "scope": "self"}]})
    assert bad.status_code == 400
    bad = client.put(f"/compliance/admin/roles/{emp['id']}/grants", json={"grants": [{"resource": "compliance", "action": "view", "scope": "galaxy"}]})
    assert bad.status_code == 400
    assert client.put(f"/compliance/admin/roles/{roles['super_admin']['id']}/grants", json={"grants": []}).status_code == 400
    assert client.delete(f"/compliance/admin/roles/{emp['id']}").status_code == 400  # built-in


def test_changing_a_role_changes_access_immediately(client, no_bootstrap, people):
    grant_role(people, BEA, "super_admin")
    login_as(client, BEA)
    roles = {r["key"]: r for r in client.get("/compliance/admin/roles").json()}
    emp = roles["employee"]
    grants = [g for g in emp["grants"] if not (g["resource"] == "compliance" and g["action"] == "view")]
    assert client.put(f"/compliance/admin/roles/{emp['id']}/grants", json={"grants": grants}).status_code == 200
    login_as(client, DANIEL)
    assert client.get("/compliance/definitions").status_code == 403


def test_cannot_remove_the_last_super_admin_or_deactivate_yourself(client, people, no_bootstrap):
    grant_role(people, BEA, "super_admin")
    login_as(client, BEA)
    assert client.patch(f"/compliance/admin/users/{BEA}", json={"is_active": False}).status_code == 400
    r = client.put(f"/compliance/admin/users/{BEA}/roles", json={"role_keys": []})
    assert r.status_code == 400 and "last Super Admin" in r.json()["detail"]


def test_deactivated_user_cannot_sign_in_and_loses_open_items(client, people):
    login_as(client, AVA)
    c = new_compliance(client, AVA, audience=[person_rule(DANIEL)])
    login_as(client, AVA)
    r = client.patch(f"/compliance/admin/users/{DANIEL}", json={"is_active": False})
    assert r.status_code == 200, r.text
    login_as(client, DANIEL)
    assert client.get("/compliance/me").status_code == 401
    login_as(client, AVA)
    items = client.get("/compliance/obligations", params={"compliance_id": c["id"]}).json()["items"]
    assert items[0]["status"] == "cancelled"


def test_user_admin_create_and_reporting_loop_guard(client):
    login_as(client, AVA)
    r = client.post("/compliance/admin/users", json={"email": "New.Hire@Corp.com", "name": "New Hire", "title": "Analyst", "manager_email": DANIEL})
    assert r.status_code == 201, r.text
    assert r.json()["email"] == "new.hire@corp.com"
    assert client.post("/compliance/admin/users", json={"email": "new.hire@corp.com", "name": "Dup"}).status_code == 409
    # Ava managing herself through a chain would be a loop.
    loop = client.patch(f"/compliance/admin/users/{AVA}", json={"manager_email": "new.hire@corp.com"})
    assert loop.status_code == 400


def test_access_preview_matches_real_permissions(client):
    login_as(client, AVA)
    prev = client.get(f"/compliance/admin/users/{DANIEL}/access").json()
    assert prev["is_super"] is False
    assert "create" not in prev["permissions"]["compliance"]
    assert prev["permissions"]["submission"]["submit"] == ["self"]
