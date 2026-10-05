"""Access control: who may do what (permissions) and to which records (scopes
and record rules). Every endpoint goes through `Ctx`; no endpoint writes its own
check, and every list/aggregate query takes its row filter from here.

Model
-----
- A role holds grants: (resource, action, scope).
- A person holds explicit roles plus implicit ones (`auto_assign`), and may have
  per-person overrides. Deny beats allow; no grant means no access.
- A scope decides which *people's* records a grant reaches (self, direct
  reports, the whole reporting line, a team, a department, everyone) or, for
  compliance definitions, "records I created".
- Record rules are extra row-level conditions: `allow` rules widen (OR),
  `restrictive` rules narrow (AND). They are structured data, never SQL.
- Super admins (a super role, or listed in COMPLIANCE_SUPER_ADMINS) bypass it all.
"""
import uuid
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, HTTPException
from sqlalchemy import and_, exists, false, or_, select, text, true
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.compliance import catalog
from app.compliance.models import (
    Compliance,
    Obligation,
    RecordRule,
    Role,
    RolePermission,
    Team,
    TeamMember,
    UserPermissionOverride,
    UserRole,
)
from app.config import settings
from app.database import get_db
from app.models import OrgUser


@dataclass(frozen=True)
class Scope:
    everyone: bool = False
    emails: frozenset[str] = frozenset()
    created_by_me: bool = False

    def __bool__(self) -> bool:
        return self.everyone or bool(self.emails) or self.created_by_me


def _bootstrap_admins() -> set[str]:
    return {e.strip().lower() for e in settings.compliance_super_admins.split(",") if e.strip()}


# ---------------------------------------------------------------- hierarchy


def subtree_emails(db: Session, email: str) -> set[str]:
    """Everyone below `email` in the reporting line (one recursive query)."""
    rows = db.execute(
        text(
            """
            WITH RECURSIVE r(email) AS (
                SELECT email FROM org_users WHERE manager_email = :me
                UNION
                SELECT u.email FROM org_users u JOIN r ON u.manager_email = r.email
            )
            SELECT email FROM r
            """
        ),
        {"me": email},
    )
    return {r[0] for r in rows}


def management_chain(db: Session, email: str, limit: int = 12) -> list[str]:
    """The person's manager, their manager's manager, ... (nearest first)."""
    chain: list[str] = []
    seen = {email}
    current = db.get(OrgUser, email)
    while current is not None and current.manager_email and len(chain) < limit:
        if current.manager_email in seen:
            break
        seen.add(current.manager_email)
        chain.append(current.manager_email)
        current = db.get(OrgUser, current.manager_email)
    return chain


# ---------------------------------------------------------------------- Ctx


