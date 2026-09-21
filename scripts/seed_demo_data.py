"""Populate the dev DB with a realistic-looking demo dataset: a few meeting
series across different organizers/teams, with a mix of full attendance,
required no-shows (real concerns) and optional no-shows (ignored). Safe to
re-run — sync_occurrence is idempotent, and org_users is seeded on startup.

Usage: python scripts/seed_demo_data.py
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.connectors.mock_teams_provider import MockTeamsProvider
from app.connectors.sync_service import sync_occurrence
from app.connectors.teams_provider import MeetingAttendee
from app.database import SessionLocal
from app.directory import STUB_DIRECTORY
from app.models import OrgUser

db = SessionLocal()
existing = {u.email for u in db.query(OrgUser).all()}
for entry in STUB_DIRECTORY:
    if entry["email"] not in existing:
        db.add(OrgUser(**entry))
db.commit()

provider = MockTeamsProvider()
NOW = datetime.now(timezone.utc)


def req(*emails):
    return [MeetingAttendee(e, required=True) for e in emails]


def opt(*emails):
    return [MeetingAttendee(e, required=False) for e in emails]


# 1) Engineering Daily Standup — 10 weekdays, Carol misses 3, Bob misses 1.
standup_start = (NOW - timedelta(days=13)).replace(hour=8, minute=0, second=0, microsecond=0)
provider.define_series(
    "standup-eng", "Engineering Daily Standup", "lead@corp.com",
    req("alice@corp.com", "bob@corp.com", "carol@corp.com"),
    standup_start, timedelta(minutes=15), "daily",
)
standup_occs = provider.get_occurrences("standup-eng", standup_start, NOW - timedelta(hours=1))
carol_misses = {standup_occs[i].occurrence_id for i in (1, 4, 8) if i < len(standup_occs)}
bob_misses = {standup_occs[2].occurrence_id} if len(standup_occs) > 2 else set()
for occ in standup_occs:
    attendees = [
        e for e in ("alice@corp.com", "bob@corp.com", "carol@corp.com")
        if not (e == "carol@corp.com" and occ.occurrence_id in carol_misses)
        and not (e == "bob@corp.com" and occ.occurrence_id in bob_misses)
    ]
    provider.set_attendance(occ.occurrence_id, attendees)
    sync_occurrence(db, provider, occ)

# 2) Support/QA Daily Sync (Priya's team) — Erin misses 2, Dave perfect.
support_start = (NOW - timedelta(days=9)).replace(hour=9, minute=30, second=0, microsecond=0)
provider.define_series(
    "sync-support", "Support & QA Daily Sync", "pm@corp.com",
    req("dave@corp.com", "erin@corp.com"),
    support_start, timedelta(minutes=15), "daily",
)
support_occs = provider.get_occurrences("sync-support", support_start, NOW - timedelta(hours=1))
erin_misses = {support_occs[i].occurrence_id for i in (0, 3) if i < len(support_occs)}
for occ in support_occs:
    attendees = [e for e in ("dave@corp.com", "erin@corp.com") if not (e == "erin@corp.com" and occ.occurrence_id in erin_misses)]
    provider.set_attendance(occ.occurrence_id, attendees)
    sync_occurrence(db, provider, occ)

# 3) Q4 Planning Kickoff — one-time. Carol (required) misses it; Dave (optional) skips too but that's fine.
kickoff_start = NOW - timedelta(days=2, hours=3)
provider.define_series(
    "kickoff-q4", "Q4 Planning Kickoff", "pm@corp.com",
    req("alice@corp.com", "bob@corp.com", "carol@corp.com") + opt("dave@corp.com"),
    kickoff_start, timedelta(minutes=45), "once",
)
kickoff_occ = provider.get_occurrences("kickoff-q4", kickoff_start, kickoff_start)[0]
provider.set_attendance(kickoff_occ.occurrence_id, ["alice@corp.com", "bob@corp.com"])
sync_occurrence(db, provider, kickoff_occ)

# 4) Quarterly All Hands — one-time, org-wide, Bob misses it.
allhands_start = NOW - timedelta(days=6, hours=1)
provider.define_series(
    "allhands-q3", "Quarterly All Hands", "taylor@corp.com",
    req("lead@corp.com", "pm@corp.com", "alice@corp.com", "bob@corp.com", "carol@corp.com", "dave@corp.com", "erin@corp.com"),
    allhands_start, timedelta(minutes=60), "once",
)
allhands_occ = provider.get_occurrences("allhands-q3", allhands_start, allhands_start)[0]
provider.set_attendance(
    allhands_occ.occurrence_id,
    ["lead@corp.com", "pm@corp.com", "alice@corp.com", "carol@corp.com", "dave@corp.com", "erin@corp.com"],
)
sync_occurrence(db, provider, allhands_occ)

# 5) Design Review — one-time, small group, everyone attends (a clean example).
design_start = NOW - timedelta(days=1, hours=4)
provider.define_series(
    "design-review-1", "Design Review: Checkout Flow", "lead@corp.com",
    req("alice@corp.com", "bob@corp.com") + opt("erin@corp.com"),
    design_start, timedelta(minutes=30), "once",
)
design_occ = provider.get_occurrences("design-review-1", design_start, design_start)[0]
provider.set_attendance(design_occ.occurrence_id, ["alice@corp.com", "bob@corp.com"])
sync_occurrence(db, provider, design_occ)

db.close()
print("Seeded demo meeting data.")
