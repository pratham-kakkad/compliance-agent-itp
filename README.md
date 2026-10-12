# Encop

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
- **Motion and 3D**: the UI is animated throughout (`frontend/src/motion.css`
  plus Framer Motion, and `three` for the 3D scenes):
  - `components/brand/` — the Encop logo (`Logo.tsx`: the mark, with a light
    sweep, and the wordmark as a mask so it takes the text colour; the
    panel outline for 3D is in `markShape.ts`) and the intro splash
    (`Splash.tsx`): the 3D mark spins in, the wordmark wipes in, then it lifts
    away. Once per browser session; click, Esc or Enter skips it; a CSS
    failsafe lifts it after about 7 s if scripts fail.
  - `components/three/LogoScene.tsx` — the Three.js scene (the red panel and
    stripe extruded from the logo outline with the hand floating in front,
    orbit rings, particles) used by the splash and the sign-in card, and just
    the particle field behind the orbit view. Falls back to the flat logo
    without WebGL.
  - `components/orbit/` — the **orbit dashboard**: the Dashboard's panels
    (`DeckBlock`) are shown by `BlockDeck` either as the normal grid or
    wrapped around a rotating 3D ring above a gradient-rimmed dial on the floor
    (the stage follows the theme: a pearl stage in light mode);
    the side panels recede and fade out toward the edges of the stage.
    Scroll, drag, arrow keys, the arrows, the dots or a click on a side
    panel turn it one panel at a time; **Unwrap** unrolls it into the grid
    and **Wrap into orbit** brings it back (choice remembered in
    localStorage `ic-deck-view`). Below 900 px wide the grid is always used.
  - `components/motion/` — number count-ups, cursor spotlight on cards,
    scroll-reveal. Everything respects `prefers-reduced-motion`.
- **Brand**: Encop. The logo (red panel, stripe and pointing hand, plus the
  "encop" wordmark) comes from the supplied artwork in
  `brand/encop-logo-source.png`. `python scripts/make_brand_assets.py` cuts it
  out of the black background into `brand/encop-mark.png` and
  `brand/encop-wordmark.png` (copies, the hand layer for 3D and
  `markShape.ts` go to `frontend/src/`; favicon and touch icon to
  `frontend/public/`). The palette is the logo's: signal red `#e00f14` on
  black and white, stripe red `#930d0e`, true-grey neutrals (tokens in
  `frontend/src/index.css` and `motion.css`). Surfaces are frosted glass
  (`.glass`: translucent, blurred, bright hairline edge) over a soft
  blue / violet / red backdrop in both themes; stat tiles are tinted by tone
  (`.tile`), primary buttons and the view toggle glow. Red marks interaction
  and brand; statuses stay green / amber / a deeper critical red, in-progress
  states are blue (`--info`) so they never read as failures, and charts draw
  a coral-to-violet gradient (`--series-a` / `--series-b`). The older Intuitive logo files in `brand/` are no
  longer used.

## Sign-in, users and e-mail

Three ways to sign in, all optional and independent: **e-mail + password**
(always on), "Sign in with Microsoft" (when `MS_*` are set) and demo accounts
(`ENABLE_DEMO_LOGIN`). People are matched by e-mail address, so an account
created for password sign-in keeps working if Microsoft sign-in is added later.

- **Bootstrap the first admin** (fresh install, no demo data, no Entra):

  ```
  python -m alembic upgrade head
  python scripts/create_admin.py you@company.com "Your Name"
  ```

  It creates (or updates) the person, grants the Super Admin role and prints a
  one-time link to set their password, built from `PUBLIC_BASE_URL`
  (`{PUBLIC_BASE_URL}/ui/invite/<token>`, valid 7 days, single use). Pass
  `--password "a long passphrase"` to set the password directly instead. For a
  real deployment also set `ENABLE_DEMO_LOGIN=false` and
  `COMPLIANCE_SUPER_ADMINS=` to your own addresses (the default bootstrap admin
  is the demo manager) — the demo accounts are still created in the database at
  startup, but nobody can sign in as them once demo login is off.
- **Adding people**: Administration > Users > Add user. With "Send invite" on,
  the person gets an invite link (e-mailed when SMTP is configured; always
  shown to the admin to copy). Row actions: Resend invite, Send reset link,
  Deactivate / Reactivate. Users show a status (Invited / Active / Disabled)
  and their last sign-in. Only a Super Admin can send links for a Super Admin.
