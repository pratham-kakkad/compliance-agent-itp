"""Static catalogs: the permission vocabulary, the seeded roles, compliance
types and escalation presets. Everything an administrator can change at runtime
(roles, grants, types) lives in the database; this file is only what gets
seeded the first time, and the vocabulary the code itself understands."""

# ---------------------------------------------------------------- permissions

# resource -> actions. `navigation_only` resources only drive which menu items a
# person sees: the existing Meetings / Attendance APIs keep their own rules.
RESOURCES: dict[str, dict] = {
    "dashboard": {"label": "Dashboard", "actions": ["view"]},
    "compliance": {
        "label": "General Compliance",
        "actions": ["view", "create", "edit", "delete", "assign", "configure", "waive", "export"],
    },
    "submission": {"label": "Submissions & reviews", "actions": ["view", "submit", "approve", "reject", "export"]},
    "user": {"label": "Users", "actions": ["view", "create", "edit", "delete"]},
    "team": {"label": "Teams & departments", "actions": ["view", "create", "edit", "delete"]},
    "role": {"label": "Roles & access", "actions": ["view", "create", "edit", "delete", "configure"]},
    "report": {"label": "Reports", "actions": ["view", "export"]},
    "analytics": {"label": "Analytics", "actions": ["view"]},
    "settings": {"label": "Settings", "actions": ["view", "configure"]},
    "audit_log": {"label": "Audit logs", "actions": ["view", "export"]},
    "meeting_compliance": {"label": "Meeting compliance", "actions": ["view", "export"], "navigation_only": True},
    "attendance_compliance": {
        "label": "Attendance compliance",
        "actions": ["view", "export"],
        "navigation_only": True,
    },
}

ALL_ACTIONS = sorted({a for r in RESOURCES.values() for a in r["actions"]})

# Which rows a grant reaches. Every scope that names people includes yourself.
SCOPES = {
    "self": "Only my own records",
    "direct_reports": "Me and the people who report directly to me",
    "subtree": "Me and everyone below me in the reporting line",
    "team": "Me and the members of my teams",
    "department": "Everyone in my department",
    "org": "Everyone",
    "created_by_me": "Records I created",
}
SCOPE_ORDER = ["self", "created_by_me", "direct_reports", "team", "subtree", "department", "org"]


def all_permission_pairs() -> list[tuple[str, str]]:
    return [(res, act) for res, spec in RESOURCES.items() for act in spec["actions"]]


def _grants(spec: dict[str, dict[str, str]]) -> list[tuple[str, str, str]]:
    return [(res, act, scope) for res, acts in spec.items() for act, scope in acts.items()]


def _all(resource: str, scope: str, skip: tuple[str, ...] = ()) -> dict[str, str]:
    return {a: scope for a in RESOURCES[resource]["actions"] if a not in skip}


