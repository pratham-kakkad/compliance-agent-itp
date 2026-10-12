"""Settings page API. Every endpoint needs a login; there are no roles yet,
so anyone logged in can change settings (the same people who can import
punch logs)."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import email_templates, mailer
from app.auth.dependencies import get_current_user
from app.compliance import audit
from app.compliance.policy import Ctx, get_ctx
from app.database import get_db
from app.models import OrgUser
from app.org_settings import service

router = APIRouter(prefix="/settings", tags=["settings"])


class SettingsUpdate(BaseModel):
    """Partial update: omitted or null fields are left as they are."""

    timezone: str | None = None


@router.get("")
def read_settings(db: Session = Depends(get_db), _user: OrgUser = Depends(get_current_user)):
    return service.get_settings(db)


@router.put("")
def update_settings(
    body: SettingsUpdate,
    db: Session = Depends(get_db),
    user: OrgUser = Depends(get_current_user),
):
    if body.timezone is None:
        return {**service.get_settings(db), "changed": False, "recomputed_days": 0}
    try:
        name = service.validate_timezone(body.timezone)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return service.set_timezone(db, name, updated_by=user.email)


@router.get("/timezones")
def list_timezones(_user: OrgUser = Depends(get_current_user)):
    return {"timezones": service.list_timezones(), "default": service.default_timezone_name()}


# ---------------------------------------------------------------- SMTP


class SmtpUpdate(BaseModel):
    host: str = ""
    port: int = 587
    security: str = "starttls"
    username: str = ""
    from_email: str = ""
    from_name: str = ""
    # None (or omitted) keeps the saved password, "" clears it, anything else replaces it.
    password: str | None = None


class SmtpTest(BaseModel):
    to: str


@router.get("/smtp")
def read_smtp(ctx: Ctx = Depends(get_ctx)):
    """Outgoing e-mail settings. Never includes the password, only `password_set`."""
    ctx.require("settings", "configure")
    return mailer.public_view(ctx.db)


@router.put("/smtp")
def update_smtp(body: SmtpUpdate, ctx: Ctx = Depends(get_ctx)):
    ctx.require("settings", "configure")
    before = mailer.public_view(ctx.db)
    try:
        mailer.save_config(
            ctx.db,
            host=body.host,
            port=body.port,
            security=body.security,
            username=body.username,
            from_email=body.from_email,
            from_name=body.from_name,
            password=body.password,
            updated_by=ctx.email,
        )
    except ValueError as exc:
        ctx.db.rollback()
        raise HTTPException(status_code=422, detail=str(exc))
    after = mailer.public_view(ctx.db)
    keep = ("host", "port", "security", "username", "from_email", "from_name", "password_set")
    audit.record(
        ctx.db, ctx.email, "settings.smtp_updated", "settings", "smtp",
        before={k: before[k] for k in keep}, after={k: after[k] for k in keep},
    )
    ctx.db.commit()
    return mailer.public_view(ctx.db)


@router.post("/smtp/test")
def test_smtp(body: SmtpTest, ctx: Ctx = Depends(get_ctx)):
    """Send a real test message with the current settings."""
    ctx.require("settings", "configure")
    subject, text, html = email_templates.smtp_test_email(ctx.user.name)
    try:
        mailer.send_email(body.to, subject, text, html, db=ctx.db)
    except mailer.MailError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}
