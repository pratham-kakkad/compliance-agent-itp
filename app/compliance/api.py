"""HTTP API for the compliance engine: what employees, managers and compliance
admins use day to day. Administration (users, roles, audit) is in admin_api.py.

Every handler asks `Ctx` first (permission, then row-level scope) and only then
calls the engine, which has no access rules of its own."""
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.compliance import audit, catalog, engine, evidence, reports
from app.compliance.models import (
    Compliance,
    ComplianceType,
    Department,
    EvidenceFile,
    EvidenceItem,
    Notification,
    Obligation,
    Role,
    Submission,
    Team,
    TeamMember,
)
from app.compliance.policy import Ctx, get_ctx
from app.compliance.serializers import Directory, compliance_dict, obligation_dict, submission_dict
from app.database import get_db
from app.models import OrgUser

router = APIRouter(prefix="/compliance", tags=["compliance"])


# ---------------------------------------------------------------- plumbing


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(engine.Conflict)
    async def _conflict(_req, exc: engine.Conflict):
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(engine.EngineError)
    async def _bad(_req, exc: engine.EngineError):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(evidence.EvidenceError)
    async def _evidence(_req, exc: evidence.EvidenceError):
        return JSONResponse(status_code=400, content={"detail": str(exc)})


def aware(dt: datetime | None) -> datetime | None:
    """The UI sends offsets; a bare timestamp is taken to be UTC."""
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def get_uuid(value: str, what: str = "id") -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"No such {what}")


def load_compliance(ctx: Ctx, cid: str, action: str = "view") -> Compliance:
    c = ctx.db.get(Compliance, get_uuid(cid, "compliance"))
    if c is None or not ctx.can_see_compliance(c.id, "view"):
        # Same answer whether it doesn't exist or you can't see it.
        raise HTTPException(status_code=404, detail="No such compliance")
    if action != "view":
        ctx.require("compliance", action)
        if not ctx.can_see_compliance(c.id, action):
            raise HTTPException(status_code=403, detail=f"You can't {action} this compliance")
    return c


def load_obligation(ctx: Ctx, oid: str) -> Obligation:
    ob = ctx.db.get(Obligation, get_uuid(oid, "item"))
    if ob is None or not ctx.can_see_obligation(ob.id):
        raise HTTPException(status_code=404, detail="No such item")
    return ob


def assert_can_assign(ctx: Ctx, emails: set[str]) -> None:
    ctx.require("compliance", "assign")
    sc = ctx.scope("compliance", "assign")
    if sc.everyone:
        return
    outside = sorted(emails - set(sc.emails))
    if outside:
        shown = ", ".join(outside[:5]) + (f" and {len(outside) - 5} more" if len(outside) > 5 else "")
        raise HTTPException(
            status_code=403,
            detail=f"You can only assign to people in your own scope. Outside it: {shown}",
        )


# ------------------------------------------------------------------ schemas


class AudienceRuleIn(BaseModel):
    selector_type: str
    selector_ref: str | None = None
    effect: str = "include"
    participation: str = "required"


class ComplianceIn(BaseModel):
    name: str | None = None
    description: str | None = None
    category: str | None = None
    type_key: str | None = None
    action_text: str | None = None
    priority: str | None = None
    start_at: datetime | None = None
    due_at: datetime | None = None
    completion_policy: str | None = None
    completion_param: int | None = None
    review_mode: str | None = None
    reviewer_email: str | None = None
    max_resubmissions: int | None = None
    dynamic_audience: bool | None = None
    evidence_requirements: list[dict] | None = None
    escalation_rules: list[dict] | None = None
    audience: list[AudienceRuleIn] | None = None

    def data(self) -> dict:
        d = self.model_dump(exclude_unset=True)
        for k in ("start_at", "due_at"):
            if k in d:
                d[k] = aware(d[k])
        if "audience" in d:
            d["audience"] = [dict(a) for a in d["audience"]]
        return d


class EvidenceValue(BaseModel):
    key: str
    text: str | None = None
    checked: bool | None = None
    file_id: str | None = None


class SubmitIn(BaseModel):
    items: list[EvidenceValue] = Field(default_factory=list)


class ReasonIn(BaseModel):
    reason: str = ""


class ExtendIn(BaseModel):
    due_at: datetime
    reason: str = ""


class ReviewIn(BaseModel):
    decision: str
    reason: str = ""


