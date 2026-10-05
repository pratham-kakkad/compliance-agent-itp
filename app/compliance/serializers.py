"""Turns model rows into the JSON the UI consumes, including the per-row `can`
flags (what *this* viewer may do), so the UI never has to guess permissions."""
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.compliance import catalog, engine
from app.compliance.models import (
    Compliance,
    Department,
    EvidenceFile,
    EvidenceItem,
    Obligation,
    ReviewDecision,
    Submission,
)
from app.compliance.policy import Ctx
from app.models import OrgUser


def iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


def is_overdue(ob: Obligation, now: datetime | None = None) -> bool:
    return ob.status in catalog.OPEN and ob.due_at is not None and (now or engine.now()) > ob.due_at


class Directory:
    """Name / department lookups for a page of results, fetched once."""

    def __init__(self, db: Session, emails: set[str]):
        self.users: dict[str, OrgUser] = {}
        if emails:
            self.users = {u.email: u for u in db.scalars(select(OrgUser).where(OrgUser.email.in_(emails)))}
        dept_ids = {u.department_id for u in self.users.values() if u.department_id}
        self.depts: dict[Any, str] = {}
        if dept_ids:
            self.depts = {d.id: d.name for d in db.scalars(select(Department).where(Department.id.in_(dept_ids)))}

    def person(self, email: str | None) -> dict | None:
        if not email:
            return None
        u = self.users.get(email)
        if u is None:
            return {"email": email, "name": email, "title": "", "department": None}
        return {"email": u.email, "name": u.name, "title": u.title, "department": self.depts.get(u.department_id)}


def compliance_dict(db: Session, c: Compliance, ctx: Ctx | None = None, detail: bool = False, d: Directory | None = None) -> dict:
    d = d or Directory(db, {c.created_by, c.reviewer_email or ""} - {""})
    out = {
        "id": str(c.id),
        "name": c.name,
        "description": c.description,
        "category": c.category,
        "type_key": c.type_key,
        "action_text": c.action_text,
        "priority": c.priority,
        "status": c.status,
        "start_at": iso(c.start_at),
        "due_at": iso(c.due_at),
        "completion_policy": c.completion_policy,
        "completion_param": c.completion_param,
        "review_mode": c.review_mode,
        "reviewer": d.person(c.reviewer_email),
        "max_resubmissions": c.max_resubmissions,
        "dynamic_audience": c.dynamic_audience,
        "current_version": c.current_version,
        "created_by": d.person(c.created_by),
        "created_at": iso(c.created_at),
        "published_at": iso(c.published_at),
        "progress": engine.rollup(db, c),
    }
    if detail:
        out["evidence_requirements"] = c.evidence_requirements
        out["escalation_rules"] = c.escalation_rules
        out["audience"] = engine.audience_of(c)
    if ctx is not None:
        editable = c.status not in ("closed", "archived")
        out["can"] = {
            "edit": editable and ctx.can_see_compliance(c.id, "edit"),
            "delete": c.status == "draft" and ctx.can_see_compliance(c.id, "delete"),
            "assign": editable and ctx.can_see_compliance(c.id, "assign"),
            "configure": ctx.can_see_compliance(c.id, "configure"),
        }
    return out


def _file_dict(db: Session, f: EvidenceFile, compliance_id) -> dict:
    # Same file content used by someone else for this compliance? Worth a reviewer's attention.
    dupes = db.scalar(
        select(func.count(EvidenceItem.id))
        .join(EvidenceFile, EvidenceFile.id == EvidenceItem.file_id)
        .join(Submission, Submission.id == EvidenceItem.submission_id)
        .join(Obligation, Obligation.id == Submission.obligation_id)
        .where(EvidenceFile.sha256 == f.sha256, EvidenceFile.id != f.id, Obligation.compliance_id == compliance_id, EvidenceFile.uploaded_by != f.uploaded_by)
    )
    return {
        "id": str(f.id),
        "name": f.original_name,
        "size": f.size,
        "mime": f.mime,
        "scan_status": f.scan_status,
        "same_file_used_by_others": int(dupes or 0),
    }


