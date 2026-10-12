"""Cross-area executive summary: the headline KPIs of each area and the few things that
need attention right now. It composes the three area builders, so a number here is
always the number on that area's own dashboard."""
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.compliance.policy import Ctx
from app.dashboards import biometric_kpis, compliance_kpis, meetings_kpis
from app.dashboards.common import Period
from app.models import OrgUser
from app.org_settings.service import get_timezone

MEETINGS_HEADLINE = ("attendance", "series_at_risk", "repeat_absentees")
BIOMETRIC_HEADLINE = ("attendance", "present_today", "not_seen")
COMPLIANCE_HEADLINE = ("completion", "overdue", "due_soon")
ATTENTION_LIMIT = 4


def _pick(kpis: dict, keys: tuple[str, ...]) -> list[dict]:
    return [kpis[k] for k in keys]


def build(db: Session, user: OrgUser, days: int, now: datetime) -> dict:
    tz = get_timezone(db)
    out: dict = {
        "area": "overview",
        "as_of": now.isoformat(),
        "timezone": str(tz),
        "period": Period.ending(now, days, tz).info(tz),
    }

    m = meetings_kpis.build(db, user, days, now)
    out["meetings"] = {
        "available": True,
        "kpis": _pick(m["kpis"], MEETINGS_HEADLINE),
        "attention": [
            {
                "series_id": s["series_id"],
                "title": s["title"],
                "organizer_name": s["organizer_name"],
                "rate": s["rate"],
                "missed": s["missed"],
                "total": s["total"],
            }
            for s in m["at_risk_series"][:ATTENTION_LIMIT]
        ],
        "attention_total": m["kpis"]["series_at_risk"]["value"] or 0,
        "period": m["period"],
    }

    b = biometric_kpis.build(db, days, now)
    out["biometric"] = {
        "available": True,
        "empty": b["empty"],
        "kpis": _pick(b["kpis"], BIOMETRIC_HEADLINE),
        "data_through": b["data_through"],
        "data_age_days": b["data_age_days"],
        "stale": b["stale"],
        "attention": [
            {"kind": "not_seen", "emp_code": p["emp_code"], "name": p["name"], "department": p["department"], "days_silent": p["days_silent"]}
            for p in b["not_seen"]
            if not p["assumed_left"]
        ][:ATTENTION_LIMIT],
        "attention_total": b["kpis"]["not_seen"]["value"] or 0,
        "missed_punch": [
            {"emp_code": p["emp_code"], "name": p["name"], "department": p["department"], "count": p["count"]}
            for p in b["missed_punch_people"][:ATTENTION_LIMIT]
        ],
        "period": b["period"],
    }

    ctx = Ctx(db, user)
    if not ctx.can("dashboard", "view"):
        out["compliance"] = {"available": False, "reason": "You don't have access to the compliance dashboard"}
    else:
        c = compliance_kpis.build(db, ctx, days, now)
        out["compliance"] = {
            "available": True,
            "kpis": _pick(c["kpis"], COMPLIANCE_HEADLINE),
            "attention": c["overdue_by_compliance"][:ATTENTION_LIMIT],
            "attention_total": c["overdue_total"],
            "aging": c["aging"],
            "period": c["period"],
        }
    return out
