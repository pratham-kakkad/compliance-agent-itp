"""The compliance engine: definitions, audience resolution and the obligation
workflow. Pure domain logic over the models: no HTTP, no permission checks (the
API layer does those through policy.Ctx before calling in)."""
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.compliance import audit, catalog
from app.compliance.models import (
    AudienceRule,
    Compliance,
    ComplianceType,
    ComplianceVersion,
    Department,
    EvidenceFile,
    EvidenceItem,
    Obligation,
    ReviewDecision,
    Role,
    Submission,
    Team,
    TeamMember,
    UserRole,
)
from app.compliance.notify import notify, obligation_link
from app.compliance.policy import management_chain, subtree_emails
from app.models import OrgUser

_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")


class EngineError(ValueError):
    """A request the engine refuses; the API turns it into a 400 / 409."""


class Conflict(EngineError):
    """The request is valid but not allowed in the current state (HTTP 409)."""


def now() -> datetime:
    return datetime.now(timezone.utc)


# ----------------------------------------------------------- normalisation


def normalize_requirements(reqs: Any) -> list[dict]:
    if reqs is None:
        return []
    if not isinstance(reqs, list):
        raise EngineError("Evidence requirements must be a list")
    out, seen = [], set()
    for i, r in enumerate(reqs, 1):
        if not isinstance(r, dict):
            raise EngineError(f"Evidence requirement {i} is not an object")
        key = str(r.get("key", "")).strip()
        kind = r.get("kind")
        label = str(r.get("label", "")).strip()
        if not _SLUG.match(key):
            raise EngineError(f"Evidence requirement {i}: key must be lowercase letters, digits, - or _")
        if key in seen:
            raise EngineError(f"Evidence requirement key '{key}' is used twice")
        if kind not in catalog.EVIDENCE_KINDS:
            raise EngineError(f"Evidence requirement '{key}': kind must be one of {catalog.EVIDENCE_KINDS}")
        if not label:
            raise EngineError(f"Evidence requirement '{key}' needs a label")
        constraints = dict(r.get("constraints") or {})
        if kind == "choice":
            options = constraints.get("options")
            if not isinstance(options, list) or len(options) < 2 or not all(isinstance(o, str) and o for o in options):
                raise EngineError(f"Evidence requirement '{key}': a choice needs at least two options")
        seen.add(key)
        out.append(
            {"key": key, "kind": kind, "label": label, "mandatory": bool(r.get("mandatory", True)), "constraints": constraints}
        )
    return out


def normalize_escalation(rules: Any) -> list[dict]:
    if rules is None:
        return []
    if not isinstance(rules, list):
        raise EngineError("Escalation rules must be a list")
    out, seen = [], set()
    for i, r in enumerate(rules, 1):
        if not isinstance(r, dict):
            raise EngineError(f"Escalation rule {i} is not an object")
        rid = str(r.get("id") or f"rule-{i}").strip()
        if not _SLUG.match(rid):
            raise EngineError(f"Escalation rule {i}: id must be lowercase letters, digits, - or _")
        if rid in seen:
            raise EngineError(f"Escalation rule id '{rid}' is used twice")
        seen.add(rid)
        trig = r.get("trigger") or {}
        ttype = trig.get("type")
        if ttype not in catalog.TRIGGERS:
            raise EngineError(f"Escalation rule '{rid}': trigger must be one of {catalog.TRIGGERS}")
        try:
            days = int(trig.get("days", 0))
        except (TypeError, ValueError):
            raise EngineError(f"Escalation rule '{rid}': days must be a whole number")
        if days < 0 or days > 365:
            raise EngineError(f"Escalation rule '{rid}': days must be between 0 and 365")
        actions = r.get("actions")
        if not isinstance(actions, list) or not actions:
            raise EngineError(f"Escalation rule '{rid}' needs at least one action")
        clean_actions = []
        for a in actions:
            atype = (a or {}).get("type")
            if atype not in catalog.ACTIONS:
                raise EngineError(f"Escalation rule '{rid}': unknown action '{atype}'")
            item: dict[str, Any] = {"type": atype}
            if atype == "notify_users":
                emails = [str(e).strip() for e in (a.get("emails") or []) if str(e).strip()]
                if not emails:
                    raise EngineError(f"Escalation rule '{rid}': notify_users needs at least one e-mail")
                item["emails"] = emails
            if atype == "notify_manager_chain":
                item["levels"] = max(1, min(6, int(a.get("levels", 2))))
            clean_actions.append(item)
        out.append(
            {
                "id": rid,
                "name": str(r.get("name") or rid),
                "trigger": {"type": ttype, "days": days},
                "actions": clean_actions,
            }
        )
    return out


