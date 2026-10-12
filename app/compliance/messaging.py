"""Manual compliance e-mail: a reviewer, manager or admin e-mails a person, a team,
a department or the assignees of one compliance, using reusable templates.

Pieces, in the order a message travels:

- **Templates and variables.** Plain text with {{variables}} and blank-line
  paragraphs. Rendering is one regex pass (no code is ever evaluated); unknown
  names stay visible so they can be flagged, and are refused on save and on send.
- **Recipients.** Resolved on the server, never trusted from the client, and cut
  down to the people the sender may reach (policy scopes). Inactive people, demo
  accounts and duplicates are skipped with a reason.
- **Sending.** `queue_batch` writes one `sent_emails` row per recipient (status
  "queued", or "skipped" with the reason) and `run_batch` -- run as a background
  task -- sends them one by one, committing each row as it is handled. A failure
  is recorded and never retried; the batch stops only after several connection
  failures in a row.

The HTTP layer is in mail_api.py.
"""
import contextlib
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone, tzinfo

from sqlalchemy import and_, func, or_, select, true
from sqlalchemy.orm import Session

from app import email_templates, mailer
from app.compliance import audit, catalog, engine, notify
from app.compliance.models import (
    Compliance,
    Department,
    EmailTemplate,
    Obligation,
    SentEmail,
    Team,
    TeamMember,
)
from app.compliance.policy import Ctx
from app.database import SessionLocal
from app.models import OrgUser

log = logging.getLogger("app.compliance.messaging")

KINDS = ("reminder", "warning", "final", "request", "thanks", "custom")
KIND_LABEL = {
    "reminder": "Reminder",
    "warning": "Warning",
    "final": "Final notice",
    "request": "Request",
    "thanks": "Thank you",
    "custom": "Custom",
}

CHASING_KINDS = ("reminder", "warning", "final", "request")  # kinds that assume something is still open
MAX_RECIPIENTS = 200  # one batch
RATE_LIMIT_PER_HOUR = 500  # recipients one person may e-mail per hour
LARGE_BATCH = 20  # a warning / final notice to more people than this needs an explicit confirm
STOP_AFTER_FAILURES = 3  # consecutive connection / login failures that stop a batch
STALE_AFTER = timedelta(minutes=15)  # a "queued" row older than this was lost in a restart
PREVIEW_COUNT = 5
MAX_SUBJECT = 200
MAX_BODY = 8000
MAX_LIST_LINES = 25

# The permissions that let someone e-mail people about compliance: assigning or
# editing it, or reviewing (approving / rejecting) submissions. Each recipient
# must be inside the scope of at least one of those the sender holds.
SEND_PERMISSIONS = (
    ("compliance", "assign"),
    ("compliance", "edit"),
    ("submission", "approve"),
    ("submission", "reject"),
)

STATUS_LABEL = {
    "not_started": "Not started",
    "in_progress": "In progress",
    "submitted": "Submitted",
    "under_review": "Under review",
    "rejected": "Changes needed",
    "completed": "Completed",
    "waived": "Waived",
    "cancelled": "Cancelled",
}
PRIORITY_LABEL = {"low": "Low", "medium": "Medium", "high": "High", "critical": "Critical"}

SKIP_LABEL = {
    "outside_scope": "Outside your scope",
    "duplicate": "Listed more than once",
    "inactive": "Account is inactive",
    "demo": "Demo account (no real mailbox)",
    "no_email": "No e-mail address",
    "self": "That is you",
    "nothing_open": "Nothing open to follow up",
    "stopped": "Not attempted: the batch stopped after repeated mail server failures",
}

# ------------------------------------------------------------------ variables

# group, name, label, description, example. The UI shows these as an "Insert variable" menu.
_V = [
    ("Person", "name", "Full name", "The recipient's full name.", "Alex Morgan"),
    ("Person", "first_name", "First name", "The recipient's first name.", "Alex"),
    ("Person", "email", "E-mail", "The recipient's e-mail address.", "alex.morgan@example.com"),
    ("Person", "manager_name", "Manager's name", "Name of the recipient's manager (empty when they have none).", "Sam Rivera"),
    ("You", "sender_name", "Your name", "The name of the person sending the message.", "Jordan Lee"),
    ("You", "sender_email", "Your e-mail", "Your e-mail address (replies go here).", "jordan.lee@example.com"),
    ("General", "org_name", "Organization", "The platform name.", "Encop"),
    ("General", "today", "Today's date", "Today's date in the organization's time zone.", "9 Oct 2026"),
    ("Compliance item", "compliance_name", "Compliance name", "The compliance this is about. When you e-mail a person rather than one item it becomes a summary such as \"3 open compliance items\".", "Annual Security Training"),
    ("Compliance item", "category", "Category", "The compliance's category.", "Training"),
    ("Compliance item", "priority", "Priority", "The compliance's priority (the highest one when several items are open).", "High"),
    ("Compliance item", "due_date", "Due date", "The deadline (the earliest one when several items are open).", "6 Oct 2026"),
    ("Compliance item", "days_overdue", "Days overdue", "Whole days past the deadline; 0 when it is not overdue.", "3"),
    ("Compliance item", "days_until_due", "Days until due", "Whole days left until the deadline; 0 when it is due today or overdue.", "0"),
    ("Compliance item", "status", "Status", "Where the item stands, e.g. Not started, Under review.", "Not started"),
    ("Compliance item", "link", "Link", "A link that opens the item (or the person's list) in Encop.", "https://encop.example.com/ui/compliance/mine"),
    ("Open items", "open_items", "Open items (list)", "A bullet list of the open and overdue items (name, due date, status), limited to what you may see. In a message about one item it lists just that item.", "• Annual Security Training: due 6 Oct 2026, 3 days overdue (Not started)"),
    ("Open items", "open_count", "Open items (count)", "How many items are in that list.", "1"),
    ("Open items", "overdue_count", "Overdue items (count)", "How many of them are overdue.", "1"),
]
VARIABLES = [
    {"group": g, "name": n, "label": label, "description": d, "example": ex, "token": "{{" + n + "}}"}
    for g, n, label, d, ex in _V
]
VAR_NAMES = frozenset(v["name"] for v in VARIABLES)

