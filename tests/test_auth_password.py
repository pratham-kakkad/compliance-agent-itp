"""Local (e-mail + password) sign-in: hashing, login, lockout, throttling,
invites, resets, change password and the admin side. SMTP is faked."""
import re
from datetime import timedelta

import pytest

from app.auth import local, passwords
from app.compliance.models import AuditEvent
from app.config import settings
from app.models import OrgUser
from tests.conftest import login_as
from tests.cx import AVA, DANIEL, grant_role, no_bootstrap  # noqa: F401  (fixture)
from tests.smtpfake import fake_smtp, no_smtp, smtp_env  # noqa: F401  (fixtures)

PW = "a-long-enough-passphrase"


@pytest.fixture(autouse=True)
def _fresh_throttles(monkeypatch):
    local.reset_throttles()
    monkeypatch.setattr(settings, "public_base_url", "http://app.test")
    yield
    local.reset_throttles()


def make_user(db, email="pat@corp.test", password=PW, active=True, name="Pat Example"):
    u = OrgUser(email=email, name=name, title="", is_demo=False, is_active=active)
    if password:
        u.password_hash = passwords.hash_password(password)
    db.add(u)
    db.commit()
    return u


def token_from(url: str) -> str:
    return url.rsplit("/", 1)[1]


# -------------------------------------------------------------- hashing


def test_hash_format_verify_and_uniqueness():
    h1, h2 = passwords.hash_password(PW), passwords.hash_password(PW)
    assert h1 != h2  # random salt
    assert h1.startswith("scrypt$v1$") and PW not in h1
    assert passwords.verify_password(PW, h1) and not passwords.verify_password(PW + "x", h1)
    for bad in (None, "", "garbage", "scrypt$v2$1$1$1$AA$AA", "scrypt$v1$x$y$z$AA$AA"):
        assert not passwords.verify_password(PW, bad)


def test_password_policy():
    with pytest.raises(passwords.PasswordPolicyError):
        passwords.validate_password("short")
    with pytest.raises(passwords.PasswordPolicyError):
        passwords.validate_password(" " * 12)
    with pytest.raises(passwords.PasswordPolicyError):
        passwords.validate_password("pat@corp.test", email="PAT@corp.test")
    passwords.validate_password("exactly-10")


def test_token_digest_is_sha256_hex():
    t = passwords.new_token()
    assert len(t) >= 43 and re.fullmatch(r"[0-9a-f]{64}", passwords.token_digest(t))


# ----------------------------------------------------------- password-login


def test_config_flags(client, no_smtp):
    c = client.get("/auth/config").json()
    assert c["password_login_enabled"] is True and c["smtp_configured"] is False
    assert c["demo_login_enabled"] is True and "microsoft_configured" in c


def test_login_success_sets_cookie_and_last_login(client, db_session):
    make_user(db_session)
    r = client.post("/auth/password-login", json={"email": " PAT@corp.test ", "password": PW})
    assert r.status_code == 200 and r.json()["email"] == "pat@corp.test"
    assert client.get("/auth/me").json()["email"] == "pat@corp.test"
    assert client.get("/auth/me").json()["has_password"] is True
    assert db_session.get(OrgUser, "pat@corp.test").last_login_at is not None


def test_login_errors_do_not_reveal_accounts(client, db_session):
    make_user(db_session)
    make_user(db_session, "nopass@corp.test", password=None)
    wrong = client.post("/auth/password-login", json={"email": "pat@corp.test", "password": "nope-nope-nope"})
    unknown = client.post("/auth/password-login", json={"email": "ghost@corp.test", "password": "nope-nope-nope"})
    nopass = client.post("/auth/password-login", json={"email": "nopass@corp.test", "password": "nope-nope-nope"})
    demo = client.post("/auth/password-login", json={"email": AVA, "password": "nope-nope-nope"})
    assert {wrong.status_code, unknown.status_code, nopass.status_code, demo.status_code} == {401}
    assert wrong.json() == unknown.json() == nopass.json() == demo.json()
    assert client.get("/auth/me").status_code == 401


def test_inactive_user_refused(client, db_session):
    make_user(db_session, active=False)
    r = client.post("/auth/password-login", json={"email": "pat@corp.test", "password": PW})
    assert r.status_code == 403 and "deactivated" in r.json()["detail"]
    assert client.get("/auth/me").status_code == 401


def test_deactivated_session_is_rejected(client, db_session):
    u = make_user(db_session)
    client.post("/auth/password-login", json={"email": u.email, "password": PW})
    assert client.get("/auth/me").status_code == 200
    u.is_active = False
    db_session.commit()
    assert client.get("/auth/me").status_code == 401