def normalize_audience(db: Session, rules: Any) -> list[dict]:
    if rules is None:
        return []
    if not isinstance(rules, list):
        raise EngineError("The audience must be a list of rules")
    out = []
    for i, r in enumerate(rules, 1):
        stype = (r or {}).get("selector_type")
        ref = (r or {}).get("selector_ref")
        effect = (r or {}).get("effect", "include")
        part = (r or {}).get("participation", "required")
        if stype not in catalog.SELECTOR_TYPES:
            raise EngineError(f"Audience rule {i}: type must be one of {catalog.SELECTOR_TYPES}")
        if effect not in ("include", "exclude"):
            raise EngineError(f"Audience rule {i}: effect must be include or exclude")
        if part not in catalog.PARTICIPATION:
            raise EngineError(f"Audience rule {i}: participation must be one of {catalog.PARTICIPATION}")
        if stype != "all":
            if not ref:
                raise EngineError(f"Audience rule {i}: choose who it applies to")
            ref = str(ref)
            if stype in ("person", "subtree") and db.get(OrgUser, ref) is None:
                raise EngineError(f"Audience rule {i}: nobody with e-mail {ref}")
            if stype == "team" and db.get(Team, _as_uuid(ref, i)) is None:
                raise EngineError(f"Audience rule {i}: that team doesn't exist")
            if stype == "department" and db.get(Department, _as_uuid(ref, i)) is None:
                raise EngineError(f"Audience rule {i}: that department doesn't exist")
            if stype == "role" and db.scalar(select(Role.id).where(Role.key == ref)) is None:
                raise EngineError(f"Audience rule {i}: that role doesn't exist")
        else:
            ref = None
        out.append({"selector_type": stype, "selector_ref": ref, "effect": effect, "participation": part})
    return out


def _as_uuid(value: str, i: int | None = None) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        raise EngineError(f"'{value}' is not a valid id" + (f" (audience rule {i})" if i else ""))


# -------------------------------------------------------------- definitions

_EDITABLE = (
    "name", "description", "category", "type_key", "action_text", "priority", "start_at", "due_at",
    "completion_policy", "completion_param", "review_mode", "reviewer_email", "max_resubmissions",
    "dynamic_audience",
)


def _check_fields(db: Session, data: dict) -> None:
    if "name" in data and not str(data["name"] or "").strip():
        raise EngineError("A compliance needs a name")
    if "priority" in data and data["priority"] not in catalog.PRIORITIES:
        raise EngineError(f"Priority must be one of {catalog.PRIORITIES}")
    if "completion_policy" in data and data["completion_policy"] not in catalog.COMPLETION_POLICIES:
        raise EngineError(f"Completion policy must be one of {catalog.COMPLETION_POLICIES}")
    if "review_mode" in data and data["review_mode"] not in catalog.REVIEW_MODES:
        raise EngineError(f"Review mode must be one of {catalog.REVIEW_MODES}")
    if "type_key" in data and db.get(ComplianceType, data["type_key"]) is None:
        raise EngineError(f"Unknown compliance type '{data['type_key']}'")
    if data.get("reviewer_email") and db.get(OrgUser, data["reviewer_email"]) is None:
        raise EngineError(f"Nobody with e-mail {data['reviewer_email']} to act as reviewer")
    if "max_resubmissions" in data and not (0 <= int(data["max_resubmissions"]) <= 20):
        raise EngineError("Resubmissions must be between 0 and 20")


def _cross_check(c: Compliance) -> None:
    if c.review_mode == "named" and not c.reviewer_email:
        raise EngineError("Choose who reviews submissions")
    if c.completion_policy in ("at_least_n", "percentage"):
        if not c.completion_param or c.completion_param < 1:
            raise EngineError("Enter how many people (or what percentage) must complete it")
        if c.completion_policy == "percentage" and c.completion_param > 100:
            raise EngineError("A percentage can't be more than 100")
    if c.start_at and c.due_at and c.due_at < c.start_at:
        raise EngineError("The deadline is before the start date")


