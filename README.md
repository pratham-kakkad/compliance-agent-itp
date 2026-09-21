# Meeting Compliance

Standalone Teams meeting-attendance dashboard, split out of the compliance-agent
project so it can evolve independently (own login, own org chart, own chat
assistant) without dragging the generic Obligation model along.

## What's here

- **FastAPI + SQLAlchemy + Alembic + Postgres** — same stack/patterns as the
  sibling `complaince_agent_project`, own database (`meeting_compliance`,
  host port **5433** so both projects can run at once).
- **Data model**: `OrgUser` (stub directory with manager hierarchy),
  `MeetingSeries` / `MeetingOccurrence` / `Attendance` (`required` vs
  `attended` — an absent *optional* invitee is never treated as a compliance
  problem anywhere: not in the dashboard, not in "top concerns", not in the
  chat assistant).
- **Auth**: `AUTH_MODE=dev` (default) — pick yourself from the directory,
  zero setup. `AUTH_MODE=microsoft` — real "Sign in with Microsoft" via MSAL;
  needs an Azure AD app registration (see `HELPDESK_EMAIL_DRAFT.md`).
- **Access model**: you can see yourself and everyone reporting to you,
  directly or indirectly — demo-only, not real authorization (no per-endpoint
  permission beyond "logged in").
- **Chat assistant**: `POST /chat`, backed by the Claude API with tool access
  to this user's own dashboard/meeting/person data. Needs `ANTHROPIC_API_KEY`
  in `.env`; without it the endpoint returns a clear 503 instead of failing
  obscurely.
- **UI**: `app/static/index.html`, served at `/ui/` — Dashboard, Meetings
  (search/filter/group-by), Team, Org Chart (click or hover a node for a
  pie-chart + top-meetings modal), and an Assistant page + floating chat
  widget on every screen. Light by default, dark mode via the sidebar toggle.

## Running it

```bash
docker compose up -d                 # Postgres on host port 5433
cp .env.example .env                 # fill in ANTHROPIC_API_KEY (chat) and
                                      # MS_* vars (only if AUTH_MODE=microsoft)
pip install -e .
python -m alembic upgrade head
python scripts/seed_demo_data.py     # realistic demo meetings/attendance
python -m uvicorn app.main:app --port 8010
```

Open http://localhost:8010/ui/ — dev-login as any stub user (try
`lead@corp.com` or `taylor@corp.com` to see a manager's/VP's view).

## Tests

```bash
python -m pytest -q
```

Runs against a dedicated `meeting_compliance_test` database (created
automatically), never the dev DB the demo data lives in.
