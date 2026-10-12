"""HTTP API for e-mailing people about their compliance with templates.

Paths live under the compliance prefixes (`/compliance/...` for everyone who may
send, `/compliance/admin/...` for managing templates). Who may do what:

- **Send** (preview, send, batch status, history, list templates): needs at least
  one of compliance.assign, compliance.edit, submission.approve, submission.reject,
  and every recipient must be inside the scope of one of those permissions the
  sender holds (see messaging.send_scope). Nothing here trusts a client-provided
  recipient list.
- **Manage templates**: compliance.configure (Super Admin and Compliance Admin).
  Any sender can use the *active* templates.
"""
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app import email_templates, mailer
from app.compliance import audit, engine, messaging
from app.compliance.models import EmailTemplate, SentEmail
from app.compliance.policy import Ctx, get_ctx
from app.compliance.serializers import Directory
from app.models import OrgUser

router = APIRouter(prefix="/compliance", tags=["compliance-email"])
admin_router = APIRouter(prefix="/compliance/admin", tags=["compliance-email-admin"])


# ---------------------------------------------------------------- schemas


class RecipientsIn(BaseModel):
    emails: list[str] | None = None
    team_id: str | None = None
    department_id: str | None = None
    compliance_id: str | None = None
    # with compliance_id: all | open | overdue | not_started | rejected
    status: str = "all"
    # with compliance_id: only these assignees (a hand-picked subset)
    only: list[str] | None = None
    obligation_id: str | None = None
    # people the sender un-ticked in the dialog
    exclude: list[str] = Field(default_factory=list)


class OptionsIn(BaseModel):
    cc_manager: bool = False
    copy_me: bool = False
    in_app: bool = False


class PreviewIn(BaseModel):
    recipients: RecipientsIn
    template_id: str | None = None
    subject: str | None = None
    body: str | None = None
    options: OptionsIn = Field(default_factory=OptionsIn)


class SendIn(PreviewIn):
    # The UI sets this after asking "send a warning to N people?"
    confirmed: bool = False


class TemplateIn(BaseModel):
    name: str
    kind: str = "custom"
    description: str = ""
    subject: str
    body: str
    active: bool = True


class TemplatePatch(BaseModel):
    name: str | None = None
    kind: str | None = None
    description: str | None = None
    subject: str | None = None
    body: str | None = None
    active: bool | None = None


class DraftIn(BaseModel):
    subject: str
    body: str
    kind: str = "custom"


# ---------------------------------------------------------------- helpers


def _bad(status: int, message: str):
    raise HTTPException(status_code=status, detail=message)


def _require_send(ctx: Ctx) -> None:
    if not messaging.can_send(ctx):
        _bad(403, "You don't have permission to e-mail people about compliance")


def _require_configure(ctx: Ctx) -> None:
    ctx.require("compliance", "configure")


def _template(ctx: Ctx, tid: str) -> EmailTemplate:
    try:
        key = uuid.UUID(tid)
    except ValueError:
        _bad(404, "No such template")
    t = ctx.db.get(EmailTemplate, key)
    if t is None:
        _bad(404, "No such template")
    return t


def _prepare(ctx: Ctx, body: PreviewIn):
    try:
        res = messaging.resolve_recipients(ctx, body.recipients.model_dump(), set(body.recipients.exclude))
        draft = messaging.load_draft(ctx, body.template_id, body.subject, body.body)
    except messaging.RecipientError as exc:
        _bad(exc.status, exc.message)
    rendered = messaging.render_all(ctx, res, draft, cc_manager=body.options.cc_manager)
    return res, draft, rendered


def _tz(ctx: Ctx):
    from app.org_settings.service import get_timezone

    return get_timezone(ctx.db)


# -------------------------------------------------- variables and template list


@router.get("/email-variables")
def email_variables(ctx: Ctx = Depends(get_ctx)):
    if not (messaging.can_send(ctx) or ctx.can("compliance", "configure")):
        _bad(403, "You don't have permission to e-mail people about compliance")
    return {"variables": messaging.VARIABLES, "kinds": [{"key": k, "label": messaging.KIND_LABEL[k]} for k in messaging.KINDS]}