def snapshot_of(c: Compliance) -> dict:
    return audit.clean(
        {
            "name": c.name,
            "description": c.description,
            "category": c.category,
            "type_key": c.type_key,
            "action_text": c.action_text,
            "priority": c.priority,
            "start_at": c.start_at,
            "due_at": c.due_at,
            "completion_policy": c.completion_policy,
            "completion_param": c.completion_param,
            "review_mode": c.review_mode,
            "reviewer_email": c.reviewer_email,
            "max_resubmissions": c.max_resubmissions,
            "evidence_requirements": c.evidence_requirements,
            "escalation_rules": c.escalation_rules,
        }
    )


def audience_of(c: Compliance) -> list[dict]:
    return [
        {"selector_type": a.selector_type, "selector_ref": a.selector_ref, "effect": a.effect, "participation": a.participation}
        for a in c.audience
    ]


def _set_audience(db: Session, c: Compliance, rules: list[dict]) -> None:
    c.audience.clear()
    db.flush()
    for r in rules:
        c.audience.append(AudienceRule(**r))


def create_compliance(db: Session, actor: str, data: dict) -> Compliance:
    data = dict(data)
    _check_fields(db, data)
    ctype = db.get(ComplianceType, data.get("type_key") or "general")
    c = Compliance(created_by=actor, status="draft", type_key=ctype.key)
    for f in _EDITABLE:
        if f in data and data[f] is not None:
            setattr(c, f, data[f])
    c.name = (c.name or "").strip()
    # Defaults come from the type unless the caller supplied their own.
    c.evidence_requirements = normalize_requirements(
        data["evidence_requirements"] if "evidence_requirements" in data else ctype.evidence_defaults
    )
    c.review_mode = data.get("review_mode") or ctype.review_default
    esc = data["escalation_rules"] if "escalation_rules" in data else catalog.ESCALATION_PRESETS.get(
        ctype.escalation_default, {"rules": []}
    )["rules"]
    c.escalation_rules = normalize_escalation(esc)
    _cross_check(c)
    db.add(c)
    db.flush()
    _set_audience(db, c, normalize_audience(db, data.get("audience")))
    audit.record(db, actor, "compliance.created", "compliance", c.id, after={**snapshot_of(c), "audience": audience_of(c)})
    return c


def update_compliance(db: Session, actor: str, c: Compliance, data: dict, apply_to_existing: bool = False) -> Compliance:
    if c.status in ("closed", "archived"):
        raise Conflict("A closed or archived compliance can't be edited")
    data = dict(data)
    _check_fields(db, data)
    before = {**snapshot_of(c), "audience": audience_of(c)}
    for f in _EDITABLE:
        if f in data:
            setattr(c, f, data[f])
    if "name" in data:
        c.name = c.name.strip()
    if "evidence_requirements" in data:
        c.evidence_requirements = normalize_requirements(data["evidence_requirements"])
    if "escalation_rules" in data:
        c.escalation_rules = normalize_escalation(data["escalation_rules"])
    _cross_check(c)
    if "audience" in data:
        _set_audience(db, c, normalize_audience(db, data["audience"]))
    db.flush()
    after = {**snapshot_of(c), "audience": audience_of(c)}
    if before == after:
        return c
    audit.record(db, actor, "compliance.updated", "compliance", c.id, before=before, after=after)

    if c.status in ("published", "paused"):
        if snapshot_of(c) != _latest_snapshot(db, c):
            _new_version(db, actor, c)
            if apply_to_existing:
                _apply_version_to_open(db, actor, c)
        if "audience" in data and c.status == "published":
            resync_audience(db, actor, c)
    return c


def _latest_snapshot(db: Session, c: Compliance) -> dict | None:
    return db.scalar(
        select(ComplianceVersion.snapshot).where(
            ComplianceVersion.compliance_id == c.id, ComplianceVersion.version == c.current_version
        )
    )


def _new_version(db: Session, actor: str, c: Compliance) -> ComplianceVersion:
    c.current_version += 1
    v = ComplianceVersion(compliance_id=c.id, version=c.current_version, snapshot=snapshot_of(c), created_by=actor)
    db.add(v)
    db.flush()
    audit.record(db, actor, "compliance.version_created", "compliance", c.id, after={"version": c.current_version})
    return v


