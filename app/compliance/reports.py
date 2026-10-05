"""Dashboard numbers and the defaulter scoreboard. Both start from the viewer's
own row filter, so a manager's totals only ever describe their own people."""
from collections import defaultdict
from datetime import datetime, timedelta

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session

from app.compliance import catalog, engine
from app.compliance.models import (
    Compliance,
    Department,
    EscalationLog,
    Obligation,
    Submission,
    Team,
    TeamMember,
)
from app.compliance.policy import Ctx
from app.models import OrgUser

# Waived and cancelled people are out of every percentage.
_COUNTED = Obligation.status.not_in(("waived", "cancelled"))


def _pct(done: int, total: int) -> int:
    return round(100 * done / total) if total else 0


def dashboard(db: Session, ctx: Ctx) -> dict:
    now = engine.now()
    scope = ctx.obligation_clause("submission", "view")
    req = and_(scope, Obligation.participation == "required")

    status_counts = dict(
        db.execute(select(Obligation.status, func.count()).where(req).group_by(Obligation.status)).all()
    )
    counted = sum(n for s, n in status_counts.items() if s not in ("waived", "cancelled"))
    completed = status_counts.get("completed", 0)
    in_review = status_counts.get("submitted", 0) + status_counts.get("under_review", 0)
    pending = sum(status_counts.get(s, 0) for s in ("not_started", "in_progress", "rejected"))
    overdue = db.scalar(
        select(func.count()).where(req, Obligation.status.in_(catalog.OPEN), Obligation.due_at.is_not(None), Obligation.due_at < now)
    )
    non_compliant = db.scalar(
        select(func.count()).where(req, Obligation.non_compliant_at.is_not(None), Obligation.status.not_in(("completed", "waived", "cancelled")))
    )
    non_compliant_users = db.scalar(
        select(func.count(func.distinct(Obligation.user_email))).where(
            req, Obligation.non_compliant_at.is_not(None), Obligation.status.not_in(("completed", "waived", "cancelled"))
        )
    )

    comp_clause = ctx.compliance_clause("view")
    comp_by_status = dict(db.execute(select(Compliance.status, func.count()).where(comp_clause).group_by(Compliance.status)).all())

    # --- breakdowns
    def _group(label_col, joins):
        q = select(
            label_col,
            func.count().filter(_COUNTED),
            func.count().filter(Obligation.status == "completed"),
            func.count().filter(Obligation.status.in_(catalog.OPEN), Obligation.due_at.is_not(None), Obligation.due_at < now),
        ).select_from(Obligation)
        for j in joins:
            q = q.outerjoin(*j)
        q = q.where(req).group_by(label_col)
        return [
            {"name": name or "Unassigned", "total": total, "completed": done, "overdue": late, "percent": _pct(done, total)}
            for name, total, done, late in db.execute(q).all()
            if total
        ]

    by_department = sorted(
        _group(Department.name, [(OrgUser, OrgUser.email == Obligation.user_email), (Department, Department.id == OrgUser.department_id)]),
        key=lambda x: x["name"],
    )
    by_team = sorted(
        _group(Team.name, [(TeamMember, TeamMember.user_email == Obligation.user_email), (Team, Team.id == TeamMember.team_id)]),
        key=lambda x: x["name"],
    )
    by_category = sorted(
        _group(Compliance.category, [(Compliance, Compliance.id == Obligation.compliance_id)]), key=lambda x: x["name"]
    )

    # --- trend: completions per day, last 30 days
    since = now - timedelta(days=29)
    day = func.date_trunc("day", Obligation.completed_at)
    done_by_day = {
        d.date().isoformat(): n
        for d, n in db.execute(
            select(day, func.count()).where(req, Obligation.completed_at >= since).group_by(day)
        ).all()
    }
    trend = []
    for i in range(30):
        dt = (since + timedelta(days=i)).date().isoformat()
        trend.append({"date": dt, "completed": done_by_day.get(dt, 0)})

    # --- upcoming deadlines and people who need attention
    upcoming_rows = db.execute(
        select(Obligation, Compliance, OrgUser)
        .join(Compliance, Compliance.id == Obligation.compliance_id)
        .join(OrgUser, OrgUser.email == Obligation.user_email)
        .where(req, Obligation.status.in_(catalog.OPEN), Obligation.due_at.is_not(None), Obligation.due_at >= now, Obligation.due_at <= now + timedelta(days=14))
        .order_by(Obligation.due_at)
        .limit(10)
    ).all()
    upcoming = [
        {"obligation_id": str(o.id), "compliance": c.name, "user": {"email": u.email, "name": u.name}, "due_at": o.due_at.isoformat(), "status": o.status}
        for o, c, u in upcoming_rows
    ]
    attention_rows = db.execute(
        select(
            OrgUser.email,
            OrgUser.name,
            func.count().filter(Obligation.status.in_(catalog.OPEN), Obligation.due_at < now).label("overdue"),
            func.count().filter(Obligation.non_compliant_at.is_not(None), Obligation.status.not_in(("completed", "waived", "cancelled"))).label("nc"),
        )
        .select_from(Obligation)
        .join(OrgUser, OrgUser.email == Obligation.user_email)
        .where(req)
        .group_by(OrgUser.email, OrgUser.name)
    ).all()
    attention = sorted(
        [{"email": e, "name": n, "overdue": o, "non_compliant": nc} for e, n, o, nc in attention_rows if o or nc],
        key=lambda x: (-x["non_compliant"], -x["overdue"]),
    )[:8]

    # --- escalations and evidence waiting for a review
    esc_since = now - timedelta(days=7)
    recent_esc = db.execute(
        select(EscalationLog, Obligation, Compliance, OrgUser)
        .join(Obligation, Obligation.id == EscalationLog.obligation_id)
        .join(Compliance, Compliance.id == Obligation.compliance_id)
        .join(OrgUser, OrgUser.email == Obligation.user_email)
        .where(scope, EscalationLog.fired_at >= esc_since)
        .order_by(EscalationLog.fired_at.desc())
        .limit(10)
    ).all()
    escalations = [
        {"obligation_id": str(o.id), "compliance": c.name, "user": u.name, "action": e.action, "rule": e.rule_id, "fired_at": e.fired_at.isoformat()}
        for e, o, c, u in recent_esc
    ]
    awaiting = review_queue(db, ctx, limit=5)

    return {
        "kpis": {
            "total_compliances": sum(comp_by_status.values()),
            "active_compliances": comp_by_status.get("published", 0),
            "obligations": counted,
            "completed": completed,
            "pending": pending,
            "in_review": in_review,
            "overdue": overdue,
            "non_compliant": non_compliant,
            "non_compliant_users": non_compliant_users,
            "compliance_percent": _pct(completed, counted),
        },
        "compliances_by_status": comp_by_status,
        "by_department": by_department,
        "by_team": by_team,
        "by_category": by_category,
        "trend": trend,
        "upcoming": upcoming,
        "attention": attention,
        "escalations": escalations,
        "review_queue": awaiting,
    }


