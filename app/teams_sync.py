"""Real Teams attendance sync against Microsoft Graph, for real (non-demo)
org members only. Demo accounts (app/directory.py, is_demo=True) never go
through this — they stay on the static seeded dataset forever. Used by the
background loop in app/main.py and by the one-off sync triggered right
after a Microsoft login (app/api/auth.py)."""
import logging
from datetime import datetime, timedelta, timezone

from app.config import settings
from app.connectors.graph_teams_provider import GraphTeamsProvider
from app.connectors.sync_service import sync_organizer
from app.database import SessionLocal
from app.models import OrgUser

logger = logging.getLogger("app.teams_sync")


def _sync_window() -> tuple[datetime, datetime]:
    end = datetime.now(timezone.utc)
    return end - timedelta(days=settings.teams_sync_window_days), end


def sync_one_organizer(email: str) -> None:
    """One-off sync for a single organizer, e.g. right after their first
    Microsoft login so they don't wait for the next scheduled cycle. Never
    raises — a Graph error (permissions not consented yet, etc.) is logged
    and swallowed, same as the background loop."""
    start, end = _sync_window()
    db = SessionLocal()
    try:
        count = sync_organizer(db, GraphTeamsProvider(), email, start, end)
        if count:
            logger.info("teams sync (login): %s -> %d occurrence(s)", email, count)
    except Exception:
        logger.exception("teams sync (login) failed for %s", email)
    finally:
        db.close()


def sync_all_real_users() -> None:
    """One pass over every real (non-demo) org member, syncing everything
    each one organizes. Runs on a thread (see app.main._teams_sync_loop)
    since GraphClient is synchronous — this must never raise into the
    caller: a bad Graph call for one organizer (e.g. permissions not
    consented yet) shouldn't stop the rest of the directory from syncing,
    or take the server down."""
    provider = GraphTeamsProvider()
    start, end = _sync_window()
    db = SessionLocal()
    try:
        real_users = db.query(OrgUser).filter(OrgUser.is_demo.is_(False)).all()
        for person in real_users:
            try:
                count = sync_organizer(db, provider, person.email, start, end)
                if count:
                    logger.info("teams sync: %s -> %d occurrence(s)", person.email, count)
            except Exception:
                logger.exception("teams sync failed for %s", person.email)
    finally:
        db.close()
