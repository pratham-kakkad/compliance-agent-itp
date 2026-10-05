"""Notifications. In-app notices are real and shown in the UI. E-mail is recorded
as intent (`email_status = "pending"`) so a sender (SMTP or Microsoft Graph) can
be plugged in later without touching the callers."""
import uuid

from sqlalchemy.orm import Session

from app.compliance.models import Notification


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