class Ctx:
    """The signed-in person's effective access, computed once per request."""

    def __init__(self, db: Session, user: OrgUser):
        self.db = db
        self.user = user
        self.email = user.email
        self._people: dict[str, set[str]] = {}
        self._load()

    # -- loading
    def _load(self) -> None:
        db, email = self.db, self.email
        has_reports = db.scalar(select(exists().where(OrgUser.manager_email == email)))
        explicit = set(db.scalars(select(UserRole.role_id).where(UserRole.user_email == email)))
        roles = list(db.scalars(select(Role)))
        held = [
            r
            for r in roles
            if r.id in explicit or r.auto_assign == "all" or (r.auto_assign == "managers" and has_reports)
        ]
        self.roles = held
        self.role_ids = {r.id for r in held}
        self.is_super = any(r.is_super for r in held) or email.lower() in _bootstrap_admins()

        self._grants: dict[tuple[str, str], set[str]] = {}
        if self.role_ids:
            for g in db.scalars(select(RolePermission).where(RolePermission.role_id.in_(self.role_ids))):
                self._grants.setdefault((g.resource, g.action), set()).add(g.scope)
        self._denied: set[tuple[str, str]] = set()
        for o in db.scalars(select(UserPermissionOverride).where(UserPermissionOverride.user_email == email)):
            if o.effect == "deny":
                self._denied.add((o.resource, o.action))
            else:
                self._grants.setdefault((o.resource, o.action), set()).add(o.scope or "self")

    # -- permissions
    def can(self, resource: str, action: str) -> bool:
        if self.is_super:
            return True
        if (resource, action) in self._denied:
            return False
        return bool(self._grants.get((resource, action)))

    def require(self, resource: str, action: str) -> None:
        if not self.can(resource, action):
            raise HTTPException(status_code=403, detail=f"You don't have permission to {action} {resource.replace('_', ' ')}")

    def permissions(self) -> dict[str, dict[str, list[str]]]:
        """resource -> action -> scopes, for the UI (menus and buttons)."""
        out: dict[str, dict[str, list[str]]] = {}
        for resource, spec in catalog.RESOURCES.items():
            for action in spec["actions"]:
                if self.can(resource, action):
                    scopes = ["org"] if self.is_super else sorted(self._grants.get((resource, action), set()))
                    out.setdefault(resource, {})[action] = scopes
        return out

    # -- scopes
    def _people_for(self, scope: str) -> set[str]:
        if scope in self._people:
            return self._people[scope]
        me, db = self.email, self.db
        if scope == "self":
            people = {me}
        elif scope == "direct_reports":
            people = {me} | set(db.scalars(select(OrgUser.email).where(OrgUser.manager_email == me)))
        elif scope == "subtree":
            people = {me} | subtree_emails(db, me)
        elif scope == "team":
            team_ids = set(db.scalars(select(TeamMember.team_id).where(TeamMember.user_email == me)))
            team_ids |= set(db.scalars(select(Team.id).where(Team.lead_email == me)))
            people = {me}
            if team_ids:
                people |= set(db.scalars(select(TeamMember.user_email).where(TeamMember.team_id.in_(team_ids))))
                people |= {e for e in db.scalars(select(Team.lead_email).where(Team.id.in_(team_ids))) if e}
        elif scope == "department":
            people = {me}
            if self.user.department_id is not None:
                people |= set(db.scalars(select(OrgUser.email).where(OrgUser.department_id == self.user.department_id)))
        else:
            people = set()
        self._people[scope] = people
        return people

    def scope(self, resource: str, action: str) -> Scope:
        if self.is_super:
            return Scope(everyone=True)
        if (resource, action) in self._denied:
            return Scope()
        emails: set[str] = set()
        created = False
        for s in self._grants.get((resource, action), set()):
            if s == "org":
                return Scope(everyone=True)
            if s == "created_by_me":
                created = True
            else:
                emails |= self._people_for(s)
        return Scope(emails=frozenset(emails), created_by_me=created)

    def person_in_scope(self, resource: str, action: str, email: str) -> bool:
        sc = self.scope(resource, action)
        return sc.everyone or email in sc.emails

    # -- record rules
    def _rules(self, resource: str, kind: str) -> list[RecordRule]:
        if self.is_super:
            return []
        q = select(RecordRule).where(
            RecordRule.resource == resource,
            RecordRule.kind == kind,
            RecordRule.active.is_(True),
            or_(RecordRule.role_id.is_(None), RecordRule.role_id.in_(self.role_ids or {None})),
        )
        return list(self.db.scalars(q))

    def _apply_rules(self, base, resource: str, target: str):
        allow = [compile_condition(r.condition, target, self) for r in self._rules(resource, "allow")]
        restrict = [compile_condition(r.condition, target, self) for r in self._rules(resource, "restrictive")]
        clause = or_(base, *allow) if allow else base
        if restrict:
            clause = and_(clause, *restrict)
        return clause

    # -- row filters
    def compliance_clause(self, action: str = "view"):
        """Which compliance definitions the person may `action`."""
        if self.is_super:
            return true()
        sc = self.scope("compliance", action)
        if sc.everyone:
            base = true()
        else:
            parts = []
            if sc.created_by_me:
                parts.append(Compliance.created_by == self.email)
            if sc.emails:
                if action == "view":
                    parts.append(
                        Compliance.id.in_(select(Obligation.compliance_id).where(Obligation.user_email.in_(sc.emails)))
                    )
                parts.append(Compliance.created_by.in_(sc.emails))
            base = or_(*parts) if parts else false()
        return self._apply_rules(base, "compliance", "compliance")

    def obligation_clause(self, resource: str = "submission", action: str = "view"):
        """Which obligations (one person's duty under one compliance) the person may `action`."""
        if self.is_super:
            return true()
        sc = self.scope(resource, action)
        if sc.everyone:
            base = true()
        else:
            parts = []
            if sc.emails:
                parts.append(Obligation.user_email.in_(sc.emails))
            if sc.created_by_me:
                parts.append(
                    Obligation.compliance_id.in_(select(Compliance.id).where(Compliance.created_by == self.email))
                )
            base = or_(*parts) if parts else false()
        return self._apply_rules(base, "obligation", "obligation")

    def can_see_obligation(self, obligation_id, action: str = "view") -> bool:
        clause = self.obligation_clause("submission", action)
        return self.db.scalar(select(exists().where(Obligation.id == obligation_id, clause))) or False

    def can_see_compliance(self, compliance_id, action: str = "view") -> bool:
        clause = self.compliance_clause(action)
        return self.db.scalar(select(exists().where(Compliance.id == compliance_id, clause))) or False

    # -- review eligibility
    def can_review(self, obligation: Obligation, compliance: Compliance, action: str = "approve") -> bool:
        """Approve or reject needs the permission over the assignee, may never be
        the assignee, and follows the compliance's review mode."""
        if compliance.review_mode == "none":
            return False
        if obligation.user_email == self.email:
            return False
        if not self.person_in_scope("submission", action, obligation.user_email):
            return False
        if self.is_super:
            return True
        mode = compliance.review_mode
        if mode == "named":
            return (compliance.reviewer_email or "").lower() == self.email.lower()
        if mode == "manager":
            if self.scope("submission", action).everyone:
                return True
            return self.email in management_chain(self.db, obligation.user_email)
        return True  # any_reviewer