class AudiencePreviewIn(BaseModel):
    audience: list[AudienceRuleIn]


# --------------------------------------------------------------- bootstrap


@router.get("/me")
def me(ctx: Ctx = Depends(get_ctx)):
    d = Directory(ctx.db, {ctx.email})
    unread = ctx.db.scalar(
        select(func.count()).where(Notification.user_email == ctx.email, Notification.read_at.is_(None))
    )
    return {
        "user": d.person(ctx.email),
        "roles": [{"key": r.key, "name": r.name} for r in ctx.roles],
        "is_super": ctx.is_super,
        "permissions": ctx.permissions(),
        "unread_notifications": unread,
    }


@router.get("/meta")
def meta(db: Session = Depends(get_db), ctx: Ctx = Depends(get_ctx)):
    types = [
        {
            "key": t.key,
            "name": t.name,
            "description": t.description,
            "evidence": t.evidence_defaults,
            "review_mode": t.review_default,
            "escalation": t.escalation_default,
            "verifier_key": t.verifier_key,
        }
        for t in db.scalars(select(ComplianceType).order_by(ComplianceType.name))
    ]
    return {
        "types": types,
        "priorities": catalog.PRIORITIES,
        "definition_statuses": catalog.DEFINITION_STATUSES,
        "obligation_statuses": catalog.OBLIGATION_STATUSES,
        "participation": catalog.PARTICIPATION,
        "completion_policies": catalog.COMPLETION_POLICIES,
        "review_modes": catalog.REVIEW_MODES,
        "selector_types": catalog.SELECTOR_TYPES,
        "evidence_kinds": catalog.EVIDENCE_KINDS,
        "triggers": catalog.TRIGGERS,
        "actions": catalog.ACTIONS,
        "scopes": [{"key": k, "label": catalog.SCOPES[k]} for k in catalog.SCOPE_ORDER],
        "resources": [
            {"key": k, "label": v["label"], "actions": v["actions"], "navigation_only": bool(v.get("navigation_only"))}
            for k, v in catalog.RESOURCES.items()
        ],
        "escalation_presets": [{"key": k, "label": v["label"], "rules": v["rules"]} for k, v in catalog.ESCALATION_PRESETS.items()],
    }


@router.get("/lookup")
def lookup(db: Session = Depends(get_db), ctx: Ctx = Depends(get_ctx)):
    """People, teams, departments and roles for pickers, limited to the people this viewer works with."""
    wanted = [("user", "view"), ("compliance", "assign"), ("compliance", "create"), ("compliance", "view"), ("submission", "view")]
    emails: set[str] = set()
    everyone = False
    for res, act in wanted:
        sc = ctx.scope(res, act)
        everyone = everyone or sc.everyone
        emails |= set(sc.emails)
    if not ctx.can("compliance", "view") and not ctx.can("user", "view"):
        raise HTTPException(status_code=403, detail="You don't have permission to list people")
    q = select(OrgUser).where(OrgUser.is_active.is_(True)).order_by(OrgUser.name)
    if not everyone:
        q = q.where(OrgUser.email.in_(emails or {""}))
    users = list(db.scalars(q))
    depts = list(db.scalars(select(Department).order_by(Department.name)))
    dname = {d.id: d.name for d in depts}
    counts = dict(db.execute(select(TeamMember.team_id, func.count()).group_by(TeamMember.team_id)).all())
    return {
        "users": [
            {
                "email": u.email,
                "name": u.name,
                "title": u.title,
                "manager_email": u.manager_email,
                "department_id": str(u.department_id) if u.department_id else None,
                "department": dname.get(u.department_id),
            }
            for u in users
        ],
        "teams": [{"id": str(t.id), "name": t.name, "members": counts.get(t.id, 0)} for t in db.scalars(select(Team).order_by(Team.name))],
        "departments": [{"id": str(d.id), "name": d.name} for d in depts],
        "roles": [{"key": r.key, "name": r.name} for r in db.scalars(select(Role).order_by(Role.name))],
    }


# ------------------------------------------------------------- definitions


