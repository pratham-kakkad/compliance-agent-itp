import secrets

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.auth import microsoft_oauth
from app.auth.dependencies import get_current_user
from app.auth.session import COOKIE_NAME, MAX_AGE_SECONDS, create_session_cookie
from app.config import settings
from app.database import get_db
from app.models import OrgUser

router = APIRouter(prefix="/auth", tags=["auth"])

_oauth_states: set[str] = set()  # single-process CSRF-state store; fine for a prototype


@router.get("/config")
def auth_config():
    return {
        "mode": settings.auth_mode,
        "microsoft_configured": microsoft_oauth.is_configured(),
    }


@router.get("/dev-login-directory")
def dev_login_directory(db: Session = Depends(get_db)):
    """Unauthenticated on purpose — the login screen needs a roster to pick
    from before any session exists. Only responds when AUTH_MODE=dev."""
    if settings.auth_mode != "dev":
        raise HTTPException(status_code=403, detail="Dev login is disabled")
    return [
        {"email": u.email, "name": u.name, "title": u.title}
        for u in db.query(OrgUser).all()
    ]


@router.get("/dev-login")
def dev_login(email: str, db: Session = Depends(get_db)):
    if settings.auth_mode != "dev":
        raise HTTPException(status_code=403, detail="Dev login is disabled (AUTH_MODE is not 'dev')")
    user = db.get(OrgUser, email)
    if user is None:
        raise HTTPException(status_code=404, detail=f"No such user in directory: {email}")
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
def callback(code: str, state: str, db: Session = Depends(get_db)):
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
        user = OrgUser(email=email, name=claims.get("name", email), title="", manager_email=None)
        db.add(user)
        db.commit()

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
    return {"email": user.email, "name": user.name, "title": user.title, "manager_email": user.manager_email}