_VAR = re.compile(r"\{\{\s*([^{}]*?)\s*\}\}")


def variables_in(*texts: str) -> list[str]:
    """Every distinct {{name}} in the texts, in order of appearance."""
    seen: dict[str, None] = {}
    for t in texts:
        for m in _VAR.finditer(t or ""):
            seen.setdefault(m.group(1), None)
    return list(seen)


def unknown_variables(*texts: str) -> list[str]:
    return [n for n in variables_in(*texts) if n not in VAR_NAMES]


def render(text: str, values: dict[str, str]) -> tuple[str, list[str]]:
    """Substitute {{variables}} in one pass; returns (text, unresolved names).
    A name that is unknown, or has no value, stays as written."""
    unresolved: list[str] = []

    def sub(m: re.Match) -> str:
        name = m.group(1)
        if name in VAR_NAMES and name in values:
            return str(values[name])
        if name not in unresolved:
            unresolved.append(name)
        return m.group(0)

    return _VAR.sub(sub, text or ""), unresolved


def _one_line(s: str) -> str:
    return " ".join(str(s).split())


# ------------------------------------------------------------------ templates

DEFAULT_TEMPLATES: list[dict] = [
    {
        "key": "friendly-reminder",
        "name": "Friendly reminder",
        "kind": "reminder",
        "description": "A light, no-pressure nudge before or around the deadline.",
        "subject": "Friendly reminder: {{compliance_name}}",
        "body": (
            "Hi {{first_name}},\n\n"
            "This is a friendly reminder about {{compliance_name}}. Here is where things stand:\n"
            "{{open_items}}\n\n"
            "If it is already done, thank you. Please check that your proof has been submitted in Encop so it shows as complete. "
            "If something is getting in the way, just reply to this e-mail and we will sort it out together.\n\n"
            "Thank you,\n"
            "{{sender_name}}"
        ),
    },
    {
        "key": "formal-warning",
        "name": "Formal warning",
        "kind": "warning",
        "description": "States the facts, the deadline, what happens next and how to resolve it. Calm and specific.",
        "subject": "Formal warning: {{compliance_name}}",
        "body": (
            "Dear {{name}},\n\n"
            "I am writing about {{compliance_name}}. The deadline was {{due_date}} and our records show it has not been completed. "
            "Here is the current position:\n"
            "{{open_items}}\n\n"
            "Please finish the outstanding steps in Encop within the next 3 working days. "
            "If it is still open after that, it may be recorded as non-compliant and your manager will be informed.\n\n"
            "If something is preventing you from completing it, or you believe this is a mistake, please reply to this e-mail and tell me. "
            "I am happy to help, or to agree a new date if there is a good reason.\n\n"
            "Thank you,\n"
            "{{sender_name}}"
        ),
    },
    {
        "key": "final-notice",
        "name": "Final notice (escalation)",
        "kind": "final",
        "description": "The last step before an item is recorded as non-compliant and escalated.",
        "subject": "Final notice: {{compliance_name}}",
        "body": (
            "Dear {{name}},\n\n"
            "This is a final notice about {{compliance_name}}. We asked for it by {{due_date}} and it is now {{days_overdue}} day(s) overdue. "
            "Here is the current position:\n"
            "{{open_items}}\n\n"
            "Unless it is completed in Encop by the end of tomorrow, it will be recorded as non-compliant and escalated to your manager "
            "and the compliance team.\n\n"
            "We would much rather resolve this with you. If something is in the way, or you need more time, please reply to this e-mail today "
            "and we can agree a way forward.\n\n"
            "Thank you,\n"
            "{{sender_name}}"
        ),
    },
    {
        "key": "status-update-request",
        "name": "Request for status update",
        "kind": "request",
        "description": "Asks for a quick progress note without implying anything is wrong.",
        "subject": "Quick update please: {{compliance_name}}",
        "body": (
            "Hi {{first_name}},\n\n"
            "Could you give me a quick update on {{compliance_name}}? It is due on {{due_date}} and Encop currently shows:\n"
            "{{open_items}}\n\n"
            "A one-line reply is plenty: are you on track, and is there anything blocking you or anything I can help with? "
            "If it is already done, please make sure your proof has been submitted in Encop.\n\n"
            "Thank you,\n"
            "{{sender_name}}"
        ),
    },
    {
        "key": "thank-you",
        "name": "Thank you for completing",
        "kind": "thanks",
        "description": "Recognition once something is done.",
        "subject": "Thank you: {{compliance_name}}",
        "body": (
            "Hi {{first_name}},\n\n"
            "Thank you for completing {{compliance_name}}. Encop shows it as: {{status}}, and there is nothing more you need to do for it.\n\n"
            "I appreciate you taking the time. It makes the whole team's work easier.\n\n"
            "Thank you again,\n"
            "{{sender_name}}"
        ),
    },
]
_DEFAULT_BY_KEY = {t["key"]: t for t in DEFAULT_TEMPLATES}


