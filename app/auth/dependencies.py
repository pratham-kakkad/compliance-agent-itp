from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.auth.session import COOKIE_NAME, read_session_cookie
from app.database import get_db
from app.models import OrgUser


def get_current_user(request: Request, db: Session = Depends(get_db)) -> OrgUser:
    email = read_session_cookie(request.cookies.get(COOKIE_NAME))
    if email is None:
        raise HTTPException(status_code=401, detail="Not logged in")
    user = db.get(OrgUser, email)
    if user is None:
        raise HTTPException(status_code=401, detail="Session user not found")
    return user
