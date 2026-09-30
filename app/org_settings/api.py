"""Settings page API. Every endpoint needs a login; there are no roles yet,
so anyone logged in can change settings (the same people who can import
punch logs)."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models import OrgUser
from app.org_settings import service

router = APIRouter(prefix="/settings", tags=["settings"])


class SettingsUpdate(BaseModel):
    """Partial update: omitted or null fields are left as they are."""

    timezone: str | None = None


@router.get("")
def read_settings(db: Session = Depends(get_db), _user: OrgUser = Depends(get_current_user)):
    return service.get_settings(db)


@router.put("")
def update_settings(
    body: SettingsUpdate,
    db: Session = Depends(get_db),
    user: OrgUser = Depends(get_current_user),
):
    if body.timezone is None:
        return {**service.get_settings(db), "changed": False, "recomputed_days": 0}
    try:
        name = service.validate_timezone(body.timezone)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return service.set_timezone(db, name, updated_by=user.email)


@router.get("/timezones")
def list_timezones(_user: OrgUser = Depends(get_current_user)):
    return {"timezones": service.list_timezones(), "default": service.default_timezone_name()}
