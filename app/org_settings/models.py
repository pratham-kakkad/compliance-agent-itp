"""Tables owned by the organization settings module."""
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class AppSetting(Base):
    """One row per organization-wide setting, keyed by name, with a JSON
    value so new settings need no migration. Only settings someone has
    actually saved have a row; everything else falls back to its default
    (see app/org_settings/service.py)."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[Any] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now()
    )
    updated_by: Mapped[str | None] = mapped_column(String, nullable=True)
