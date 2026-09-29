"""Pull real Teams meeting attendance from Microsoft Graph for every real
(non-demo) org member and sync it into the database. The running app also
does this automatically every `TEAMS_SYNC_INTERVAL_MINUTES` once Microsoft
sign-in is configured (see app/teams_sync.py) — this script is for a one-off
backfill, or for running the sync from cron/a scheduled task instead of
in-process.

Needs the MS_* app registration with the application permissions from
HELPDESK_EMAIL_DRAFT.md granted with admin consent: OnlineMeetings.Read.All,
OnlineMeetingArtifact.Read.All, Calendars.Read, User.Read.All.

Usage: python scripts/sync_teams_data.py [days_back]
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.auth import microsoft_oauth
from app.config import settings
from app.connectors.graph_teams_provider import GraphTeamsProvider
from app.connectors.sync_service import sync_organizer
from app.database import SessionLocal
from app.models import OrgUser

if not microsoft_oauth.is_configured():
    raise SystemExit("Set MS_CLIENT_ID/MS_CLIENT_SECRET/MS_TENANT_ID in .env before syncing real Teams data.")

days_back = int(sys.argv[1]) if len(sys.argv) > 1 else settings.teams_sync_window_days
end = datetime.now(timezone.utc)
start = end - timedelta(days=days_back)

provider = GraphTeamsProvider()
db = SessionLocal()
total = 0
try:
    real_users = db.query(OrgUser).filter(OrgUser.is_demo.is_(False)).all()
    for person in real_users:
        try:
            count = sync_organizer(db, provider, person.email, start, end)
            print(f"{person.email}: synced {count} occurrence(s)")
            total += count
        except Exception as exc:  # one organizer's Graph error shouldn't abort the run
            print(f"{person.email}: FAILED — {exc}")
finally:
    db.close()

print(f"Done. {total} occurrence(s) synced across {len(real_users)} organizer(s).")
