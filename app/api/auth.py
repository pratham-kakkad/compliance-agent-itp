import logging
import secrets

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import email_templates, mailer
from app.auth import local, microsoft_oauth, passwords
from app.auth.dependencies import get_current_user
from app.auth.session import COOKIE_NAME, MAX_AGE_SECONDS, create_session_cookie
from app.config import settings
from app.database import get_db
from app.models import OrgUser
from app.teams_sync import sync_one_organizer

router = APIRouter(prefix="/auth", tags=["auth"])

logger = logging.getLogger("app.auth")

_oauth_states: set[str] = set()  # single-process CSRF-state store; fine for a prototype

# One message for every failed password sign-in, so nothing here reveals
# whether an e-mail has an account, is locked or has no password yet.
_BAD_LOGIN = "Incorrect e-mail or password. After several failed attempts an account is locked for a few minutes."


def _set_session(response: Response, email: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        create_session_cookie(email),
        max_age=MAX_AGE_SECONDS,
        httponly=True,
        samesite="lax",
        # Behind HTTPS (PUBLIC_BASE_URL is https://...) the cookie is never sent over plain http.
        secure=settings.public_base_url.strip().lower().startswith("https://"),
    )


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip() or "unknown"
    return request.client.host if request.client else "unknown"


@router.get("/config")
def auth_config(db: Session = Depends(get_db)):
    return {
        "demo_login_enabled": settings.enable_demo_login,
        "microsoft_configured": microsoft_oauth.is_configured(),
        "password_login_enabled": True,
        "smtp_configured": mailer.is_configured(db),
    }


@router.get("/dev-login-directory")
def dev_login_directory(db: Session = Depends(get_db)):
    """Unauthenticated on purpose — the login screen needs a roster to pick
    from before any session exists. Only ever lists demo accounts, and only
    responds while demo login is enabled."""
    if not settings.enable_demo_login:
        raise HTTPException(status_code=403, detail="Demo login is disabled")
    return [
        {"email": u.email, "name": u.name, "title": u.title}
        for u in db.query(OrgUser).filter(OrgUser.is_demo.is_(True)).all()
    ]


@router.get("/dev-login")
def dev_login(email: str, db: Session = Depends(get_db)):
    if not settings.enable_demo_login:
        raise HTTPException(status_code=403, detail="Demo login is disabled (ENABLE_DEMO_LOGIN is false)")
    user = db.get(OrgUser, email)
    if user is None or not user.is_demo:
        # Deliberately the same 404 whether the email doesn't exist at all
        # or belongs to a real (non-demo) account — dev-login must never
        # double as a password-free way to sign in as a real person.
        raise HTTPException(status_code=404, detail=f"No such demo account: {email}")
    user.last_login_at = local.now()
    db.commit()
    response = RedirectResponse(url="/ui/")
    response.set_cookie(
        COOKIE_NAME, create_session_cookie(email), max_age=MAX_AGE_SECONDS, httponly=True
    )
    return response


@router.get("/login")
def login():
    if not microsoft_oauth.is_configured():
        raise HTTPException(
            status_code=400,
            detail="Microsoft sign-in isn't configured yet — set MS_CLIENT_ID/MS_CLIENT_SECRET/MS_TENANT_ID.",
        )
    state = secrets.token_urlsafe(16)
    _oauth_states.add(state)
    return RedirectResponse(url=microsoft_oauth.get_authorization_url(state))


@router.get("/callback")
def callback(code: str, state: str, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    if state not in _oauth_states:
        raise HTTPException(status_code=400, detail="Invalid or expired OAuth state")
    _oauth_states.discard(state)

    try:
        token_result = microsoft_oauth.acquire_token_by_auth_code(code)
        email = microsoft_oauth.get_user_email(token_result)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # An account an administrator created (by e-mail) is matched here, so
    # people created before Microsoft sign-in existed just start using it.
    user = db.get(OrgUser, email) or local.find_user(db, email)
    if user is None:
        claims = token_result.get("id_token_claims", {})
        user = OrgUser(email=email, name=claims.get("name", email), title="", manager_email=None, is_demo=False)
        db.add(user)
    elif not user.is_active:
        raise HTTPException(status_code=403, detail="This account has been deactivated")
    email = user.email
    user.last_login_at = local.now()
    db.commit()

    # Sync this person's real calendar right away so they don't have to wait
    # for the next scheduled cycle to see any data after signing in.
    background_tasks.add_task(sync_one_organizer, email)

    response = RedirectResponse(url="/ui/")
    response.set_cookie(
        COOKIE_NAME, create_session_cookie(email), max_age=MAX_AGE_SECONDS, httponly=True
    )
    return response


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME)
    return {"ok": True}


@router.get("/me")
def me(user: OrgUser = Depends(get_current_user)):
    return {
        "email": user.email,
        "name": user.name,
        "title": user.title,
        "manager_email": user.manager_email,
        "is_demo": user.is_demo,
        "has_password": user.password_hash is not None,
    }


# ------------------------------------------------------------ local sign-in


class PasswordLoginIn(BaseModel):
    email: str
    password: str


class InviteAcceptIn(BaseModel):
    token: str
    password: str


class ForgotIn(BaseModel):
    email: str


class ResetIn(BaseModel):
    token: str
    password: str


class ChangePasswordIn(BaseModel):
    current_password: str = ""
    new_password: str


def _policy(password: str, email: str = "") -> None:
    try:
        passwords.validate_password(password, email=email)
    except passwords.PasswordPolicyError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