def seed_email_templates(db: Session) -> None:
    """Create the built-in templates that are missing (by key). Runs at every
    start and never overwrites what an administrator edited."""
    have = {k for k in db.scalars(select(EmailTemplate.key))}
    added = False
    for t in DEFAULT_TEMPLATES:
        if t["key"] in have:
            continue
        db.add(EmailTemplate(**t, is_system=True, active=True, created_by=None))
        added = True
    if added:
        db.commit()


class TemplateError(ValueError):
    """Invalid template input; the message is for people."""


def validate_template(name: str, kind: str, subject: str, body: str, description: str = "") -> None:
    if len(description) > 300:
        raise TemplateError("Keep the description under 300 characters")
    if not name.strip():
        raise TemplateError("A template needs a name")
    if len(name.strip()) > 80:
        raise TemplateError("Keep the name under 80 characters")
    if kind not in KINDS:
        raise TemplateError(f"Kind must be one of: {', '.join(KINDS)}")
    if not subject.strip():
        raise TemplateError("A template needs a subject")
    if "\n" in subject or "\r" in subject:
        raise TemplateError("The subject must be a single line")
    if len(subject) > MAX_SUBJECT:
        raise TemplateError(f"Keep the subject under {MAX_SUBJECT} characters")
    if not body.strip():
        raise TemplateError("A template needs a message")
    if len(body) > MAX_BODY:
        raise TemplateError(f"Keep the message under {MAX_BODY} characters")
    bad = unknown_variables(subject, body)
    if bad:
        shown = ", ".join("{{" + b + "}}" for b in bad)
        raise TemplateError(
            f"Unknown variable{'s' if len(bad) > 1 else ''}: {shown}. Use \"Insert variable\" to pick one from the list."
        )


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s[:50] or "template"


def unique_key(db: Session, name: str) -> str:
    base = _slug(name)
    key, n = base, 2
    while db.scalar(select(EmailTemplate.id).where(EmailTemplate.key == key)) is not None:
        key = f"{base}-{n}"
        n += 1
    return key


def is_modified(t: EmailTemplate) -> bool:
    """A system template that no longer matches its built-in default."""
    d = _DEFAULT_BY_KEY.get(t.key)
    if not t.is_system or d is None:
        return False
    return (t.name, t.description, t.kind, t.subject, t.body, t.active) != (
        d["name"], d["description"], d["kind"], d["subject"], d["body"], True,
    )


