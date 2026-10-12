"""Work hours: when the working day starts and ends, and how many minutes of
grace a late arrival / early exit gets. They decide which biometric days count
as a late arrival or an early exit (app/dashboards/biometric_kpis.py).

Stored in the generic app_settings table under their own keys, so no
migration is needed. Until someone saves them, DEFAULTS apply ("saved" is
false in the response, so the UI can say the numbers use the default).
Times are wall-clock times in the organization time zone.
"""
from datetime import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models import OrgUser
from app.org_settings.models import AppSetting
from app.org_settings.service import _upsert

START_KEY = "work_start"
END_KEY = "work_end"
GRACE_KEY = "work_grace_minutes"
DEFAULTS = {"work_start": "09:00", "work_end": "18:00", "grace_minutes": 15}

router = APIRouter(prefix="/settings/work-hours", tags=["settings"])


def parse_hhmm(value: str) -> time:
    """'09:30' -> time(9, 30); ValueError (with a message for people) otherwise."""
    try:
        hh, mm = str(value).strip().split(":")
        out = time(int(hh), int(mm))
    except (ValueError, TypeError):
        raise ValueError(f"'{value}' is not a time like 09:30")
    return out


def _fmt(t: time) -> str:
    return f"{t.hour:02d}:{t.minute:02d}"


def get_work_hours(db: Session) -> dict:
    """{"work_start": "09:00", "work_end": "18:00", "grace_minutes": 15, "saved": bool}."""
    rows = {k: db.get(AppSetting, k) for k in (START_KEY, END_KEY, GRACE_KEY)}
    out = dict(DEFAULTS)
    saved = False
    try:
        if rows[START_KEY] is not None:
            out["work_start"] = _fmt(parse_hhmm(rows[START_KEY].value))
            saved = True
        if rows[END_KEY] is not None:
            out["work_end"] = _fmt(parse_hhmm(rows[END_KEY].value))
            saved = True
        if rows[GRACE_KEY] is not None:
            out["grace_minutes"] = max(0, min(120, int(rows[GRACE_KEY].value)))
            saved = True
    except (ValueError, TypeError):
        out, saved = dict(DEFAULTS), False  # an unusable saved value: fall back to the defaults
    out["saved"] = saved
    return out


class WorkHoursUpdate(BaseModel):
    work_start: str
    work_end: str
    grace_minutes: int = DEFAULTS["grace_minutes"]


@router.get("")
def read_work_hours(db: Session = Depends(get_db), _user: OrgUser = Depends(get_current_user)):
    return get_work_hours(db)


@router.put("")
def update_work_hours(body: WorkHoursUpdate, db: Session = Depends(get_db), user: OrgUser = Depends(get_current_user)):
    try:
        start, end = parse_hhmm(body.work_start), parse_hhmm(body.work_end)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if end <= start:
        raise HTTPException(status_code=422, detail="The working day must end after it starts")
    if not 0 <= body.grace_minutes <= 120:
        raise HTTPException(status_code=422, detail="Grace must be between 0 and 120 minutes")
    _upsert(db, START_KEY, _fmt(start), user.email)
    _upsert(db, END_KEY, _fmt(end), user.email)
    _upsert(db, GRACE_KEY, body.grace_minutes, user.email)
    db.commit()
    return get_work_hours(db)