def get_ctx(db: Session = Depends(get_db), user: OrgUser = Depends(get_current_user)) -> Ctx:
    return Ctx(db, user)


# ------------------------------------------------------------- record rules

# field -> where it lives. "compliance" fields are columns of Compliance; when
# the rule targets obligations they are reached through the obligation's compliance.
_COMPLIANCE_FIELDS = {"category": "category", "priority": "priority", "type": "type_key", "status": "status"}
_OBLIGATION_FIELDS = {"participation": "participation", "status": "status"}
RULE_RESOURCES = ("compliance", "obligation")
RULE_OPS = ("in", "not_in", "eq", "ne")


def rule_fields(resource: str) -> list[str]:
    if resource == "compliance":
        return sorted(_COMPLIANCE_FIELDS)
    return sorted(set(_COMPLIANCE_FIELDS) | set(_OBLIGATION_FIELDS) | {"department"})


def validate_condition(cond: Any, resource: str) -> None:
    """Raises ValueError with a readable message for anything we can't compile."""
    if resource not in RULE_RESOURCES:
        raise ValueError(f"Unknown resource '{resource}'")
    if not isinstance(cond, dict) or not cond:
        raise ValueError("A condition must be an object")
    if "all" in cond or "any" in cond:
        key = "all" if "all" in cond else "any"
        items = cond[key]
        if not isinstance(items, list) or not items:
            raise ValueError(f"'{key}' needs a non-empty list of conditions")
        for c in items:
            validate_condition(c, resource)
        return
    field, op = cond.get("field"), cond.get("op", "in")
    if field not in rule_fields(resource):
        raise ValueError(f"Field '{field}' is not available for {resource} rules (use one of {rule_fields(resource)})")
    if op not in RULE_OPS:
        raise ValueError(f"Operator must be one of {list(RULE_OPS)}")
    value = cond.get("value")
    if op in ("in", "not_in"):
        if not isinstance(value, list) or not value:
            raise ValueError("'in' / 'not_in' need a non-empty list of values")
    elif value in (None, "", []):
        raise ValueError("A value is required")


def compile_condition(cond: dict, target: str, ctx: Ctx):
    """Structured condition -> SQLAlchemy clause on `target` ("compliance" or "obligation")."""
    if "all" in cond:
        return and_(*[compile_condition(c, target, ctx) for c in cond["all"]])
    if "any" in cond:
        return or_(*[compile_condition(c, target, ctx) for c in cond["any"]])
    field, op, value = cond["field"], cond.get("op", "in"), cond.get("value")
    values = value if isinstance(value, list) else [value]
    values = [
        (str(ctx.user.department_id) if v == "$my_department" else v) for v in values
    ]

    def apply(column):
        if op == "in":
            return column.in_(values)
        if op == "not_in":
            return column.not_in(values)
        if op == "eq":
            return column == values[0]
        return column != values[0]

    if field in _COMPLIANCE_FIELDS:
        col = getattr(Compliance, _COMPLIANCE_FIELDS[field])
        if target == "compliance":
            return apply(col)
        return Obligation.compliance_id.in_(select(Compliance.id).where(apply(col)))
    if target == "obligation" and field in _OBLIGATION_FIELDS:
        return apply(getattr(Obligation, _OBLIGATION_FIELDS[field]))
    if target == "obligation" and field == "department":
        dept_ids = []
        for v in values:
            try:
                dept_ids.append(uuid.UUID(str(v)))
            except ValueError:
                continue  # "$my_department" with no department, or a bad id: matches nobody
        return Obligation.user_email.in_(
            select(OrgUser.email).where(OrgUser.department_id.in_(dept_ids))
            if op in ("in", "eq")
            else select(OrgUser.email).where(or_(OrgUser.department_id.is_(None), OrgUser.department_id.not_in(dept_ids)))
        )
    return false()
