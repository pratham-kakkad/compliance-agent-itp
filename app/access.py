"""Visibility rule: you can see yourself and everyone who reports to you,
directly or indirectly. This is a demo convenience, not real authorization —
there is no per-endpoint permission check beyond "are you logged in", and a
determined client could still request another person's email directly. Real
access control is a Phase-2 problem once this sits behind real Azure AD
groups/roles.
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import OrgUser


def direct_reports(db: Session, email: str) -> list[OrgUser]:
    return list(db.scalars(select(OrgUser).where(OrgUser.manager_email == email)))


def all_reports(db: Session, email: str) -> list[OrgUser]:
    result: list[OrgUser] = []
    frontier = direct_reports(db, email)
    seen = set()
    while frontier:
        result.extend(frontier)
        next_frontier: list[OrgUser] = []
        for person in frontier:
            if person.email in seen:
                continue
            seen.add(person.email)
            next_frontier.extend(direct_reports(db, person.email))
        frontier = next_frontier
    return result


def visible_emails(db: Session, viewer_email: str) -> set[str]:
    return {viewer_email} | {u.email for u in all_reports(db, viewer_email)}