def _apply_version_to_open(db: Session, actor: str, c: Compliance) -> int:
    """Move people who haven't finished onto the new rules (and new deadline, unless theirs was extended by hand)."""
    n = 0
    for ob in db.scalars(select(Obligation).where(Obligation.compliance_id == c.id, Obligation.status.in_(catalog.OPEN))):
        ob.version = c.current_version
        if not ob.due_overridden:
            ob.due_at = c.due_at
        n += 1
    if n:
        audit.record(db, actor, "compliance.version_applied", "compliance", c.id, meta={"obligations": n, "version": c.current_version})
    return n


def delete_draft(db: Session, actor: str, c: Compliance) -> None:
    if c.status != "draft":
        raise Conflict("Only a draft can be deleted: published compliance is closed or archived, so its history stays")
    audit.record(db, actor, "compliance.deleted", "compliance", c.id, before={**snapshot_of(c), "audience": audience_of(c)})
    db.delete(c)
    db.flush()


def validate_for_publish(db: Session, c: Compliance) -> None:
    if not c.name.strip():
        raise EngineError("A compliance needs a name")
    if not c.audience:
        raise EngineError("Choose who this applies to before publishing")
    _cross_check(c)
    if not any(a.effect == "include" for a in c.audience):
        raise EngineError("The audience needs at least one 'include' rule")
    if not resolve_audience(db, audience_of(c)):
        raise EngineError("The audience doesn't match anyone right now")


def publish(db: Session, actor: str, c: Compliance) -> dict:
    if c.status != "draft":
        raise Conflict("Only a draft can be published")
    validate_for_publish(db, c)
    c.status = "published"
    c.published_at = now()
    _new_version(db, actor, c)
    audit.record(db, actor, "compliance.published", "compliance", c.id)
    return resync_audience(db, actor, c)


def set_status(db: Session, actor: str, c: Compliance, new: str) -> Compliance:
    allowed = {
        "pause": ("published", "paused"),
        "resume": ("paused", "published"),
        "close": (("published", "paused"), "closed"),
        "archive": (("closed", "draft"), "archived"),
    }[new]
    sources, target = allowed
    sources = (sources,) if isinstance(sources, str) else sources
    if c.status not in sources:
        raise Conflict(f"Can't {new} a compliance that is {c.status}")
    old = c.status
    c.status = target
    audit.record(db, actor, f"compliance.{new}", "compliance", c.id, before={"status": old}, after={"status": target})
    if new == "close":
        for ob in db.scalars(select(Obligation).where(Obligation.compliance_id == c.id, Obligation.status.in_(catalog.OPEN))):
            _move(db, ob, "cancelled", actor, "The compliance was closed", notify_user=False)
    return c


def clone(db: Session, actor: str, c: Compliance) -> Compliance:
    data = {f: getattr(c, f) for f in _EDITABLE}
    data.update(
        name=f"{c.name} (copy)",
        evidence_requirements=c.evidence_requirements,
        escalation_rules=c.escalation_rules,
        audience=audience_of(c),
    )
    copy = create_compliance(db, actor, data)
    audit.record(db, actor, "compliance.cloned", "compliance", copy.id, meta={"from": str(c.id)})
    return copy


# ---------------------------------------------------------------- audience


def _users_for(db: Session, stype: str, ref: str | None) -> set[str]:
    if stype == "all":
        return set(db.scalars(select(OrgUser.email)))
    if stype == "person":
        return {ref} if ref else set()
    if stype == "subtree":
        return subtree_emails(db, ref)
    if stype == "team":
        tid = uuid.UUID(ref)
        people = set(db.scalars(select(TeamMember.user_email).where(TeamMember.team_id == tid)))
        lead = db.scalar(select(Team.lead_email).where(Team.id == tid))
        return people | ({lead} if lead else set())
    if stype == "department":
        return set(db.scalars(select(OrgUser.email).where(OrgUser.department_id == uuid.UUID(ref))))
    if stype == "role":
        role = db.scalar(select(Role).where(Role.key == ref))
        if role is None:
            return set()
        people = set(db.scalars(select(UserRole.user_email).where(UserRole.role_id == role.id)))
        if role.auto_assign == "all":
            people |= set(db.scalars(select(OrgUser.email)))
        elif role.auto_assign == "managers":
            people |= set(db.scalars(select(OrgUser.manager_email).where(OrgUser.manager_email.is_not(None)).distinct()))
        return people
    return set()