@router.get("/definitions")
def list_definitions(
    status: str | None = None,
    q: str | None = None,
    category: str | None = None,
    limit: int = Query(100, le=500),
    offset: int = 0,
    ctx: Ctx = Depends(get_ctx),
):
    ctx.require("compliance", "view")
    db = ctx.db
    cond = [ctx.compliance_clause("view")]
    if status:
        cond.append(Compliance.status == status)
    if category:
        cond.append(Compliance.category == category)
    if q:
        like = f"%{q.strip()}%"
        cond.append(or_(Compliance.name.ilike(like), Compliance.description.ilike(like)))
    total = db.scalar(select(func.count()).select_from(Compliance).where(*cond))
    rows = list(db.scalars(select(Compliance).where(*cond).order_by(Compliance.created_at.desc()).limit(limit).offset(offset)))
    d = Directory(db, {r.created_by for r in rows} | {r.reviewer_email for r in rows if r.reviewer_email})
    return {"total": total, "items": [compliance_dict(db, c, ctx, d=d) for c in rows]}


@router.get("/categories")
def categories(ctx: Ctx = Depends(get_ctx)):
    ctx.require("compliance", "view")
    rows = ctx.db.scalars(select(Compliance.category).where(ctx.compliance_clause("view")).distinct().order_by(Compliance.category))
    return list(rows)


