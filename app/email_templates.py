"""E-mail templates: clean, responsive HTML with inline CSS plus a plain-text
fallback. Every function returns (subject, text, html).

Branding is a simple wordmark and an indigo (#4f46e5) button. Red is only used
for overdue / critical wording.
"""
from html import escape

INDIGO = "#4f46e5"
INK = "#1e1b4b"
MUTED = "#6b7280"
CRITICAL = "#b91c1c"

Rendered = tuple[str, str, str]


def _layout(*, preheader: str, heading: str, paragraphs: list[str], button: tuple[str, str] | None = None,
            note: str | None = None, tag: tuple[str, str] | None = None) -> str:
    """paragraphs are plain text (escaped here). tag = (label, colour)."""
    body = "".join(
        f'<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#374151;">{escape(p).replace(chr(10), "<br>")}</p>'
        for p in paragraphs
        if p
    )
    tag_html = ""
    if tag:
        tag_html = (
            f'<div style="margin:0 0 12px;"><span style="display:inline-block;padding:3px 10px;border-radius:999px;'
            f'font-size:12px;font-weight:600;letter-spacing:.02em;color:{tag[1]};background:#f3f4f6;">{escape(tag[0])}</span></div>'
        )
    button_html = ""
    fallback = ""
    if button:
        label, url = button
        button_html = (
            f'<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="border-radius:10px;background:{INDIGO};">'
            f'<a href="{escape(url, quote=True)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;'
            f'color:#ffffff;text-decoration:none;border-radius:10px;">{escape(label)}</a></td></tr></table>'
        )
        fallback = (
            f'<p style="margin:0 0 16px;font-size:12px;line-height:18px;color:{MUTED};">If the button doesn\'t work, copy this link into your browser:<br>'
            f'<a href="{escape(url, quote=True)}" style="color:{INDIGO};word-break:break-all;">{escape(url)}</a></p>'
        )
    note_html = f'<p style="margin:0;font-size:12px;line-height:18px;color:{MUTED};">{escape(note)}</p>' if note else ""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>{escape(heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4fb;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">{escape(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4fb;">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
    <tr><td style="padding:0 4px 16px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:22px;font-weight:700;letter-spacing:-.02em;color:{INK};">encop<span style="color:{INDIGO};">.</span></td></tr>
    <tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:32px 28px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
      {tag_html}
      <h1 style="margin:0 0 16px;font-size:22px;line-height:30px;font-weight:700;color:{INK};">{escape(heading)}</h1>
      {body}
      {button_html}
      {fallback}
      {note_html}
    </td></tr>
    <tr><td style="padding:16px 8px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:{MUTED};text-align:center;">Sent by Encop, your compliance platform.</td></tr>
  </table>
</td></tr>
</table>
</body>
</html>"""


def _text(heading: str, paragraphs: list[str], link: tuple[str, str] | None = None, note: str | None = None) -> str:
    parts = [heading, "", *[p for p in paragraphs if p]]
    if link:
        parts += ["", f"{link[0]}: {link[1]}"]
    if note:
        parts += ["", note]
    parts += ["", "-- Encop"]
    return "\n".join(parts)


def invite_email(name: str, url: str, invited_by: str | None = None, days: int = 7) -> Rendered:
    who = f"{invited_by} has" if invited_by else "You have been"
    first = f"{who} invited you to Encop." if invited_by else "You have been invited to Encop."
    paras = [f"Hi {name},", first + " Set a password to finish creating your account."]
    note = f"This link works once and expires in {days} days. If you weren't expecting this, you can ignore this e-mail."
    subject = "You're invited to Encop"
    return (
        subject,
        _text("Welcome to Encop", paras, ("Set your password", url), note),
        _layout(preheader="Set your password to get started.", heading="Welcome to Encop", paragraphs=paras,
                button=("Set your password", url), note=note),
    )


def reset_email(name: str, url: str, hours: int = 1, by_admin: bool = False) -> Rendered:
    paras = [f"Hi {name},"]
    paras.append(
        "An administrator asked for a password reset on your Encop account."
        if by_admin
        else "We got a request to reset the password on your Encop account."
    )
    paras.append("Use the button below to choose a new password.")
    note = f"This link works once and expires in {hours} hour{'s' if hours != 1 else ''}. If you didn't ask for this, you can ignore this e-mail: your password stays as it is."
    return (
        "Reset your Encop password",
        _text("Reset your password", paras, ("Choose a new password", url), note),
        _layout(preheader="Choose a new password.", heading="Reset your password", paragraphs=paras,
                button=("Choose a new password", url), note=note),
    )


_CRITICAL_KINDS = {"escalation", "non_compliant", "review_overdue"}


def notification_email(title: str, body: str, url: str | None, kind: str = "", name: str | None = None) -> Rendered:
    """Compliance reminder / escalation / status notice. The title is the subject."""
    critical = kind in _CRITICAL_KINDS or title.lower().startswith("overdue")
    labels = {
        "reminder": "Reminder", "escalation": "Escalation", "review_needed": "Review needed",
        "review_overdue": "Review waiting", "approved": "Approved", "rejected": "Changes needed",
        "non_compliant": "Not accepted", "completed": "Done", "waived": "Exempt", "deadline_changed": "New deadline",
    }
    label = "Overdue" if title.lower().startswith("overdue") else labels.get(kind, "Compliance update")
    tag = (label, CRITICAL if critical else INDIGO)
    paras = ([f"Hi {name},"] if name else []) + ([body] if body else [])
    button = ("Open in Encop", url) if url else None
    return (
        title,
        _text(title, paras, ("Open in Encop", url) if url else None),
        _layout(preheader=body[:120] if body else title, heading=title, paragraphs=paras, button=button, tag=tag),
    )


def smtp_test_email(sent_by: str | None = None) -> Rendered:
    paras = ["This is a test message from Encop.", "If you can read this, outgoing e-mail is set up correctly."]
    if sent_by:
        paras.append(f"Requested by {sent_by}.")
    return (
        "Encop test e-mail",
        _text("Your e-mail settings work", paras),
        _layout(preheader="Outgoing e-mail is set up correctly.", heading="Your e-mail settings work", paragraphs=paras,
                tag=("Test", INDIGO)),
    )


# ----------------------------------------------------- manual compliance message

# kind -> (label, text colour, background). Red only for the escalation ("final") kind.
_KIND_STYLE = {
    "reminder": ("Reminder", "#0369a1", "#e0f2fe"),
    "warning": ("Warning", "#9a5b00", "#fdf1d3"),
    "final": ("Final notice", CRITICAL, "#fdeaea"),
    "request": ("Request", "#6d28d9", "#ede9fe"),
    "thanks": ("Thank you", "#047857", "#d9f7ea"),
    "custom": ("Message", INDIGO, "#eef2ff"),
}
_BULLETS = ("• ", "- ", "* ")


def _body_blocks(body: str) -> str:
    """Plain text with blank-line paragraphs and bullet lines -> inline-styled HTML. Everything is escaped."""
    p_style = "margin:0 0 16px;font-size:15px;line-height:24px;color:#374151;"
    out: list[str] = []

    def flush(group: list[str], bullets: bool) -> None:
        if not group:
            return
        if bullets:
            items = "".join(f'<li style="margin:0 0 6px;">{escape(t)}</li>' for t in group)
            out.append(f'<ul style="margin:0 0 16px;padding:0 0 0 22px;font-size:15px;line-height:23px;color:#374151;">{items}</ul>')
        else:
            out.append(f'<p style="{p_style}">' + "<br>".join(escape(t) for t in group) + "</p>")

    for block in body.replace("\r\n", "\n").strip().split("\n\n"):
        group: list[str] = []
        bullets = False
        for ln in block.split("\n"):
            stripped = ln.strip()
            if not stripped:
                continue
            is_bullet = stripped.startswith(_BULLETS)
            if group and is_bullet != bullets:
                flush(group, bullets)
                group = []
            bullets = is_bullet
            group.append(stripped[2:].strip() if is_bullet else stripped)
        flush(group, bullets)
    return "".join(out)


def compliance_message_email(
    subject: str,
    body: str,
    *,
    kind: str = "custom",
    link: str | None = None,
    sender_name: str | None = None,
    note: str | None = None,
) -> Rendered:
    """A message a reviewer / manager / admin wrote to someone about their compliance
    (built from an e-mail template, see app/compliance/messaging.py). `subject` and
    `body` are the final plain text; the body may hold blank-line paragraphs and
    bullet lines ("• item"). Returns (subject, text, html)."""
    label, colour, tint = _KIND_STYLE.get(kind, _KIND_STYLE["custom"])
    button_html = fallback = ""
    if link:
        button_html = (
            f'<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="border-radius:10px;background:{INDIGO};">'
            f'<a href="{escape(link, quote=True)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;'
            f'color:#ffffff;text-decoration:none;border-radius:10px;">Open in Encop</a></td></tr></table>'
        )
        fallback = (
            f'<p style="margin:0 0 16px;font-size:12px;line-height:18px;color:{MUTED};">If the button doesn\'t work, copy this link into your browser:<br>'
            f'<a href="{escape(link, quote=True)}" style="color:{INDIGO};word-break:break-all;">{escape(link)}</a></p>'
        )
    note_html = f'<p style="margin:0 0 12px;font-size:12px;line-height:18px;color:{MUTED};">{escape(note)}</p>' if note else ""
    who = f"Sent by {escape(sender_name)} through Encop. Reply to this e-mail to reach them." if sender_name else "Sent through Encop."
    preview = " ".join(body.split())[:140]
    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>{escape(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4fb;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">{escape(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4fb;">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
    <tr><td style="padding:0 4px 16px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:22px;font-weight:700;letter-spacing:-.02em;color:{INK};">encop<span style="color:{INDIGO};">.</span></td></tr>
    <tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:32px 28px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
      <div style="margin:0 0 12px;"><span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:.02em;color:{colour};background:{tint};">{escape(label)}</span></div>
      <h1 style="margin:0 0 16px;font-size:22px;line-height:30px;font-weight:700;color:{INK};">{escape(subject)}</h1>
      {_body_blocks(body)}
      {button_html}
      {fallback}
      {note_html}
    </td></tr>
    <tr><td style="padding:16px 8px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:{MUTED};text-align:center;">{who}</td></tr>
  </table>
</td></tr>
</table>
</body>
</html>"""
    parts = [subject, "", body.strip()]
    if link:
        parts += ["", f"Open in Encop: {link}"]
    if note:
        parts += ["", note]
    parts += ["", f"-- Sent by {sender_name} through Encop. Reply to this e-mail to reach them." if sender_name else "-- Encop"]
    return subject, "\n".join(parts), html