# key -> role definition. `auto_assign`: "all" = everyone holds it implicitly,
# "managers" = anyone with at least one direct report holds it implicitly.
DEFAULT_ROLES: dict[str, dict] = {
    "super_admin": {
        "name": "Super Admin",
        "description": "Full access to everything, including roles, permissions and the audit log.",
        "is_super": True,
        "grants": [(r, a, "org") for r, a in all_permission_pairs()],
    },
    "compliance_admin": {
        "name": "Compliance Admin",
        "description": "Creates, assigns, configures and reviews compliance across the organization.",
        "grants": _grants(
            {
                "dashboard": {"view": "org"},
                "compliance": _all("compliance", "org"),
                "submission": {"view": "org", "submit": "self", "approve": "org", "reject": "org", "export": "org"},
                "user": {"view": "org", "create": "org", "edit": "org"},
                "team": {"view": "org", "create": "org", "edit": "org"},
                "role": {"view": "org"},
                "report": {"view": "org", "export": "org"},
                "analytics": {"view": "org"},
                "settings": {"view": "org"},
                "audit_log": {"view": "org"},
                "meeting_compliance": {"view": "org", "export": "org"},
                "attendance_compliance": {"view": "org", "export": "org"},
            }
        ),
    },
    "compliance_manager": {
        "name": "Compliance Manager",
        "description": "Runs compliance for a part of the organization: creates, assigns and reviews within their reporting line.",
        "grants": _grants(
            {
                "dashboard": {"view": "subtree"},
                "compliance": {
                    "view": "subtree",
                    "create": "subtree",
                    "edit": "subtree",
                    "assign": "subtree",
                    "waive": "subtree",
                    "export": "subtree",
                },
                "submission": {
                    "view": "subtree",
                    "submit": "self",
                    "approve": "subtree",
                    "reject": "subtree",
                    "export": "subtree",
                },
                "user": {"view": "subtree"},
                "team": {"view": "subtree"},
                "report": {"view": "subtree", "export": "subtree"},
                "analytics": {"view": "subtree"},
                "meeting_compliance": {"view": "subtree"},
                "attendance_compliance": {"view": "subtree"},
            }
        ),
    },
    "manager": {
        "name": "Manager",
        "description": "Sees and reviews compliance for their reports. Held automatically by anyone with direct reports.",
        "auto_assign": "managers",
        "grants": _grants(
            {
                "dashboard": {"view": "subtree"},
                "compliance": {"view": "subtree"},
                "submission": {"view": "subtree", "submit": "self", "approve": "subtree", "reject": "subtree"},
                "user": {"view": "subtree"},
                "team": {"view": "subtree"},
                "report": {"view": "subtree"},
                "meeting_compliance": {"view": "subtree"},
                "attendance_compliance": {"view": "subtree"},
            }
        ),
    },
    "employee": {
        "name": "Employee",
        "description": "Sees their own compliance and submits proof. Held automatically by everyone.",
        "auto_assign": "all",
        "grants": _grants(
            {
                "dashboard": {"view": "self"},
                "compliance": {"view": "self"},
                "submission": {"view": "self", "submit": "self"},
                "meeting_compliance": {"view": "self"},
                "attendance_compliance": {"view": "self"},
            }
        ),
    },
    "auditor": {
        "name": "Auditor",
        "description": "Read-only access across the organization, including exports and the audit log.",
        "grants": _grants(
            {
                "dashboard": {"view": "org"},
                "compliance": {"view": "org", "export": "org"},
                "submission": {"view": "org", "export": "org"},
                "user": {"view": "org"},
                "team": {"view": "org"},
                "report": {"view": "org", "export": "org"},
                "analytics": {"view": "org"},
                "audit_log": {"view": "org", "export": "org"},
                "meeting_compliance": {"view": "org", "export": "org"},
                "attendance_compliance": {"view": "org", "export": "org"},
            }
        ),
    },
}

# ------------------------------------------------------------------- compliance

PRIORITIES = ["low", "medium", "high", "critical"]
PRIORITY_WEIGHT = {"low": 1, "medium": 2, "high": 3, "critical": 5}

DEFINITION_STATUSES = ["draft", "published", "paused", "closed", "archived"]
OBLIGATION_STATUSES = [
    "not_started",
    "in_progress",
    "submitted",
    "under_review",
    "rejected",
    "completed",
    "waived",
    "cancelled",
]
TERMINAL = {"completed", "waived", "cancelled"}
OPEN = {s for s in OBLIGATION_STATUSES if s not in TERMINAL}

# status -> statuses it may move to
TRANSITIONS: dict[str, set[str]] = {
    "not_started": {"in_progress", "submitted", "waived", "cancelled"},
    "in_progress": {"submitted", "waived", "cancelled"},
    "submitted": {"under_review", "completed", "rejected", "waived", "cancelled"},
    "under_review": {"completed", "rejected", "waived", "cancelled"},
    "rejected": {"in_progress", "submitted", "waived", "cancelled"},
    "completed": {"in_progress"},  # reopen
    "waived": {"in_progress"},
    "cancelled": {"in_progress"},
}

PARTICIPATION = ["required", "optional", "informational"]
PARTICIPATION_RANK = {"informational": 0, "optional": 1, "required": 2}

COMPLETION_POLICIES = ["all", "at_least_n", "percentage", "any"]
REVIEW_MODES = ["none", "manager", "named", "any_reviewer"]
SELECTOR_TYPES = ["person", "team", "department", "role", "subtree", "all"]

