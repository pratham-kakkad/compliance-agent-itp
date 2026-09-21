from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models import OrgUser

router = APIRouter(prefix="/directory", tags=["directory"])


@router.get("/users")
def list_directory(db: Session = Depends(get_db), _user: OrgUser = Depends(get_current_user)):
    """Names/titles only, org-wide — no attendance data, no reporting-line
    restriction. Used purely so the UI can show a readable name for anyone
    referenced as a meeting organizer, even outside the viewer's own team."""
    return [
        {"email": u.email, "name": u.name, "title": u.title}
        for u in db.query(OrgUser).all()
    ]
