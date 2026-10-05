"""Seed the compliance engine's demo data (departments, a team and three example
compliances for the demo accounts). Safe to re-run.

Usage: python scripts/seed_demo_compliance.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.compliance.escalation import tick
from app.compliance.seed import seed_demo
from app.database import SessionLocal
from app.directory import STUB_DIRECTORY
from app.models import OrgUser

db = SessionLocal()
try:
    existing = {u.email for u in db.query(OrgUser).all()}
    for entry in STUB_DIRECTORY:
        if entry["email"] not in existing:
            db.add(OrgUser(**entry, is_demo=True))
    db.commit()
    seed_demo(db)
    print("tick:", tick(db))
    db.commit()
finally:
    db.close()
print("Compliance demo data ready.")
