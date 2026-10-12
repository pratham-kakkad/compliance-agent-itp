"""Tables owned by the compliance engine. Users stay in `org_users` (email is the
natural key everywhere); this module adds departments, teams, roles and the
compliance entities themselves."""
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    DDL,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    event,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def _created() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now())


# --------------------------------------------------------------------- org


class Department(Base):
    __tablename__ = "departments"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    created_at: Mapped[datetime] = _created()


class Team(Base):
    __tablename__ = "teams"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    department_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("departments.id", ondelete="SET NULL"))
    lead_email: Mapped[str | None] = mapped_column(ForeignKey("org_users.email", ondelete="SET NULL"))
    created_at: Mapped[datetime] = _created()

    members: Mapped[list["TeamMember"]] = relationship(cascade="all, delete-orphan")


class TeamMember(Base):
    __tablename__ = "team_members"

    team_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), primary_key=True)
    user_email: Mapped[str] = mapped_column(ForeignKey("org_users.email", ondelete="CASCADE"), primary_key=True)


# ------------------------------------------------------------------ access


class Role(Base):
    __tablename__ = "roles"

    id: Mapped[uuid.UUID] = _uuid_pk()
    key: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # A super role bypasses every permission and record rule.
    is_super: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # "all" | "managers" | None: roles people hold implicitly.
    auto_assign: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = _created()

    grants: Mapped[list["RolePermission"]] = relationship(cascade="all, delete-orphan", back_populates="role")


class RolePermission(Base):
    __tablename__ = "role_permissions"
    __table_args__ = (UniqueConstraint("role_id", "resource", "action"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    role_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("roles.id", ondelete="CASCADE"), nullable=False)
    resource: Mapped[str] = mapped_column(String, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)
    scope: Mapped[str] = mapped_column(String, nullable=False, default="self")

    role: Mapped[Role] = relationship(back_populates="grants")


class UserRole(Base):
    __tablename__ = "user_roles"

    user_email: Mapped[str] = mapped_column(ForeignKey("org_users.email", ondelete="CASCADE"), primary_key=True)
    role_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True)


class UserPermissionOverride(Base):
    """A per-person exception to their roles. A deny always beats any allow."""

    __tablename__ = "user_permission_overrides"
    __table_args__ = (UniqueConstraint("user_email", "resource", "action"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_email: Mapped[str] = mapped_column(ForeignKey("org_users.email", ondelete="CASCADE"), nullable=False)
    resource: Mapped[str] = mapped_column(String, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)
    effect: Mapped[str] = mapped_column(String, nullable=False)  # allow | deny
    scope: Mapped[str | None] = mapped_column(String)  # for allow
    created_at: Mapped[datetime] = _created()


class RecordRule(Base):
    """Row-level rule on top of scopes. `allow` rules widen what a person can
    see (OR); `restrictive` rules narrow it for everyone they apply to (AND).
    `condition` is a small structured document, never SQL (see policy.py)."""

    __tablename__ = "record_rules"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String, nullable=False)
    resource: Mapped[str] = mapped_column(String, nullable=False)  # compliance | obligation
    kind: Mapped[str] = mapped_column(String, nullable=False)  # allow | restrictive
    role_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("roles.id", ondelete="CASCADE"))
    condition: Mapped[Any] = mapped_column(JSONB, nullable=False, default=dict)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = _created()


# -------------------------------------------------------------- compliance


class ComplianceType(Base):
    __tablename__ = "compliance_types"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    evidence_defaults: Mapped[Any] = mapped_column(JSONB, nullable=False, default=list)
    review_default: Mapped[str] = mapped_column(String, nullable=False, default="manager")
    escalation_default: Mapped[str] = mapped_column(String, nullable=False, default="standard")
    # Optional automatic verifier (see verifiers.py); None = proof is submitted by hand.
    verifier_key: Mapped[str | None] = mapped_column(String)
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class Compliance(Base):
    __tablename__ = "compliances"

    id: Mapped[uuid.UUID] = _uuid_pk()
    type_key: Mapped[str] = mapped_column(ForeignKey("compliance_types.key"), nullable=False, default="general")
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    category: Mapped[str] = mapped_column(String, nullable=False, default="General")
    action_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    priority: Mapped[str] = mapped_column(String, nullable=False, default="medium")
    status: Mapped[str] = mapped_column(String, nullable=False, default="draft")
    start_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completion_policy: Mapped[str] = mapped_column(String, nullable=False, default="all")
    completion_param: Mapped[int | None] = mapped_column(Integer)
    review_mode: Mapped[str] = mapped_column(String, nullable=False, default="manager")
    reviewer_email: Mapped[str | None] = mapped_column(ForeignKey("org_users.email", ondelete="SET NULL"))
    max_resubmissions: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    dynamic_audience: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    evidence_requirements: Mapped[Any] = mapped_column(JSONB, nullable=False, default=list)
    escalation_rules: Mapped[Any] = mapped_column(JSONB, nullable=False, default=list)
    current_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow, server_default=func.now()
    )
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    audience: Mapped[list["AudienceRule"]] = relationship(cascade="all, delete-orphan", back_populates="compliance")

    __table_args__ = (Index("ix_compliances_status", "status"),)