@router.post("/definitions", status_code=201)
def create_definition(body: ComplianceIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("compliance", "create")
    data = body.data()
    if not (data.get("name") or "").strip():
        raise HTTPException(status_code=422, detail="A compliance needs a name")
    c = engine.create_compliance(ctx.db, ctx.email, data)
    ctx.db.commit()
    return compliance_dict(ctx.db, c, ctx, detail=True)


@router.get("/definitions/{cid}")
def get_definition(cid: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("compliance", "view")
    c = load_compliance(ctx, cid)
    return compliance_dict(ctx.db, c, ctx, detail=True)


@router.patch("/definitions/{cid}")
def update_definition(cid: str, body: ComplianceIn, apply_to_existing: bool = False, ctx: Ctx = Depends(get_ctx)):
    c = load_compliance(ctx, cid, "edit")
    data = body.data()
    if "audience" in data:
        ctx.require("compliance", "assign")
    if "escalation_rules" in data or "evidence_requirements" in data:
        # Changing the rules of the engine is a stronger right than editing text.
        if not (ctx.can("compliance", "configure") or ctx.can("compliance", "edit")):
            raise HTTPException(status_code=403, detail="You can't change these settings")
    engine.update_compliance(ctx.db, ctx.email, c, data, apply_to_existing)
    if "audience" in data and c.status == "published":
        try:
            assert_can_assign(ctx, set(engine.resolve_audience(ctx.db, engine.audience_of(c))))
        except HTTPException:
            ctx.db.rollback()  # the audience change already created obligations: undo it
            raise
    ctx.db.commit()
    return compliance_dict(ctx.db, c, ctx, detail=True)


@router.delete("/definitions/{cid}", status_code=204)
def delete_definition(cid: str, ctx: Ctx = Depends(get_ctx)):
    c = load_compliance(ctx, cid, "delete")
    engine.delete_draft(ctx.db, ctx.email, c)
    ctx.db.commit()


@router.post("/audience/preview")
def preview_audience(body: AudiencePreviewIn, ctx: Ctx = Depends(get_ctx)):
    """Who a set of audience rules would reach, before saving anything."""
    if not (ctx.can("compliance", "create") or ctx.can("compliance", "assign") or ctx.can("compliance", "edit")):
        raise HTTPException(status_code=403, detail="You don't have permission to assign compliance")
    rules = engine.normalize_audience(ctx.db, [r.model_dump() for r in body.audience])
    resolved = engine.resolve_audience(ctx.db, rules)
    d = Directory(ctx.db, set(resolved))
    sc = ctx.scope("compliance", "assign")
    people = []
    for email, info in sorted(resolved.items(), key=lambda kv: (d.person(kv[0]) or {}).get("name", kv[0])):
        p = d.person(email)
        people.append({**p, "participation": info["participation"], "via": info["via"], "in_scope": sc.everyone or email in sc.emails})
    counts: dict[str, int] = {}
    for p in people:
        counts[p["participation"]] = counts.get(p["participation"], 0) + 1
    return {"total": len(people), "by_participation": counts, "outside_scope": sum(1 for p in people if not p["in_scope"]), "people": people}


@router.post("/definitions/{cid}/publish")
def publish_definition(cid: str, ctx: Ctx = Depends(get_ctx)):
    c = load_compliance(ctx, cid, "assign")
    engine.validate_for_publish(ctx.db, c)
    assert_can_assign(ctx, set(engine.resolve_audience(ctx.db, engine.audience_of(c))))
    result = engine.publish(ctx.db, ctx.email, c)
    ctx.db.commit()
    return {"result": result, "compliance": compliance_dict(ctx.db, c, ctx, detail=True)}


@router.post("/definitions/{cid}/resync")
def resync_definition(cid: str, ctx: Ctx = Depends(get_ctx)):
    c = load_compliance(ctx, cid, "assign")
    if c.status != "published":
        raise engine.Conflict("Only a published compliance has an audience to refresh")
    assert_can_assign(ctx, set(engine.resolve_audience(ctx.db, engine.audience_of(c))))
    result = engine.resync_audience(ctx.db, ctx.email, c)
    ctx.db.commit()
    return result


@router.post("/definitions/{cid}/clone", status_code=201)
def clone_definition(cid: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("compliance", "create")
    c = load_compliance(ctx, cid)
    copy = engine.clone(ctx.db, ctx.email, c)
    ctx.db.commit()
    return compliance_dict(ctx.db, copy, ctx, detail=True)


@router.post("/definitions/{cid}/{action}")
def definition_action(cid: str, action: str, ctx: Ctx = Depends(get_ctx)):
    if action not in ("pause", "resume", "close", "archive"):
        raise HTTPException(status_code=404, detail="Unknown action")
    c = load_compliance(ctx, cid, "edit")
    engine.set_status(ctx.db, ctx.email, c, action)
    ctx.db.commit()
    return compliance_dict(ctx.db, c, ctx, detail=True)


# ------------------------------------------------------------- obligations


def _list_obligations(ctx: Ctx, mine: bool, status, compliance_id, user, overdue, q, limit, offset, resource="submission"):
    ctx.require("submission", "view")
    db = ctx.db
    cond = [ctx.obligation_clause(resource, "view")]
    if mine:
        cond.append(Obligation.user_email == ctx.email)
    if status:
        cond.append(Obligation.status.in_([s for s in status.split(",") if s]))
    if compliance_id:
        cond.append(Obligation.compliance_id == get_uuid(compliance_id, "compliance"))
    if user:
        cond.append(Obligation.user_email == user)
    if overdue:
        cond += [Obligation.status.in_(catalog.OPEN), Obligation.due_at.is_not(None), Obligation.due_at < engine.now()]
    query = select(Obligation).join(Compliance, Compliance.id == Obligation.compliance_id).where(*cond)
    if q:
        like = f"%{q.strip()}%"
        query = query.where(or_(Compliance.name.ilike(like), Obligation.user_email.ilike(like)))
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    # Open items first, nearest deadline first.
    rows = list(
        db.scalars(
            query.order_by(
                Obligation.status.in_(catalog.TERMINAL).asc(),
                Obligation.due_at.asc().nulls_last(),
                Obligation.created_at.desc(),
            )
            .limit(limit)
            .offset(offset)
        )
    )
    d = Directory(db, {o.user_email for o in rows})
    return {"total": total, "items": [obligation_dict(db, o, ctx, d) for o in rows]}


@router.get("/obligations")
def list_obligations(
    mine: bool = False,
    status: str | None = None,
    compliance_id: str | None = None,
    user: str | None = None,
    overdue: bool = False,
    q: str | None = None,
    limit: int = Query(100, le=500),
    offset: int = 0,
    ctx: Ctx = Depends(get_ctx),
):
    return _list_obligations(ctx, mine, status, compliance_id, user, overdue, q, limit, offset)


@router.get("/obligations/{oid}")
def get_obligation(oid: str, ctx: Ctx = Depends(get_ctx)):
    ctx.require("submission", "view")
    ob = load_obligation(ctx, oid)
    return obligation_dict(ctx.db, ob, ctx, detail=True)


def _own(ctx: Ctx, oid: str) -> Obligation:
    ctx.require("submission", "submit")
    ob = load_obligation(ctx, oid)
    if ob.user_email != ctx.email:
        raise HTTPException(status_code=403, detail="This is someone else's task")
    return ob


@router.post("/obligations/{oid}/start")
def start_obligation(oid: str, ctx: Ctx = Depends(get_ctx)):
    ob = _own(ctx, oid)
    engine.start(ctx.db, ob, ctx.email)
    ctx.db.commit()
    return obligation_dict(ctx.db, ob, ctx, detail=True)


@router.post("/obligations/{oid}/submit")
def submit_obligation(oid: str, body: SubmitIn, ctx: Ctx = Depends(get_ctx)):
    ob = _own(ctx, oid)
    engine.submit(ctx.db, ob, ctx.email, [i.model_dump() for i in body.items])
    ctx.db.commit()
    return obligation_dict(ctx.db, ob, ctx, detail=True)


@router.post("/obligations/{oid}/waive")
def waive_obligation(oid: str, body: ReasonIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("compliance", "waive")
    ob = load_obligation(ctx, oid)
    if not ctx.person_in_scope("compliance", "waive", ob.user_email):
        raise HTTPException(status_code=403, detail="You can't waive this person's compliance")
    engine.waive(ctx.db, ob, ctx.email, body.reason)
    ctx.db.commit()
    return obligation_dict(ctx.db, ob, ctx, detail=True)


@router.post("/obligations/{oid}/extend")
def extend_obligation(oid: str, body: ExtendIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("compliance", "edit")
    ob = load_obligation(ctx, oid)
    if not ctx.person_in_scope("compliance", "edit", ob.user_email):
        raise HTTPException(status_code=403, detail="You can't change this person's deadline")
    engine.extend(ctx.db, ob, ctx.email, aware(body.due_at), body.reason)
    ctx.db.commit()
    return obligation_dict(ctx.db, ob, ctx, detail=True)


@router.post("/obligations/{oid}/reopen")
def reopen_obligation(oid: str, body: ReasonIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("compliance", "configure")
    ob = load_obligation(ctx, oid)
    engine.reopen(ctx.db, ob, ctx.email, body.reason)
    ctx.db.commit()
    return obligation_dict(ctx.db, ob, ctx, detail=True)


@router.post("/obligations/{oid}/cancel")
def cancel_obligation(oid: str, body: ReasonIn, ctx: Ctx = Depends(get_ctx)):
    ctx.require("compliance", "configure")
    ob = load_obligation(ctx, oid)
    engine.cancel(ctx.db, ob, ctx.email, body.reason)
    ctx.db.commit()
    return obligation_dict(ctx.db, ob, ctx, detail=True)


# ---------------------------------------------------------------- evidence


@router.post("/evidence", status_code=201)
async def upload_evidence(file: UploadFile, ctx: Ctx = Depends(get_ctx)):
    ctx.require("submission", "submit")
    data = await file.read()
    f = evidence.save_upload(ctx.db, ctx.email, file.filename or "", data)
    audit.record(ctx.db, ctx.email, "evidence.uploaded", "evidence_file", f.id, after={"name": f.original_name, "size": f.size, "sha256": f.sha256})
    ctx.db.commit()
    return {"id": str(f.id), "name": f.original_name, "size": f.size, "mime": f.mime, "scan_status": f.scan_status}


@router.get("/evidence/{fid}/download")
def download_evidence(fid: str, inline: bool = False, ctx: Ctx = Depends(get_ctx)):
    db = ctx.db
    f = db.get(EvidenceFile, get_uuid(fid, "file"))
    if f is None:
        raise HTTPException(status_code=404, detail="No such file")
    allowed = f.uploaded_by == ctx.email
    if not allowed:
        ob_ids = list(
            db.scalars(
                select(Submission.obligation_id)
                .join(EvidenceItem, EvidenceItem.submission_id == Submission.id)
                .where(EvidenceItem.file_id == f.id)
            )
        )
        allowed = any(ctx.can_see_obligation(i) for i in ob_ids)
    if not allowed:
        raise HTTPException(status_code=404, detail="No such file")
    try:
        path = evidence.read_path(f)
    except FileNotFoundError:
        raise HTTPException(status_code=410, detail="The stored file is missing")
    safe_inline = inline and (f.mime.startswith("image/") or f.mime == "application/pdf")
    audit.record(db, ctx.email, "evidence.downloaded", "evidence_file", f.id)
    db.commit()
    return FileResponse(
        path,
        media_type=f.mime,
        filename=f.original_name,
        content_disposition_type="inline" if safe_inline else "attachment",
        headers={"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox"},
    )


# ----------------------------------------------------------------- reviews


@router.get("/reviews")
def review_queue(ctx: Ctx = Depends(get_ctx)):
    if not (ctx.can("submission", "approve") or ctx.can("submission", "reject")):
        raise HTTPException(status_code=403, detail="You don't review submissions")
    q = reports.review_queue(ctx.db, ctx)
    d = Directory(ctx.db, {o.user_email for o, _ in q["items"]})
    return {"total": q["total"], "items": [obligation_dict(ctx.db, o, ctx, d, detail=True, c=c) for o, c in q["items"]]}


def _load_submission(ctx: Ctx, sid: str) -> tuple[Submission, Obligation, Compliance]:
    sub = ctx.db.get(Submission, get_uuid(sid, "submission"))
    if sub is None:
        raise HTTPException(status_code=404, detail="No such submission")
    ob = load_obligation(ctx, str(sub.obligation_id))
    return sub, ob, ob.compliance


@router.post("/submissions/{sid}/claim")
def claim_submission(sid: str, ctx: Ctx = Depends(get_ctx)):
    sub, ob, c = _load_submission(ctx, sid)
    if not ctx.can_review(ob, c, "approve"):
        raise HTTPException(status_code=403, detail="You can't review this submission")
    engine.claim(ctx.db, ob, sub, ctx.email)
    ctx.db.commit()
    return obligation_dict(ctx.db, ob, ctx, detail=True)


@router.post("/submissions/{sid}/review")
def review_submission(sid: str, body: ReviewIn, ctx: Ctx = Depends(get_ctx)):
    sub, ob, c = _load_submission(ctx, sid)
    action = "approve" if body.decision == "approved" else "reject"
    if body.decision not in ("approved", "rejected"):
        raise HTTPException(status_code=422, detail="Decision must be approved or rejected")
    if not ctx.can("submission", action) or not ctx.can_review(ob, c, action):
        raise HTTPException(status_code=403, detail="You can't review this submission")
    engine.review(ctx.db, ob, sub, ctx.email, body.decision, body.reason)
    ctx.db.commit()
    return obligation_dict(ctx.db, ob, ctx, detail=True)


# --------------------------------------------------------------- dashboards


@router.get("/dashboard")
def dashboard(ctx: Ctx = Depends(get_ctx)):
    ctx.require("dashboard", "view")
    out = reports.dashboard(ctx.db, ctx)
    q = out.pop("review_queue")
    d = Directory(ctx.db, {o.user_email for o, _ in q["items"]})
    out["review_queue"] = {
        "total": q["total"],
        "items": [obligation_dict(ctx.db, o, ctx, d, c=c) for o, c in q["items"]],
    }
    return out


@router.get("/scoreboard")
def scoreboard(days: int = Query(90, ge=7, le=730), ctx: Ctx = Depends(get_ctx)):
    ctx.require("report", "view")
    return {"days": days, "people": reports.scoreboard(ctx.db, ctx, days)}


# ----------------------------------------------------------- notifications


@router.get("/notifications")
def list_notifications(unread: bool = False, limit: int = Query(50, le=200), ctx: Ctx = Depends(get_ctx)):
    q = select(Notification).where(Notification.user_email == ctx.email)
    if unread:
        q = q.where(Notification.read_at.is_(None))
    rows = list(ctx.db.scalars(q.order_by(Notification.created_at.desc()).limit(limit)))
    unread_n = ctx.db.scalar(select(func.count()).where(Notification.user_email == ctx.email, Notification.read_at.is_(None)))
    return {
        "unread": unread_n,
        "items": [
            {
                "id": str(n.id),
                "kind": n.kind,
                "title": n.title,
                "body": n.body,
                "link": n.link,
                "created_at": n.created_at.isoformat(),
                "read": n.read_at is not None,
            }
            for n in rows
        ],
    }


@router.post("/notifications/read-all")
def read_all(ctx: Ctx = Depends(get_ctx)):
    now = engine.now()
    for n in ctx.db.scalars(select(Notification).where(Notification.user_email == ctx.email, Notification.read_at.is_(None))):
        n.read_at = now
    ctx.db.commit()
    return {"ok": True}


@router.post("/notifications/{nid}/read")
def read_one(nid: str, ctx: Ctx = Depends(get_ctx)):
    n = ctx.db.get(Notification, get_uuid(nid, "notification"))
    if n is None or n.user_email != ctx.email:
        raise HTTPException(status_code=404, detail="No such notification")
    n.read_at = n.read_at or engine.now()
    ctx.db.commit()
    return {"ok": True}