- **Passwords**: min 10 characters, hashed with scrypt (standard library,
  `app/auth/passwords.py`). Invite and reset links carry a random token of which
  only the SHA-256 is stored; invites last 7 days, resets 1 hour, both are single
  use and a new link replaces the old one. After 5 wrong passwords an account is
  locked for 15 minutes, and an address that keeps failing is throttled (in
  memory, per process). Every failure shows the same message. Forgot password
  (`/ui/forgot`) always answers the same and only sends mail when the account
  exists and SMTP is set up. Signed-in users can change their password from the
  account menu.
- **E-mail (SMTP)**: `app/mailer.py` (standard library `smtplib`). Defaults come
  from `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` (`none` | `starttls` | `ssl`),
  `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`; an
  administrator can instead (or on top) configure it on Settings > Email (SMTP)
  (needs the `settings.configure` permission), which overrides the environment.
  The saved password is encrypted at rest (Fernet, key derived from
  `SESSION_SECRET`: if you change that secret, re-enter the SMTP password) and is
  never returned by the API (`password_set: true/false` only). "Send test email"
  (`POST /settings/smtp/test`) sends a real message and shows the exact error.
  Templates are in `app/email_templates.py`. People can also e-mail each other
  about compliance from templates (see "E-mailing people about their compliance").
- **Notification e-mail**: reminders and escalations were only recorded
  (`email_status = pending`); once SMTP is configured `deliver_pending`
  (`app/compliance/notify.py`) mails them after every compliance tick and on
  `POST /compliance/admin/send-pending`. Failed ones are retried up to 3 times;
  nothing is sent (and rows stay pending) while SMTP isn't configured; notices
  for inactive people, demo accounts or older than 7 days are marked `skipped`.
- Settings: `PUBLIC_BASE_URL` (default `http://localhost:8010`) is the base of
  every link in an e-mail. Endpoints: `POST /auth/password-login`,
  `GET /auth/invite/{token}`, `POST /auth/invite/accept`,
  `POST /auth/forgot-password`, `POST /auth/reset-password`,
  `POST /auth/change-password`; admin: `POST /compliance/admin/users`
  (`send_invite`), `POST /compliance/admin/users/{email}/invite`,
  `POST /compliance/admin/users/{email}/reset-password`.
- Tests: `TEST_DB_NAME=my_test_db python -m pytest` runs against a separate
  test database (default `meeting_compliance_test`), handy when several runs
  share one Postgres.

## Compliance engine

A generic engine for any compliance requirement: define it, say who it applies
to, say what proof is needed, review the proof, and handle people who don't
comply. Nothing in it is specific to one kind of compliance; "repost a LinkedIn
post", "acknowledge a policy", "upload a training certificate" are the same
machinery with different proof requirements. Code: `app/compliance/`; UI:
`frontend/src/pages/compliance/`.

### The model

| Concept | Meaning |
|---|---|
| **Compliance** | The rule: what, by when, what proof, how it is reviewed, what happens if ignored. Draft, then Active (published), Paused, Closed or Archived. |
| **Audience rules** | Who it applies to: a person, team, department, role, everyone below a manager, or the whole organization. *Include* and *exclude* rules; each carries a **participation**: *must act*, *optional* or *for information*. The strongest wins when several match; exclude beats include. |
| **Obligation** | One row per person per compliance. Status, deadline, evidence, review and escalation all hang off it, so ten assigned people are ten independent lifecycles. |
| **Submission / evidence** | What the person proved, versioned (a resubmission is a new version). Evidence slots are a schema on the compliance: text, file, link, confirmation tick-box, or one-of-a-list, each mandatory or optional, with constraints (length, file types). |
| **Review** | None (completes on submit), the person's manager, a named reviewer, or anyone allowed to review. A reviewer can never review their own submission. |

*"Created for 10 people but only 3 must act"*: give the 3 *must act* and the
others *for information*. Only *must act* people count towards progress and are
chased by escalation. A compliance's **completion rule** can be everyone who
must act, at least N, a percentage, or any one.

Lifecycle of an obligation: not started → in progress → submitted → under review
→ completed, with *changes needed* sending it back, and *waived* / *cancelled*
as exits. *Overdue* and *non-compliant* are flags on top of that, not extra
states. Editing a published compliance creates a **new version**; people keep the
rules they were assigned under unless the editor chooses to move them.

