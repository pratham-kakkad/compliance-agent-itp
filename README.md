# Intuitive Compliance Hub

A general compliance platform: one shell (auth, dashboard, nav) with
self-contained "agents" plugged into it, each owning its own tables,
connector(s) and API — no shared generic "obligation" model to force every
domain through. Split out of the sibling `complaince_agent_project` (which
takes the opposite, generic-engine approach) so each agent can evolve on
its own schema.

Agents today:

- **Meetings** — Teams meeting attendance compliance (`app/api/meetings.py`,
  `app/api/dashboard.py`, `app/api/orgchart.py`, `app/connectors/`).
- **Attendance** — biometric device punch-log attendance tracking (`app/attendance/`).

Adding a new agent means adding a new self-contained module (its own
models/api/connector under `app/<agent>/` or `app/api/`) and a nav entry on
the frontend — not touching the others.

## What's here

- **FastAPI + SQLAlchemy + Alembic + Postgres** — same stack/patterns as the
  sibling `complaince_agent_project`, own database (`meeting_compliance`,
  host port **5433** so both projects can run at once).
- **Meetings agent data model**: `OrgUser` — a handful of fixed demo accounts
  (`app/directory.py`, `is_demo=True`) plus real accounts created on first
  Microsoft login (`is_demo=False`) — and `MeetingSeries` /
  `MeetingOccurrence` / `Attendance` (`required` vs `attended` — an absent
  *optional* invitee is never treated as a compliance problem anywhere: not
  in the dashboard, not in "top concerns", not in the chat assistant).
- **Demo data vs. real data — both live at once**: demo accounts are always
  backed by the static dataset from `scripts/seed_demo_data.py`
  (`MockTeamsProvider`) and are never touched by any Graph sync. Real
  accounts are only ever created by an actual Microsoft login and are the
  only ones the real sync ever runs for. `TeamsProvider` is an interface
  (`app/connectors/teams_provider.py`) with two implementations —
  `MockTeamsProvider` (in-memory, used by demo seeding and tests) and
  `GraphTeamsProvider` (`app/connectors/graph_teams_provider.py`, real
  Microsoft Graph calendar + online-meeting attendance reports). Once
  Microsoft sign-in is configured (`MS_CLIENT_ID`/`MS_CLIENT_SECRET`/
  `MS_TENANT_ID` set), the running app syncs each real user's own calendar
  right after they sign in, and keeps syncing every real user in the
  background every `TEAMS_SYNC_INTERVAL_MINUTES` (default 15) — see
  `app/teams_sync.py` and `app/main.py`'s lifespan. Needs the application
  permissions from `HELPDESK_EMAIL_DRAFT.md` (`OnlineMeetings.Read.All`,
  `OnlineMeetingArtifact.Read.All`, `Calendars.Read`) granted and
  admin-consented. `scripts/sync_teams_data.py` runs the same sync as a
  one-off/cron job instead of in-process.
- **Auth**: "Sign in with Microsoft" (real MSAL auth-code flow, needs an
  Azure AD app registration — see `HELPDESK_EMAIL_DRAFT.md`) and demo login
  (instant sign-in as one of 3 fixed demo accounts, no setup) are both
  available on the login screen at the same time. Set
  `ENABLE_DEMO_LOGIN=false` to hide demo login in a real deployment; demo
  login only ever accepts the 3 demo accounts regardless of that flag, so
  it can never be used to sign in as a real person.
- **Access model**: you can see yourself and everyone reporting to you,
  directly or indirectly — demo-only, not real authorization (no per-endpoint
  permission beyond "logged in").