def _label(db: Session, stype: str, ref: str | None) -> str:
    """How a rule is described to the person it picked ("Team Platform"), not its raw id."""
    try:
        if stype == "all":
            return "Everyone in the organization"
        if stype in ("person", "subtree"):
            u = db.get(OrgUser, ref)
            name = u.name if u else ref
            return name if stype == "person" else f"Reports to {name}"
        if stype == "team":
            t = db.get(Team, uuid.UUID(ref))
            return f"Team {t.name}" if t else "A team"
        if stype == "department":
            d = db.get(Department, uuid.UUID(ref))
            return f"Department {d.name}" if d else "A department"
        if stype == "role":
            r = db.scalar(select(Role).where(Role.key == ref))
            return f"Role {r.name}" if r else "A role"
    except (ValueError, TypeError):
        pass
    return stype


def resolve_audience(db: Session, rules: list[dict]) -> dict[str, dict]:
    """email -> {participation, via}. Include rules add people (the strongest
    participation wins when several match); exclude rules remove them. Only
    active users are ever assigned."""
    chosen: dict[str, dict] = {}
    excluded: set[str] = set()
    for r in rules:
        people = _users_for(db, r["selector_type"], r.get("selector_ref"))
        label = _label(db, r["selector_type"], r.get("selector_ref"))
        if r["effect"] == "exclude":
            excluded |= people
            continue
        for e in people:
            cur = chosen.get(e)
            if cur is None:
                chosen[e] = {"participation": r["participation"], "via": [label]}
            else:
                cur["via"].append(label)
                if catalog.PARTICIPATION_RANK[r["participation"]] > catalog.PARTICIPATION_RANK[cur["participation"]]:
                    cur["participation"] = r["participation"]
    for e in excluded:
        chosen.pop(e, None)
    if not chosen:
        return {}
    active = set(db.scalars(select(OrgUser.email).where(OrgUser.email.in_(chosen.keys()), OrgUser.is_active.is_(True))))
    return {e: v for e, v in chosen.items() if e in active}


def resync_audience(db: Session, actor: str | None, c: Compliance) -> dict:
    """Create obligations for people who now match, cancel untouched ones for people who no longer do."""
    desired = resolve_audience(db, audience_of(c))
    existing = {o.user_email: o for o in db.scalars(select(Obligation).where(Obligation.compliance_id == c.id))}
    added = cancelled = updated = 0
    for email, info in desired.items():
        ob = existing.get(email)
        if ob is None:
            ob = Obligation(
                compliance_id=c.id,
                version=c.current_version or 1,
                user_email=email,
                participation=info["participation"],
                status="not_started",
                due_at=c.due_at,
                assigned_via=info["via"],
            )
            db.add(ob)
            db.flush()
            added += 1
            notify(
                db,
                email,
                "assigned",
                f"New compliance: {c.name}",
                _assigned_body(c, info["participation"]),
                obligation_link(ob.id),
                ob.id,
            )
            audit.record(
                db, actor, "obligation.assigned", "obligation", ob.id,
                after={"compliance": str(c.id), "user": email, "participation": info["participation"], "via": info["via"]},
            )
        else:
            changed = False
            if ob.status == "cancelled":
                ob.status, ob.status_reason, ob.status_by = "not_started", "Back in the audience", actor
                ob.version = c.current_version or ob.version
                changed = True
            if ob.status not in catalog.TERMINAL and ob.participation != info["participation"]:
                ob.participation = info["participation"]
                changed = True
            ob.assigned_via = info["via"]
            if changed:
                updated += 1
                audit.record(db, actor, "obligation.updated", "obligation", ob.id, after={"participation": ob.participation, "status": ob.status})
    for email, ob in existing.items():
        if email not in desired and ob.status == "not_started":
            _move(db, ob, "cancelled", actor, "No longer in the audience", notify_user=False)
            cancelled += 1
    audit.record(db, actor, "compliance.audience_resolved", "compliance", c.id, meta={"added": added, "cancelled": cancelled, "updated": updated})
    return {"added": added, "cancelled": cancelled, "updated": updated, "total": len(desired)}


def _assigned_body(c: Compliance, participation: str) -> str:
    due = f" Due {c.due_at.date().isoformat()}." if c.due_at else ""
    if participation == "informational":
        return f"For your information: no action is needed from you.{due}"
    return f"{c.action_text or c.description}{due}".strip()


# ---------------------------------------------------------------- workflow


