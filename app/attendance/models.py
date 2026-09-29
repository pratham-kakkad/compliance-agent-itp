import uuid
from datetime import date as date_, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ImportBatch(Base):
    """One row per uploaded punch-log file. Kept even though there's no
    dedicated audit-log page yet — cheap to record now, useful once one
    exists, and gives the import endpoint something to point back to."""

    __tablename__ = "attendance_import_batches"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    filename: Mapped[str] = mapped_column(String, nullable=False)
    imported_by: Mapped[str] = mapped_column(String, nullable=False)
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    accepted_count: Mapped[int] = mapped_column(Integer, default=0)
    rejected_count: Mapped[int] = mapped_column(Integer, default=0)


class BiometricPunchLog(Base):
    """Raw staging table — one row per punch-log sheet row, landed as-is
    from import and never mutated."""

    __tablename__ = "biometric_punch_logs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    import_batch_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("attendance_import_batches.id"), nullable=True
    )
    log_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # Raw Entry/Exit marker from the device export — stored as-is, not used
    # for any in/out or duration logic in this pass.
    device: Mapped[str] = mapped_column(String, nullable=True)
    emp_code: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    company: Mapped[str] = mapped_column(String, nullable=True)
    department: Mapped[str] = mapped_column(String, nullable=True)
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class AttendanceEmployee(Base):
    """The biometric device's own employee roster — a separate identity
    system from OrgUser (device Emp Code, not a work email/Azure AD
    account). Upserted from the latest punch-log row seen for each Emp
    Code; not linked to org_users in this pass."""

    __tablename__ = "attendance_employees"

    emp_code: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    company: Mapped[str] = mapped_column(String, nullable=True)
    department: Mapped[str] = mapped_column(String, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    days: Mapped[list["AttendanceDay"]] = relationship(back_populates="employee", cascade="all, delete-orphan")


class AttendanceDay(Base):
    """One row per employee per calendar day that had at least one punch.
    Computed from BiometricPunchLog by app/attendance/rules.py — safe to
    recompute/overwrite for a given (emp_code, work_date), same upsert
    spirit as the Meetings agent's sync_occurrence.

    Plain presence tracking only: no in/out direction or duration logic,
    so a row here just means "this employee had activity on this day"."""

    __tablename__ = "attendance_days"
    __table_args__ = (UniqueConstraint("emp_code", "work_date"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    emp_code: Mapped[str] = mapped_column(ForeignKey("attendance_employees.emp_code"), nullable=False)
    work_date: Mapped[date_] = mapped_column(Date, nullable=False)
    first_punch: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_punch: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    punch_count: Mapped[int] = mapped_column(Integer, default=0)

    employee: Mapped["AttendanceEmployee"] = relationship(back_populates="days")
