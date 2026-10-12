"""Dashboard endpoints. All take ?days=7|30|90 (the period; the comparison is the equal period
before it) and need a login. Scoping: meetings follow the reporting line (as GET /dashboard),
compliance follows the viewer's permissions (app/compliance/policy.py), biometric attendance is
organization-wide like the rest of the Attendance API."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.compliance.policy import Ctx, get_ctx
from app.dashboards import biometric_kpis, compliance_kpis, meetings_kpis, overview
from app.dashboards.common import ALLOWED_DAYS, utcnow
from app.database import get_db
from app.models import OrgUser

router = APIRouter(prefix="/dashboards", tags=["dashboards"])


def _days(days: int = Query(30, description="Period length in days: 7, 30 or 90")) -> int:
    if days not in ALLOWED_DAYS:
        raise HTTPException(status_code=422, detail=f"days must be one of {list(ALLOWED_DAYS)}")
    return days


@router.get("/overview")
def overview_dashboard(days: int = Depends(_days), db: Session = Depends(get_db), user: OrgUser = Depends(get_current_user)):
    return overview.build(db, user, days, utcnow())


@router.get("/meetings")
def meetings_dashboard(days: int = Depends(_days), db: Session = Depends(get_db), user: OrgUser = Depends(get_current_user)):
    return meetings_kpis.build(db, user, days, utcnow())


@router.get("/biometric")
def biometric_dashboard(days: int = Depends(_days), db: Session = Depends(get_db), _user: OrgUser = Depends(get_current_user)):
    return biometric_kpis.build(db, days, utcnow())


@router.get("/compliance")
def compliance_dashboard(days: int = Depends(_days), ctx: Ctx = Depends(get_ctx)):
    ctx.require("dashboard", "view")
    return compliance_kpis.build(ctx.db, ctx, days, utcnow())