def _move(
    db: Session, ob: Obligation, new: str, actor: str | None, reason: str | None = None, notify_user: bool = True
) -> None:
    old = ob.status
    if new == old:
        return
    if new not in catalog.TRANSITIONS.get(old, set()):
        raise Conflict(f"A '{old.replace('_', ' ')}' item can't become '{new.replace('_', ' ')}'")
    ob.status = new
    ob.status_reason = reason
    ob.status_by = actor
    if new == "completed":
        ob.completed_at = now()
    elif old == "completed":
        ob.completed_at = None
    audit.record(db, actor, "obligation.status_changed", "obligation", ob.id, before={"status": old}, after={"status": new}, meta={"reason": reason} if reason else None)


def _compliance_of(db: Session, ob: Obligation) -> Compliance:
    return ob.compliance if ob.compliance is not None else db.get(Compliance, ob.compliance_id)


def requirements_of(db: Session, ob: Obligation) -> list[dict]:
    snap = db.scalar(
        select(ComplianceVersion.snapshot).where(
            ComplianceVersion.compliance_id == ob.compliance_id, ComplianceVersion.version == ob.version
        )
    )
    if snap is None:
        return _compliance_of(db, ob).evidence_requirements
    return snap.get("evidence_requirements", [])


def settings_of(db: Session, ob: Obligation) -> dict:
    """The compliance settings this obligation was assigned under."""
    snap = db.scalar(
        select(ComplianceVersion.snapshot).where(
            ComplianceVersion.compliance_id == ob.compliance_id, ComplianceVersion.version == ob.version
        )
    )
    return snap or snapshot_of(_compliance_of(db, ob))


def start(db: Session, ob: Obligation, actor: str) -> Obligation:
    if ob.user_email != actor:
        raise Conflict("Only the assignee can start their own task")
    if ob.status == "not_started":
        _move(db, ob, "in_progress", actor)
        ob.started_at = ob.started_at or now()
    return ob


def validate_evidence(db: Session, ob: Obligation, actor: str, items: list[dict]) -> list[dict]:
    """Check submitted items against the requirements the obligation was assigned under."""
    reqs = {r["key"]: r for r in requirements_of(db, ob)}
    given: dict[str, dict] = {}
    for it in items or []:
        key = (it or {}).get("key")
        if key not in reqs:
            raise EngineError(f"'{key}' isn't something this compliance asks for")
        if key in given:
            raise EngineError(f"'{key}' was provided twice")
        given[key] = it
    out, problems = [], []
    for key, req in reqs.items():
        it = given.get(key)
        kind, label, c = req["kind"], req["label"], req.get("constraints") or {}
        present = False
        value: dict[str, Any] = {"requirement_key": key, "kind": kind}
        if it is not None:
            if kind in ("text", "choice"):
                text_v = str(it.get("text") or "").strip()
                if text_v:
                    present = True
                    if kind == "text":
                        mn, mx = int(c.get("min_length", 0) or 0), int(c.get("max_length", 5000) or 5000)
                        if len(text_v) < mn:
                            problems.append(f"{label}: write at least {mn} characters")
                        if len(text_v) > mx:
                            problems.append(f"{label}: keep it under {mx} characters")
                    elif text_v not in c.get("options", []):
                        problems.append(f"{label}: pick one of the listed options")
                    value["text_value"] = text_v
            elif kind == "url":
                text_v = str(it.get("text") or "").strip()
                if text_v:
                    present = True
                    if not re.match(r"^https?://[^\s]+$", text_v, re.I):
                        problems.append(f"{label}: enter a full web address starting with http:// or https://")
                    value["text_value"] = text_v
            elif kind == "attestation":
                checked = bool(it.get("checked"))
                present = checked
                value["bool_value"] = checked
            elif kind == "file":
                fid = it.get("file_id")
                if fid:
                    present = True
                    f = db.get(EvidenceFile, _as_uuid(fid))
                    if f is None or f.uploaded_by != actor:
                        problems.append(f"{label}: that file wasn't uploaded by you")
                    else:
                        allowed = [e.lower() for e in c.get("extensions", [])]
                        if allowed and not any(f.original_name.lower().endswith(e) for e in allowed):
                            problems.append(f"{label}: allowed file types are {', '.join(allowed)}")
                        if db.scalar(select(func.count(EvidenceItem.id)).where(EvidenceItem.file_id == f.id)):
                            problems.append(f"{label}: that file was already used in another submission")
                        value["file_id"] = f.id
        if req.get("mandatory", True) and not present:
            problems.append(f"{label} is required")
        if present:
            out.append(value)
    if problems:
        raise EngineError("; ".join(problems))
    return out