def _bad_link() -> HTTPException:
    return HTTPException(status_code=400, detail="This link is invalid, has expired or was already used. Ask for a new one.")


@router.post("/password-login")
def password_login(body: PasswordLoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    ip = _client_ip(request)
    if local.login_failures.blocked(ip):
        raise HTTPException(status_code=429, detail="Too many sign-in attempts from this address. Try again in a few minutes.")
    user = local.find_user(db, body.email)
    if user is None or user.password_hash is None or local.is_locked(user):
        # Same work and same answer whether or not the account exists, has a
        # password or is locked.
        passwords.burn_verify(body.password)
        local.login_failures.hit(ip)
        raise HTTPException(status_code=401, detail=_BAD_LOGIN)
    if not passwords.verify_password(body.password, user.password_hash):
        local.register_failure(user)
        db.commit()
        local.login_failures.hit(ip)
        raise HTTPException(status_code=401, detail=_BAD_LOGIN)
    if not user.is_active:  # they proved the password, so a clear message is fine
        raise HTTPException(status_code=403, detail="This account has been deactivated. Ask an administrator.")
    local.register_success(user)
    db.commit()
    _set_session(response, user.email)
    return {"ok": True, "email": user.email, "name": user.name}


@router.get("/invite/{token}")
def check_invite(token: str, request: Request, db: Session = Depends(get_db)):
    ip = _client_ip(request)
    if local.token_attempts.blocked(ip):
        raise HTTPException(status_code=429, detail="Too many attempts. Try again in a few minutes.")
    user = local.user_for_token(db, token, local.PURPOSE_INVITE)
    if user is None or not user.is_active:
        local.token_attempts.hit(ip)
        raise _bad_link()
    return {"name": user.name, "email": user.email}


@router.post("/invite/accept")
def accept_invite(body: InviteAcceptIn, request: Request, response: Response, db: Session = Depends(get_db)):
    ip = _client_ip(request)
    if local.token_attempts.blocked(ip):
        raise HTTPException(status_code=429, detail="Too many attempts. Try again in a few minutes.")
    user = local.user_for_token(db, body.token, local.PURPOSE_INVITE)
    if user is None or not user.is_active:
        local.token_attempts.hit(ip)
        raise _bad_link()
    _policy(body.password, user.email)
    local.set_password(user, passwords.hash_password(body.password))
    local.register_success(user)
    db.commit()
    _set_session(response, user.email)  # they proved they own the mailbox: sign them in
    return {"ok": True, "email": user.email, "name": user.name}


def _send_in_background(cfg: mailer.SmtpConfig, to: str, rendered: email_templates.Rendered) -> None:
    subject, text, html = rendered
    try:
        mailer.send_email(to, subject, text, html, config=cfg)
    except mailer.MailError as exc:
        logger.warning("Couldn't send the password e-mail to %s: %s", to, exc)


@router.post("/forgot-password")
def forgot_password(body: ForgotIn, request: Request, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Always 200 with the same body. A link is only mailed when the account
    exists, is active and SMTP is configured; the mail goes out in the
    background so timing doesn't give the answer away either."""
    ip = _client_ip(request)
    answer = {"ok": True, "message": "If that e-mail has an account, a reset link is on its way."}
    if local.forgot_requests.blocked(ip):
        return answer
    local.forgot_requests.hit(ip)
    cfg = mailer.get_config(db)
    user = local.find_user(db, body.email)
    if user is None or not user.is_active or user.is_demo or not cfg.configured:
        return answer
    if local.token_issued_recently(user):
        return answer
    if user.password_hash is None:
        # Never set a password (still on the invite): send a fresh invite instead.
        token = local.issue_token(user, local.PURPOSE_INVITE)
        rendered = email_templates.invite_email(user.name, local.invite_url(token), None, passwords.INVITE_TTL_HOURS // 24)
    else:
        token = local.issue_token(user, local.PURPOSE_RESET)
        rendered = email_templates.reset_email(user.name, local.reset_url(token), passwords.RESET_TTL_HOURS)
    db.commit()
    background_tasks.add_task(_send_in_background, cfg, user.email, rendered)
    return answer


@router.post("/reset-password")
def reset_password(body: ResetIn, request: Request, db: Session = Depends(get_db)):
    ip = _client_ip(request)
    if local.token_attempts.blocked(ip):
        raise HTTPException(status_code=429, detail="Too many attempts. Try again in a few minutes.")
    user = local.user_for_token(db, body.token, local.PURPOSE_RESET)
    if user is None or not user.is_active:
        local.token_attempts.hit(ip)
        raise _bad_link()
    _policy(body.password, user.email)
    local.set_password(user, passwords.hash_password(body.password))
    db.commit()
    return {"ok": True}


@router.post("/change-password")
def change_password(body: ChangePasswordIn, db: Session = Depends(get_db), user: OrgUser = Depends(get_current_user)):
    if user.password_hash is not None:
        if local.is_locked(user) or not passwords.verify_password(body.current_password, user.password_hash):
            local.register_failure(user)
            db.commit()
            raise HTTPException(status_code=400, detail="Your current password isn't right.")
        if body.current_password == body.new_password:
            raise HTTPException(status_code=422, detail="Choose a password different from the current one.")
    _policy(body.new_password, user.email)
    local.set_password(user, passwords.hash_password(body.new_password))
    db.commit()
    return {"ok": True}
