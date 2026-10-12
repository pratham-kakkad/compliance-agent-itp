"""Notifications. In-app notices are real and shown in the UI. E-mail is first
recorded as intent (`email_status = "pending"`); `deliver_pending` (called after
every compliance tick and from POST /compliance/admin/send-pending) then sends
the pending ones over SMTP and marks them sent / failed / skipped."""
import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app import email_templates, mailer
from app.compliance.models import Notification
from app.models import OrgUser

log = logging.getLogger("app.compliance.notify")

MAX_EMAIL_ATTEMPTS = 3
# Notices older than this are never e-mailed (so switching SMTP on doesn't
# send a backlog of stale reminders); they stay visible in the app.
MAX_EMAIL_AGE = timedelta(days=7)
_STOP_AFTER_CONSECUTIVE_FAILURES = 3


def notify(
    db: Session,
    user_email: str,
    kind: str,
    title: str,
    body: str = "",
    link: str | None = None,
    obligation_id: uuid.UUID | None = None,
) -> Notification:
    n = Notification(
        user_email=user_email, kind=kind, title=title, body=body, link=link, obligation_id=obligation_id
    )
    db.add(n)
    return n


def obligation_link(obligation_id: uuid.UUID) -> str:
    return f"/compliance/obligations/{obligation_id}"


def pending_count(db: Session) -> int:
    return db.scalar(
        select(func.count()).select_from(Notification).where(
            or_(
                Notification.email_status == "pending",
                and_(Notification.email_status == "failed", Notification.email_attempts < MAX_EMAIL_ATTEMPTS),
            )
        )
    ) or 0


def deliver_pending(db: Session, limit: int = 50) -> dict:
    """E-mail pending notifications (and failed ones with fewer than 3 attempts).

    Does nothing, and leaves rows pending, when SMTP isn't configured. Skips
    (marks "skipped") notices for people who are inactive, demo accounts (their
    addresses aren't real) or notices older than a week. Each row is committed
    as it is handled so a crash never re-sends a message that went out.
    """
    cfg = mailer.get_config(db)
    if not cfg.configured:
        return {"configured": False, "sent": 0, "failed": 0, "skipped": 0, "remaining": pending_count(db)}

    rows = list(
        db.scalars(
            select(Notification)
            .where(
                or_(
                    Notification.email_status == "pending",
                    and_(Notification.email_status == "failed", Notification.email_attempts < MAX_EMAIL_ATTEMPTS),
                )
            )
            .order_by(Notification.created_at)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
    )
    from app.auth.local import app_url  # lazy: keeps the import graph acyclic

    sent = failed = skipped = 0
    consecutive_failures = 0
    now = datetime.now(timezone.utc)
    for n in rows:
        user = db.get(OrgUser, n.user_email)
        created = n.created_at if n.created_at.tzinfo else n.created_at.replace(tzinfo=timezone.utc)
        reason = None
        if user is None or not user.is_active:
            reason = "The recipient is inactive"
        elif user.is_demo:
            reason = "Demo accounts have no real mailbox"
        elif now - created > MAX_EMAIL_AGE:
            reason = "Too old to e-mail"
        if reason:
            n.email_status, n.email_error = "skipped", reason
            skipped += 1
            db.commit()
            continue
        subject, text, html = email_templates.notification_email(
            n.title, n.body or "", app_url(n.link) if n.link else None, n.kind, user.name
        )
        n.email_attempts = (n.email_attempts or 0) + 1
        try:
            mailer.send_email(user.email, subject, text, html, config=cfg)
        except mailer.MailError as exc:
            n.email_status, n.email_error = "failed", str(exc)[:500]
            failed += 1
            consecutive_failures += 1
        else:
            n.email_status, n.email_error, n.email_sent_at = "sent", None, datetime.now(timezone.utc)
            sent += 1
            consecutive_failures = 0
        db.commit()
        if consecutive_failures >= _STOP_AFTER_CONSECUTIVE_FAILURES:
            log.warning("Stopping this e-mail batch after %d failures in a row: %s", consecutive_failures, n.email_error)
            break
    if sent or failed:
        log.info("Notification e-mail: %d sent, %d failed, %d skipped", sent, failed, skipped)
    return {"configured": True, "sent": sent, "failed": failed, "skipped": skipped, "remaining": pending_count(db)}
