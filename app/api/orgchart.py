from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import access, analytics
from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models import OrgUser

router = APIRouter(prefix="/orgchart", tags=["orgchart"])


def _node(db: Session, person: OrgUser) -> dict:
    summary = analytics.person_attendance_summary(db, person.email)
    return {
        "email": person.email,
        "name": person.name,
        "title": person.title,
        "attendance_rate": summary["attendance_rate"],
        "required_total": summary["required_total"],
        "required_attended": summary["required_attended"],
        "children": [
            _node(db, child) for child in access.direct_reports(db, person.email)
        ],
    }


@router.get("")
def org_chart(db: Session = Depends(get_db), user: OrgUser = Depends(get_current_user)):
    """Tree rooted at the logged-in user — themself plus everyone reporting
    to them, directly or indirectly. Each node carries enough summary data
    for the hover card (pie chart + top meetings come from GET /people/{email})."""
    return _node(db, user)
