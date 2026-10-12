"""General-compliance dashboard: what is done, what is late, what is waiting, who keeps
missing things. Every query starts from the viewer's row filter
(`Ctx.obligation_clause`), so a manager's numbers only describe their own people.

Only obligations where the person MUST act count; waived and cancelled ones are out
of every number (same as app/compliance/reports.py).

Terms (also the tooltips):

- Completion rate  = required obligations that fell due in the period and are now
                     completed / all required obligations that fell due in the period.
                     Obligations without a deadline are not part of it.
- On-time rate     = of the obligations completed in the period, the share completed on or
                     before their deadline.
- Overdue          = open obligations whose deadline has passed, aged in three buckets
                     (up to 7 days, 8 to 30, over 30 days late). The comparison is the same
                     count as it stood at the start of the period.
- Due soon         = open obligations falling due in the next 7 days.
- Review queue     = submissions this person may approve or reject (the Reviews page).
- Review turnaround= average time from a submission to the decision on it, for decisions in the period.
- Time to complete = average time from assignment to completion, for completions in the period.
"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.compliance import catalog, reports
from app.compliance.models import Compliance, Department, EscalationLog, Obligation, ReviewDecision, Submission
from app.compliance.policy import Ctx
from app.dashboards.common import (
    Period,
    bucket_count,
    bucket_from_end,
    bucket_start,
    count_tone,
    kpi,
    rate_tone,
    ratio,
    trend_is_daily,
)
from app.models import OrgUser
from app.org_settings.service import get_timezone

TARGET = 0.9
WARN_FLOOR = 0.7
LIST_LIMIT = 8
PRIORITY_ORDER = ["critical", "high", "medium", "low"]
_OPEN = list(catalog.OPEN)


def _base(ctx: Ctx):
    return and_(
        ctx.obligation_clause("submission", "view"),
        Obligation.participation == "required",
        Obligation.status.not_in(("waived", "cancelled")),
    )


def _due_between(start: datetime, end: datetime):
    return and_(Obligation.due_at.is_not(None), Obligation.due_at >= start, Obligation.due_at < end)


def _completion(db: Session, base, start: datetime, end: datetime) -> tuple[int, int]:
    """(due in [start, end), of which completed)."""
    row = db.execute(
        select(func.count(), func.count().filter(Obligation.status == "completed")).where(base, _due_between(start, end))
    ).one()
    return row[0], row[1]


def _on_time(db: Session, base, start: datetime, end: datetime) -> tuple[int, int]:
    """(completed in [start, end) with a deadline, of which on or before the deadline)."""
    row = db.execute(
        select(func.count(), func.count().filter(Obligation.completed_at <= Obligation.due_at)).where(
            base,
            Obligation.status == "completed",
            Obligation.due_at.is_not(None),
            Obligation.completed_at >= start,
            Obligation.completed_at < end,
        )
    ).one()
    return row[0], row[1]


def _overdue_at(db: Session, base, at: datetime, now: datetime) -> int:
    """Open and past the deadline as of `at` (for the past: still open then, i.e. not completed by `at`)."""
    if at >= now:
        still_open = Obligation.status.in_(_OPEN)
    else:
        still_open = or_(Obligation.status.in_(_OPEN), and_(Obligation.status == "completed", Obligation.completed_at > at))
    return db.scalar(select(func.count()).where(base, Obligation.due_at.is_not(None), Obligation.due_at < at, still_open)) or 0


def _avg_seconds(db: Session, expr, *conds) -> float | None:
    v = db.scalar(select(func.avg(func.extract("epoch", expr))).where(*conds))
    return float(v) if v is not None else None


def _review_turnaround_h(db: Session, base, start: datetime, end: datetime) -> float | None:
    v = db.scalar(
        select(func.avg(func.extract("epoch", ReviewDecision.decided_at - Submission.submitted_at)))
        .select_from(ReviewDecision)
        .join(Submission, Submission.id == ReviewDecision.submission_id)
        .join(Obligation, Obligation.id == Submission.obligation_id)
        .where(base, ReviewDecision.decided_at >= start, ReviewDecision.decided_at < end)
    )
    return round(float(v) / 3600, 2) if v is not None else None


def _complete_days(db: Session, base, start: datetime, end: datetime) -> float | None:
    v = _avg_seconds(
        db,
        Obligation.completed_at - Obligation.created_at,
        base,
        Obligation.status == "completed",
        Obligation.completed_at >= start,
        Obligation.completed_at < end,
    )
    return round(v / 86400, 2) if v is not None else None


def _group(db: Session, base, label_col, joins, period: Period, now: datetime) -> list[dict]:
    """Completion over the period's due cohort per group, plus every currently overdue item of the group."""

    def q(*extra):
        s = select(label_col, func.count(), func.count().filter(Obligation.status == "completed")).select_from(Obligation)
        for j in joins:
            s = s.outerjoin(*j)
        return s.where(base, *extra).group_by(label_col)

    cohort = {name or "Unassigned": (t, c) for name, t, c in db.execute(q(_due_between(period.start, now))).all()}
    prev = {name or "Unassigned": (t, c) for name, t, c in db.execute(q(_due_between(period.prev_start, period.start))).all()}
    over_q = select(label_col, func.count()).select_from(Obligation)
    for j in joins:
        over_q = over_q.outerjoin(*j)
    overdue = {
        (name or "Unassigned"): n
        for name, n in db.execute(
            over_q.where(base, Obligation.status.in_(_OPEN), Obligation.due_at.is_not(None), Obligation.due_at < now).group_by(label_col)
        ).all()
    }
    out = []
    for name in set(cohort) | set(overdue):
        t, c = cohort.get(name, (0, 0))
        pt, pc = prev.get(name, (0, 0))
        r, pr = ratio(c, t), ratio(pc, pt)
        out.append(
            {
                "name": name,
                "total": t,
                "completed": c,
                "rate": r,
                "previous_rate": pr,
                "delta": round(r - pr, 4) if r is not None and pr is not None else None,
                "overdue": overdue.get(name, 0),
            }
        )
    out.sort(key=lambda x: (x["rate"] is None, x["rate"] if x["rate"] is not None else 0, -x["overdue"], x["name"]))
    return out