@router.get("/email-templates")
def usable_templates(ctx: Ctx = Depends(get_ctx)):
    """The templates a sender can pick: the active ones."""
    _require_send(ctx)
    rows = ctx.db.scalars(select(EmailTemplate).where(EmailTemplate.active.is_(True)).order_by(EmailTemplate.is_system.desc(), EmailTemplate.name))
    return [messaging.template_dict(t) for t in rows]


# --------------------------------------------------------------- preview/send


@router.post("/emails/preview")
def preview(body: PreviewIn, ctx: Ctx = Depends(get_ctx)):
    _require_send(ctx)
    db = ctx.db
    res, draft, rendered = _prepare(ctx, body)
    d = Directory(db, {r.recipient.user.email for r in rendered})
    previews = []
    for r in rendered[: messaging.PREVIEW_COUNT]:
        if draft.empty:
            break
        subject, text, html = email_templates.compliance_message_email(
            r.subject, r.body, kind=draft.kind, link=r.link, sender_name=ctx.user.name
        )
        previews.append(
            {
                "email": r.recipient.user.email,
                "name": r.recipient.user.name,
                "subject": subject,
                "text": text,
                "html": html,
                "cc": r.cc,
                "unresolved": r.unresolved,
            }
        )
    recipients = []
    for r in rendered[:500]:
        u = r.recipient.user
        ob, c = r.recipient.obligation, r.recipient.compliance
        recipients.append(
            {
                "email": u.email,
                "name": u.name,
                "title": u.title,
                "department": (d.person(u.email) or {}).get("department"),
                "cc": r.cc,
                "item": (
                    {"compliance": c.name, "status": ob.status, "due_at": ob.due_at.isoformat() if ob.due_at else None, "overdue": r.items[0].overdue if r.items else False}
                    if ob is not None and c is not None
                    else None
                ),
                "open_count": len(r.items),
            }
        )
    counts: dict[str, int] = {}
    for s in res.skipped:
        counts[s.reason] = counts.get(s.reason, 0) + 1
    unresolved = list(dict.fromkeys(n for r in rendered for n in r.unresolved)) or messaging.unknown_variables(draft.subject, draft.body)
    n = len(rendered)
    sent_hour = messaging.sent_in_last_hour(db, ctx.email)
    return {
        "source": res.source,
        "kind": draft.kind,
        "template_id": str(draft.template_id) if draft.template_id else None,
        "template_name": draft.template_name,
        "will_send": n,
        "skipped": len(res.skipped),
        "skipped_counts": counts,
        "skipped_list": [{"email": s.email, "name": s.name, "reason": s.reason, "label": s.label} for s in res.skipped[:300]],
        "recipients": recipients,
        "previews": previews,
        "unresolved": unresolved,
        "notes": [],
        "limits": {
            "max_recipients": messaging.MAX_RECIPIENTS,
            "rate_limit_per_hour": messaging.RATE_LIMIT_PER_HOUR,
            "sent_last_hour": sent_hour,
            "large_batch": messaging.LARGE_BATCH,
        },
        "over_cap": n > messaging.MAX_RECIPIENTS,
        "over_rate": sent_hour + n > messaging.RATE_LIMIT_PER_HOUR,
        "needs_confirm": n > messaging.LARGE_BATCH and draft.kind in ("warning", "final"),
        "smtp_configured": mailer.is_configured(db),
        "sender_is_demo": bool(ctx.user.is_demo),
    }