def test_lockout_after_repeated_failures_even_with_right_password(client, db_session):
    make_user(db_session)
    for _ in range(local.MAX_FAILED_LOGINS):
        assert client.post("/auth/password-login", json={"email": "pat@corp.test", "password": "wrong-wrong-1"}).status_code == 401
    assert db_session.get(OrgUser, "pat@corp.test").locked_until is not None
    r = client.post("/auth/password-login", json={"email": "pat@corp.test", "password": PW})
    assert r.status_code == 401  # still locked, and no different from any other failure
    u = db_session.get(OrgUser, "pat@corp.test")
    u.locked_until = local.now() - timedelta(seconds=1)  # lock expires
    db_session.commit()
    assert client.post("/auth/password-login", json={"email": "pat@corp.test", "password": PW}).status_code == 200


def test_success_resets_failure_counter(client, db_session):
    make_user(db_session)
    for _ in range(local.MAX_FAILED_LOGINS - 1):
        client.post("/auth/password-login", json={"email": "pat@corp.test", "password": "wrong-wrong-1"})
    assert client.post("/auth/password-login", json={"email": "pat@corp.test", "password": PW}).status_code == 200
    assert db_session.get(OrgUser, "pat@corp.test").failed_logins == 0


def test_ip_throttle(client, db_session):
    for i in range(local.login_failures.limit):
        client.post("/auth/password-login", json={"email": f"ghost{i}@corp.test", "password": "wrong-wrong-1"})
    r = client.post("/auth/password-login", json={"email": "ghost@corp.test", "password": "wrong-wrong-1"})
    assert r.status_code == 429


# ------------------------------------------------------------ admin + invite


def _super(db):
    grant_role(db, AVA, "super_admin")


def test_admin_creates_user_gets_invite_link_without_smtp(client, db_session, no_smtp):
    login_as(client, AVA)
    r = client.post("/compliance/admin/users", json={"email": "New.Hire@Corp.test", "name": "New Hire"})
    assert r.status_code == 201
    d = r.json()
    assert d["email"] == "new.hire@corp.test" and d["status"] == "invited"
    assert d["smtp_configured"] is False and d["email_sent"] is False
    assert d["invite_url"].startswith("http://app.test/ui/invite/")
    token = token_from(d["invite_url"])
    stored = db_session.get(OrgUser, "new.hire@corp.test")
    assert stored.invite_token_hash == passwords.token_digest(token) and token not in str(stored.invite_token_hash)
    assert db_session.query(AuditEvent).filter_by(action="user.invited", entity_id="new.hire@corp.test").count() == 1
    # the link works once
    client.cookies.clear()
    info = client.get(f"/auth/invite/{token}")
    assert info.json() == {"name": "New Hire", "email": "new.hire@corp.test"}
    assert client.post("/auth/invite/accept", json={"token": token, "password": "short"}).status_code == 422
    ok = client.post("/auth/invite/accept", json={"token": token, "password": PW})
    assert ok.status_code == 200
    assert client.get("/auth/me").json()["email"] == "new.hire@corp.test"  # signed in
    assert client.get(f"/auth/invite/{token}").status_code == 400  # single use
    assert client.post("/auth/invite/accept", json={"token": token, "password": PW}).status_code == 400
    client.cookies.clear()
    assert client.post("/auth/password-login", json={"email": "new.hire@corp.test", "password": PW}).status_code == 200
    login_as(client, AVA)
    detail = client.get("/compliance/admin/users/new.hire@corp.test").json()
    assert detail["status"] == "active" and detail["last_login_at"]


def test_create_user_emails_invite_when_smtp_configured(client, fake_smtp, smtp_env):
    login_as(client, AVA)
    d = client.post("/compliance/admin/users", json={"email": "mail.me@corp.test", "name": "Mail Me"}).json()
    assert d["email_sent"] is True and d["smtp_configured"] is True
    msg = fake_smtp.sent[0]
    assert msg["To"] == "mail.me@corp.test"
    assert d["invite_url"] in msg.get_body(("plain",)).get_content()
    # a failing server is reported, the user and the link are still created
    fake_smtp.fail, fake_smtp.fail_at = ConnectionRefusedError(), "connect"
    d2 = client.post("/compliance/admin/users", json={"email": "mail.me2@corp.test", "name": "Mail Me2"}).json()
    assert d2["email_sent"] is False and "refused" in d2["email_error"] and d2["invite_url"]


