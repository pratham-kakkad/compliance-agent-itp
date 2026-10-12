"""SMTP: the mailer, the encrypted settings, the templates and delivery of
pending notifications. smtplib is faked (tests/smtpfake.py); no network."""
import smtplib
import socket
import ssl
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest

from app import email_templates, mailer
from app.compliance.models import Notification
from app.compliance.notify import deliver_pending, notify
from app.models import OrgUser
from tests.conftest import login_as
from tests.cx import AVA, DANIEL, grant_role, no_bootstrap  # noqa: F401  (fixture)
from tests.smtpfake import fake_smtp, no_smtp, smtp_env  # noqa: F401  (fixtures)

CFG = mailer.SmtpConfig(host="smtp.test", port=587, security="starttls", username="u", password="p", from_email="a@b.test", from_name="Encop")


def test_send_email_starttls_builds_multipart(fake_smtp):
    mailer.send_email("x@y.test", "Hello\nthere", "plain body", "<p>html body</p>", config=CFG)
    assert [s[0] for s in fake_smtp.log] == ["connect", "ehlo", "starttls", "ehlo", "login", "send"]
    msg = fake_smtp.sent[0]
    assert msg["To"] == "x@y.test" and msg["Subject"] == "Hello there"  # header injection stripped
    assert "a@b.test" in msg["From"] and "Encop" in msg["From"]
    assert msg.get_body(("plain",)).get_content().strip() == "plain body"
    assert "html body" in msg.get_body(("html",)).get_content()


def test_security_modes(fake_smtp):
    mailer.send_email("x@y.test", "s", "t", config=replace(CFG, security="ssl", port=465))
    assert fake_smtp.last_args["ssl"] is True and ("starttls",) not in fake_smtp.log
    fake_smtp.reset()
    mailer.send_email("x@y.test", "s", "t", config=replace(CFG, security="none", username=""))
    assert fake_smtp.last_args["ssl"] is False
    assert ("starttls",) not in fake_smtp.log and not [e for e in fake_smtp.log if e[0] == "login"]


@pytest.mark.parametrize(
    "exc, step, expect",
    [
        (smtplib.SMTPAuthenticationError(535, b"bad creds"), "login", "user name or password"),
        (smtplib.SMTPRecipientsRefused({"x@y.test": (550, b"no")}), "send", "refused the recipient"),
        (smtplib.SMTPSenderRefused(553, b"no", "a@b.test"), "send", "From address"),
        (ConnectionRefusedError(), "connect", "refused"),
        (socket.gaierror(), "connect", "find the mail server"),
        (socket.timeout(), "connect", "Timed out"),
        (ssl.SSLError(1, "WRONG_VERSION_NUMBER"), "starttls", "TLS"),
        (smtplib.SMTPServerDisconnected("closed"), "connect", "closed the connection"),
        (smtplib.SMTPNotSupportedError("STARTTLS extension not supported by server."), "starttls", "Security"),
    ],
)
def test_friendly_errors(fake_smtp, exc, step, expect):
    fake_smtp.fail, fake_smtp.fail_at = exc, step
    with pytest.raises(mailer.MailError) as e:
        mailer.send_email("x@y.test", "s", "t", config=CFG)
    assert expect in str(e.value)


def test_not_configured_and_bad_recipient(fake_smtp, no_smtp):
    with pytest.raises(mailer.MailError, match="isn't set up"):
        mailer.send_email("x@y.test", "s", "t")
    with pytest.raises(mailer.MailError, match="valid recipient"):
        mailer.send_email("nope", "s", "t", config=CFG)
    assert fake_smtp.sent == []


def test_secret_encryption_round_trip():
    token = mailer.encrypt_secret("hunter2")
    assert "hunter2" not in token and mailer.decrypt_secret(token) == "hunter2"
    assert mailer.decrypt_secret("garbage") is None


def test_smtp_settings_api_never_returns_password(client, fake_smtp, no_smtp, db_session):
    login_as(client, AVA)
    assert client.get("/settings/smtp").json()["configured"] is False
    body = {"host": "smtp.test", "port": 587, "security": "starttls", "username": "u", "from_email": "no-reply@corp.test", "from_name": "Encop", "password": "s3cret-pw"}
    r = client.put("/settings/smtp", json=body)
    assert r.status_code == 200
    assert "s3cret-pw" not in r.text
    out = r.json()
    assert out["password_set"] is True and out["configured"] is True and "password" not in out
    assert "s3cret-pw" not in client.get("/settings/smtp").text
    # stored encrypted
    from app.org_settings.models import AppSetting

    stored = db_session.get(AppSetting, "smtp").value
    assert "s3cret-pw" not in str(stored) and mailer.decrypt_secret(stored["password_enc"]) == "s3cret-pw"
    # omitted password keeps it; the saved password is what the mailer uses
    body.pop("password")
    body["host"] = "smtp2.test"
    assert client.put("/settings/smtp", json=body).json()["password_set"] is True
    assert mailer.get_config(db_session).password == "s3cret-pw" and mailer.get_config(db_session).host == "smtp2.test"
    # explicit empty clears it
    body["password"] = ""
    assert client.put("/settings/smtp", json=body).json()["password_set"] is False
    # validation
    assert client.put("/settings/smtp", json={**body, "port": 0}).status_code == 422
    assert client.put("/settings/smtp", json={**body, "security": "magic"}).status_code == 422
    assert client.put("/settings/smtp", json={**body, "from_email": "bad"}).status_code == 422
    # /auth/config reflects it
    assert client.get("/auth/config").json()["smtp_configured"] is True


def test_smtp_settings_need_permission(client, no_bootstrap):
    login_as(client, DANIEL)
    assert client.get("/settings/smtp").status_code == 403
    assert client.put("/settings/smtp", json={"host": "x"}).status_code == 403
    assert client.post("/settings/smtp/test", json={"to": "a@b.test"}).status_code == 403


