"""Local (password) accounts: invite / reset tokens, lockout, throttling and the
mails that carry the links. Used by app/api/auth.py, the admin API and
scripts/create_admin.py.

Matching is always by e-mail, so an account created here keeps working if
Microsoft sign-in is switched on later. Microsoft and demo login are untouched.
"""
import logging
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import email_templates, mailer
from app.auth.passwords import INVITE_TTL_HOURS, RESET_TTL_HOURS, new_token, token_digest
from app.config import settings
from app.models import OrgUser

logger = logging.getLogger("app.auth")

MAX_FAILED_LOGINS = 5
LOCKOUT_MINUTES = 15
# A reset/invite is not re-issued by the public "forgot password" form more
# often than this, so nobody can keep invalidating someone else's link.
RESEND_COOLDOWN_SECONDS = 60

PURPOSE_INVITE = "invite"
PURPOSE_RESET = "reset"


def now() -> datetime:
    return datetime.now(timezone.utc)


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def find_user(db: Session, email: str) -> OrgUser | None:
    email = normalize_email(email)
    if not email:
        return None
    return db.scalars(select(OrgUser).where(func.lower(OrgUser.email) == email)).first()


def user_status(u: OrgUser) -> str:
    """"disabled", "invited" (created, hasn't set a password or signed in yet) or "active"."""
    if not u.is_active:
        return "disabled"
    if not u.is_demo and u.password_hash is None and u.last_login_at is None and u.invited_at is not None:
        return "invited"
    return "active"


# ------------------------------------------------------------------- tokens


def _aware(value: datetime | None) -> datetime | None:
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def issue_token(user: OrgUser, purpose: str) -> str:
    """Create a one-time token for the user (replacing any outstanding one) and
    return the raw token. Only its SHA-256 is stored. Caller commits."""
    token = new_token()
    hours = INVITE_TTL_HOURS if purpose == PURPOSE_INVITE else RESET_TTL_HOURS
    stamp = now()
    user.invite_token_hash = token_digest(token)
    user.invite_expires_at = stamp + timedelta(hours=hours)
    user.invite_purpose = purpose
    if purpose == PURPOSE_INVITE:
        user.invited_at = stamp
    return token


def token_issued_recently(user: OrgUser) -> bool:
    if not user.invite_token_hash or user.invite_expires_at is None:
        return False
    hours = INVITE_TTL_HOURS if user.invite_purpose == PURPOSE_INVITE else RESET_TTL_HOURS
    issued = _aware(user.invite_expires_at) - timedelta(hours=hours)
    return (now() - issued).total_seconds() < RESEND_COOLDOWN_SECONDS


def clear_token(user: OrgUser) -> None:
    user.invite_token_hash = None
    user.invite_expires_at = None
    user.invite_purpose = None


def user_for_token(db: Session, token: str, purpose: str) -> OrgUser | None:
    """The user a valid (right purpose, unexpired, unused) token belongs to."""
    if not token or len(token) > 200:
        return None
    u = db.scalars(select(OrgUser).where(OrgUser.invite_token_hash == token_digest(token))).first()
    if u is None or u.invite_purpose != purpose:
        return None
    expires = _aware(u.invite_expires_at)
    if expires is None or expires < now():
        return None
    return u


def set_password(user: OrgUser, password_hash: str) -> None:
    user.password_hash = password_hash
    user.password_set_at = now()
    user.failed_logins = 0
    user.locked_until = None
    clear_token(user)


# --------------------------------------------------------------------- links


def base_url() -> str:
    return settings.public_base_url.strip().rstrip("/")


def invite_url(token: str) -> str:
    return f"{base_url()}/ui/invite/{token}"


def reset_url(token: str) -> str:
    return f"{base_url()}/ui/reset/{token}"


def app_url(path: str) -> str:
    """Absolute link to an SPA route (path like "/compliance/obligations/<id>")."""
    return f"{base_url()}/ui{path if path.startswith('/') else '/' + path}"


# ----------------------------------------------------------------- lockout


def is_locked(user: OrgUser) -> bool:
    locked = _aware(user.locked_until)
    return locked is not None and locked > now()


def register_failure(user: OrgUser) -> None:
    user.failed_logins = (user.failed_logins or 0) + 1
    if user.failed_logins >= MAX_FAILED_LOGINS:
        user.locked_until = now() + timedelta(minutes=LOCKOUT_MINUTES)
        user.failed_logins = 0


def register_success(user: OrgUser) -> None:
    user.failed_logins = 0
    user.locked_until = None
    user.last_login_at = now()


# ---------------------------------------------------------------- IP throttle


class IpThrottle:
    """Sliding-window counter per client address, in memory (one process).
    Good enough to slow guessing; the per-account lockout is the hard limit."""

    def __init__(self, limit: int, window_seconds: int):
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def _trim(self, key: str) -> deque[float]:
        q = self._hits[key]
        cutoff = time.monotonic() - self.window
        while q and q[0] < cutoff:
            q.popleft()
        if not q:
            self._hits.pop(key, None)
            return deque()
        return q

    def blocked(self, key: str) -> bool:
        return len(self._trim(key)) >= self.limit

    def hit(self, key: str) -> None:
        self._trim(key)
        self._hits[key].append(time.monotonic())

    def reset(self) -> None:
        self._hits.clear()


login_failures = IpThrottle(limit=20, window_seconds=10 * 60)
forgot_requests = IpThrottle(limit=10, window_seconds=10 * 60)
token_attempts = IpThrottle(limit=30, window_seconds=10 * 60)


def reset_throttles() -> None:
    for t in (login_failures, forgot_requests, token_attempts):
        t.reset()


# --------------------------------------------------------------------- mail


def send_invite_mail(db: Session, user: OrgUser, token: str, invited_by: str | None = None) -> tuple[bool, str | None]:
    """Returns (sent, error). (False, None) when SMTP isn't configured."""
    cfg = mailer.get_config(db)
    if not cfg.configured:
        return False, None
    subject, text, html = email_templates.invite_email(user.name, invite_url(token), invited_by, INVITE_TTL_HOURS // 24)
    try:
        mailer.send_email(user.email, subject, text, html, config=cfg)
        return True, None
    except mailer.MailError as exc:
        return False, str(exc)


def send_reset_mail(db: Session, user: OrgUser, token: str, by_admin: bool = False) -> tuple[bool, str | None]:
    cfg = mailer.get_config(db)
    if not cfg.configured:
        return False, None
    subject, text, html = email_templates.reset_email(user.name, reset_url(token), RESET_TTL_HOURS, by_admin)
    try:
        mailer.send_email(user.email, subject, text, html, config=cfg)
        return True, None
    except mailer.MailError as exc:
        return False, str(exc)