### Access control

- **Roles** hold grants of `resource + action + scope`. Resources: dashboard,
  compliance, submission, user, team, role, report, analytics, settings,
  audit_log (plus meeting / attendance compliance, which only control the menu).
  Actions: view, create, edit, delete, assign, approve, reject, submit, export,
  configure, waive. **Scopes**: self, direct reports, whole reporting line, team,
  department, organization, or "records I created".
- Built-in roles (editable, not deletable): **Super Admin**, **Compliance Admin**,
  **Compliance Manager**, **Manager** (held automatically by anyone with direct
  reports), **Employee** (held by everyone), **Auditor**. Create your own on
  *Roles & access*.
- **Per-person overrides** add one allow or one deny; a deny always wins.
- **Record rules** are row-level conditions on top of scopes: *allow* rules widen
  what a role sees, *restrictive* rules narrow it (e.g. "managers never see
  category HR"). They are structured data, never SQL.
- `COMPLIANCE_SUPER_ADMINS` (comma-separated e-mails; default is the demo
  manager) are always Super Admins, so a fresh install has someone who can set up
  access. **Set it to your own administrators in production.**
- Every endpoint goes through one policy object (`app/compliance/policy.py`);
  every list, count and chart takes its row filter from it, so a manager's
  dashboard only describes their own people. A request for a record you can't
  see answers 404, the same as for one that doesn't exist.

### Non-compliance and escalation

Each compliance carries escalation rules (data, not code): a trigger (*N days
before the deadline*, *on the deadline*, *N days after*, *rejected for N days*,
*review waiting N days*) and actions (remind the person, tell the manager or the
management chain, notify named people, nudge reviewers, mark non-compliant, flag
as a defaulter). Presets: *Standard*, *Strict*, *None*. A background pass runs
every `COMPLIANCE_TICK_MINUTES` (also *Audit log → Run deadline check now*) and
each action fires at most once per person (unique key in `escalation_log`), so
restarts and retries never double-send. The **defaulter scoreboard** ranks people
by incidents (late, overdue, non-compliant or flagged), weighted by priority;
three or more makes a repeat offender, and a manager only sees their own line.

### Audit and notifications

Every important action writes an `audit_events` row in the same transaction
(who, what, which record, before and after). The table rejects UPDATE and DELETE
in the database itself, and each row stores a hash chained to the previous one;
*Audit log → Verify integrity* recomputes the chain. In-app notifications are
real (bell in the header); e-mail is recorded as intent
(`notifications.email_status = 'pending'`) for a sender to pick up later.

### E-mailing people about their compliance

A reviewer, manager or admin can e-mail a person, a team, a department or the
assignees of one compliance (a warning, a reminder, a thank-you) from reusable
**e-mail templates**, preview exactly what each person will get, and send. Code:
`app/compliance/messaging.py` (templates, variables, recipients, sending),
`app/compliance/mail_api.py` (HTTP), `app/email_templates.py`
(`compliance_message_email`, the branded layout); UI: *Administration → Email
templates* and the **Email** / **Send a warning** buttons (one reusable dialog,
`frontend/src/components/compliance/email/SendEmailDialog.tsx`) on the item page,
the compliance's People tab (select people, or quick-select all overdue / not
started / rejected), the scoreboard (a person, or all repeat offenders), a user's
page (with their sent-mail history), teams and departments, and the review queue.

- **Templates.** Five built-in ones (Friendly reminder, Formal warning, Final
  notice, Request for status update, Thank you), editable, never deletable, with
  *Reset to default*; add your own, duplicate, turn off. Each has a kind
  (reminder, warning, final, request, thanks, custom) that only sets its colour.
  Plain text, blank line = new paragraph, lines starting with a bullet or a dash
  become a list. The HTML is the Encop layout with an "Open in Encop" button and a
  plain-text part; every value is HTML-escaped.
- **Variables** are `{{name}}` and are filled by one regex pass (nothing is ever
  evaluated). `GET /compliance/email-variables` lists them (the *Insert variable*
  menu): `name`, `first_name`, `email`, `manager_name`, `sender_name`,
  `sender_email`, `org_name`, `today`, `compliance_name`, `category`, `priority`,
  `due_date`, `days_overdue`, `days_until_due`, `status`, `link`, `open_items`
  (bullet list), `open_count`, `overdue_count`. Written about one item they describe
  that item; written to a person they summarise the person's open items ("3 open
  compliance items", earliest deadline...). An unknown `{{name}}` is refused when
  saving a template and blocks a send; the preview flags it.
