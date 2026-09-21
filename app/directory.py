"""Stub org directory — stands in for a real HRIS/Azure AD group sync until
Phase 2. Seeded into the org_users table on first startup (see main.py)."""

STUB_DIRECTORY = [
    {"email": "taylor@corp.com", "name": "Taylor Brooks", "title": "VP Engineering", "manager_email": None},
    {"email": "lead@corp.com", "name": "Jordan Lee", "title": "Engineering Lead", "manager_email": "taylor@corp.com"},
    {"email": "pm@corp.com", "name": "Priya Menon", "title": "Program Manager", "manager_email": "taylor@corp.com"},
    {"email": "alice@corp.com", "name": "Alice Chen", "title": "Software Engineer", "manager_email": "lead@corp.com"},
    {"email": "bob@corp.com", "name": "Bob Rutherford", "title": "Software Engineer", "manager_email": "lead@corp.com"},
    {"email": "carol@corp.com", "name": "Carol Nkemelu", "title": "Software Engineer", "manager_email": "lead@corp.com"},
    {"email": "dave@corp.com", "name": "Dave Osei", "title": "Support Engineer", "manager_email": "pm@corp.com"},
    {"email": "erin@corp.com", "name": "Erin Walsh", "title": "QA Engineer", "manager_email": "pm@corp.com"},
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
