from datetime import date

from fastapi import APIRouter, Depends, Form, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session

from app.attendance import analytics
from app.attendance.importer import import_punch_log
from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models import OrgUser
from app.org_settings.service import get_timezone_name, validate_timezone

router = APIRouter(prefix="/attendance", tags=["attendance"])


@router.post("/import")
async def import_punches(
    file: UploadFile,
    # The IANA zone the file's times are in (multipart field "timezone");
    # empty = the organization zone.
    timezone: str | None = Form(default=None),
    db: Session = Depends(get_db),
    user: OrgUser = Depends(get_current_user),
):
    if not file.filename or not file.filename.lower().endswith((".csv", ".xlsx", ".xlsm")):
        raise HTTPException(status_code=400, detail="Upload a .csv or .xlsx punch-log export")
    source_timezone = None
    if timezone is not None and timezone.strip():
        try:
            source_timezone = validate_timezone(timezone)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    raw = await file.read()
    result = import_punch_log(db, file.filename, raw, imported_by=user.email, source_timezone=source_timezone)
    if result.batch_id:
        # New punches -> the assistant's search index is stale. Imported here
        # rather than at module top so the Attendance agent doesn't depend on
        # the chat module at import time.
        from app.chat.attendance_index import attendance_index

        attendance_index.invalidate()
    return {
        "batch_id": result.batch_id,
        "row_count": result.row_count,
        "accepted": result.accepted,
        "employees_affected": result.employees_affected,
        "rejected": [{"row": r.row_number, "reason": r.reason} for r in result.rejected],
        "source_timezone": result.source_timezone,
        # The organization zone the punches were assigned to days in (read
        # under the import's zone lock, so it's the zone actually used).
        "timezone": result.timezone or get_timezone_name(db),
    }


@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db), _user: OrgUser = Depends(get_current_user)):
    return {
        "summary": analytics.overall_summary(db),
        "trend": analytics.attendance_trend(db),
        "by_department": analytics.department_breakdown(db),
        "insights": analytics.insights(db),
    }


@router.get("")
def list_employees(
    # Repeat a param (?department=A&department=B) or comma-separate it for "any of".
    company: list[str] | None = Query(default=None),
    department: list[str] | None = Query(default=None),
    search: str | None = None,
    days_min: int | None = Query(default=None, ge=0),
    days_max: int | None = Query(default=None, ge=0),
    last_seen_from: date | None = None,
    last_seen_to: date | None = None,
    not_seen_days: int | None = Query(default=None, ge=1, le=3650),
    present_latest: bool | None = None,
    rate_min: float | None = Query(default=None, ge=0, le=1),
    rate_max: float | None = Query(default=None, ge=0, le=1),
    sort: str | None = Query(default=None, pattern="^(name|company|department|days|last_seen|rate)$"),
    dir: str = Query(default="asc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_db),
    _user: OrgUser = Depends(get_current_user),
):
    return {
        "items": analytics.employee_list(
            db,
            company,
            department,
            search,
            days_min=days_min,
            days_max=days_max,
            last_seen_from=last_seen_from,
            last_seen_to=last_seen_to,
            not_seen_days=not_seen_days,
            present_latest=present_latest,
            rate_min=rate_min,
            rate_max=rate_max,
            sort=sort,
            direction=dir,
        )
    }


@router.get("/{emp_code}")
def employee_detail(
    emp_code: str, db: Session = Depends(get_db), _user: OrgUser = Depends(get_current_user)
):
    detail = analytics.employee_detail(db, emp_code)
    if detail is None:
        raise HTTPException(status_code=404, detail="No such employee")
    return detail