class ComplianceVersion(Base):
    """The settings an obligation was assigned under. Editing a published
    compliance makes a new version; existing obligations keep the old one."""

    __tablename__ = "compliance_versions"
    __table_args__ = (UniqueConstraint("compliance_id", "version"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    compliance_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("compliances.id", ondelete="CASCADE"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    snapshot: Mapped[Any] = mapped_column(JSONB, nullable=False)
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = _created()


class AudienceRule(Base):
    __tablename__ = "audience_rules"

    id: Mapped[uuid.UUID] = _uuid_pk()
    compliance_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("compliances.id", ondelete="CASCADE"), nullable=False)
    selector_type: Mapped[str] = mapped_column(String, nullable=False)
    selector_ref: Mapped[str | None] = mapped_column(String)
    effect: Mapped[str] = mapped_column(String, nullable=False, default="include")  # include | exclude
    participation: Mapped[str] = mapped_column(String, nullable=False, default="required")

    compliance: Mapped[Compliance] = relationship(back_populates="audience")


class Obligation(Base):
    __tablename__ = "obligations"
    __table_args__ = (
        UniqueConstraint("compliance_id", "user_email"),
        Index("ix_obligations_user_status_due", "user_email", "status", "due_at"),
        Index("ix_obligations_compliance_status", "compliance_id", "status"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    compliance_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("compliances.id", ondelete="CASCADE"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    user_email: Mapped[str] = mapped_column(ForeignKey("org_users.email", ondelete="CASCADE"), nullable=False)
    participation: Mapped[str] = mapped_column(String, nullable=False, default="required")
    status: Mapped[str] = mapped_column(String, nullable=False, default="not_started")
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    due_overridden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Why this person got it: the audience rule(s) that matched.
    assigned_via: Mapped[Any] = mapped_column(JSONB, nullable=False, default=list)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    non_compliant_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    defaulter_flag: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    resubmissions: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status_reason: Mapped[str | None] = mapped_column(Text)
    status_by: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow, server_default=func.now()
    )

    compliance: Mapped[Compliance] = relationship()
    submissions: Mapped[list["Submission"]] = relationship(
        cascade="all, delete-orphan", order_by="Submission.version_no"
    )


class Submission(Base):
    __tablename__ = "submissions"
    __table_args__ = (UniqueConstraint("obligation_id", "version_no"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    obligation_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("obligations.id", ondelete="CASCADE"), nullable=False)
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default="submitted")  # submitted|under_review|approved|rejected
    submitted_by: Mapped[str] = mapped_column(String, nullable=False)
    submitted_at: Mapped[datetime] = _created()
    late: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    items: Mapped[list["EvidenceItem"]] = relationship(cascade="all, delete-orphan")
    decisions: Mapped[list["ReviewDecision"]] = relationship(
        cascade="all, delete-orphan", order_by="ReviewDecision.decided_at"
    )


class EvidenceFile(Base):
    __tablename__ = "evidence_files"

    id: Mapped[uuid.UUID] = _uuid_pk()
    original_name: Mapped[str] = mapped_column(String, nullable=False)
    storage_key: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    mime: Mapped[str] = mapped_column(String, nullable=False)
    sha256: Mapped[str] = mapped_column(String, nullable=False, index=True)
    uploaded_by: Mapped[str] = mapped_column(String, nullable=False)
    uploaded_at: Mapped[datetime] = _created()
    # not_scanned | clean | infected. No scanner is wired in yet (see evidence.py).
    scan_status: Mapped[str] = mapped_column(String, nullable=False, default="not_scanned")


class EvidenceItem(Base):
    __tablename__ = "evidence_items"

    id: Mapped[uuid.UUID] = _uuid_pk()
    submission_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("submissions.id", ondelete="CASCADE"), nullable=False)
    requirement_key: Mapped[str] = mapped_column(String, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    text_value: Mapped[str | None] = mapped_column(Text)
    bool_value: Mapped[bool | None] = mapped_column(Boolean)
    file_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("evidence_files.id"))

    file: Mapped[EvidenceFile | None] = relationship()


class ReviewDecision(Base):
    __tablename__ = "review_decisions"

    id: Mapped[uuid.UUID] = _uuid_pk()
    submission_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("submissions.id", ondelete="CASCADE"), nullable=False)
    reviewer_email: Mapped[str] = mapped_column(String, nullable=False)
    decision: Mapped[str] = mapped_column(String, nullable=False)  # approved | rejected
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    decided_at: Mapped[datetime] = _created()


class EscalationLog(Base):
    """One row per action fired, so the scheduler is idempotent: the unique key
    means a retry or a second worker can never send the same thing twice."""

    __tablename__ = "escalation_log"
    __table_args__ = (UniqueConstraint("obligation_id", "rule_id", "action_idx"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    obligation_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("obligations.id", ondelete="CASCADE"), nullable=False)
    rule_id: Mapped[str] = mapped_column(String, nullable=False)
    action_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)
    fired_at: Mapped[datetime] = _created()
    result: Mapped[str] = mapped_column(String, nullable=False, default="ok")


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notifications_user_read", "user_email", "read_at"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_email: Mapped[str] = mapped_column(ForeignKey("org_users.email", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    link: Mapped[str | None] = mapped_column(String)
    obligation_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("obligations.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = _created()
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Email is not delivered yet: "pending" rows are what an SMTP/Graph sender would pick up.
    email_status: Mapped[str] = mapped_column(String, nullable=False, default="pending")
    # Set by app/compliance/notify.py deliver_pending: pending -> sent | failed | skipped.
    email_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    email_error: Mapped[str | None] = mapped_column(Text)
    email_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))


class AuditEvent(Base):
    """Append-only. A database trigger rejects UPDATE and DELETE, and each row
    carries a hash of the previous one so tampering is detectable."""

    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_entity", "entity_type", "entity_id"),
        Index("ix_audit_actor", "actor_email"),
        Index("ix_audit_at", "at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = _created()
    actor_email: Mapped[str] = mapped_column(String, nullable=False)  # or "system"
    action: Mapped[str] = mapped_column(String, nullable=False)
    entity_type: Mapped[str] = mapped_column(String, nullable=False)
    entity_id: Mapped[str] = mapped_column(String, nullable=False)
    before: Mapped[Any | None] = mapped_column(JSONB)
    after: Mapped[Any | None] = mapped_column(JSONB)
    meta: Mapped[Any | None] = mapped_column(JSONB)
    prev_hash: Mapped[str] = mapped_column(String, nullable=False, default="")
    hash: Mapped[str] = mapped_column(String, nullable=False, default="")


AUDIT_IMMUTABLE_DDL = [
    """
    CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
    BEGIN
        RAISE EXCEPTION 'audit_events is append-only';
    END;
    $$ LANGUAGE plpgsql
    """,
    "DROP TRIGGER IF EXISTS audit_events_no_change ON audit_events",
    """
    CREATE TRIGGER audit_events_no_change BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_immutable()
    """,
]

for _stmt in AUDIT_IMMUTABLE_DDL:
    event.listen(AuditEvent.__table__, "after_create", DDL(_stmt))


# ----------------------------------------------------------- e-mail templates


class EmailTemplate(Base):
    """A reusable message a reviewer / manager / admin can send about someone's
    compliance. Plain text with {{variables}} (see app/compliance/messaging.py).
    System templates (is_system) are seeded, editable and can be reset, never deleted."""

    __tablename__ = "email_templates"

    id: Mapped[uuid.UUID] = _uuid_pk()
    key: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # reminder | warning | final | request | thanks | custom
    kind: Mapped[str] = mapped_column(String, nullable=False, default="custom")
    subject: Mapped[str] = mapped_column(String, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_by: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow, server_default=func.now()
    )


class SentEmail(Base):
    """One row per recipient of a manual compliance e-mail (a batch shares batch_id).
    subject and body are the final, rendered text. Rows are written when the batch
    is queued (status "queued") and updated as each message is handled:
    queued -> sent | failed | skipped."""

    __tablename__ = "sent_emails"
    __table_args__ = (
        Index("ix_sent_emails_batch", "batch_id"),
        Index("ix_sent_emails_recipient", "recipient_email", "created_at"),
        Index("ix_sent_emails_sender", "sent_by", "created_at"),
        Index("ix_sent_emails_obligation", "obligation_id"),
        Index("ix_sent_emails_compliance", "compliance_id"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    batch_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    sent_by: Mapped[str] = mapped_column(String, nullable=False)
    recipient_email: Mapped[str] = mapped_column(String, nullable=False)
    recipient_name: Mapped[str] = mapped_column(String, nullable=False, default="")
    template_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("email_templates.id", ondelete="SET NULL"))
    template_name: Mapped[str] = mapped_column(String, nullable=False, default="")
    subject: Mapped[str] = mapped_column(String, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    obligation_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("obligations.id", ondelete="SET NULL"))
    compliance_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("compliances.id", ondelete="SET NULL"))
    # kind, link, cc, options and where the recipients came from (team / department / filters)
    context: Mapped[Any] = mapped_column(JSONB, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(String, nullable=False, default="queued")
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()