- **Chat assistant** (`app/chat/`, `POST /chat`): a LangChain tool-calling
  agent on Groq, focused on biometric attendance; see
  [Chat assistant](#chat-assistant) below.
- **Attendance agent** (`app/attendance/`): biometric device punch-log
  attendance tracking, entirely separate from the Meetings agent's
  tables/identity system (device `Emp Code`, not an OrgUser email — no
  linkage between the two in this pass). `BiometricPunchLog` is the raw
  staging table (one row per import row, never mutated); `AttendanceEmployee`
  is the roster upserted from the latest row seen per Emp Code;
  `AttendanceDay` is the computed daily result — plain presence tracking
  (first punch, last punch, punch count), no in/out direction or
  worked-hours logic, and no `absent` status since there's no shift roster
  to say who was expected to work. `app/attendance/importer.py` parses a
  `.csv`/`.xlsx` export with columns `Log Date, Device, Emp Code, Name,
  Company, Department` (case-insensitive, order-independent; any other
  columns the export includes, e.g. Category/Status/EmploymentType, are
  ignored). `Log Date` is `DD-MM-YYYY Hr:Min` and is parsed day-first;
  `Device` carries a raw Entry/Exit marker that's stored but not used for
  any logic yet. `app/attendance/rules.py` has the aggregation. API: `POST
  /attendance/import` (multipart `file` plus an optional `timezone`, see
  [Time zones](#time-zones)), `GET /attendance/dashboard`, `GET
  /attendance`, `GET /attendance/{emp_code}`.
  `scripts/seed_demo_attendance.py` seeds realistic demo punch data for the
  3 demo accounts by running it through the real import path. It is
  idempotent: each run first deletes the punches and import batches of
  earlier seed runs (only batches imported by `seed_demo_attendance.py`,
  never any other import), recomputes or removes the days they made, then
  imports the last 14 days again — so the demo counts no longer grow on
  every container start.
- **Settings** (`app/org_settings/`, `GET/PUT /settings`, `GET
  /settings/timezones`, the Settings page pinned at the bottom of the nav):
  organization-wide settings in a generic key-value table (`app_settings`),
  so more settings can be added without a migration. Anyone logged in can
  change them (there are no roles yet — the same people who can import).
  The first setting is the organization time zone.
- **UI**: a React + TypeScript SPA (`frontend/`, Vite + Tailwind + Recharts +
  Framer Motion) served at `/ui/` (`/` redirects there). In Docker it's its
  own service (nginx, see below); on the host FastAPI serves the committed
  build in `app/static/`, so running the backend alone needs no Node
  toolchain — only rebuild when you change something under `frontend/`. Nav
  is grouped by agent — a combined Dashboard, a Meetings group (Meetings
  list, Team, Org Chart) and an Attendance group (employee list/detail,
  punch-log import) — with the cross-agent Assistant and Settings pinned at
  the bottom, above the collapse control. Light by default, dark mode via the sidebar
  toggle.
- **Brand**: the official logo lives in `brand/` (the original PNG plus
  traced SVG versions for light and dark backgrounds and an app icon). The
  UI draws the same vector paths inline (`frontend/src/components/shell/Logo.tsx`)
  so the logo follows the theme's text color.

## Time zones

- **Storage is UTC.** Every punch (`biometric_punch_logs.log_date`) is a UTC
  instant. Punches imported before time zones existed were stored as-is
  and are treated as UTC.
- **Organization time zone** (Settings page, `PUT /settings
  {"timezone": "Asia/Kolkata"}`): one IANA zone for the whole organization.
  It decides how every time is shown — the UI and the assistant both use it
  instead of each viewer's browser zone — and which calendar day a punch
  counts for (`attendance_days.work_date` is the punch's date in that zone,
  so with Asia/Kolkata a punch at 20:00 UTC is 01:30 the next day). Until
  someone saves a zone there, `DEFAULT_TIMEZONE` from `.env` is used
  (default `UTC`; must be an IANA name such as `Asia/Kolkata`; an unknown
  name falls back to UTC with a warning).
- **Changing the zone recomputes every attendance day** from the raw
  punches, in the same transaction as the change (all or nothing), and
  rebuilds the assistant's search index on the next search. The response
  says how many days there are after the recompute. If `DEFAULT_TIMEZONE`
  changes while no zone is saved in Settings, the app notices at startup
  (it remembers which zone the days were computed in) and recomputes then.
- **Import time zone**: device exports carry wall-clock times with no zone,
  so the upload form asks which zone the file is in (multipart field
  `timezone`, default the organization zone). Times without an offset are
  read in that zone (a time made ambiguous by a DST change is taken as its
  first occurrence) and converted to UTC; a value that carries its own
  offset (`...+05:30`, `...Z`) keeps it. The zone used is stored on the
  import batch (`attendance_import_batches.source_timezone`) and returned
  as `source_timezone`, next to `timezone` (the organization zone the days
  were computed in). An unknown zone is a 400 and nothing is imported.
- `GET /settings/timezones` lists every zone with its current UTC offset
  (`"(UTC+05:30) Asia/Kolkata"`), sorted by offset. Zone data comes from the
  `tzdata` package, so it is the same on Windows, Linux and the slim Docker
  image.

## Chat assistant

`POST /chat` (`{message, history}` -> `{reply}`) runs a LangChain
tool-calling agent (`app/chat/agent.py`). The LLM is Groq via
`langchain-groq`; `app/chat/llm.py` is the only module that knows that, so
switching provider is a change there.

- **Hybrid retrieval, on purpose.** Attendance questions are mostly exact
  ("how many days was X in last month", "who punched in on 25-09-2026"),
  and vector search is unreliable for counts and dates. So the agent gets
  four SQL-backed tools (`attendance_overview`, `find_employees`,
  `employee_attendance`, `attendance_on_date` in
  `app/chat/attendance_tools.py`) plus `search_attendance_records`, a
  semantic search for fuzzy questions ("who tends to arrive early").
- **What gets vectorized** (`app/chat/attendance_docs.py`): one short
  natural-language document per employee (profile, days tracked, median
  first/last punch), per attendance day in the last `ASSISTANT_INDEX_DAYS`
  (default 120), per department and per tracked date. Embeddings are
  HuggingFace (`sentence-transformers/all-MiniLM-L6-v2` by default) via the
  Inference API, into an in-memory LangChain `InMemoryVectorStore`.
- **Freshness** (`app/chat/attendance_index.py`): the index rebuilds lazily
  on the next search when attendance data or the organization time zone
  changes (a cheap fingerprint query), after an import, when the date rolls
  over in the organization zone, when the embedding model changes, or on
  `POST /chat/reindex`. Vectors are cached in the
  `assistant_embedding_cache` table (namespace = mode + model, key = sha256
  of the text), so only new or changed texts are sent to HuggingFace; the
  first build after a fresh install embeds everything once. A failed build
  isn't retried for 60 seconds. The table is pure cache and safe to
  truncate.
- **Time zone**: every date and HH:MM the assistant sees or says is in the
  organization time zone (the system prompt names it and its UTC offset),
  and "today" is today there. See [Time zones](#time-zones).
- **Meetings**: the four original meeting tools (`app/chat/meeting_tools.py`)
  are ported unchanged, including the `access.visible_emails` scoping
  (meeting timestamps are given in the organization zone).
  Attendance tools see all attendance data, the same as the attendance API.
- **Keys** (`.env`): `GROQ_API_KEY` (https://console.groq.com/keys; without
  it `/chat` returns a clear 503) and `HUGGINGFACEHUB_API_TOKEN` or
  `HF_TOKEN` (https://huggingface.co/settings/tokens, a fine-grained token
  with "Make calls to Inference Providers"; without it the chatbot still
  works, only semantic search is off). `GROQ_MODEL` defaults to
  `openai/gpt-oss-120b` (Groq has retired the Llama 3.x models); set any
  current tool-calling model instead. `GROQ_REASONING_EFFORT=low` keeps
  gpt-oss's reasoning tokens inside the free tier's 8k tokens per minute.
- **Local embeddings**: `pip install '.[local-embeddings]'` (pulls in
  sentence-transformers and torch) and set `EMBEDDINGS_MODE=local`. The
  model then runs on this machine and no HuggingFace token is needed.
- `GET /chat/status` reports whether the LLM and embeddings are configured
  and the index state, without making any network call.

## Running it

### Option A — everything in Docker (recommended)

`docker-compose.yml` runs three services:

- `db` — Postgres, on host port 5433.
- `backend` — the FastAPI app only (root `Dockerfile`). Migrations and
  demo-data seeding run automatically on start (`docker-entrypoint.sh`). Not
  published on the host.
- `frontend` — nginx (`frontend/Dockerfile`, `frontend/nginx.conf`) serving
  the built SPA at `/ui/` and proxying every other path (the API, `/auth/*`
  including the Microsoft callback, `/docs`, `/health`) to `backend`. This
  is the one public entry point, on host port 8010, so the browser sees a
  single origin: the session cookie and OAuth redirects work unchanged.

```bash
cp .env.example .env                 # fill in GROQ_API_KEY + HUGGINGFACEHUB_API_TOKEN
                                      # (chat) and MS_* vars (Microsoft sign-in)
docker compose up -d --build
```

Open http://localhost:8010/ (redirects to `/ui/`). Rebuild after pulling
changes with `docker compose up -d --build` again, or just one side with
`docker compose up -d --build backend` / `frontend`. Set
`SEED_DEMO_DATA=false` in `.env` to skip re-seeding demo data on every
start. To debug the backend, add the overlay:
`docker compose -f docker-compose.yml -f docker-compose.debug.yml up -d --build`
(debugpy on port 5678; see `.vscode/launch.json`).

### Option B — app on the host, only Postgres in Docker

Useful if you're actively developing the backend and want faster
iteration than a full image rebuild.

```bash
docker compose up -d db              # just Postgres, on host port 5433
cp .env.example .env
pip install -e .
python -m alembic upgrade head
python scripts/seed_demo_data.py         # realistic demo meetings
python scripts/seed_demo_attendance.py   # realistic demo biometric punches
python -m uvicorn app.main:app --port 8010
```

Either way: use demo login on the sign-in screen (try `daniel.kim@corp.com`
or `ava.martinez@corp.com` to see an engineer's/manager's view), or
"Sign in with Microsoft" once the `MS_*` vars are filled in — both options
are shown together, and each one always uses its own data source.

### Frontend development

Only needed if you're changing the UI itself:

```bash
cd frontend
npm install
npm run dev          # Vite dev server on :5173, proxies API calls to :8010
# ...edit frontend/src...
npm run build         # writes the production build into app/static/
```

Commit the resulting `app/static/` changes alongside your `frontend/`
source changes — that's what the running app actually serves.

## Tests

```bash
python -m pytest -q
```

Runs against a dedicated `meeting_compliance_test` database (created
automatically), never the dev DB the demo data lives in.