def submission_dict(db: Session, s: Submission, compliance_id, d: Directory | None = None) -> dict:
    d = d or Directory(db, {s.submitted_by} | {x.reviewer_email for x in s.decisions})
    items = []
    for it in s.items:
        items.append(
            {
                "key": it.requirement_key,
                "kind": it.kind,
                "text": it.text_value,
                "checked": it.bool_value,
                "file": _file_dict(db, it.file, compliance_id) if it.file else None,
            }
        )
    return {
        "id": str(s.id),
        "version": s.version_no,
        "status": s.status,
        "late": s.late,
        "submitted_by": d.person(s.submitted_by),
        "submitted_at": iso(s.submitted_at),
        "items": items,
        "decisions": [
            {
                "decision": x.decision,
                "reason": x.reason,
                "reviewer": d.person(x.reviewer_email) if x.reviewer_email != "system" else {"email": "system", "name": "System", "title": "", "department": None},
                "decided_at": iso(x.decided_at),
            }
            for x in s.decisions
        ],
    }


def obligation_dict(
    db: Session, ob: Obligation, ctx: Ctx, d: Directory | None = None, detail: bool = False, c: Compliance | None = None
) -> dict:
    c = c or ob.compliance
    d = d or Directory(db, {ob.user_email})
    now = engine.now()
    out = {
        "id": str(ob.id),
        "compliance": {
            "id": str(c.id),
            "name": c.name,
            "category": c.category,
            "type_key": c.type_key,
            "priority": c.priority,
            "action_text": c.action_text,
            "status": c.status,
        },
        "user": d.person(ob.user_email),
        "participation": ob.participation,
        "status": ob.status,
        "due_at": iso(ob.due_at),
        "due_overridden": ob.due_overridden,
        "overdue": is_overdue(ob, now),
        "non_compliant": ob.non_compliant_at is not None,
        "non_compliant_at": iso(ob.non_compliant_at),
        "defaulter_flag": ob.defaulter_flag,
        "resubmissions": ob.resubmissions,
        "submitted_at": iso(ob.submitted_at),
        "completed_at": iso(ob.completed_at),
        "status_reason": ob.status_reason,
        "version": ob.version,
    }
    mine = ob.user_email == ctx.email
    settings = engine.settings_of(db, ob)
    out["can"] = {
        "start": mine and ob.status == "not_started" and ob.participation != "informational",
        "submit": mine
        and c.status == "published"
        and ob.participation != "informational"
        and ob.status in ("not_started", "in_progress", "rejected")
        and not (ob.status == "rejected" and ob.resubmissions >= int(settings.get("max_resubmissions", 3))),
        "review": ob.status in ("submitted", "under_review") and ctx.can_review(ob, c, "approve"),
        "waive": ob.status in catalog.OPEN and ctx.can("compliance", "waive") and ctx.person_in_scope("compliance", "waive", ob.user_email),
        "extend": ob.status in catalog.OPEN and ctx.can("compliance", "edit") and ctx.person_in_scope("compliance", "edit", ob.user_email),
        "reopen": ob.status in catalog.TERMINAL and ctx.can("compliance", "configure"),
    }
    if detail:
        out["assigned_via"] = ob.assigned_via
        out["instructions"] = {
            "description": c.description,
            "action_text": c.action_text,
            "review_mode": settings.get("review_mode"),
            "evidence_requirements": engine.requirements_of(db, ob),
            "max_resubmissions": settings.get("max_resubmissions", 3),
        }
        dd = Directory(db, {ob.user_email} | {s.submitted_by for s in ob.submissions} | {x.reviewer_email for s in ob.submissions for x in s.decisions})
        out["submissions"] = [submission_dict(db, s, c.id, dd) for s in ob.submissions]
    return out