- **Who may send.** Anyone holding at least one of `compliance.assign`,
  `compliance.edit`, `submission.approve` or `submission.reject`, and **every
  recipient must be inside the scope of one of those permissions the sender holds**
  (the union of the scopes; Super Admins reach everyone). Recipients are always
  resolved on the server; a client-provided list is only a request, so a manager
  cannot e-mail outside their reporting line even by crafting the request. Managing
  templates needs `compliance.configure` (Super Admin, Compliance Admin); any sender
  can use the active templates. No new permission exists, so already-seeded
  databases need no change. Reading the sent-mail history needs a send permission,
  `compliance.configure` or `audit_log.view`, and shows mail the viewer sent plus
  mail to people (and about items) they may see.
- **Skipped, with a reason:** outside your scope, inactive, demo account (fake
  address), no e-mail address, yourself, listed twice, and (for reminders,
  warnings, final notices and requests about a *person*) nothing open to chase.
  One batch is at most 200 people; one sender may e-mail 500 people an hour; a
  warning or final notice to more than 20 people needs an explicit confirm (checked
  by the server too). SMTP must be configured (Settings → Email), otherwise the
  send answers 409 and says where to fix it.
- **Sending** never holds a request open: `POST /compliance/emails/send` records a
  `sent_emails` row per recipient (`queued`, or `skipped` with the reason), returns a
  `batch_id` and a background task sends them one by one, committing each row. A
  failure is recorded with the mail server's message and is never retried
  automatically; one failure doesn't stop the rest, but three connection or login
  failures in a row stop the batch (the rest are marked skipped). Poll
  `GET /compliance/emails/batches/{batch_id}` for sent / failed / skipped. A batch
  lost to a restart shows its unsent rows as failed after 15 minutes. Options: cc
  each person's manager (when they have one), send the sender a copy (a Bcc for one
  person, one summary mail for many), and also add an in-app notice (kind
  `message`, under the bell; not mailed a second time). Replies go to the sender.
- **Audit.** `email.batch_started` / `email.batch_finished` (who, template,
  recipient count, batch id, counts; never the body) and `email_template.*`
  events. The full text of every message is in `sent_emails`.
- **Endpoints.** `GET /compliance/email-templates` (active), `GET
  /compliance/email-variables`, `POST /compliance/emails/preview`,
  `POST /compliance/emails/send`, `GET /compliance/emails/batches/{id}`,
  `GET /compliance/emails/history?person=&obligation_id=&compliance_id=&batch_id=`;
  admin: `GET|POST /compliance/admin/email-templates`,
  `PATCH|DELETE /compliance/admin/email-templates/{id}`, `POST .../{id}/reset`,
  `POST .../preview` (sample data), `POST .../test` (sends to your own address).
  Recipients are `{emails}`, `{team_id}`, `{department_id}`,
  `{compliance_id, status, only}` or `{obligation_id}`, plus `exclude`.

### Evidence files

Stored on disk under `EVIDENCE_DIR` (a Docker volume), metadata in the database.
Extension allow-list, size limit (`EVIDENCE_MAX_MB`), content must match the
extension, duplicates across people are flagged to the reviewer, downloads go
through an authorized endpoint as attachments. **No virus scanner is wired in
yet**: `app/compliance/evidence.py: scan()` is the hook, and files carry
`scan_status = not_scanned` until you add one.

### API

Everything is under `/compliance` (user-facing) and `/compliance/admin`
(users, departments and teams, roles, record rules, audit, scheduler); the full
list is in the interactive docs at `/docs`. Sign-in is the app's existing one
(Microsoft work account or demo login); *Administration → Users* pre-provisions
people, there are no local passwords.

### Not built yet

Recurring (repeating) compliances, saving a draft submission, an e-mail sender,
a virus scanner, automatic verifiers that complete a compliance by themselves
(the hook is `compliance_types.verifier_key`; Meetings and Attendance are not
yet expressed as compliance types), delegation while a reviewer is away, legal
hold / retention rules, MFA. Meetings and Attendance keep their own access rules;
the permissions for them only control menu visibility.

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