def test_create_user_without_invite(client, no_smtp):
    login_as(client, AVA)
    d = client.post("/compliance/admin/users", json={"email": "quiet@corp.test", "name": "Quiet", "send_invite": False}).json()
    assert "invite_url" not in d


def test_resend_invite_invalidates_old_link(client, no_smtp):
    login_as(client, AVA)
    first = client.post("/compliance/admin/users", json={"email": "r@corp.test", "name": "R"}).json()["invite_url"]
    second = client.post("/compliance/admin/users/r@corp.test/invite").json()["invite_url"]
    assert first != second
    client.cookies.clear()
    assert client.get(f"/auth/invite/{token_from(first)}").status_code == 400
    assert client.get(f"/auth/invite/{token_from(second)}").status_code == 200


def test_expired_invite(client, db_session, no_smtp):
    login_as(client, AVA)
    url = client.post("/compliance/admin/users", json={"email": "e@corp.test", "name": "E"}).json()["invite_url"]
    u = db_session.get(OrgUser, "e@corp.test")
    u.invite_expires_at = local.now() - timedelta(minutes=1)
    db_session.commit()
    client.cookies.clear()
    assert client.get(f"/auth/invite/{token_from(url)}").status_code == 400


def test_invite_ttl_is_seven_days_and_reset_one_hour(client, db_session, no_smtp):
    login_as(client, AVA)
    client.post("/compliance/admin/users", json={"email": "t@corp.test", "name": "T"})
    u = db_session.get(OrgUser, "t@corp.test")
    delta = u.invite_expires_at - local.now()
    assert timedelta(days=6, hours=23) < delta <= timedelta(days=7)
    make_user(db_session, "has@corp.test")
    client.post("/compliance/admin/users/has@corp.test/reset-password")
    r = db_session.get(OrgUser, "has@corp.test")
    assert r.invite_purpose == "reset" and timedelta(minutes=59) < r.invite_expires_at - local.now() <= timedelta(hours=1)


def test_resend_invite_refused_when_password_set(client, db_session):
    make_user(db_session)
    login_as(client, AVA)
    assert client.post("/compliance/admin/users/pat@corp.test/invite").status_code == 400


def test_admin_reset_link_flow(client, db_session, no_smtp):
    make_user(db_session)
    login_as(client, AVA)
    d = client.post("/compliance/admin/users/pat@corp.test/reset-password").json()
    assert d["link_kind"] == "reset" and "/ui/reset/" in d["invite_url"]
    token = token_from(d["invite_url"])
    client.cookies.clear()
    assert client.post("/auth/reset-password", json={"token": token, "password": "tiny"}).status_code == 422
    assert client.post("/auth/reset-password", json={"token": token, "password": "brand-new-passphrase"}).status_code == 200
    assert client.post("/auth/reset-password", json={"token": token, "password": "another-passphrase"}).status_code == 400
    assert client.post("/auth/password-login", json={"email": "pat@corp.test", "password": PW}).status_code == 401
    assert client.post("/auth/password-login", json={"email": "pat@corp.test", "password": "brand-new-passphrase"}).status_code == 200


def test_reset_token_cannot_be_used_as_invite_and_vice_versa(client, db_session, no_smtp):
    make_user(db_session)
    login_as(client, AVA)
    reset = token_from(client.post("/compliance/admin/users/pat@corp.test/reset-password").json()["invite_url"])
    invite = token_from(client.post("/compliance/admin/users", json={"email": "inv@corp.test", "name": "I"}).json()["invite_url"])
    client.cookies.clear()
    assert client.get(f"/auth/invite/{reset}").status_code == 400
    assert client.post("/auth/reset-password", json={"token": invite, "password": PW}).status_code == 400


def test_admin_link_permissions_and_guards(client, db_session, no_bootstrap):
    make_user(db_session)
    login_as(client, DANIEL)  # employee
    assert client.post("/compliance/admin/users", json={"email": "x@corp.test", "name": "X"}).status_code == 403
    assert client.post("/compliance/admin/users/pat@corp.test/invite").status_code == 403
    assert client.post("/compliance/admin/users/pat@corp.test/reset-password").status_code == 403
    # a user admin who is not a Super Admin can't mint a link for a Super Admin
    make_user(db_session, "boss@corp.test")
    grant_role(db_session, "boss@corp.test", "super_admin")
    grant_role(db_session, DANIEL, "compliance_admin")  # may create/edit users
    assert client.post("/compliance/admin/users/pat@corp.test/reset-password").status_code == 200
    assert client.post("/compliance/admin/users/boss@corp.test/reset-password").status_code == 403
    assert client.post("/compliance/admin/users/boss@corp.test/invite").status_code == 403
    grant_role(db_session, AVA, "super_admin")
    login_as(client, AVA)
    assert client.post("/compliance/admin/users/boss@corp.test/reset-password").status_code == 200  # Ava is super
    assert client.post(f"/compliance/admin/users/{AVA}/reset-password").status_code == 400  # demo
    db_session.get(OrgUser, "pat@corp.test").is_active = False
    db_session.commit()
    assert client.post("/compliance/admin/users/pat@corp.test/reset-password").status_code == 400  # inactive