def review_queue(db: Session, ctx: Ctx, limit: int = 100) -> dict:
    """Submissions this person is allowed to decide, oldest first."""
    clause = ctx.obligation_clause("submission", "approve")
    rows = db.execute(
        select(Obligation, Compliance)
        .join(Compliance, Compliance.id == Obligation.compliance_id)
        .where(clause, Obligation.status.in_(("submitted", "under_review")), Compliance.review_mode != "none", Obligation.user_email != ctx.email)
        .order_by(Obligation.submitted_at)
        .limit(500)
    ).all()
    eligible = [(o, c) for o, c in rows if ctx.can_review(o, c, "approve")]
    return {"total": len(eligible), "items": eligible[:limit]}


def scoreboard(db: Session, ctx: Ctx, days: int = 90) -> list[dict]:
    """Who keeps missing things. Each missed deadline, non-compliant or defaulter
    mark, or currently-overdue item is an incident, weighted by the compliance's
    priority; three or more incidents make someone a repeat offender."""
    now = engine.now()
    since = now - timedelta(days=days)
    scope = ctx.obligation_clause("report", "view")
    rows = db.execute(
        select(Obligation, Compliance, OrgUser, Department.name)
        .join(Compliance, Compliance.id == Obligation.compliance_id)
        .join(OrgUser, OrgUser.email == Obligation.user_email)
        .outerjoin(Department, Department.id == OrgUser.department_id)
        .where(
            scope,
            Obligation.participation == "required",
            Obligation.due_at.is_not(None),
            Obligation.due_at >= since,
            Obligation.status.not_in(("waived", "cancelled")),
        )
    ).all()
    people: dict[str, dict] = {}
    for ob, c, u, dept in rows:
        late_done = ob.status == "completed" and ob.completed_at is not None and ob.due_at is not None and ob.completed_at > ob.due_at
        overdue_open = ob.status in catalog.OPEN and ob.due_at < now
        flagged = ob.non_compliant_at is not None or ob.defaulter_flag
        if not (late_done or overdue_open or flagged):
            continue
        w = catalog.PRIORITY_WEIGHT.get(c.priority, 2)
        p = people.setdefault(
            u.email,
            {"email": u.email, "name": u.name, "department": dept, "score": 0, "incidents": 0, "non_compliant": 0, "overdue": 0, "late": 0, "items": []},
        )
        p["incidents"] += 1
        p["score"] += w
        if ob.non_compliant_at is not None:
            p["non_compliant"] += 1
        if overdue_open:
            p["overdue"] += 1
        if late_done:
            p["late"] += 1
        p["items"].append({"obligation_id": str(ob.id), "compliance": c.name, "priority": c.priority, "status": ob.status})
    board = sorted(people.values(), key=lambda p: (-p["score"], p["name"]))
    for i, p in enumerate(board, 1):
        p["rank"] = i
        p["repeat_offender"] = p["incidents"] >= 3
    return board
