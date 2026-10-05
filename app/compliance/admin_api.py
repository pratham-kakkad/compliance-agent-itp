"""Administration API: users, departments and teams, roles and permissions,
record rules, the audit log and the scheduler. Every change is audited with
before/after."""
import csv
import io
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from app.compliance import audit, catalog, engine, escalation, policy
from app.compliance.api import aware, get_uuid
from app.compliance.models import (
    AuditEvent,
    Compliance,
    Department,
    Obligation,
    RecordRule,
    Role,
    RolePermission,
    Team,
    TeamMember,
    UserPermissionOverride,
    UserRole,
)
from app.compliance.policy import Ctx, get_ctx
from app.compliance.serializers import Directory, obligation_dict
from app.models import OrgUser

router = APIRouter(prefix="/compliance/admin", tags=["compliance-admin"])


def _bad(msg: str, code: int = 400):
    raise HTTPException(status_code=code, detail=msg)


# ---------------------------------------------------------------- schemas


class UserIn(BaseModel):
    email: str
    name: str
    title: str = ""
    manager_email: str | None = None
    department_id: str | None = None
    role_keys: list[str] = Field(default_factory=list)


class UserPatch(BaseModel):
    name: str | None = None
    title: str | None = None
    manager_email: str | None = None
    department_id: str | None = None
    is_active: bool | None = None
    clear_manager: bool = False
    clear_department: bool = False


class RolesIn(BaseModel):
    role_keys: list[str]


class OverrideIn(BaseModel):
    resource: str
    action: str
    effect: str
    scope: str | None = None


class OverridesIn(BaseModel):
    overrides: list[OverrideIn]


class NameIn(BaseModel):
    name: str
    department_id: str | None = None
    lead_email: str | None = None


class MembersIn(BaseModel):
    emails: list[str]


class RoleIn(BaseModel):
    key: str | None = None
    name: str
    description: str = ""
    auto_assign: str | None = None


class RolePatch(BaseModel):
    name: str | None = None
    description: str | None = None


class GrantIn(BaseModel):
    resource: str
    action: str
    scope: str


class GrantsIn(BaseModel):
    grants: list[GrantIn]


class RuleIn(BaseModel):
    name: str
    resource: str
    kind: str
    role_key: str | None = None
    condition: dict
    active: bool = True


# ------------------------------------------------------------------ helpers


def _user_dict(u: OrgUser, depts: dict, roles: dict[str, list[dict]]) -> dict:
    return {
        "email": u.email,
        "name": u.name,
        "title": u.title,
        "manager_email": u.manager_email,
        "department_id": str(u.department_id) if u.department_id else None,
        "department": depts.get(u.department_id),
        "is_active": u.is_active,
        "is_demo": u.is_demo,
        "roles": roles.get(u.email, []),
    }


def _roles_by_user(db) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for ur, r in db.execute(select(UserRole, Role).join(Role, Role.id == UserRole.role_id)).all():
        out.setdefault(ur.user_email, []).append({"key": r.key, "name": r.name})
    return out


def _super_emails(db) -> set[str]:
    held = set(
        db.scalars(select(UserRole.user_email).join(Role, Role.id == UserRole.role_id).where(Role.is_super.is_(True)))
    )
    return {e.lower() for e in held} | policy._bootstrap_admins()


def _super_count(db, excluding: str | None = None) -> int:
    return len(_super_emails(db) - {(excluding or "").lower()})


def _check_perm(resource: str, action: str, scope: str | None = None):
    if resource not in catalog.RESOURCES or action not in catalog.RESOURCES[resource]["actions"]:
        _bad(f"'{action}' isn't an action of '{resource}'")
    if scope is not None and scope not in catalog.SCOPES:
        _bad(f"Scope must be one of {list(catalog.SCOPES)}")


def _role_dict(db, r: Role) -> dict:
    members = db.scalar(select(func.count()).where(UserRole.role_id == r.id))
    return {
        "id": str(r.id),
        "key": r.key,
        "name": r.name,
        "description": r.description,
        "is_system": r.is_system,
        "is_super": r.is_super,
        "auto_assign": r.auto_assign,
        "members": members,
        "grants": sorted(
            ({"resource": g.resource, "action": g.action, "scope": g.scope} for g in r.grants),
            key=lambda g: (g["resource"], g["action"]),
        ),
    }


