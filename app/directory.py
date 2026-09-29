"""Stub demo directory — a small, fixed set of demo accounts used only for
dev/demo login (see app/api/auth.py). Every row here is seeded with
is_demo=True (see main.py's seed_directory) and is never touched by the
real Microsoft Graph sync, which only ever syncs real (is_demo=False)
org_users created by an actual Microsoft login."""

STUB_DIRECTORY = [
    {"email": "ava.martinez@corp.com", "name": "Ava Martinez", "title": "Engineering Manager", "manager_email": None},
    {"email": "daniel.kim@corp.com", "name": "Daniel Kim", "title": "Senior Software Engineer", "manager_email": "ava.martinez@corp.com"},
    {"email": "sofia.rossi@corp.com", "name": "Sofia Rossi", "title": "Software Engineer", "manager_email": "ava.martinez@corp.com"},
]


def direct_reports(email: str) -> list[dict]:
    return [u for u in STUB_DIRECTORY if u["manager_email"] == email]


def all_reports(email: str) -> list[dict]:
    """Every person reporting directly or indirectly to `email`."""
    result: list[dict] = []
    frontier = direct_reports(email)
    while frontier:
        result.extend(frontier)
        next_frontier: list[dict] = []
        for person in frontier:
            next_frontier.extend(direct_reports(person["email"]))
        frontier = next_frontier
    return result


def by_email(email: str) -> dict | None:
    return next((u for u in STUB_DIRECTORY if u["email"] == email), None)