def reviewers_for(db: Session, ob: Obligation, settings: dict) -> list[str]:
    mode = settings.get("review_mode")
    if mode == "none":
        return []
    if mode == "named" and settings.get("reviewer_email"):
        return [settings["reviewer_email"]]
    chain = management_chain(db, ob.user_email, limit=1)
    if chain and mode == "manager":
        return chain
    # No manager (or any_reviewer): the administrators who can approve everything.
    from app.compliance.policy import Ctx  # local import: policy imports engine-free modules only

    admins: list[str] = []
    for u in db.scalars(select(OrgUser).where(OrgUser.is_active.is_(True))):
        if u.email != ob.user_email:
            ctx = Ctx(db, u)
            if ctx.is_super or ctx.scope("submission", "approve").everyone:
                admins.append(u.email)
    return admins


def submit(db: Session, ob: Obligation, actor: str, items: list[dict]) -> Submission:
    c = _compliance_of(db, ob)
    if ob.user_email != actor:
        raise Conflict("You can only submit your own tasks")
    if c.status != "published":
        raise Conflict(f"This compliance is {c.status}, so it can't be submitted right now")
    if ob.participation == "informational":
        raise Conflict("This one is for your information: no action is needed from you")
    if ob.status not in ("not_started", "in_progress", "rejected"):
        raise Conflict(f"It's already {ob.status.replace('_', ' ')}")
    s = settings_of(db, ob)
    resubmitting = ob.status == "rejected"
    if resubmitting and ob.resubmissions >= int(s.get("max_resubmissions", 3)):
        raise Conflict("The number of allowed resubmissions has been used up")
    values = validate_evidence(db, ob, actor, items)

    n = (db.scalar(select(func.max(Submission.version_no)).where(Submission.obligation_id == ob.id)) or 0) + 1
    sub = Submission(
        obligation_id=ob.id,
        version_no=n,
        submitted_by=actor,
        late=bool(ob.due_at and now() > ob.due_at),
        status="submitted",
    )
    db.add(sub)
    db.flush()
    for v in values:
        db.add(EvidenceItem(submission_id=sub.id, **v))
    if resubmitting:
        ob.resubmissions += 1
    ob.started_at = ob.started_at or now()
    ob.submitted_at = now()
    _move(db, ob, "submitted", actor)
    audit.record(
        db, actor, "submission.submitted", "submission", sub.id,
        after={"obligation": str(ob.id), "version": n, "late": sub.late, "items": [v["requirement_key"] for v in values]},
    )

    if s.get("review_mode") == "none":
        sub.status = "approved"
        db.add(ReviewDecision(submission_id=sub.id, reviewer_email="system", decision="approved", reason="No review required"))
        _move(db, ob, "completed", "system", "No review required")
        notify(db, ob.user_email, "completed", f"Done: {c.name}", "Thanks, this is recorded as complete.", obligation_link(ob.id), ob.id)
    else:
        for r in reviewers_for(db, ob, s):
            person = db.get(OrgUser, ob.user_email)
            notify(db, r, "review_needed", f"Review needed: {c.name}", f"{person.name if person else ob.user_email} submitted proof.", obligation_link(ob.id), ob.id)
    db.flush()
    return sub


def claim(db: Session, ob: Obligation, sub: Submission, reviewer: str) -> None:
    if sub.status != "submitted":
        raise Conflict("This submission isn't waiting for a reviewer")
    sub.status = "under_review"
    _move(db, ob, "under_review", reviewer)
    audit.record(db, reviewer, "submission.claimed", "submission", sub.id)