def template_dict(t: EmailTemplate) -> dict:
    return {
        "id": str(t.id),
        "key": t.key,
        "name": t.name,
        "description": t.description,
        "kind": t.kind,
        "subject": t.subject,
        "body": t.body,
        "is_system": t.is_system,
        "active": t.active,
        "modified": is_modified(t),
        "variables": [v for v in variables_in(t.subject, t.body) if v in VAR_NAMES],
        "created_by": t.created_by,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


def reset_template(t: EmailTemplate) -> None:
    d = _DEFAULT_BY_KEY.get(t.key)
    if not t.is_system or d is None:
        raise TemplateError("Only the built-in templates have a default to go back to")
    t.name, t.description, t.kind, t.subject, t.body, t.active = (
        d["name"], d["description"], d["kind"], d["subject"], d["body"], True,
    )


# ------------------------------------------------------------- open items etc.


@dataclass
class OpenItem:
    obligation_id: uuid.UUID
    compliance_id: uuid.UUID
    name: str
    category: str
    priority: str
    status: str
    due_at: datetime | None
    overdue: bool = False


def _aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def fmt_date(dt: datetime, tz: tzinfo) -> str:
    d = dt.astimezone(tz)
    return f"{d.day} {d.strftime('%b %Y')}"


def _day(dt: datetime, tz: tzinfo):
    return dt.astimezone(tz).date()


def item_from(ob: Obligation, c: Compliance, now: datetime) -> OpenItem:
    due = _aware(ob.due_at)
    return OpenItem(
        obligation_id=ob.id,
        compliance_id=c.id,
        name=c.name,
        category=c.category,
        priority=c.priority,
        status=ob.status,
        due_at=due,
        overdue=bool(ob.status in catalog.OPEN and due is not None and now > due),
    )


def _days_overdue(it: OpenItem, now: datetime, tz: tzinfo) -> int:
    if not it.overdue or it.due_at is None:
        return 0
    return max(0, (_day(now, tz) - _day(it.due_at, tz)).days)


def _days_until(it: OpenItem, now: datetime, tz: tzinfo) -> int:
    if it.due_at is None or it.overdue:
        return 0
    return max(0, (_day(it.due_at, tz) - _day(now, tz)).days)


def _plural(n: int, one: str, many: str) -> str:
    return one if n == 1 else many


def item_line(it: OpenItem, now: datetime, tz: tzinfo) -> str:
    status = STATUS_LABEL.get(it.status, it.status)
    if it.due_at is None:
        return f"• {it.name} ({status})"
    when = f"due {fmt_date(it.due_at, tz)}"
    if it.overdue:
        n = _days_overdue(it, now, tz)
        when += f", {n} {_plural(n, 'day', 'days')} overdue" if n else ", overdue"
    return f"• {it.name}: {when} ({status})"


def open_items_for(db: Session, ctx: Ctx, emails: set[str], now: datetime) -> dict[str, list[OpenItem]]:
    """Each person's open items (they must act on them), limited to what the sender may see."""
    out: dict[str, list[OpenItem]] = {}
    if not emails:
        return out
    obs = list(
        db.scalars(
            select(Obligation)
            .where(
                ctx.obligation_clause("submission", "view"),
                Obligation.user_email.in_(emails),
                Obligation.status.in_(catalog.OPEN),
                Obligation.participation != "informational",
            )
            .order_by(Obligation.due_at.asc().nulls_last(), Obligation.created_at)
        )
    )
    comps = {c.id: c for c in db.scalars(select(Compliance).where(Compliance.id.in_({o.compliance_id for o in obs} or {uuid.uuid4()})))}
    for ob in obs:
        c = comps.get(ob.compliance_id)
        if c is None or c.status not in ("published", "paused"):
            continue
        out.setdefault(ob.user_email, []).append(item_from(ob, c, now))
    return out


def first_name(name: str) -> str:
    parts = (name or "").split()
    return parts[0] if parts else ""


def build_values(
    *,
    user: OrgUser,
    manager_name: str,
    sender: OrgUser,
    items: list[OpenItem],
    single: OpenItem | None,
    link: str,
    now: datetime,
    tz: tzinfo,
) -> dict[str, str]:
    """Every variable for one recipient. `single` is the item the message is about
    (None: the message is about the person, so the item variables summarise `items`)."""
    shown = [single] if single is not None else items
    if single is not None:
        item_vals = {
            "compliance_name": single.name,
            "category": single.category,
            "priority": PRIORITY_LABEL.get(single.priority, single.priority),
            "due_date": fmt_date(single.due_at, tz) if single.due_at else "no deadline",
            "days_overdue": str(_days_overdue(single, now, tz)),
            "days_until_due": str(_days_until(single, now, tz)),
            "status": STATUS_LABEL.get(single.status, single.status),
        }
    elif items:
        n = len(items)
        dues = [i.due_at for i in items if i.due_at is not None]
        cats = {i.category for i in items}
        rank = {p: k for k, p in enumerate(catalog.PRIORITIES)}
        top = max(items, key=lambda i: rank.get(i.priority, 0)).priority
        late = [_days_overdue(i, now, tz) for i in items if i.overdue]
        ahead = [_days_until(i, now, tz) for i in items if not i.overdue and i.due_at is not None]
        item_vals = {
            "compliance_name": items[0].name if n == 1 else f"{n} open compliance items",
            "category": next(iter(cats)) if len(cats) == 1 else "several categories",
            "priority": PRIORITY_LABEL.get(top, top),
            "due_date": fmt_date(min(dues), tz) if dues else "no deadline",
            "days_overdue": str(max(late) if late else 0),
            "days_until_due": str(min(ahead) if ahead else 0),
            "status": (STATUS_LABEL.get(items[0].status, items[0].status) if n == 1 else ("Overdue" if late else "Open")),
        }
    else:
        item_vals = {
            "compliance_name": "your compliance items",
            "category": "",
            "priority": "",
            "due_date": "no deadline",
            "days_overdue": "0",
            "days_until_due": "0",
            "status": "Up to date",
        }
    lines = [item_line(i, now, tz) for i in shown[:MAX_LIST_LINES]]
    if len(shown) > MAX_LIST_LINES:
        lines.append(f"• …and {len(shown) - MAX_LIST_LINES} more")
    return {
        "name": _one_line(user.name),
        "first_name": _one_line(first_name(user.name)),
        "email": user.email,
        "manager_name": _one_line(manager_name),
        "sender_name": _one_line(sender.name),
        "sender_email": sender.email,
        "org_name": "Encop",
        "today": fmt_date(now, tz),
        "link": link,
        "open_items": "\n".join(lines) if lines else "• Nothing is open right now.",
        "open_count": str(len(shown)),
        "overdue_count": str(sum(1 for i in shown if i.overdue)),
        **{k: _one_line(v) for k, v in item_vals.items()},
    }


def sample_values(sender: OrgUser, now: datetime, tz: tzinfo) -> dict[str, str]:
    """Made-up data for the template editor's preview and "send me a test"."""
    from app.auth.local import app_url

    due = now - timedelta(days=3)
    items = [
        OpenItem(uuid.uuid4(), uuid.uuid4(), "Annual Security Training", "Training", "high", "not_started", due, True),
        OpenItem(uuid.uuid4(), uuid.uuid4(), "Acknowledge the Information Security Policy", "Policy", "medium", "in_progress", now + timedelta(days=4), False),
    ]
    user = OrgUser(email="alex.morgan@example.com", name="Alex Morgan", title="", is_demo=True)
    return build_values(
        user=user, manager_name="Sam Rivera", sender=sender, items=items, single=items[0],
        link=app_url("/compliance/mine"), now=now, tz=tz,
    )


# ----------------------------------------------------------------- recipients


@dataclass
class SendScope:
    everyone: bool
    emails: frozenset[str]

    def allows(self, email: str) -> bool:
        return self.everyone or email in self.emails


def can_send(ctx: Ctx) -> bool:
    return any(ctx.can(r, a) for r, a in SEND_PERMISSIONS)


def send_scope(ctx: Ctx) -> SendScope:
    """The people the sender may e-mail: the union of the scopes of the send
    permissions they hold (ctx.person_in_scope for each, in one set)."""
    if ctx.is_super:
        return SendScope(True, frozenset())
    emails: set[str] = set()
    for r, a in SEND_PERMISSIONS:
        sc = ctx.scope(r, a)
        if sc.everyone:
            return SendScope(True, frozenset())
        emails |= set(sc.emails)
    return SendScope(False, frozenset(emails))


class RecipientError(Exception):
    """The way of picking recipients is invalid; (status code, message)."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


STATUS_FILTERS = ("all", "open", "overdue", "not_started", "rejected")


@dataclass
class Recipient:
    user: OrgUser
    obligation: Obligation | None = None
    compliance: Compliance | None = None


@dataclass
class Skipped:
    email: str
    name: str
    reason: str

    @property
    def label(self) -> str:
        return SKIP_LABEL.get(self.reason, self.reason)


@dataclass
class Resolution:
    recipients: list[Recipient] = field(default_factory=list)
    skipped: list[Skipped] = field(default_factory=list)
    source: dict = field(default_factory=dict)


def _pick_one(spec: dict) -> str:
    chosen = [k for k in ("emails", "team_id", "department_id", "compliance_id", "obligation_id") if spec.get(k)]
    if len(chosen) != 1:
        raise RecipientError(422, "Choose who to e-mail: specific people, a team, a department, or the people assigned to a compliance")
    return chosen[0]


def _uuid(value: str, what: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        raise RecipientError(404, f"No such {what}")


def resolve_recipients(ctx: Ctx, spec: dict, exclude: set[str] | None = None) -> Resolution:
    """Work out who a send would reach. `spec` has exactly one of: emails, team_id,
    department_id, compliance_id (+ optional status), obligation_id. Everything is
    looked up here; a client-provided list is only ever a list of *requests*, each
    one checked against the sender's scope."""
    db = ctx.db
    kind = _pick_one(spec)
    scope = send_scope(ctx)
    now = engine.now()
    res = Resolution()
    candidates: list[tuple[str, OrgUser | None, Obligation | None, Compliance | None]] = []  # (requested email, user, ob, compliance)

    if kind == "emails":
        wanted = [str(e).strip() for e in spec["emails"] if str(e).strip()]
        if not wanted:
            raise RecipientError(422, "Choose at least one person")
        by_lower = {
            u.email.lower(): u
            for u in db.scalars(select(OrgUser).where(func.lower(OrgUser.email).in_({w.lower() for w in wanted})))
        }
        for w in wanted:
            candidates.append((w, by_lower.get(w.lower()), None, None))
        res.source = {"type": "people", "count": len(wanted)}
    elif kind in ("team_id", "department_id"):
        if kind == "team_id":
            t = db.get(Team, _uuid(spec["team_id"], "team"))
            if t is None:
                raise RecipientError(404, "No such team")
            emails = set(db.scalars(select(TeamMember.user_email).where(TeamMember.team_id == t.id)))
            if t.lead_email:
                emails.add(t.lead_email)
            res.source = {"type": "team", "id": str(t.id), "name": t.name}
        else:
            d = db.get(Department, _uuid(spec["department_id"], "department"))
            if d is None:
                raise RecipientError(404, "No such department")
            emails = set(db.scalars(select(OrgUser.email).where(OrgUser.department_id == d.id)))
            res.source = {"type": "department", "id": str(d.id), "name": d.name}
        users = list(db.scalars(select(OrgUser).where(OrgUser.email.in_(emails or {""})).order_by(OrgUser.name)))
        for u in users:
            candidates.append((u.email, u, None, None))
    elif kind == "compliance_id":
        cid = _uuid(spec["compliance_id"], "compliance")
        c = db.get(Compliance, cid)
        if c is None or not ctx.can_see_compliance(cid, "view"):
            raise RecipientError(404, "No such compliance")
        flt = spec.get("status") or "all"
        if flt not in STATUS_FILTERS:
            raise RecipientError(422, f"Status must be one of: {', '.join(STATUS_FILTERS)}")
        cond = [
            Obligation.compliance_id == cid,
            Obligation.participation != "informational",
            ctx.obligation_clause("submission", "view"),
        ]
        if flt == "open":
            cond.append(Obligation.status.in_(catalog.OPEN))
        elif flt == "overdue":
            cond += [Obligation.status.in_(catalog.OPEN), Obligation.due_at.is_not(None), Obligation.due_at < now]
        elif flt in ("not_started", "rejected"):
            cond.append(Obligation.status == flt)
        else:
            cond.append(Obligation.status != "cancelled")
        only = {str(e).strip().lower() for e in (spec.get("only") or []) if str(e).strip()}
        if only:  # a hand-picked subset of this compliance's assignees
            cond.append(func.lower(Obligation.user_email).in_(only))
        obs = list(db.scalars(select(Obligation).where(*cond)))
        users = {u.email: u for u in db.scalars(select(OrgUser).where(OrgUser.email.in_({o.user_email for o in obs} or {""})))}
        for ob in sorted(obs, key=lambda o: (users[o.user_email].name.lower() if o.user_email in users else o.user_email)):
            candidates.append((ob.user_email, users.get(ob.user_email), ob, c))
        res.source = {"type": "compliance", "id": str(c.id), "name": c.name, "status": flt, **({"selected": len(only)} if only else {})}
    else:  # obligation_id
        oid = _uuid(spec["obligation_id"], "item")
        ob = db.get(Obligation, oid)
        if ob is None or not ctx.can_see_obligation(oid):
            raise RecipientError(404, "No such item")
        c = db.get(Compliance, ob.compliance_id)
        candidates.append((ob.user_email, db.get(OrgUser, ob.user_email), ob, c))
        res.source = {"type": "obligation", "id": str(ob.id), "name": c.name if c else ""}

    excluded = {e.lower() for e in (exclude or set())}
    seen: set[str] = set()
    masked = kind in ("team_id", "department_id", "compliance_id")  # don't name people the sender can't reach
    for requested, user, ob, c in candidates:
        email = user.email if user is not None else requested
        if email.lower() in excluded:
            continue
        if user is None or not scope.allows(user.email):
            # Unknown addresses and out-of-scope ones look the same, so this can't be used to probe who exists.
            res.skipped.append(Skipped("" if masked else requested, "Someone outside your scope" if masked else requested, "outside_scope"))
            continue
        key = user.email.lower()
        if key in seen:
            res.skipped.append(Skipped(user.email, user.name, "duplicate"))
            continue
        seen.add(key)
        if user.email.lower() == ctx.email.lower():
            res.skipped.append(Skipped(user.email, user.name, "self"))
        elif not user.is_active:
            res.skipped.append(Skipped(user.email, user.name, "inactive"))
        elif user.is_demo:
            res.skipped.append(Skipped(user.email, user.name, "demo"))
        elif "@" not in (user.email or "") or " " in user.email:
            res.skipped.append(Skipped(user.email, user.name, "no_email"))
        else:
            res.recipients.append(Recipient(user, ob, c))
    return res


# -------------------------------------------------------------------- drafting


@dataclass
class Draft:
    subject: str
    body: str
    kind: str = "custom"
    template_id: uuid.UUID | None = None
    template_name: str = "Custom message"
    edited: bool = False

    @property
    def empty(self) -> bool:
        return not self.subject.strip() and not self.body.strip()


def load_draft(ctx: Ctx, template_id: str | None, subject: str | None, body: str | None) -> Draft:
    db = ctx.db
    t = None
    if template_id:
        t = db.get(EmailTemplate, _uuid(template_id, "template"))
        if t is None or (not t.active and not ctx.can("compliance", "configure")):
            raise RecipientError(404, "No such template")
    d = Draft(
        subject=(subject if subject is not None else (t.subject if t else "")),
        body=(body if body is not None else (t.body if t else "")),
    )
    if t is not None:
        d.kind, d.template_id, d.template_name = t.kind, t.id, t.name
        d.edited = (d.subject, d.body) != (t.subject, t.body)
    return d


@dataclass
class Rendered:
    recipient: Recipient
    subject: str
    body: str
    link: str
    unresolved: list[str]
    cc: list[str]
    items: list[OpenItem]


def render_all(ctx: Ctx, res: Resolution, draft: Draft, *, cc_manager: bool) -> list[Rendered]:
    from app.auth.local import app_url
    from app.org_settings.service import get_timezone

    db = ctx.db
    now = engine.now()
    tz = get_timezone(db)
    people = {r.user.email for r in res.recipients}
    open_map = open_items_for(db, ctx, people, now)
    mgr_emails = {r.user.manager_email for r in res.recipients if r.user.manager_email}
    managers = {u.email: u for u in db.scalars(select(OrgUser).where(OrgUser.email.in_(mgr_emails or {""})))}
    out: list[Rendered] = []
    kept: list[Recipient] = []
    # A reminder, warning, final notice or request about a *person* (not one item) means nothing to someone with nothing open.
    chasing = draft.kind in CHASING_KINDS and res.source.get("type") in ("people", "team", "department")
    for r in res.recipients:
        u = r.user
        if chasing and not open_map.get(u.email):
            res.skipped.append(Skipped(u.email, u.name, "nothing_open"))
            continue
        kept.append(r)
        mgr = managers.get(u.manager_email) if u.manager_email else None
        single = item_from(r.obligation, r.compliance, now) if r.obligation is not None and r.compliance is not None else None
        link = app_url(notify.obligation_link(r.obligation.id) if r.obligation is not None else "/compliance/mine")
        values = build_values(
            user=u, manager_name=mgr.name if mgr else "", sender=ctx.user,
            items=open_map.get(u.email, []), single=single, link=link, now=now, tz=tz,
        )
        subject, bad1 = render(draft.subject, values)
        body, bad2 = render(draft.body, values)
        cc = []
        if cc_manager and mgr is not None and mgr.is_active and not mgr.is_demo and "@" in mgr.email:
            if mgr.email.lower() not in (u.email.lower(), ctx.email.lower()):
                cc = [mgr.email]
        out.append(Rendered(r, _one_line(subject), body, link, list(dict.fromkeys(bad1 + bad2)), cc, [single] if single else open_map.get(u.email, [])))
    res.recipients = kept
    return out


# --------------------------------------------------------------------- queueing


def sent_in_last_hour(db: Session, email: str) -> int:
    since = engine.now() - timedelta(hours=1)
    return db.scalar(
        select(func.count()).select_from(SentEmail).where(
            SentEmail.sent_by == email,
            SentEmail.created_at >= since,
            SentEmail.status.in_(("queued", "sent", "failed")),
            SentEmail.context["test"].astext.is_(None),
        )
    ) or 0


def queue_batch(
    ctx: Ctx,
    res: Resolution,
    rendered: list[Rendered],
    draft: Draft,
    *,
    cc_manager: bool,
    copy_me: bool,
    in_app: bool,
) -> uuid.UUID:
    """Write the batch (no commit) and its audit event; the caller commits and then runs `run_batch`."""
    db = ctx.db
    batch = uuid.uuid4()
    base = {
        "kind": draft.kind,
        "source": res.source,
        "edited": draft.edited,
        "options": {"cc_manager": cc_manager, "copy_me": copy_me, "in_app": in_app},
    }
    start = engine.now()
    for i, r in enumerate(rendered):  # created_at in recipient order, so the batch sends in that order
        u = r.recipient.user
        ob, c = r.recipient.obligation, r.recipient.compliance
        db.add(
            SentEmail(
                created_at=start + timedelta(microseconds=i),
                batch_id=batch,
                sent_by=ctx.email,
                recipient_email=u.email,
                recipient_name=u.name,
                template_id=draft.template_id,
                template_name=draft.template_name,
                subject=r.subject,
                body=r.body,
                obligation_id=ob.id if ob is not None else None,
                compliance_id=c.id if c is not None else None,
                context={**base, "link": r.link, "cc": r.cc, "in_app": in_app, "copy_me": copy_me},
                status="queued",
            )
        )
    for j, s in enumerate(res.skipped):
        db.add(
            SentEmail(
                created_at=start + timedelta(microseconds=len(rendered) + j),
                batch_id=batch,
                sent_by=ctx.email,
                recipient_email=s.email,
                recipient_name=s.name,
                template_id=draft.template_id,
                template_name=draft.template_name,
                subject=draft.subject,
                body="",
                context={**base, "skip_reason": s.reason},
                status="skipped",
                error=s.label,
            )
        )
    db.flush()
    audit.record(
        db,
        ctx.email,
        "email.batch_started",
        "email_batch",
        batch,
        meta={
            "template": draft.template_name,
            "template_id": str(draft.template_id) if draft.template_id else None,
            "kind": draft.kind,
            "recipients": len(rendered),
            "skipped": len(res.skipped),
            "source": res.source,
            "options": base["options"],
        },
    )
    return batch


# ---------------------------------------------------------------------- sending


@contextlib.contextmanager
def session_scope():
    """A fresh database session for the background job (tests replace this)."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _in_app_notice(db: Session, row: SentEmail) -> None:
    link = notify.obligation_link(row.obligation_id) if row.obligation_id else "/compliance/mine"
    body = " ".join(row.body.split())
    n = notify.notify(db, row.recipient_email, "message", row.subject, body[:400] + ("…" if len(body) > 400 else ""), link, row.obligation_id)
    # The message went (or was tried) by e-mail already: don't let the notification mailer send it a second time.
    n.email_status, n.email_error = "skipped", "Sent as a manual e-mail"


def run_batch(batch_id: uuid.UUID) -> None:
    """Background task: send every queued row of the batch, one at a time."""
    try:
        with session_scope() as db:
            _run_batch(db, batch_id)
    except Exception:  # never let a bug leave rows "queued" forever
        log.exception("E-mail batch %s crashed", batch_id)
        try:
            with session_scope() as db:
                for r in db.scalars(select(SentEmail).where(SentEmail.batch_id == batch_id, SentEmail.status == "queued")):
                    r.status, r.error = "failed", "Sending stopped unexpectedly. Nothing more was sent from this batch."
                db.commit()
        except Exception:
            log.exception("Couldn't mark batch %s as failed", batch_id)


def _run_batch(db: Session, batch_id: uuid.UUID) -> None:
    rows = list(
        db.scalars(
            select(SentEmail)
            .where(SentEmail.batch_id == batch_id, SentEmail.status == "queued")
            .order_by(SentEmail.created_at, SentEmail.id)
        )
    )
    if not rows:
        return
    sender = db.get(OrgUser, rows[0].sent_by)
    sender_name = sender.name if sender else rows[0].sent_by
    reply_to = sender.email if sender is not None and not sender.is_demo else None
    cfg = mailer.get_config(db)
    total = len(rows)
    consecutive = 0
    stopped: str | None = None
    first_ok: SentEmail | None = None  # the first message that went out: the sender's copy shows it
    sent = failed = skipped = 0
    names: list[str] = []

    for row in rows:
        ctx = row.context or {}
        if stopped:
            row.status, row.error = "skipped", SKIP_LABEL["stopped"]
            skipped += 1
            db.commit()
            continue
        if not cfg.configured:
            row.status, row.error = "failed", "E-mail isn't set up yet: add the SMTP host and a From address in Settings."
            failed += 1
            consecutive = STOP_AFTER_FAILURES
        else:
            subject, text, html = email_templates.compliance_message_email(
                row.subject, row.body, kind=ctx.get("kind", "custom"), link=ctx.get("link"), sender_name=sender_name
            )
            bcc = [sender.email] if (ctx.get("copy_me") and total == 1 and sender is not None and not sender.is_demo) else None
            try:
                mailer.send_email(
                    row.recipient_email, subject, text, html, config=cfg, cc=ctx.get("cc") or None, bcc=bcc, reply_to=reply_to
                )
            except mailer.MailError as exc:
                row.status, row.error = "failed", str(exc)[:500]
                failed += 1
                consecutive = 0 if exc.recipient_problem else consecutive + 1
            else:
                row.status, row.error = "sent", None
                sent += 1
                consecutive = 0
                names.append(row.recipient_name or row.recipient_email)
                if first_ok is None:
                    first_ok = row
        if ctx.get("in_app"):
            _in_app_notice(db, row)
        db.commit()
        if consecutive >= STOP_AFTER_FAILURES and not stopped:
            stopped = row.error or "repeated failures"
            log.warning("Stopping e-mail batch %s after %d failures in a row: %s", batch_id, consecutive, stopped)

    # One copy for the sender when a batch went to several people (a single recipient carries the sender as Bcc).
    copy_me = bool((rows[0].context or {}).get("copy_me"))
    if copy_me and total > 1 and first_ok is not None and sender is not None and not sender.is_demo and cfg.configured:
        listing = ", ".join(names[:30]) + (f" and {len(names) - 30} more" if len(names) > 30 else "")
        note = f"Your copy of a message sent to {sent} {_plural(sent, 'person', 'people')}: {listing}. Shown as {first_ok.recipient_name} received it."
        fctx = first_ok.context or {}
        subject, text, html = email_templates.compliance_message_email(
            "Copy: " + first_ok.subject, first_ok.body, kind=fctx.get("kind", "custom"), link=fctx.get("link"),
            sender_name=sender_name, note=note,
        )
        try:
            mailer.send_email(sender.email, subject, text, html, config=cfg)
        except mailer.MailError as exc:
            log.warning("Couldn't send the sender's copy for batch %s: %s", batch_id, exc)

    audit.record(
        db,
        rows[0].sent_by,
        "email.batch_finished",
        "email_batch",
        batch_id,
        meta={"sent": sent, "failed": failed, "skipped_after_stop": skipped, "stopped": bool(stopped)},
    )
    db.commit()


def sweep_stale(db: Session, batch_id: uuid.UUID) -> None:
    """Rows still "queued" long after the batch started were lost in a restart: say so instead of spinning forever."""
    cutoff = engine.now() - STALE_AFTER
    changed = False
    for r in db.scalars(select(SentEmail).where(SentEmail.batch_id == batch_id, SentEmail.status == "queued", SentEmail.created_at < cutoff)):
        r.status, r.error = "failed", "Sending was interrupted (the server restarted). This message was not sent."
        changed = True
    if changed:
        db.commit()


# ---------------------------------------------------------------------- history


def history_filter(ctx: Ctx):
    """Which sent_emails rows this viewer may see: their own, plus mail to people
    (and about items) they can see."""
    if ctx.is_super:
        return true()
    sc = ctx.scope("submission", "view")
    visible_obligation = or_(
        SentEmail.obligation_id.is_(None),
        SentEmail.obligation_id.in_(select(Obligation.id).where(ctx.obligation_clause("submission", "view"))),
    )
    if sc.everyone:
        about_people = true()
    else:
        about_people = SentEmail.recipient_email.in_(sc.emails or {""})
    return or_(SentEmail.sent_by == ctx.email, and_(about_people, visible_obligation))


def can_view_history(ctx: Ctx) -> bool:
    return can_send(ctx) or ctx.can("compliance", "configure") or ctx.can("audit_log", "view")