def test_status_and_last_login_in_user_list(client, db_session, no_smtp):
    make_user(db_session, "off@corp.test", active=False)
    login_as(client, AVA)
    client.post("/compliance/admin/users", json={"email": "inv@corp.test", "name": "Invitee"})
    items = {u["email"]: u for u in client.get("/compliance/admin/users").json()["items"]}
    assert items["inv@corp.test"]["status"] == "invited"
    assert items["off@corp.test"]["status"] == "disabled"
    assert items[AVA]["status"] == "active" and "last_login_at" in items[AVA]


# ---------------------------------------------------------- forgot password


def test_forgot_password_always_200_and_mails_only_real_users(client, db_session, fake_smtp, smtp_env):
    make_user(db_session)
    make_user(db_session, "off@corp.test", active=False)
    answers = []
    for email in ("pat@corp.test", "ghost@corp.test", "off@corp.test", AVA, "not-an-email"):
        r = client.post("/auth/forgot-password", json={"email": email})
        assert r.status_code == 200
        answers.append(r.json())
    assert all(a == answers[0] for a in answers)
    assert [m["To"] for m in fake_smtp.sent] == ["pat@corp.test"]
    link = re.search(r"http://app\.test/ui/reset/\S+", fake_smtp.sent[0].get_body(("plain",)).get_content()).group(0)
    assert client.post("/auth/reset-password", json={"token": token_from(link), "password": "new-passphrase-1"}).status_code == 200


def test_forgot_password_without_smtp_sends_nothing(client, db_session, fake_smtp, no_smtp):
    make_user(db_session)
    assert client.post("/auth/forgot-password", json={"email": "pat@corp.test"}).status_code == 200
    assert fake_smtp.sent == [] and db_session.get(OrgUser, "pat@corp.test").invite_token_hash is None


def test_forgot_password_cooldown_keeps_the_first_link_valid(client, db_session, fake_smtp, smtp_env):
    make_user(db_session)
    client.post("/auth/forgot-password", json={"email": "pat@corp.test"})
    client.post("/auth/forgot-password", json={"email": "pat@corp.test"})
    assert len(fake_smtp.sent) == 1


def test_forgot_password_for_never_activated_user_sends_a_fresh_invite(client, db_session, fake_smtp, smtp_env, no_bootstrap):
    login_as(client, AVA)
    grant_role(db_session, AVA, "super_admin")
    client.post("/compliance/admin/users", json={"email": "late@corp.test", "name": "Late"})
    fake_smtp.reset()
    u = db_session.get(OrgUser, "late@corp.test")
    u.invite_expires_at = local.now() - timedelta(days=1)  # invite long expired
    db_session.commit()
    client.cookies.clear()
    client.post("/auth/forgot-password", json={"email": "late@corp.test"})
    assert "/ui/invite/" in fake_smtp.sent[0].get_body(("plain",)).get_content()


# ---------------------------------------------------------- change password


def test_change_password(client, db_session):
    make_user(db_session)
    assert client.post("/auth/change-password", json={"current_password": PW, "new_password": "x" * 12}).status_code == 401
    client.post("/auth/password-login", json={"email": "pat@corp.test", "password": PW})
    assert client.post("/auth/change-password", json={"current_password": "wrong-wrong-1", "new_password": "x" * 12}).status_code == 400
    assert client.post("/auth/change-password", json={"current_password": PW, "new_password": "short"}).status_code == 422
    assert client.post("/auth/change-password", json={"current_password": PW, "new_password": PW}).status_code == 422
    assert client.post("/auth/change-password", json={"current_password": PW, "new_password": "my-new-passphrase"}).status_code == 200
    client.cookies.clear()
    assert client.post("/auth/password-login", json={"email": "pat@corp.test", "password": PW}).status_code == 401
    assert client.post("/auth/password-login", json={"email": "pat@corp.test", "password": "my-new-passphrase"}).status_code == 200


def test_demo_and_dev_login_still_work(client):
    r = client.get(f"/auth/dev-login?email={AVA}", follow_redirects=False)
    assert r.status_code in (302, 307)
    assert client.get("/auth/me").json()["email"] == AVA
