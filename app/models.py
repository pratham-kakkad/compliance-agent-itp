import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class OrgUser(Base):
    """Stub org directory. Stands in for real HRIS/Azure AD group data until
    a real directory sync exists — email is the natural key everywhere else
    in this schema, so swapping this out later doesn't touch other tables."""

    __tablename__ = "org_users"

    email: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    manager_email: Mapped[str | None] = mapped_column(
        ForeignKey("org_users.email"), nullable=True
    )


class MeetingSeries(Base):
    """One recurring or one-off meeting. A single occurrence is still a
    series of length one — there is no separate "single meeting" table."""

    __tablename__ = "meeting_series"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    external_id: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    organizer_email: Mapped[str] = mapped_column(ForeignKey("org_users.email"), nullable=False)
    recurrence: Mapped[str] = mapped_column(String, nullable=False)  # "once" | "daily" | "weekly"
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    occurrences: Mapped[list["MeetingOccurrence"]] = relationship(
        back_populates="series", cascade="all, delete-orphan"
    )


class MeetingOccurrence(Base):
    __tablename__ = "meeting_occurrences"
    __table_args__ = (UniqueConstraint("series_id", "external_occurrence_id"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    series_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("meeting_series.id"), nullable=False)
    external_occurrence_id: Mapped[str] = mapped_column(String, nullable=False)
    start_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    end_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    series: Mapped["MeetingSeries"] = relationship(back_populates="occurrences")
    attendances: Mapped[list["Attendance"]] = relationship(
        back_populates="occurrence", cascade="all, delete-orphan"
    )


class Attendance(Base):
    """One expected-attendee row per occurrence. `required=False` rows are
    informational only — the whole point of this table is that an absent
    optional invitee is never treated as a compliance problem anywhere
    upstream (dashboard counts, "top concerns", org-chart pie charts all
    filter on `required` before counting an absence against anyone)."""

    __tablename__ = "attendances"
    __table_args__ = (UniqueConstraint("occurrence_id", "attendee_email"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    occurrence_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("meeting_occurrences.id"), nullable=False
    )
    attendee_email: Mapped[str] = mapped_column(ForeignKey("org_users.email"), nullable=False)
    required: Mapped[bool] = mapped_column(Boolean, default=True)
    attended: Mapped[bool] = mapped_column(Boolean, default=False)
    joined_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    left_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    occurrence: Mapped["MeetingOccurrence"] = relationship(back_populates="attendances")