def review(db: Session, ob: Obligation, sub: Submission, reviewer: str, decision: str, reason: str) -> Submission:
    if decision not in ("approved", "rejected"):
        raise EngineError("Decision must be approved or rejected")
    if sub.status not in ("submitted", "under_review"):
        raise Conflict("This submission has already been decided")
    if sub.id != db.scalar(select(Submission.id).where(Submission.obligation_id == ob.id).order_by(Submission.version_no.desc()).limit(1)):
        raise Conflict("A newer submission replaced this one")
    reason = (reason or "").strip()
    if decision == "rejected" and not reason:
        raise EngineError("Say what needs to change when you reject")
    c = _compliance_of(db, ob)
    s = settings_of(db, ob)
    sub.status = decision
    db.add(ReviewDecision(submission_id=sub.id, reviewer_email=reviewer, decision=decision, reason=reason))
    if decision == "approved":
        _move(db, ob, "completed", reviewer, reason or None)
        notify(db, ob.user_email, "approved", f"Approved: {c.name}", reason, obligation_link(ob.id), ob.id)
    else:
        _move(db, ob, "rejected", reviewer, reason)
        if ob.resubmissions >= int(s.get("max_resubmissions", 3)):
            _mark_non_compliant(db, ob, reviewer, "Rejected and no resubmissions left")
            notify(db, ob.user_email, "non_compliant", f"Not accepted: {c.name}", f"{reason} No resubmissions are left, so this is recorded as non-compliant.", obligation_link(ob.id), ob.id)
        else:
            notify(db, ob.user_email, "rejected", f"Changes needed: {c.name}", reason, obligation_link(ob.id), ob.id)
    audit.record(db, reviewer, f"submission.{decision}", "submission", sub.id, after={"obligation": str(ob.id), "reason": reason})
    return sub


def _mark_non_compliant(db: Session, ob: Obligation, actor: str | None, why: str) -> bool:
    if ob.non_compliant_at is not None:
        return False
    ob.non_compliant_at = now()
    audit.record(db, actor, "obligation.non_compliant", "obligation", ob.id, meta={"reason": why})
    return True


def waive(db: Session, ob: Obligation, actor: str, reason: str) -> None:
    if not (reason or "").strip():
        raise EngineError("Give a reason for the waiver")
    _move(db, ob, "waived", actor, reason.strip())
    c = _compliance_of(db, ob)
    notify(db, ob.user_email, "waived", f"Exempt: {c.name}", reason.strip(), obligation_link(ob.id), ob.id)


def extend(db: Session, ob: Obligation, actor: str, due_at: datetime, reason: str) -> None:
    if ob.status in catalog.TERMINAL:
        raise Conflict("It's already finished")
    if not (reason or "").strip():
        raise EngineError("Give a reason for the new deadline")
    old = ob.due_at
    ob.due_at, ob.due_overridden = due_at, True
    audit.record(db, actor, "obligation.deadline_changed", "obligation", ob.id, before={"due_at": old}, after={"due_at": due_at}, meta={"reason": reason.strip()})
    c = _compliance_of(db, ob)
    notify(db, ob.user_email, "deadline_changed", f"New deadline: {c.name}", f"Now due {due_at.date().isoformat()}. {reason.strip()}", obligation_link(ob.id), ob.id)


def reopen(db: Session, ob: Obligation, actor: str, reason: str) -> None:
    if not (reason or "").strip():
        raise EngineError("Give a reason for reopening")
    _move(db, ob, "in_progress", actor, reason.strip())
    ob.non_compliant_at = None
    ob.defaulter_flag = False


def cancel(db: Session, ob: Obligation, actor: str, reason: str) -> None:
    if not (reason or "").strip():
        raise EngineError("Give a reason")
    _move(db, ob, "cancelled", actor, reason.strip(), notify_user=False)


# ------------------------------------------------------------------ roll-up


def rollup(db: Session, c: Compliance) -> dict:
    """Progress of the whole compliance, from its required obligations. Waived
    and cancelled people are out of the denominator."""
    rows = db.execute(
        select(Obligation.status, func.count())
        .where(Obligation.compliance_id == c.id, Obligation.participation == "required")
        .group_by(Obligation.status)
    ).all()
    counts = {s: n for s, n in rows}
    total = sum(n for s, n in counts.items() if s not in ("waived", "cancelled"))
    done = counts.get("completed", 0)
    pct = round(100 * done / total) if total else 0
    policy, param = c.completion_policy, c.completion_param or 0
    if policy == "any":
        satisfied = done >= 1
    elif policy == "at_least_n":
        satisfied = done >= param
    elif policy == "percentage":
        satisfied = total > 0 and (100 * done / total) >= param
    else:
        satisfied = total > 0 and done == total
    return {"required_total": total, "completed": done, "percent": pct, "satisfied": satisfied, "by_status": counts}