@router.post("/emails/send", status_code=202)
def send(body: SendIn, background: BackgroundTasks, ctx: Ctx = Depends(get_ctx)):
    """Queue the batch and return at once; `run_batch` sends in the background.
    Poll GET /compliance/emails/batches/{batch_id} for progress."""
    _require_send(ctx)
    db = ctx.db
    if not mailer.is_configured(db):
        _bad(
            409,
            "E-mail isn't set up yet. An administrator can add the SMTP host and a From address in Settings > Email (SMTP).",
        )
    res, draft, rendered = _prepare(ctx, body)
    if not draft.subject.strip():
        _bad(422, "Add a subject")
    if not draft.body.strip():
        _bad(422, "Write the message, or pick a template")
    if len(draft.subject) > messaging.MAX_SUBJECT or len(draft.body) > messaging.MAX_BODY:
        _bad(422, f"Keep the subject under {messaging.MAX_SUBJECT} and the message under {messaging.MAX_BODY} characters")
    bad = list(dict.fromkeys(n for r in rendered for n in r.unresolved)) or messaging.unknown_variables(draft.subject, draft.body)
    if bad:
        shown = ", ".join("{{" + b + "}}" for b in bad)
        _bad(422, f"The message still has {shown}, which can't be filled in. Remove it or pick a variable from the list.")
    n = len(rendered)
    if n == 0:
        why = ""
        if res.skipped:
            first = res.skipped[0].label.lower()
            why = f" ({len(res.skipped)} skipped, e.g. {first})"
        _bad(422, f"There is nobody to send this to{why}")
    if n > messaging.MAX_RECIPIENTS:
        _bad(422, f"One batch is limited to {messaging.MAX_RECIPIENTS} people and this one has {n}. Narrow it down and send in parts.")
    used = messaging.sent_in_last_hour(db, ctx.email)
    if used + n > messaging.RATE_LIMIT_PER_HOUR:
        left = max(0, messaging.RATE_LIMIT_PER_HOUR - used)
        _bad(429, f"You can e-mail {messaging.RATE_LIMIT_PER_HOUR} people per hour and have {left} left. Try again later.")
    if n > messaging.LARGE_BATCH and draft.kind in ("warning", "final") and not body.confirmed:
        _bad(409, f"This sends a {messaging.KIND_LABEL[draft.kind].lower()} to {n} people. Confirm to continue.")

    opts = body.options
    batch = messaging.queue_batch(ctx, res, rendered, draft, cc_manager=opts.cc_manager, copy_me=opts.copy_me, in_app=opts.in_app)
    db.commit()
    background.add_task(messaging.run_batch, batch)
    return {"batch_id": str(batch), "queued": n, "skipped": len(res.skipped)}


def _batch_dict(rows: list[SentEmail]) -> dict:
    counts = {"queued": 0, "sent": 0, "failed": 0, "skipped": 0}
    for r in rows:
        counts[r.status] = counts.get(r.status, 0) + 1
    first = rows[0]
    return {
        "batch_id": str(first.batch_id),
        "status": "sending" if counts["queued"] else "done",
        "total": len(rows),
        "counts": counts,
        "stopped": any(r.error == messaging.SKIP_LABEL["stopped"] for r in rows),
        "template_name": first.template_name,
        "kind": (first.context or {}).get("kind", "custom"),
        "source": (first.context or {}).get("source"),
        "created_at": first.created_at.isoformat(),
        "recipients": [
            {"id": str(r.id), "email": r.recipient_email, "name": r.recipient_name, "status": r.status, "error": r.error, "subject": r.subject}
            for r in rows
        ],
    }


@router.get("/emails/batches/{batch_id}")
def batch_status(batch_id: str, ctx: Ctx = Depends(get_ctx)):
    try:
        bid = uuid.UUID(batch_id)
    except ValueError:
        _bad(404, "No such batch")
    db = ctx.db
    messaging.sweep_stale(db, bid)
    rows = list(
        db.scalars(select(SentEmail).where(SentEmail.batch_id == bid).order_by(SentEmail.created_at, SentEmail.id))
    )
    if not rows or not (rows[0].sent_by == ctx.email or ctx.is_super or ctx.can("audit_log", "view")):
        _bad(404, "No such batch")
    return _batch_dict(rows)


# ------------------------------------------------------------------ history


def _history_row(r: SentEmail, d: Directory, names: dict[uuid.UUID, str]) -> dict:
    return {
        "id": str(r.id),
        "batch_id": str(r.batch_id),
        "created_at": r.created_at.isoformat(),
        "sent_by": d.person(r.sent_by),
        "recipient": {"email": r.recipient_email, "name": r.recipient_name},
        "template_name": r.template_name,
        "kind": (r.context or {}).get("kind", "custom"),
        "subject": r.subject,
        "body": r.body,
        "status": r.status,
        "error": r.error,
        "obligation_id": str(r.obligation_id) if r.obligation_id else None,
        "compliance_id": str(r.compliance_id) if r.compliance_id else None,
        "compliance": names.get(r.compliance_id) if r.compliance_id else None,
        "cc": (r.context or {}).get("cc") or [],
    }