def _weekly(db: Session, base, period: Period, tz: ZoneInfo, now: datetime) -> dict:
    daily = trend_is_daily(period.days)
    first, last = period.local_dates(tz)
    n = bucket_count(first, last, daily)
    pfirst = period.prev_start.astimezone(tz).date()
    plast = first - timedelta(days=1)
    rows = db.scalars(
        select(Obligation.completed_at).where(
            base, Obligation.status == "completed", Obligation.completed_at >= period.prev_start, Obligation.completed_at < now
        )
    ).all()
    cur, prev = [0] * n, [0] * n
    for at in rows:
        d = at.astimezone(tz).date()
        if d >= first:
            i = bucket_from_end(d, last, daily)
            if 0 <= i < n:
                cur[i] += 1
        else:
            i = bucket_from_end(d, plast, daily)
            if 0 <= i < n:
                prev[i] += 1
    pts = [
        {
            "start": bucket_start(i, first, last, daily).isoformat(),
            "completed": cur[i],
            "previous_start": bucket_start(i, pfirst, plast, daily).isoformat(),
            "previous_completed": prev[i],
        }
        for i in range(n - 1, -1, -1)
    ]
    return {"daily": daily, "points": pts, "total": sum(cur), "previous_total": sum(prev)}


def build(db: Session, ctx: Ctx, days: int, now: datetime) -> dict:
    tz = get_timezone(db)
    period = Period.ending(now, days, tz)
    base = _base(ctx)
    quiet = f"Nothing with a deadline fell due in the last {days} days"

    # --- headline numbers
    due_n, done_n = _completion(db, base, period.start, now)
    pdue_n, pdone_n = _completion(db, base, period.prev_start, period.start)
    rate, prate = ratio(done_n, due_n), ratio(pdone_n, pdue_n)
    ot_n, ot_ok = _on_time(db, base, period.start, now)
    pot_n, pot_ok = _on_time(db, base, period.prev_start, period.start)
    ontime, pontime = ratio(ot_ok, ot_n), ratio(pot_ok, pot_n)

    overdue_n = _overdue_at(db, base, now, now)
    overdue_prev = _overdue_at(db, base, period.start, now)
    soon_n = db.scalar(
        select(func.count()).where(base, Obligation.status.in_(_OPEN), Obligation.due_at.is_not(None), Obligation.due_at >= now, Obligation.due_at < now + timedelta(days=7))
    ) or 0

    # --- overdue aging and the items themselves
    overdue_rows = db.execute(
        select(Obligation, Compliance, OrgUser)
        .join(Compliance, Compliance.id == Obligation.compliance_id)
        .join(OrgUser, OrgUser.email == Obligation.user_email)
        .where(base, Obligation.status.in_(_OPEN), Obligation.due_at.is_not(None), Obligation.due_at < now)
    ).all()
    aging = {"d1_7": 0, "d8_30": 0, "d30_plus": 0}
    items, by_compliance = [], {}
    for ob, c, u in overdue_rows:
        late_days = (now - ob.due_at).total_seconds() / 86400
        aging["d1_7" if late_days <= 7 else "d8_30" if late_days <= 30 else "d30_plus"] += 1
        items.append(
            {
                "obligation_id": str(ob.id),
                "compliance": c.name,
                "compliance_id": str(c.id),
                "priority": c.priority,
                "user": {"email": u.email, "name": u.name},
                "due_at": ob.due_at.isoformat(),
                "days_overdue": int(late_days) if late_days >= 1 else 0,
                "status": ob.status,
            }
        )
        g = by_compliance.setdefault(c.id, {"compliance_id": str(c.id), "name": c.name, "priority": c.priority, "overdue": 0, "oldest_days": 0})
        g["overdue"] += 1
        g["oldest_days"] = max(g["oldest_days"], int(late_days))
    w = catalog.PRIORITY_WEIGHT
    items.sort(key=lambda i: (-w.get(i["priority"], 2), -i["days_overdue"], i["user"]["name"]))
    top_compliances = sorted(by_compliance.values(), key=lambda g: (-w.get(g["priority"], 2), -g["overdue"], -g["oldest_days"], g["name"]))

    due_soon = [
        {
            "obligation_id": str(ob.id),
            "compliance": c.name,
            "priority": c.priority,
            "user": {"email": u.email, "name": u.name},
            "due_at": ob.due_at.isoformat(),
            "status": ob.status,
        }
        for ob, c, u in db.execute(
            select(Obligation, Compliance, OrgUser)
            .join(Compliance, Compliance.id == Obligation.compliance_id)
            .join(OrgUser, OrgUser.email == Obligation.user_email)
            .where(base, Obligation.status.in_(_OPEN), Obligation.due_at.is_not(None), Obligation.due_at >= now, Obligation.due_at < now + timedelta(days=7))
            .order_by(Obligation.due_at)
            .limit(LIST_LIMIT)
        ).all()
    ]

    # --- reviews
    can_review = ctx.can("submission", "approve") or ctx.can("submission", "reject")
    queue = reports.review_queue(db, ctx) if can_review else {"total": 0, "items": []}
    review_items = []
    oldest_wait = None
    if queue["items"]:
        emails = {o.user_email for o, _ in queue["items"]}
        names = dict(db.execute(select(OrgUser.email, OrgUser.name).where(OrgUser.email.in_(emails))).all())
        for o, c in queue["items"]:
            if o.submitted_at is None:
                continue
            wait = (now - o.submitted_at).total_seconds() / 86400
            oldest_wait = wait if oldest_wait is None else max(oldest_wait, wait)
            review_items.append(
                {
                    "obligation_id": str(o.id),
                    "compliance": c.name,
                    "priority": c.priority,
                    "user": {"email": o.user_email, "name": names.get(o.user_email, o.user_email)},
                    "submitted_at": o.submitted_at.isoformat(),
                    "waiting_days": round(wait, 1),
                }
            )
    turnaround = _review_turnaround_h(db, base, period.start, now) if can_review else None
    pturnaround = _review_turnaround_h(db, base, period.prev_start, period.start) if can_review else None

    # --- people
    nc_clause = and_(base, Obligation.non_compliant_at.is_not(None), Obligation.status.not_in(("completed",)))
    nc_people = db.scalar(select(func.count(func.distinct(Obligation.user_email))).where(nc_clause)) or 0
    nc_items = db.scalar(select(func.count()).where(nc_clause)) or 0
    board = reports.scoreboard(db, ctx, days) if ctx.can("report", "view") else None
    repeat = [p for p in board if p["repeat_offender"]] if board is not None else None
    defaulters = (
        [
            {
                "email": p["email"],
                "name": p["name"],
                "department": p["department"],
                "incidents": p["incidents"],
                "score": p["score"],
                "overdue": p["overdue"],
                "non_compliant": p["non_compliant"],
                "late": p["late"],
                "repeat": p["repeat_offender"],
            }
            for p in board[:5]
        ]
        if board is not None
        else []
    )

    # --- what the escalation rules did in the period (reminders, manager notices, non-compliant marks)
    escalations = [
        {
            "obligation_id": str(o.id),
            "compliance": c.name,
            "user": u.name,
            "action": e.action,
            "fired_at": e.fired_at.isoformat(),
        }
        for e, o, c, u in db.execute(
            select(EscalationLog, Obligation, Compliance, OrgUser)
            .join(Obligation, Obligation.id == EscalationLog.obligation_id)
            .join(Compliance, Compliance.id == Obligation.compliance_id)
            .join(OrgUser, OrgUser.email == Obligation.user_email)
            .where(ctx.obligation_clause("submission", "view"), EscalationLog.fired_at >= period.start)
            .order_by(EscalationLog.fired_at.desc())
            .limit(LIST_LIMIT)
        ).all()
    ]

    # --- time to complete
    ttc = _complete_days(db, base, period.start, now)
    pttc = _complete_days(db, base, period.prev_start, period.start)

    kpis = {
        "completion": kpi(
            "completion",
            "Completion rate",
            "Required obligations that fell due in the period and are now completed, divided by all that fell due in the period. Obligations without a deadline are not included.",
            "percent",
            rate,
            previous=prate,
            good="up",
            target=TARGET,
            tone=rate_tone(rate, TARGET, WARN_FLOOR),
            numerator=done_n,
            denominator=due_n,
            detail=f"{done_n} of {due_n} due items completed",
            no_data=quiet,
        ),
        "on_time": kpi(
            "on_time",
            "On-time rate",
            "Of the required obligations completed in the period, the share completed on or before their deadline.",
            "percent",
            ontime,
            previous=pontime,
            good="up",
            target=TARGET,
            tone=rate_tone(ontime, TARGET, WARN_FLOOR),
            numerator=ot_ok,
            denominator=ot_n,
            detail=f"{ot_ok} of {ot_n} completions on time",
            no_data=f"Nothing was completed in the last {days} days",
        ),
        "overdue": kpi(
            "overdue",
            "Overdue",
            "Open required obligations whose deadline has passed. The comparison is the same count at the start of the period.",
            "count",
            overdue_n,
            previous=overdue_prev,
            good="down",
            tone=count_tone(overdue_n, 1, 5),
            detail=f"{aging['d30_plus']} late by over 30 days" if aging["d30_plus"] else "none late by over 30 days" if overdue_n else "nothing is late",
        ),
        "due_soon": kpi(
            "due_soon",
            "Due in 7 days",
            "Open required obligations whose deadline falls in the next 7 days.",
            "count",
            soon_n,
            tone="neutral",
            detail="open items, next 7 days",
            compare_label="snapshot",
        ),
        "review_queue": kpi(
            "review_queue",
            "Review queue",
            "Submissions waiting for a decision from you: the same list as the Reviews page.",
            "count",
            queue["total"] if can_review else None,
            good="down",
            tone="neutral" if oldest_wait is None or oldest_wait <= 3 else "warn" if oldest_wait <= 7 else "crit",
            detail=(f"oldest waiting {int(oldest_wait)} days" if oldest_wait is not None and oldest_wait >= 1 else "waiting for you") if queue["total"] else "nothing waiting",
            no_data="You are not a reviewer",
            compare_label="snapshot",
        ),
        "review_turnaround": kpi(
            "review_turnaround",
            "Review turnaround",
            "Average time from a submission to the decision on it, for decisions made in the period.",
            "hours",
            turnaround,
            previous=pturnaround,
            good="down",
            tone="neutral",
            no_data="No review decisions in the last %d days" % days if can_review else "You are not a reviewer",
        ),
        "non_compliant": kpi(
            "non_compliant",
            "Non-compliant people",
            "People with at least one open obligation marked non-compliant by an escalation rule.",
            "count",
            nc_people,
            good="down",
            tone="crit" if nc_people else "good",
            detail=f"{nc_items} open items marked" if nc_items else "nobody marked",
            compare_label="snapshot",
        ),
        "repeat_defaulters": kpi(
            "repeat_defaulters",
            "Repeat defaulters",
            f"People with 3 or more incidents (late, overdue, non-compliant or flagged) in the last {days} days, from the defaulter scoreboard.",
            "count",
            len(repeat) if repeat is not None else None,
            good="down",
            tone="crit" if repeat else "good",
            detail=f"of {len(board)} people with incidents" if board else "no incidents",
            no_data="You can't see the scoreboard",
            compare_label="snapshot",
        ),
        "time_to_complete": kpi(
            "time_to_complete",
            "Time to complete",
            "Average time from an obligation being assigned to it being completed, for completions in the period.",
            "days",
            ttc,
            previous=pttc,
            good="down",
            tone="neutral",
            no_data=f"Nothing was completed in the last {days} days",
        ),
    }

    return {
        "area": "compliance",
        "as_of": now.isoformat(),
        "timezone": str(tz),
        "period": period.info(tz),
        "kpis": kpis,
        "thresholds": {"target": TARGET, "warn_floor": WARN_FLOOR},
        "aging": {**aging, "total": overdue_n},
        "completions": _weekly(db, base, period, tz, now),
        "by_category": _group(db, base, Compliance.category, [(Compliance, Compliance.id == Obligation.compliance_id)], period, now),
        "by_priority": sorted(
            _group(db, base, Compliance.priority, [(Compliance, Compliance.id == Obligation.compliance_id)], period, now),
            key=lambda g: PRIORITY_ORDER.index(g["name"]) if g["name"] in PRIORITY_ORDER else 9,
        ),
        "by_department": _group(
            db,
            base,
            Department.name,
            [(OrgUser, OrgUser.email == Obligation.user_email), (Department, Department.id == OrgUser.department_id)],
            period,
            now,
        ),
        "overdue_items": items[:LIST_LIMIT],
        "overdue_total": len(items),
        "overdue_by_compliance": top_compliances[:LIST_LIMIT],
        "due_soon": due_soon,
        "review_items": review_items[:5],
        "defaulters": defaulters,
        "escalations": escalations,
    }