def test_smtp_test_endpoint(client, fake_smtp, smtp_env):
    login_as(client, AVA)
    r = client.post("/settings/smtp/test", json={"to": "me@corp.test"})
    assert r.json() == {"ok": True}
    assert fake_smtp.sent[0]["To"] == "me@corp.test"
    fake_smtp.fail, fake_smtp.fail_at = smtplib.SMTPAuthenticationError(535, b"x"), "login"
    r = client.post("/settings/smtp/test", json={"to": "me@corp.test"}).json()
    assert r["ok"] is False and "user name or password" in r["error"]


def test_templates_render_text_and_html():
    for subject, text, html in (
        email_templates.invite_email("Ann <b>", "https://x.test/ui/invite/t", "Ava"),
        email_templates.reset_email("Ann", "https://x.test/ui/reset/t"),
        email_templates.notification_email("Overdue: Policy", "Do it", "https://x.test/ui/c", "reminder", "Ann"),
        email_templates.smtp_test_email("Ava"),
    ):
        assert subject and text and "<html" in html and "#4f46e5" in html
    _, _, html = email_templates.invite_email("Ann <b>", "https://x.test/ui/invite/t")
    assert "Ann <b>" not in html and "Ann &lt;b&gt;" in html  # escaped
    _, _, overdue = email_templates.notification_email("Overdue: X", "b", None, "reminder")
    _, _, normal = email_templates.notification_email("Reminder: X", "b", None, "reminder")
    assert email_templates.CRITICAL in overdue and email_templates.CRITICAL not in normal


# ------------------------------------------------------------ deliver_pending


def _real_user(db, email="real@corp.test", active=True):
    u = OrgUser(email=email, name="Real Person", title="", is_demo=False, is_active=active)
    db.add(u)
    db.commit()
    return u


def test_deliver_pending_noop_without_smtp(db_session, fake_smtp, no_smtp):
    _real_user(db_session)
    notify(db_session, "real@corp.test", "reminder", "Reminder: X", "b", "/compliance/mine")
    db_session.commit()
    r = deliver_pending(db_session)
    assert r["configured"] is False and r["sent"] == 0 and r["remaining"] >= 1
    n = db_session.query(Notification).filter_by(user_email="real@corp.test").one()
    assert n.email_status == "pending" and n.email_attempts == 0 and fake_smtp.sent == []


def test_deliver_pending_sends_marks_and_links(db_session, fake_smtp, smtp_env, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "public_base_url", "https://encop.corp.test/")
    _real_user(db_session)
    notify(db_session, "real@corp.test", "reminder", "Overdue: Policy", "Please act", "/compliance/obligations/abc")
    db_session.commit()
    r = deliver_pending(db_session)
    assert r["sent"] == 1
    n = db_session.query(Notification).filter_by(user_email="real@corp.test").one()
    assert n.email_status == "sent" and n.email_sent_at is not None and n.email_attempts == 1
    msg = fake_smtp.sent[0]
    assert msg["Subject"] == "Overdue: Policy" and msg["To"] == "real@corp.test"
    assert "https://encop.corp.test/ui/compliance/obligations/abc" in msg.get_body(("plain",)).get_content()
    assert deliver_pending(db_session)["sent"] == 0  # not sent twice


def test_deliver_pending_retries_failed_up_to_three_times(db_session, fake_smtp, smtp_env):
    _real_user(db_session)
    notify(db_session, "real@corp.test", "reminder", "Reminder: X", "b")
    db_session.commit()
    fake_smtp.fail, fake_smtp.fail_at = ConnectionRefusedError(), "connect"
    for attempt in (1, 2, 3):
        assert deliver_pending(db_session)["failed"] == 1
        n = db_session.query(Notification).filter_by(user_email="real@corp.test").one()
        assert n.email_status == "failed" and n.email_attempts == attempt and "refused" in n.email_error
    assert deliver_pending(db_session)["failed"] == 0  # gave up
    assert db_session.query(Notification).filter_by(user_email="real@corp.test").one().email_attempts == 3
    # a new notification still goes out once the server works again
    notify(db_session, "real@corp.test", "reminder", "Reminder: Y", "b")
    db_session.commit()
    fake_smtp.fail = None
    assert deliver_pending(db_session)["sent"] == 1


def test_deliver_pending_skips_inactive_demo_and_stale(db_session, fake_smtp, smtp_env):
    _real_user(db_session, "gone@corp.test", active=False)
    _real_user(db_session, "old@corp.test")
    notify(db_session, "gone@corp.test", "reminder", "A", "b")
    notify(db_session, DANIEL, "reminder", "B", "b")  # demo account
    stale = notify(db_session, "old@corp.test", "reminder", "C", "b")
    db_session.flush()
    stale.created_at = datetime.now(timezone.utc) - timedelta(days=9)
    db_session.commit()
    r = deliver_pending(db_session)
    assert r["sent"] == 0 and r["skipped"] >= 3 and fake_smtp.sent == []
    statuses = {n.title: n.email_status for n in db_session.query(Notification)}
    assert statuses["A"] == statuses["B"] == statuses["C"] == "skipped"


def test_send_pending_endpoint(client, db_session, fake_smtp, smtp_env, no_bootstrap):
    _real_user(db_session)
    notify(db_session, "real@corp.test", "reminder", "Reminder: X", "b")
    db_session.commit()
    login_as(client, DANIEL)
    assert client.post("/compliance/admin/send-pending").status_code == 403
    grant_role(db_session, AVA, "super_admin")
    login_as(client, AVA)
    r = client.post("/compliance/admin/send-pending")
    assert r.status_code == 200 and r.json()["sent"] == 1
