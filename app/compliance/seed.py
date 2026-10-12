"""Seed data. `seed_system_data` (roles and compliance types) is idempotent and
runs at every start: it only creates what is missing, never overwrites what an
administrator has edited. `seed_demo` adds sample departments, a team and three
example compliances for the demo accounts."""
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.compliance import catalog, engine
from app.compliance.models import Compliance, ComplianceType, Department, Role, RolePermission, Team, TeamMember
from app.models import OrgUser

DEMO_ACTOR = "ava.martinez@corp.com"


def seed_system_data(db: Session) -> None:
    existing = {r.key for r in db.scalars(select(Role))}
    for key, spec in catalog.DEFAULT_ROLES.items():
        if key in existing:
            continue
        role = Role(
            key=key,
            name=spec["name"],
            description=spec["description"],
            is_system=True,
            is_super=bool(spec.get("is_super")),
            auto_assign=spec.get("auto_assign"),
        )
        for resource, action, scope in spec["grants"]:
            role.grants.append(RolePermission(resource=resource, action=action, scope=scope))
        db.add(role)

    have_types = {t.key for t in db.scalars(select(ComplianceType))}
    for t in catalog.DEFAULT_TYPES:
        if t["key"] in have_types:
            continue
        db.add(
            ComplianceType(
                key=t["key"],
                name=t["name"],
                description=t["description"],
                evidence_defaults=t["evidence"],
                review_default=t["review_mode"],
                escalation_default=t["escalation"],
                is_system=True,
            )
        )
    db.commit()

    # The built-in e-mail templates. If the migration hasn't been applied yet the table is missing: skip, don't fail start-up.
    from sqlalchemy.exc import ProgrammingError

    from app.compliance.messaging import seed_email_templates

    try:
        seed_email_templates(db)
    except ProgrammingError:
        db.rollback()


def seed_demo(db: Session) -> None:
    seed_system_data(db)
    ava = db.get(OrgUser, DEMO_ACTOR)
    daniel = db.get(OrgUser, "daniel.kim@corp.com")
    sofia = db.get(OrgUser, "sofia.rossi@corp.com")
    if not (ava and daniel and sofia):
        return

    eng = db.scalar(select(Department).where(Department.name == "Engineering"))
    if eng is None:
        eng = Department(name="Engineering")
        db.add(eng)
        db.flush()
    for u in (ava, daniel, sofia):
        if u.department_id is None:
            u.department_id = eng.id

    team = db.scalar(select(Team).where(Team.name == "Platform"))
    if team is None:
        team = Team(name="Platform", department_id=eng.id)
        db.add(team)
        db.flush()
        db.add_all([TeamMember(team_id=team.id, user_email=daniel.email), TeamMember(team_id=team.id, user_email=sofia.email)])
    db.commit()

    now = engine.now()

    def make(data: dict) -> Compliance | None:
        if db.scalar(select(Compliance.id).where(Compliance.name == data["name"])):
            return None
        c = engine.create_compliance(db, DEMO_ACTOR, data)
        engine.publish(db, DEMO_ACTOR, c)
        db.commit()
        return c

    # The example from the brief: a social action with description + screenshot as proof.
    # Daniel and Sofia must act; Ava (their manager, in the department) is only informed.
    make(
        {
            "name": "Repost the Company's LinkedIn Post",
            "description": "Repost this week's company announcement on your own LinkedIn profile.",
            "category": "Social media",
            "type_key": "external_action",
            "action_text": "Repost the latest company post on LinkedIn, then describe what you did and attach a screenshot.",
            "priority": "medium",
            "due_at": now + timedelta(days=5),
            "review_mode": "manager",
            "evidence_requirements": [
                {"key": "description", "kind": "text", "label": "What did you do?", "mandatory": True, "constraints": {"min_length": 10}},
                {"key": "screenshot", "kind": "file", "label": "Screenshot of the repost", "mandatory": True, "constraints": {"extensions": [".png", ".jpg", ".jpeg"]}},
            ],
            "audience": [
                {"selector_type": "team", "selector_ref": str(team.id), "effect": "include", "participation": "required"},
                {"selector_type": "department", "selector_ref": str(eng.id), "effect": "include", "participation": "informational"},
            ],
        }
    )

    ack = make(
        {
            "name": "Acknowledge the Information Security Policy",
            "description": "Read the policy and confirm you understand it.",
            "category": "Policy",
            "type_key": "policy_acknowledgement",
            "action_text": "Open the policy, read it, and tick the acknowledgement.",
            "priority": "high",
            "due_at": now + timedelta(days=10),
            "review_mode": "none",
            "audience": [{"selector_type": "all", "effect": "include", "participation": "required"}],
        }
    )
    if ack is not None:
        from app.compliance.models import Obligation

        ob = db.scalar(select(Obligation).where(Obligation.compliance_id == ack.id, Obligation.user_email == sofia.email))
        if ob is not None:
            engine.submit(db, ob, sofia.email, [{"key": "acknowledged", "checked": True}])
            db.commit()

    make(
        {
            "name": "Complete the Annual Security Training",
            "description": "Finish the course and submit your certificate.",
            "category": "Training",
            "type_key": "training",
            "action_text": "Complete the course in the learning portal and upload the certificate.",
            "priority": "critical",
            "due_at": now - timedelta(days=3),  # already late, so the demo shows escalation and the scoreboard
            "review_mode": "manager",
            "audience": [
                {"selector_type": "person", "selector_ref": daniel.email, "effect": "include", "participation": "required"},
                {"selector_type": "person", "selector_ref": sofia.email, "effect": "include", "participation": "required"},
            ],
        }
    )
