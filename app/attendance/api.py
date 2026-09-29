from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.attendance import analytics
from app.attendance.importer import import_punch_log
from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models import OrgUser

router = APIRouter(prefix="/attendance", tags=["attendance"])


@router.post("/import")
async def import_punches(
    file: UploadFile,
    db: Session = Depends(get_db),
    user: OrgUser = Depends(get_current_user),
):
    if not file.filename or not file.filename.lower().endswith((".csv", ".xlsx", ".xlsm")):
        raise HTTPException(status_code=400, detail="Upload a .csv or .xlsx punch-log export")

    raw = await file.read()
    result = import_punch_log(db, file.filename, raw, imported_by=user.email)
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
    }


@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db), _user: OrgUser = Depends(get_current_user)):
    return {
        "summary": analytics.overall_summary(db),
        "trend": analytics.attendance_trend(db),
        "by_department": analytics.department_breakdown(db),
    }


@router.get("")
def list_employees(
    company: str | None = None,
    department: str | None = None,
    search: str | None = None,
    db: Session = Depends(get_db),
    _user: OrgUser = Depends(get_current_user),
):
    return {"items": analytics.employee_list(db, company, department, search)}


@router.get("/{emp_code}")
def employee_detail(
    emp_code: str, db: Session = Depends(get_db), _user: OrgUser = Depends(get_current_user)
):
    detail = analytics.employee_detail(db, emp_code)
    if detail is None:
        raise HTTPException(status_code=404, detail="No such employee")
    return detail
