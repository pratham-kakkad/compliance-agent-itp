"""The scheduler pass (`tick`): keeps dynamic audiences current, then walks every
open required obligation and fires the escalation rules it has reached.

Rules are data on the compliance (and frozen per version), not code. A rule is
`trigger -> actions`. Each (obligation, rule, action) fires at most once: the
unique key on `escalation_log` makes a retry, a restart or a second worker safe.
"""
import logging
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.compliance import audit, catalog, engine
from app.compliance.models import Compliance, EscalationLog, Obligation
from app.compliance.notify import notify, obligation_link
from app.compliance.policy import management_chain
from app.models import OrgUser

log = logging.getLogger("app.compliance")


def _reached(trigger: dict, ob: Obligation, now: datetime) -> bool:
    days = timedelta(days=int(trigger.get("days", 0)))
    t = trigger["type"]
    if t in ("before_due", "on_due", "after_due"):
        if ob.due_at is None:
            return False
        if t == "before_due":
            return ob.due_at - days <= now < ob.due_at  # a reminder that would arrive after the deadline is pointless
        if t == "on_due":
            return now >= ob.due_at
        return now >= ob.due_at + days
    if t == "rejected":
        return ob.status == "rejected" and now >= ob.updated_at + days
    if t == "review_pending":
        return ob.status in ("submitted", "under_review") and ob.submitted_at is not None and now >= ob.submitted_at + days
    return False


def _fire(db: Session, ob: Obligation, c: Compliance, rule: dict, idx: int, action: dict, now: datetime) -> bool:
    """Record and perform one action. Returns False if it had already fired."""
    entry = EscalationLog(obligation_id=ob.id, rule_id=rule["id"], action_idx=idx, action=action["type"])
    try:
        with db.begin_nested():
            db.add(entry)
            db.flush()
    except IntegrityError:
        return False

    person = db.get(OrgUser, ob.user_email)
    who = person.name if person else ob.user_email
    when = ob.due_at.date().isoformat() if ob.due_at else "no deadline"
    late = ob.due_at is not None and now > ob.due_at
    status_line = f"{c.name} was due {when}" if late else f"{c.name} is due {when}"
    link = obligation_link(ob.id)
    kind = action["type"]

    if kind == "notify_assignee":
        notify(db, ob.user_email, "reminder", ("Overdue: " if late else "Reminder: ") + c.name, status_line, link, ob.id)
    elif kind == "notify_manager":
        chain = management_chain(db, ob.user_email, limit=1)
        if chain:
            notify(db, chain[0], "escalation", f"{who} has not completed: {c.name}", status_line, link, ob.id)
        else:
            entry.result = "no manager"
    elif kind == "notify_manager_chain":
        chain = management_chain(db, ob.user_email, limit=int(action.get("levels", 2)))
        for m in chain:
            notify(db, m, "escalation", f"{who} has not completed: {c.name}", status_line, link, ob.id)
        if not chain:
            entry.result = "no manager"
    elif kind == "notify_users":
        for e in action.get("emails", []):
            if db.get(OrgUser, e) is not None:
                notify(db, e, "escalation", f"{who} has not completed: {c.name}", status_line, link, ob.id)
    elif kind == "notify_reviewers":
        for r in engine.reviewers_for(db, ob, engine.settings_of(db, ob)):
            notify(db, r, "review_overdue", f"Review waiting: {c.name}", f"{who}'s submission is still waiting for a decision.", link, ob.id)
    elif kind == "mark_non_compliant":
        if engine._mark_non_compliant(db, ob, audit.SYSTEM, f"Rule '{rule['name']}'"):
            notify(db, ob.user_email, "non_compliant", f"Non-compliant: {c.name}", status_line, link, ob.id)
    elif kind == "flag_defaulter":
        if not ob.defaulter_flag:
            ob.defaulter_flag = True
            audit.record(db, audit.SYSTEM, "obligation.defaulter_flagged", "obligation", ob.id, meta={"rule": rule["id"]})
    audit.record(db, audit.SYSTEM, "escalation.fired", "obligation", ob.id, meta={"rule": rule["id"], "action": kind})
    return True


def tick(db: Session, at: datetime | None = None) -> dict:
    """One pass. Safe to run any number of times, from any number of workers."""
    at = at or engine.now()
    summary = {"resynced": 0, "fired": 0, "obligations_checked": 0}

    for c in db.scalars(select(Compliance).where(Compliance.status == "published", Compliance.dynamic_audience.is_(True))):
        r = engine.resync_audience(db, None, c)
        if r["added"] or r["cancelled"]:
            summary["resynced"] += 1

    rows = db.execute(
        select(Obligation, Compliance)
        .join(Compliance, Compliance.id == Obligation.compliance_id)
        .where(
            Compliance.status == "published",
            Obligation.participation == "required",
            Obligation.status.in_(catalog.OPEN),
        )
    ).all()
    for ob, c in rows:
        summary["obligations_checked"] += 1
        rules = engine.settings_of(db, ob).get("escalation_rules", [])
        for rule in rules:
            if not _reached(rule["trigger"], ob, at):
                continue
            for idx, action in enumerate(rule["actions"]):
                if _fire(db, ob, c, rule, idx, action, at):
                    summary["fired"] += 1
    db.flush()
    return summary


def run_and_commit(db: Session) -> dict:
    try:
        result = tick(db)
        db.commit()
        return result
    except Exception:
        db.rollback()
        log.exception("Compliance tick failed")
        raise
