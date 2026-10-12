"""A fake smtplib for tests (not a test module): nothing touches the network.

The `fake_smtp` fixture replaces smtplib.SMTP / SMTP_SSL; every message "sent"
lands in `FakeSmtp.sent`. Set `FakeSmtp.fail` to an exception instance to make
a step raise it: `fail_at` is "connect", "starttls", "login" or "send".
"""
import smtplib

import pytest

from app.config import settings


class FakeSmtp:
    sent: list = []
    log: list = []
    fail: Exception | None = None
    fail_at: str = "send"
    last_args: dict = {}

    def __init__(self, host, port, timeout=None, context=None, **kw):
        FakeSmtp.last_args = {"host": host, "port": port, "timeout": timeout, "ssl": type(self).__name__ == "FakeSmtpSsl"}
        FakeSmtp.log.append(("connect", host, port))
        self._maybe("connect")

    def _maybe(self, step):
        if FakeSmtp.fail is not None and FakeSmtp.fail_at == step:
            raise FakeSmtp.fail

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def ehlo(self):
        FakeSmtp.log.append(("ehlo",))

    def starttls(self, context=None):
        FakeSmtp.log.append(("starttls",))
        self._maybe("starttls")

    def login(self, user, password):
        FakeSmtp.log.append(("login", user, password))
        self._maybe("login")

    def send_message(self, msg):
        FakeSmtp.log.append(("send", msg["To"]))
        self._maybe("send")
        FakeSmtp.sent.append(msg)

    @classmethod
    def reset(cls):
        FakeSmtp.sent, FakeSmtp.log, FakeSmtp.fail, FakeSmtp.fail_at, FakeSmtp.last_args = [], [], None, "send", {}


class FakeSmtpSsl(FakeSmtp):
    pass


@pytest.fixture
def fake_smtp(monkeypatch):
    FakeSmtp.reset()
    monkeypatch.setattr(smtplib, "SMTP", FakeSmtp)
    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSmtpSsl)
    yield FakeSmtp
    FakeSmtp.reset()


@pytest.fixture
def smtp_env(monkeypatch):
    """SMTP configured through the environment settings."""
    values = dict(
        smtp_host="smtp.test", smtp_port=587, smtp_security="starttls", smtp_username="user", smtp_password="pw",
        smtp_from_email="no-reply@corp.test", smtp_from_name="Encop",
    )
    for k, v in values.items():
        monkeypatch.setattr(settings, k, v)


@pytest.fixture
def no_smtp(monkeypatch):
    for k in ("smtp_host", "smtp_username", "smtp_password", "smtp_from_email"):
        monkeypatch.setattr(settings, k, "")
