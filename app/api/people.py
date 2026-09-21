from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import access, analytics
from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models import OrgUser

router = APIRouter(prefix="/people", tags=["people"])


@router.get("")
def list_people(db: Session = Depends(get_db), user: OrgUser = Depends(get_current_user)):
    visible = access.visible_emails(db, user.email)
    people = [db.get(OrgUser, email) for email in visible]
    return [
        {
            "email": p.email,
            "name": p.name,
            "title": p.title,
            "manager_email": p.manager_email,
            "is_self": p.email == user.email,
            **{"attendance_rate": analytics.person_attendance_summary(db, p.email)["attendance_rate"]},
        }
        for p in people
        if p is not None
    ]


@router.get("/{email}")
def person_detail(email: str, db: Session = Depends(get_db), user: OrgUser = Depends(get_current_user)):
    if email not in access.visible_emails(db, user.email):
        raise HTTPException(status_code=403, detail="You can only view your own or your reports' data")
    person = db.get(OrgUser, email)
    if person is None:
        raise HTTPException(status_code=404, detail="No such person")
    summary = analytics.person_attendance_summary(db, email)
    reports = access.direct_reports(db, email)
    return {
        "email": person.email,
        "name": person.name,
        "title": person.title,
        "manager_email": person.manager_email,
        "direct_reports": [{"email": r.email, "name": r.name, "title": r.title} for r in reports],
        **summary,
    }
