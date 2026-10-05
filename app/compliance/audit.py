"""The audit trail: who did what, when, to which record, with before/after.

Rows are written in the same transaction as the change they describe, so there
is never a change without a record. The table rejects UPDATE/DELETE (trigger in
models.py) and every row stores a hash chained to the previous one, so
`verify_chain` can show whether history was altered behind the application's back.
"""
import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.compliance.models import AuditEvent

SYSTEM = "system"
_LOCK_KEY = 7283461


def clean(value: Any) -> Any:
    """JSON-safe copy (datetimes, UUIDs and sets become strings / lists)."""
    return json.loads(json.dumps(value, default=lambda o: sorted(o) if isinstance(o, (set, frozenset)) else str(o)))


def _digest(prev: str, at: datetime, actor: str, action: str, etype: str, eid: str, before, after, meta) -> str:
    payload = json.dumps(
        [prev, at.astimezone(timezone.utc).isoformat(), actor, action, etype, eid, before, after, meta],
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def record(
    db: Session,
    actor: str | None,
    action: str,
    entity_type: str,
    entity_id: Any,
    before: Any = None,
    after: Any = None,
    meta: Any = None,
) -> AuditEvent:
    actor = actor or SYSTEM
    # One writer at a time per transaction keeps the chain in id order.
    db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _LOCK_KEY})
    prev = db.scalar(select(AuditEvent.hash).order_by(AuditEvent.id.desc()).limit(1)) or ""
    at = datetime.now(timezone.utc)
    before, after, meta = clean(before), clean(after), clean(meta)
    ev = AuditEvent(
        at=at,
        actor_email=actor,
        action=action,
        entity_type=entity_type,
        entity_id=str(entity_id),
        before=before,
        after=after,
        meta=meta,
        prev_hash=prev,
        hash=_digest(prev, at, actor, action, entity_type, str(entity_id), before, after, meta),
    )
    db.add(ev)
    db.flush()
    return ev


def verify_chain(db: Session, limit: int = 100_000) -> dict:
    prev = ""
    checked = 0
    for ev in db.scalars(select(AuditEvent).order_by(AuditEvent.id).limit(limit)):
        expected = _digest(
            prev, ev.at, ev.actor_email, ev.action, ev.entity_type, ev.entity_id, ev.before, ev.after, ev.meta
        )
        if ev.prev_hash != prev or ev.hash != expected:
            return {"ok": False, "checked": checked, "first_bad_id": ev.id}
        prev = ev.hash
        checked += 1
    return {"ok": True, "checked": checked, "first_bad_id": None}
