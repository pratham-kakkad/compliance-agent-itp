import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint, text
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
    # True for the fixed demo accounts (app/directory.py). Demo accounts are
    # always backed by the static seeded dataset and are the only accounts
    # dev-login will accept; real accounts (created by an actual Microsoft
    # login) are the only ones the Graph sync loop ever touches.
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Compliance engine (app/compliance/): the person's department, and whether
    # they can sign in / be assigned compliance. Deactivating keeps all history.
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL"), nullable=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, server_default=text("true"))

    # Local sign-in (app/auth/passwords.py, app/api/auth.py). Optional: Microsoft
    # and demo sign-in don't need any of these. Matching is by e-mail, so an
    # account created here keeps working if Microsoft sign-in is added later.
    password_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    password_set_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # One outstanding one-time token at a time (an invite or a password reset);
    # only its SHA-256 is stored. invite_purpose is "invite" or "reset".
    invite_token_hash: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    invite_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    invite_purpose: Mapped[str | None] = mapped_column(String, nullable=True)
    invited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0, nullable=False, server_default=text("0"))
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


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