@router.get("/emails/history")
def history(
    person: str | None = None,
    obligation_id: str | None = None,
    compliance_id: str | None = None,
    batch_id: str | None = None,
    include_skipped: bool = False,
    limit: int = Query(50, le=200),
    offset: int = 0,
    ctx: Ctx = Depends(get_ctx),
):
    """What was e-mailed, newest first, limited to mail the viewer sent or mail to people and items they can see."""
    if not messaging.can_view_history(ctx):
        _bad(403, "You don't have permission to see sent e-mail")
    db = ctx.db
    cond = [messaging.history_filter(ctx), SentEmail.context["test"].astext.is_(None)]
    if not include_skipped:
        cond.append(SentEmail.status != "skipped")
    try:
        if person:
            cond.append(func.lower(SentEmail.recipient_email) == person.strip().lower())
        if obligation_id:
            oid = uuid.UUID(obligation_id)
            if not ctx.can_see_obligation(oid):
                _bad(404, "No such item")
            cond.append(SentEmail.obligation_id == oid)
        if compliance_id:
            cid = uuid.UUID(compliance_id)
            if not ctx.can_see_compliance(cid, "view"):
                _bad(404, "No such compliance")
            cond.append(SentEmail.compliance_id == cid)
        if batch_id:
            cond.append(SentEmail.batch_id == uuid.UUID(batch_id))
    except ValueError:
        _bad(404, "No such record")
    total = db.scalar(select(func.count()).select_from(SentEmail).where(*cond))
    rows = list(db.scalars(select(SentEmail).where(*cond).order_by(SentEmail.created_at.desc(), SentEmail.id).limit(limit).offset(offset)))
    d = Directory(db, {r.sent_by for r in rows})
    from app.compliance.models import Compliance

    names = {c.id: c.name for c in db.scalars(select(Compliance).where(Compliance.id.in_({r.compliance_id for r in rows if r.compliance_id} or {uuid.uuid4()})))}
    return {"total": total, "items": [_history_row(r, d, names) for r in rows]}


# --------------------------------------------------- template management (admin)


@admin_router.get("/email-templates")
def list_templates(ctx: Ctx = Depends(get_ctx)):
    _require_configure(ctx)
    rows = ctx.db.scalars(select(EmailTemplate).order_by(EmailTemplate.is_system.desc(), EmailTemplate.name))
    return [messaging.template_dict(t) for t in rows]


@admin_router.post("/email-templates", status_code=201)
def create_template(body: TemplateIn, ctx: Ctx = Depends(get_ctx)):
    _require_configure(ctx)
    try:
        messaging.validate_template(body.name, body.kind, body.subject, body.body, body.description)
    except messaging.TemplateError as exc:
        _bad(422, str(exc))
    db = ctx.db
    t = EmailTemplate(
        key=messaging.unique_key(db, body.name),
        name=body.name.strip(),
        description=body.description.strip(),
        kind=body.kind,
        subject=body.subject.strip(),
        body=body.body.strip("\n"),
        is_system=False,
        active=body.active,
        created_by=ctx.email,
    )
    db.add(t)
    db.flush()
    audit.record(db, ctx.email, "email_template.created", "email_template", t.id, after={"name": t.name, "kind": t.kind})
    db.commit()
    return messaging.template_dict(t)


@admin_router.patch("/email-templates/{tid}")
def update_template(tid: str, body: TemplatePatch, ctx: Ctx = Depends(get_ctx)):
    _require_configure(ctx)
    t = _template(ctx, tid)
    data = body.model_dump(exclude_unset=True)
    merged = {"name": t.name, "kind": t.kind, "subject": t.subject, "body": t.body, **{k: v for k, v in data.items() if k in ("name", "kind", "subject", "body") and v is not None}}
    try:
        messaging.validate_template(merged["name"], merged["kind"], merged["subject"], merged["body"], data.get("description") or "")
    except messaging.TemplateError as exc:
        _bad(422, str(exc))
    before = {"name": t.name, "kind": t.kind, "subject": t.subject, "active": t.active}
    t.name, t.kind, t.subject, t.body = merged["name"].strip(), merged["kind"], merged["subject"].strip(), merged["body"].strip("\n")
    if data.get("description") is not None:
        t.description = data["description"].strip()
    if data.get("active") is not None:
        t.active = data["active"]
    ctx.db.flush()
    audit.record(ctx.db, ctx.email, "email_template.updated", "email_template", t.id, before=before, after={"name": t.name, "kind": t.kind, "subject": t.subject, "active": t.active})
    ctx.db.commit()
    return messaging.template_dict(t)