# ------------------------------------------------------------------- users


@router.get("/users")
def list_users(q: str | None = None, include_inactive: bool = True, limit: int = Query(300, le=1000), ctx: Ctx = Depends(get_ctx)):
    ctx.require("user", "view")
    db = ctx.db
    cond = []
    sc = ctx.scope("user", "view")
    if not sc.everyone:
        cond.append(OrgUser.email.in_(sc.emails or {""}))
    if not include_inactive:
        cond.append(OrgUser.is_active.is_(True))
    if q:
        like = f"%{q.strip()}%"
        cond.append(or_(OrgUser.name.ilike(like), OrgUser.email.ilike(like), OrgUser.title.ilike(like)))
    rows = list(db.scalars(select(OrgUser).where(*cond).order_by(OrgUser.name).limit(limit)))
    depts = {d.id: d.name for d in db.scalars(select(Department))}
    roles = _roles_by_user(db)
    return {"total": len(rows), "items": [_user_dict(u, depts, roles) for u in rows]}


@router.post("/users", status_code=201)
def create_user(body: UserIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("user", "create")
    db = ctx.db
    email = body.email.strip().lower()
    if "@" not in email or " " in email:
        _bad("Enter a valid e-mail address")
    if not body.name.strip():
        _bad("A user needs a name")
    if db.get(OrgUser, email) is not None:
        _bad("Someone with that e-mail already exists", 409)
    if body.manager_email and db.get(OrgUser, body.manager_email) is None:
        _bad("That manager doesn't exist")
    dept = get_uuid(body.department_id, "department") if body.department_id else None
    if dept and db.get(Department, dept) is None:
        _bad("That department doesn't exist")
    u = OrgUser(email=email, name=body.name.strip(), title=body.title.strip(), manager_email=body.manager_email, department_id=dept, is_demo=False, is_active=True)
    db.add(u)
    db.flush()
    if body.role_keys:
        ctx.require("role", "configure")
        _set_roles(ctx, u, body.role_keys)
    audit.record(db, ctx.email, "user.created", "user", email, after={"name": u.name, "title": u.title, "manager": u.manager_email, "roles": body.role_keys})
    db.commit()
    return _user_dict(u, {d.id: d.name for d in db.scalars(select(Department))}, _roles_by_user(db))


def _load_user(ctx: Ctx, email: str, action: str = "view") -> OrgUser:
    u = ctx.db.get(OrgUser, email)
    if u is None or not ctx.person_in_scope("user", "view", email):
        _bad("No such user", 404)
    if action != "view" and not ctx.person_in_scope("user", action, email):
        _bad(f"You can't {action} this user", 403)
    return u


@router.get("/users/{email}")
def get_user(email: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("user", "view")
    u = _load_user(ctx, email)
    db = ctx.db
    depts = {d.id: d.name for d in db.scalars(select(Department))}
    out = _user_dict(u, depts, _roles_by_user(db))
    out["overrides"] = [
        {"resource": o.resource, "action": o.action, "effect": o.effect, "scope": o.scope}
        for o in db.scalars(select(UserPermissionOverride).where(UserPermissionOverride.user_email == email))
    ]
    out["teams"] = [
        {"id": str(t.id), "name": t.name}
        for t in db.scalars(select(Team).join(TeamMember, TeamMember.team_id == Team.id).where(TeamMember.user_email == email))
    ]
    # Compliance history, limited to what the viewer may see.
    clause = ctx.obligation_clause("submission", "view")
    counts = dict(db.execute(select(Obligation.status, func.count()).where(clause, Obligation.user_email == email).group_by(Obligation.status)).all())
    rows = list(db.scalars(select(Obligation).where(clause, Obligation.user_email == email).order_by(Obligation.created_at.desc()).limit(30)))
    d = Directory(db, {email})
    out["history"] = {"counts": counts, "items": [obligation_dict(db, o, ctx, d) for o in rows]}
    return out


@router.patch("/users/{email}")
def update_user(email: str, body: UserPatch, ctx: Ctx = Depends(get_ctx)):
    ctx.require("user", "edit")
    u = _load_user(ctx, email, "edit")
    db = ctx.db
    before = {"name": u.name, "title": u.title, "manager": u.manager_email, "department": str(u.department_id) if u.department_id else None, "is_active": u.is_active}
    if body.name is not None:
        if not body.name.strip():
            _bad("A user needs a name")
        u.name = body.name.strip()
    if body.title is not None:
        u.title = body.title.strip()
    if body.clear_manager:
        u.manager_email = None
    elif body.manager_email is not None:
        if db.get(OrgUser, body.manager_email) is None:
            _bad("That manager doesn't exist")
        if body.manager_email == email or body.manager_email in policy.subtree_emails(db, email):
            _bad("That would make a reporting loop")
        u.manager_email = body.manager_email
    if body.clear_department:
        u.department_id = None
    elif body.department_id is not None:
        dept = get_uuid(body.department_id, "department")
        if db.get(Department, dept) is None:
            _bad("That department doesn't exist")
        u.department_id = dept
    cancelled = 0
    if body.is_active is not None and body.is_active != u.is_active:
        ctx.require("user", "delete")
        if email == ctx.email and not body.is_active:
            _bad("You can't deactivate yourself")
        if not body.is_active and email.lower() in _super_emails(db) and _super_count(db, excluding=email) == 0:
            _bad("That's the last Super Admin")
        u.is_active = body.is_active
        if not body.is_active:
            for ob in db.scalars(select(Obligation).where(Obligation.user_email == email, Obligation.status.in_(catalog.OPEN))):
                engine._move(db, ob, "cancelled", ctx.email, "The person was deactivated", notify_user=False)
                cancelled += 1
    after = {"name": u.name, "title": u.title, "manager": u.manager_email, "department": str(u.department_id) if u.department_id else None, "is_active": u.is_active}
    if before != after:
        audit.record(db, ctx.email, "user.updated", "user", email, before=before, after=after, meta={"obligations_cancelled": cancelled} if cancelled else None)
    db.commit()
    return get_user(email, ctx)


def _is_super_holder(db, email: str) -> bool:
    return bool(
        db.scalar(
            select(func.count())
            .select_from(UserRole)
            .join(Role, Role.id == UserRole.role_id)
            .where(UserRole.user_email == email, Role.is_super.is_(True))
        )
    )


def _set_roles(ctx: Ctx, u: OrgUser, keys: list[str]) -> None:
    db = ctx.db
    roles = {r.key: r for r in db.scalars(select(Role))}
    unknown = [k for k in keys if k not in roles]
    if unknown:
        _bad(f"Unknown role: {', '.join(unknown)}")
    explicit_keys = [k for k in keys if roles[k].auto_assign is None]  # implicit roles aren't stored
    current = {ur.role_id: ur for ur in db.scalars(select(UserRole).where(UserRole.user_email == u.email))}
    want_ids = {roles[k].id for k in explicit_keys}
    for rid, ur in list(current.items()):
        if rid not in want_ids:
            db.delete(ur)
    for rid in want_ids - set(current):
        db.add(UserRole(user_email=u.email, role_id=rid))
    db.flush()


@router.put("/users/{email}/roles")
def set_user_roles(email: str, body: RolesIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("role", "configure")
    u = _load_user(ctx, email)
    db = ctx.db
    before = sorted(r["key"] for r in _roles_by_user(db).get(email, []))
    super_keys = {r.key for r in db.scalars(select(Role).where(Role.is_super.is_(True)))}
    if email.lower() in _super_emails(db) and not (set(body.role_keys) & super_keys) and _super_count(db, excluding=email) == 0 and email.lower() not in policy._bootstrap_admins():
        _bad("That's the last Super Admin")
    if (set(body.role_keys) & super_keys) and not ctx.is_super:
        _bad("Only a Super Admin can make someone a Super Admin", 403)
    _set_roles(ctx, u, body.role_keys)
    after = sorted(body.role_keys)
    audit.record(db, ctx.email, "user.roles_changed", "user", email, before=before, after=after)
    db.commit()
    return get_user(email, ctx)


@router.put("/users/{email}/overrides")
def set_user_overrides(email: str, body: OverridesIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("role", "configure")
    u = _load_user(ctx, email)
    db = ctx.db
    for o in body.overrides:
        _check_perm(o.resource, o.action, o.scope)
        if o.effect not in ("allow", "deny"):
            _bad("Effect must be allow or deny")
        if o.effect == "allow" and not o.scope:
            _bad("An allow needs a scope")
    before = [
        {"resource": o.resource, "action": o.action, "effect": o.effect, "scope": o.scope}
        for o in db.scalars(select(UserPermissionOverride).where(UserPermissionOverride.user_email == email))
    ]
    for o in db.scalars(select(UserPermissionOverride).where(UserPermissionOverride.user_email == email)):
        db.delete(o)
    db.flush()
    seen = set()
    for o in body.overrides:
        if (o.resource, o.action) in seen:
            _bad(f"{o.resource}:{o.action} is listed twice")
        seen.add((o.resource, o.action))
        db.add(UserPermissionOverride(user_email=email, resource=o.resource, action=o.action, effect=o.effect, scope=o.scope if o.effect == "allow" else None))
    audit.record(db, ctx.email, "user.overrides_changed", "user", email, before=before, after=[o.model_dump() for o in body.overrides])
    db.commit()
    return get_user(email, ctx)


@router.get("/users/{email}/access")
def user_access(email: str, ctx: Ctx = Depends(get_ctx)):
    """What this person can do, exactly as the system will evaluate it ("view as")."""
    ctx.require("role", "view")
    u = _load_user(ctx, email)
    other = Ctx(ctx.db, u)
    return {
        "email": email,
        "is_super": other.is_super,
        "roles": [{"key": r.key, "name": r.name} for r in other.roles],
        "permissions": other.permissions(),
    }


# ---------------------------------------------------- departments and teams


@router.get("/departments")
def list_departments(ctx: Ctx = Depends(get_ctx)):
    ctx.require("team", "view")
    db = ctx.db
    counts = dict(db.execute(select(OrgUser.department_id, func.count()).group_by(OrgUser.department_id)).all())
    return [{"id": str(d.id), "name": d.name, "members": counts.get(d.id, 0)} for d in db.scalars(select(Department).order_by(Department.name))]


@router.post("/departments", status_code=201)
def create_department(body: NameIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("team", "create")
    name = body.name.strip()
    if not name:
        _bad("A department needs a name")
    if ctx.db.scalar(select(Department.id).where(func.lower(Department.name) == name.lower())):
        _bad("A department with that name exists", 409)
    d = Department(name=name)
    ctx.db.add(d)
    ctx.db.flush()
    audit.record(ctx.db, ctx.email, "department.created", "department", d.id, after={"name": name})
    ctx.db.commit()
    return {"id": str(d.id), "name": d.name, "members": 0}


@router.patch("/departments/{did}")
def rename_department(did: str, body: NameIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("team", "edit")
    d = ctx.db.get(Department, get_uuid(did, "department"))
    if d is None:
        _bad("No such department", 404)
    old, d.name = d.name, body.name.strip()
    if not d.name:
        _bad("A department needs a name")
    audit.record(ctx.db, ctx.email, "department.renamed", "department", d.id, before={"name": old}, after={"name": d.name})
    ctx.db.commit()
    return {"id": str(d.id), "name": d.name}


@router.delete("/departments/{did}", status_code=204)
def delete_department(did: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("team", "delete")
    d = ctx.db.get(Department, get_uuid(did, "department"))
    if d is None:
        _bad("No such department", 404)
    audit.record(ctx.db, ctx.email, "department.deleted", "department", d.id, before={"name": d.name})
    ctx.db.delete(d)
    ctx.db.commit()


def _team_dict(db, t: Team) -> dict:
    members = list(db.scalars(select(TeamMember.user_email).where(TeamMember.team_id == t.id)))
    return {
        "id": str(t.id),
        "name": t.name,
        "department_id": str(t.department_id) if t.department_id else None,
        "lead_email": t.lead_email,
        "members": sorted(members),
    }


@router.get("/teams")
def list_teams(ctx: Ctx = Depends(get_ctx)):
    ctx.require("team", "view")
    return [_team_dict(ctx.db, t) for t in ctx.db.scalars(select(Team).order_by(Team.name))]


def _apply_team(ctx: Ctx, t: Team, body: NameIn) -> None:
    db = ctx.db
    name = body.name.strip()
    if not name:
        _bad("A team needs a name")
    clash = db.scalar(select(Team.id).where(func.lower(Team.name) == name.lower(), Team.id != t.id))
    if clash:
        _bad("A team with that name exists", 409)
    t.name = name
    if body.department_id:
        did = get_uuid(body.department_id, "department")
        if db.get(Department, did) is None:
            _bad("That department doesn't exist")
        t.department_id = did
    else:
        t.department_id = None
    if body.lead_email and db.get(OrgUser, body.lead_email) is None:
        _bad("That lead doesn't exist")
    t.lead_email = body.lead_email or None


@router.post("/teams", status_code=201)
def create_team(body: NameIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("team", "create")
    t = Team(id=uuid.uuid4(), name="")
    _apply_team(ctx, t, body)
    ctx.db.add(t)
    ctx.db.flush()
    audit.record(ctx.db, ctx.email, "team.created", "team", t.id, after={"name": t.name})
    ctx.db.commit()
    return _team_dict(ctx.db, t)


@router.patch("/teams/{tid}")
def update_team(tid: str, body: NameIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("team", "edit")
    t = ctx.db.get(Team, get_uuid(tid, "team"))
    if t is None:
        _bad("No such team", 404)
    before = _team_dict(ctx.db, t)
    _apply_team(ctx, t, body)
    audit.record(ctx.db, ctx.email, "team.updated", "team", t.id, before=before, after=_team_dict(ctx.db, t))
    ctx.db.commit()
    return _team_dict(ctx.db, t)


@router.put("/teams/{tid}/members")
def set_team_members(tid: str, body: MembersIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("team", "edit")
    db = ctx.db
    t = db.get(Team, get_uuid(tid, "team"))
    if t is None:
        _bad("No such team", 404)
    emails = set(body.emails)
    known = set(db.scalars(select(OrgUser.email).where(OrgUser.email.in_(emails or {""}))))
    if emails - known:
        _bad(f"Unknown people: {', '.join(sorted(emails - known))}")
    before = _team_dict(db, t)["members"]
    for m in list(t.members):
        if m.user_email not in emails:
            db.delete(m)
    have = {m.user_email for m in t.members}
    for e in emails - have:
        db.add(TeamMember(team_id=t.id, user_email=e))
    db.flush()
    audit.record(db, ctx.email, "team.members_changed", "team", t.id, before=before, after=sorted(emails))
    db.commit()
    db.expire(t)
    return _team_dict(db, t)


@router.delete("/teams/{tid}", status_code=204)
def delete_team(tid: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("team", "delete")
    t = ctx.db.get(Team, get_uuid(tid, "team"))
    if t is None:
        _bad("No such team", 404)
    audit.record(ctx.db, ctx.email, "team.deleted", "team", t.id, before=_team_dict(ctx.db, t))
    ctx.db.delete(t)
    ctx.db.commit()


# ------------------------------------------------------------------- roles


@router.get("/roles")
def list_roles(ctx: Ctx = Depends(get_ctx)):
    ctx.require("role", "view")
    return [_role_dict(ctx.db, r) for r in ctx.db.scalars(select(Role).order_by(Role.is_super.desc(), Role.name))]


@router.post("/roles", status_code=201)
def create_role(body: RoleIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("role", "create")
    db = ctx.db
    name = body.name.strip()
    if not name:
        _bad("A role needs a name")
    key = (body.key or name).strip().lower().replace(" ", "_")
    if db.scalar(select(Role.id).where(Role.key == key)):
        _bad("A role with that key exists", 409)
    if body.auto_assign not in (None, "all", "managers"):
        _bad("auto_assign must be empty, 'all' or 'managers'")
    r = Role(key=key, name=name, description=body.description, is_system=False, auto_assign=body.auto_assign)
    db.add(r)
    db.flush()
    audit.record(db, ctx.email, "role.created", "role", r.id, after={"key": key, "name": name})
    db.commit()
    return _role_dict(db, r)


@router.patch("/roles/{rid}")
def update_role(rid: str, body: RolePatch, ctx: Ctx = Depends(get_ctx)):
    ctx.require("role", "edit")
    r = ctx.db.get(Role, get_uuid(rid, "role"))
    if r is None:
        _bad("No such role", 404)
    before = {"name": r.name, "description": r.description}
    if body.name is not None and body.name.strip():
        r.name = body.name.strip()
    if body.description is not None:
        r.description = body.description
    audit.record(ctx.db, ctx.email, "role.updated", "role", r.id, before=before, after={"name": r.name, "description": r.description})
    ctx.db.commit()
    return _role_dict(ctx.db, r)


@router.put("/roles/{rid}/grants")
def set_role_grants(rid: str, body: GrantsIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("role", "configure")
    db = ctx.db
    r = db.get(Role, get_uuid(rid, "role"))
    if r is None:
        _bad("No such role", 404)
    if r.is_super:
        _bad("A Super Admin always has every permission; there is nothing to edit")
    seen = set()
    for g in body.grants:
        _check_perm(g.resource, g.action, g.scope)
        if (g.resource, g.action) in seen:
            _bad(f"{g.resource}:{g.action} is listed twice")
        seen.add((g.resource, g.action))
    before = _role_dict(db, r)["grants"]
    r.grants.clear()
    db.flush()
    for g in body.grants:
        r.grants.append(RolePermission(resource=g.resource, action=g.action, scope=g.scope))
    db.flush()
    audit.record(db, ctx.email, "role.grants_changed", "role", r.id, before=before, after=[g.model_dump() for g in body.grants])
    db.commit()
    return _role_dict(db, r)


@router.delete("/roles/{rid}", status_code=204)
def delete_role(rid: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("role", "delete")
    r = ctx.db.get(Role, get_uuid(rid, "role"))
    if r is None:
        _bad("No such role", 404)
    if r.is_system:
        _bad("The built-in roles can't be deleted (edit their permissions instead)")
    audit.record(ctx.db, ctx.email, "role.deleted", "role", r.id, before=_role_dict(ctx.db, r))
    ctx.db.delete(r)
    ctx.db.commit()


# ------------------------------------------------------------ record rules


def _rule_dict(db, r: RecordRule) -> dict:
    role = db.get(Role, r.role_id) if r.role_id else None
    return {
        "id": str(r.id),
        "name": r.name,
        "resource": r.resource,
        "kind": r.kind,
        "role_key": role.key if role else None,
        "role_name": role.name if role else "Everyone",
        "condition": r.condition,
        "active": r.active,
    }


@router.get("/record-rules")
def list_rules(ctx: Ctx = Depends(get_ctx)):
    ctx.require("role", "view")
    out = [_rule_dict(ctx.db, r) for r in ctx.db.scalars(select(RecordRule).order_by(RecordRule.name))]
    return {"rules": out, "fields": {res: policy.rule_fields(res) for res in policy.RULE_RESOURCES}, "ops": list(policy.RULE_OPS)}


def _rule_from(ctx: Ctx, body: RuleIn) -> tuple[uuid.UUID | None]:
    if body.kind not in ("allow", "restrictive"):
        _bad("Kind must be allow or restrictive")
    try:
        policy.validate_condition(body.condition, body.resource)
    except ValueError as e:
        _bad(str(e))
    if body.role_key:
        role = ctx.db.scalar(select(Role).where(Role.key == body.role_key))
        if role is None:
            _bad("Unknown role")
        return (role.id,)
    return (None,)


@router.post("/record-rules", status_code=201)
def create_rule(body: RuleIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("role", "configure")
    (role_id,) = _rule_from(ctx, body)
    r = RecordRule(name=body.name.strip() or "Rule", resource=body.resource, kind=body.kind, role_id=role_id, condition=body.condition, active=body.active)
    ctx.db.add(r)
    ctx.db.flush()
    audit.record(ctx.db, ctx.email, "record_rule.created", "record_rule", r.id, after=_rule_dict(ctx.db, r))
    ctx.db.commit()
    return _rule_dict(ctx.db, r)


@router.put("/record-rules/{rid}")
def update_rule(rid: str, body: RuleIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("role", "configure")
    r = ctx.db.get(RecordRule, get_uuid(rid, "rule"))
    if r is None:
        _bad("No such rule", 404)
    before = _rule_dict(ctx.db, r)
    (role_id,) = _rule_from(ctx, body)
    r.name, r.resource, r.kind, r.role_id, r.condition, r.active = body.name.strip() or r.name, body.resource, body.kind, role_id, body.condition, body.active
    ctx.db.flush()
    audit.record(ctx.db, ctx.email, "record_rule.updated", "record_rule", r.id, before=before, after=_rule_dict(ctx.db, r))
    ctx.db.commit()
    return _rule_dict(ctx.db, r)


@router.delete("/record-rules/{rid}", status_code=204)
def delete_rule(rid: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("role", "configure")
    r = ctx.db.get(RecordRule, get_uuid(rid, "rule"))
    if r is None:
        _bad("No such rule", 404)
    audit.record(ctx.db, ctx.email, "record_rule.deleted", "record_rule", r.id, before=_rule_dict(ctx.db, r))
    ctx.db.delete(r)
    ctx.db.commit()


# ------------------------------------------------------------------- audit


def _audit_query(ctx: Ctx, actor, action, entity_type, entity_id, since, until, q):
    cond = []
    sc = ctx.scope("audit_log", "view")
    if not sc.everyone:
        cond.append(AuditEvent.actor_email.in_(sc.emails or {""}))
    if actor:
        cond.append(AuditEvent.actor_email == actor)
    if action:
        cond.append(AuditEvent.action.ilike(f"{action}%"))
    if entity_type:
        cond.append(AuditEvent.entity_type == entity_type)
    if entity_id:
        cond.append(AuditEvent.entity_id == entity_id)
    if since:
        cond.append(AuditEvent.at >= aware(since))
    if until:
        cond.append(AuditEvent.at <= aware(until))
    if q:
        like = f"%{q.strip()}%"
        cond.append(or_(AuditEvent.action.ilike(like), AuditEvent.actor_email.ilike(like), AuditEvent.entity_id.ilike(like)))
    return cond


def _event(e: AuditEvent) -> dict:
    return {
        "id": e.id,
        "at": e.at.isoformat(),
        "actor": e.actor_email,
        "action": e.action,
        "entity_type": e.entity_type,
        "entity_id": e.entity_id,
        "before": e.before,
        "after": e.after,
        "meta": e.meta,
    }


@router.get("/audit")
def list_audit(
    actor: str | None = None,
    action: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    q: str | None = None,
    limit: int = Query(100, le=500),
    offset: int = 0,
    ctx: Ctx = Depends(get_ctx),
):
    ctx.require("audit_log", "view")
    cond = _audit_query(ctx, actor, action, entity_type, entity_id, since, until, q)
    total = ctx.db.scalar(select(func.count()).select_from(AuditEvent).where(*cond))
    rows = ctx.db.scalars(select(AuditEvent).where(*cond).order_by(AuditEvent.id.desc()).limit(limit).offset(offset))
    return {"total": total, "items": [_event(e) for e in rows]}


@router.get("/audit/verify")
def verify_audit(ctx: Ctx = Depends(get_ctx)):
    ctx.require("audit_log", "view")
    return audit.verify_chain(ctx.db)


@router.get("/audit/export")
def export_audit(
    actor: str | None = None,
    action: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    q: str | None = None,
    ctx: Ctx = Depends(get_ctx),
):
    ctx.require("audit_log", "export")
    cond = _audit_query(ctx, actor, action, entity_type, entity_id, since, until, q)
    rows = list(ctx.db.scalars(select(AuditEvent).where(*cond).order_by(AuditEvent.id.desc()).limit(50_000)))
    audit.record(ctx.db, ctx.email, "audit.exported", "audit_log", "export", meta={"rows": len(rows)})
    ctx.db.commit()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "at", "actor", "action", "entity_type", "entity_id", "before", "after", "meta"])
    for e in rows:
        w.writerow([e.id, e.at.isoformat(), e.actor_email, e.action, e.entity_type, e.entity_id, e.before, e.after, e.meta])
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="audit-log.csv"'},
    )


# --------------------------------------------------------------- scheduler


@router.post("/run-tick")
def run_tick(ctx: Ctx = Depends(get_ctx)):
    """Run the deadline / escalation pass now (it also runs on a timer)."""
    ctx.require("settings", "configure")
    result = escalation.tick(ctx.db)
    audit.record(ctx.db, ctx.email, "scheduler.run", "scheduler", "manual", meta=result)
    ctx.db.commit()
    return result
