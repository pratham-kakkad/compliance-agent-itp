from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import access, analytics
from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models import OrgUser

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("")
def dashboard(db: Session = Depends(get_db), user: OrgUser = Depends(get_current_user)):
    reports = access.all_reports(db, user.email)
    report_emails = [r.email for r in reports]
    visible = [user.email] + report_emails

    my_summary = analytics.person_attendance_summary(db, user.email)

    payload = {
        "me": {
            "email": user.email,
            "name": user.name,
            "attendance_rate": my_summary["attendance_rate"],
            "required_total": my_summary["required_total"],
            "required_attended": my_summary["required_attended"],
        },
        "has_reports": bool(report_emails),
        "direct_report_count": len(access.direct_reports(db, user.email)),
        "total_report_count": len(report_emails),
        "trend": analytics.attendance_trend(db, visible),
        "top_concern_series": analytics.top_concern_series(db, visible, limit=5),
        "top_members_to_focus": (
            analytics.top_members_to_focus(db, report_emails, limit=5) if report_emails else []
        ),
        "team": analytics.team_attendance_rate(db, report_emails) if report_emails else None,
    }
    return payload