EVIDENCE_KINDS = ["text", "file", "url", "attestation", "choice"]

# --------------------------------------------------------------- escalation

TRIGGERS = ["before_due", "on_due", "after_due", "rejected", "review_pending"]
ACTIONS = [
    "notify_assignee",
    "notify_manager",
    "notify_manager_chain",
    "notify_users",
    "notify_reviewers",
    "mark_non_compliant",
    "flag_defaulter",
]

ESCALATION_PRESETS: dict[str, dict] = {
    "none": {"label": "No automatic follow-up", "rules": []},
    "standard": {
        "label": "Standard: reminder, manager copy, non-compliant after a week",
        "rules": [
            {
                "id": "remind-before",
                "name": "Reminder 3 days before",
                "trigger": {"type": "before_due", "days": 3},
                "actions": [{"type": "notify_assignee"}],
            },
            {
                "id": "remind-due",
                "name": "Reminder on the due date",
                "trigger": {"type": "on_due", "days": 0},
                "actions": [{"type": "notify_assignee"}],
            },
            {
                "id": "late-manager",
                "name": "Tell the manager 2 days late",
                "trigger": {"type": "after_due", "days": 2},
                "actions": [{"type": "notify_assignee"}, {"type": "notify_manager"}],
            },
            {
                "id": "non-compliant",
                "name": "Mark non-compliant 7 days late",
                "trigger": {"type": "after_due", "days": 7},
                "actions": [{"type": "mark_non_compliant"}, {"type": "flag_defaulter"}, {"type": "notify_manager_chain", "levels": 2}],
            },
        ],
    },
    "strict": {
        "label": "Strict: non-compliant the day after the deadline",
        "rules": [
            {
                "id": "remind-before",
                "name": "Reminder 2 days before",
                "trigger": {"type": "before_due", "days": 2},
                "actions": [{"type": "notify_assignee"}],
            },
            {
                "id": "non-compliant",
                "name": "Mark non-compliant 1 day late",
                "trigger": {"type": "after_due", "days": 1},
                "actions": [
                    {"type": "mark_non_compliant"},
                    {"type": "flag_defaulter"},
                    {"type": "notify_manager"},
                ],
            },
        ],
    },
}

# ------------------------------------------------------------ compliance types

DEFAULT_TYPES: list[dict] = [
    {
        "key": "general",
        "name": "General",
        "description": "Any requirement. Describe the action and choose the proof you need.",
        "evidence": [
            {"key": "description", "kind": "text", "label": "What did you do?", "mandatory": True},
        ],
        "review_mode": "manager",
        "escalation": "standard",
    },
    {
        "key": "policy_acknowledgement",
        "name": "Policy acknowledgement",
        "description": "Read a company policy and confirm you understand it.",
        "evidence": [
            {
                "key": "acknowledged",
                "kind": "attestation",
                "label": "I have read and understood this policy",
                "mandatory": True,
            },
        ],
        "review_mode": "none",
        "escalation": "standard",
    },
    {
        "key": "training",
        "name": "Mandatory training",
        "description": "Complete a course and submit the certificate.",
        "evidence": [
            {"key": "certificate", "kind": "file", "label": "Certificate", "mandatory": True},
            {"key": "completed_on", "kind": "text", "label": "Completion date", "mandatory": True},
        ],
        "review_mode": "manager",
        "escalation": "standard",
    },
    {
        "key": "document_submission",
        "name": "Document submission",
        "description": "Submit a document or form.",
        "evidence": [
            {"key": "document", "kind": "file", "label": "Document", "mandatory": True},
            {"key": "notes", "kind": "text", "label": "Notes", "mandatory": False},
        ],
        "review_mode": "manager",
        "escalation": "standard",
    },
    {
        "key": "external_action",
        "name": "External action",
        "description": "Do something outside this system (a social post, a form on another site) and show proof.",
        "evidence": [
            {"key": "description", "kind": "text", "label": "Describe what you did", "mandatory": True},
            {"key": "proof", "kind": "file", "label": "Screenshot or other proof", "mandatory": True},
        ],
        "review_mode": "manager",
        "escalation": "standard",
    },
]
