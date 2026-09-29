"""Populate the dev DB with a realistic-looking demo dataset for the 3 demo
accounts: a manager and two engineers, across a mix of full attendance,
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
        db.add(OrgUser(**entry, is_demo=True))
db.commit()

provider = MockTeamsProvider()
NOW = datetime.now(timezone.utc)

AVA = "ava.martinez@corp.com"
DANIEL = "daniel.kim@corp.com"
SOFIA = "sofia.rossi@corp.com"


def req(*emails):
    return [MeetingAttendee(e, required=True) for e in emails]


def opt(*emails):
    return [MeetingAttendee(e, required=False) for e in emails]


# 1) Engineering Daily Standup — 10 weekdays. Sofia misses 3, Daniel misses 1.
standup_start = (NOW - timedelta(days=13)).replace(hour=8, minute=0, second=0, microsecond=0)
provider.define_series(
    "standup-eng", "Engineering Daily Standup", AVA,
    req(DANIEL, SOFIA),
    standup_start, timedelta(minutes=15), "daily",
)
standup_occs = provider.get_occurrences("standup-eng", standup_start, NOW - timedelta(hours=1))
sofia_misses = {standup_occs[i].occurrence_id for i in (1, 4, 8) if i < len(standup_occs)}
daniel_misses = {standup_occs[2].occurrence_id} if len(standup_occs) > 2 else set()
for occ in standup_occs:
    attendees = [
        e for e in (DANIEL, SOFIA)
        if not (e == SOFIA and occ.occurrence_id in sofia_misses)
        and not (e == DANIEL and occ.occurrence_id in daniel_misses)
    ]
    provider.set_attendance(occ.occurrence_id, attendees)
    sync_occurrence(db, provider, occ)

# 2) Q4 Planning Kickoff — one-time. Sofia (required) misses it, a real concern.
kickoff_start = NOW - timedelta(days=2, hours=3)
provider.define_series(
    "kickoff-q4", "Q4 Planning Kickoff", AVA,
    req(DANIEL, SOFIA),
    kickoff_start, timedelta(minutes=45), "once",
)
kickoff_occ = provider.get_occurrences("kickoff-q4", kickoff_start, kickoff_start)[0]
provider.set_attendance(kickoff_occ.occurrence_id, [DANIEL])
sync_occurrence(db, provider, kickoff_occ)

# 3) Quarterly All Hands — one-time, org-wide. Daniel misses it this time.
allhands_start = NOW - timedelta(days=6, hours=1)
provider.define_series(
    "allhands-q3", "Quarterly All Hands", AVA,
    req(DANIEL, SOFIA),
    allhands_start, timedelta(minutes=60), "once",
)
allhands_occ = provider.get_occurrences("allhands-q3", allhands_start, allhands_start)[0]
provider.set_attendance(allhands_occ.occurrence_id, [SOFIA])
sync_occurrence(db, provider, allhands_occ)

# 4) Design Review — one-time, small group, everyone required attends (a clean example).
design_start = NOW - timedelta(days=1, hours=4)
provider.define_series(
    "design-review-1", "Design Review: Checkout Flow", DANIEL,
    req(SOFIA) + opt(AVA),
    design_start, timedelta(minutes=30), "once",
)
design_occ = provider.get_occurrences("design-review-1", design_start, design_start)[0]
provider.set_attendance(design_occ.occurrence_id, [SOFIA])
sync_occurrence(db, provider, design_occ)

db.close()
print("Seeded demo meeting data.")
