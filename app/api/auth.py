import secrets

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.auth import microsoft_oauth
from app.auth.dependencies import get_current_user
from app.auth.session import COOKIE_NAME, MAX_AGE_SECONDS, create_session_cookie
from app.config import settings
from app.database import get_db
from app.models import OrgUser
from app.teams_sync import sync_one_organizer

router = APIRouter(prefix="/auth", tags=["auth"])

_oauth_states: set[str] = set()  # single-process CSRF-state store; fine for a prototype


@router.get("/config")
def auth_config():
    return {
        "demo_login_enabled": settings.enable_demo_login,
        "microsoft_configured": microsoft_oauth.is_configured(),
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

    user = db.get(OrgUser, email)
    if user is None:
        claims = token_result.get("id_token_claims", {})
        user = OrgUser(email=email, name=claims.get("name", email), title="", manager_email=None, is_demo=False)
        db.add(user)
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
    }