@admin_router.delete("/email-templates/{tid}", status_code=204)
def delete_template(tid: str, ctx: Ctx = Depends(get_ctx)):
    _require_configure(ctx)
    t = _template(ctx, tid)
    if t.is_system:
        _bad(400, "The built-in templates can be edited or turned off, but not deleted. Use \"Reset to default\" to undo your edits.")
    audit.record(ctx.db, ctx.email, "email_template.deleted", "email_template", t.id, before={"name": t.name, "kind": t.kind})
    ctx.db.delete(t)
    ctx.db.commit()


@admin_router.post("/email-templates/{tid}/reset")
def reset_template(tid: str, ctx: Ctx = Depends(get_ctx)):
    _require_configure(ctx)
    t = _template(ctx, tid)
    before = {"name": t.name, "kind": t.kind, "subject": t.subject, "active": t.active}
    try:
        messaging.reset_template(t)
    except messaging.TemplateError as exc:
        _bad(400, str(exc))
    ctx.db.flush()
    audit.record(ctx.db, ctx.email, "email_template.reset", "email_template", t.id, before=before, after={"name": t.name, "kind": t.kind, "subject": t.subject})
    ctx.db.commit()
    return messaging.template_dict(t)


def _sample_mail(ctx: Ctx, draft: DraftIn):
    from app.auth.local import app_url

    now = engine.now()
    values = messaging.sample_values(ctx.user, now, _tz(ctx))
    subject, bad1 = messaging.render(draft.subject, values)
    body, bad2 = messaging.render(draft.body, values)
    unknown = messaging.unknown_variables(draft.subject, draft.body)
    kind = draft.kind if draft.kind in messaging.KINDS else "custom"
    subject = " ".join(subject.split())
    s, text, html = email_templates.compliance_message_email(
        subject, body, kind=kind, link=app_url("/compliance/mine"), sender_name=ctx.user.name
    )
    return s, text, html, unknown


@admin_router.post("/email-templates/preview")
def preview_template(body: DraftIn, ctx: Ctx = Depends(get_ctx)):
    """Render a draft with made-up data (the editor's live preview)."""
    _require_configure(ctx)
    subject, text, html, unknown = _sample_mail(ctx, body)
    return {"subject": subject, "text": text, "html": html, "unknown": unknown}


@admin_router.post("/email-templates/test")
def test_template(body: DraftIn, ctx: Ctx = Depends(get_ctx)):
    """Send the draft, filled with made-up data, to the signed-in person's own address."""
    _require_configure(ctx)
    db = ctx.db
    if ctx.user.is_demo:
        _bad(400, "This is a demo account, which has no real mailbox. Sign in with a real account to send yourself a test.")
    if not mailer.is_configured(db):
        _bad(409, "E-mail isn't set up yet. Add the SMTP host and a From address in Settings > Email (SMTP).")
    subject, text, html, unknown = _sample_mail(ctx, body)
    if unknown:
        _bad(422, "Unknown variable: " + ", ".join("{{" + u + "}}" for u in unknown))
    subject = "[Test] " + subject
    batch = uuid.uuid4()
    row = SentEmail(
        batch_id=batch,
        sent_by=ctx.email,
        recipient_email=ctx.email,
        recipient_name=ctx.user.name,
        template_name="Test",
        subject=subject,
        body=text,
        context={"test": True, "kind": body.kind},
        status="queued",
    )
    db.add(row)
    db.commit()
    try:
        mailer.send_email(ctx.email, subject, text, html, db=db)
    except mailer.MailError as exc:
        row.status, row.error = "failed", str(exc)[:500]
        db.commit()
        return {"ok": False, "error": str(exc)}
    row.status = "sent"
    db.commit()
    return {"ok": True, "to": ctx.email}
