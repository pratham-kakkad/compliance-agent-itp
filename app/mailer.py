"""Outgoing e-mail over SMTP (standard library only).

Configuration comes from the environment (SMTP_* in app/config.py) and can be
overridden from the Settings page: the saved values live in the generic
app_settings table under the key "smtp", with the password encrypted at rest
(Fernet, key derived from SESSION_SECRET). The password is never returned by
any API -- only whether one is set.

`send_email` raises MailError with a message written for people ("Couldn't
connect to smtp.example.com:587", "The server rejected the user name or
password", ...), so the Settings page can show it as is.
"""
import base64
import hashlib
import logging
import smtplib
import socket
import ssl
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.orm import Session

from app.config import settings

logger = logging.getLogger("app.mailer")

SMTP_KEY = "smtp"
SECURITY_MODES = ("none", "starttls", "ssl")


class MailError(Exception):
    """Sending failed; str(exc) is a friendly, specific reason.

    `recipient_problem` is True when the server refused this one address (as
    opposed to a connection or login problem), so a batch can carry on."""

    recipient_problem = False


@dataclass(frozen=True)
class SmtpConfig:
    host: str = ""
    port: int = 587
    security: str = "starttls"
    username: str = ""
    password: str = ""
    from_email: str = ""
    from_name: str = "Encop"
    timeout: int = 20

    @property
    def configured(self) -> bool:
        return bool(self.host.strip() and self.sender_address)

    @property
    def sender_address(self) -> str:
        if self.from_email.strip():
            return self.from_email.strip()
        # Many providers use the login as the sender address.
        return self.username.strip() if "@" in self.username else ""


# ---------------------------------------------------------------- encryption


def _fernet() -> Fernet:
    key = hashlib.sha256(("encop-smtp-v1:" + settings.session_secret).encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_secret(plain: str) -> str:
    return _fernet().encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt_secret(token: str) -> str | None:
    """The plain text, or None when it can't be decrypted (SESSION_SECRET changed)."""
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return None


# ------------------------------------------------------------ config storage


def env_config() -> SmtpConfig:
    security = (settings.smtp_security or "starttls").strip().lower()
    return SmtpConfig(
        host=settings.smtp_host.strip(),
        port=settings.smtp_port,
        security=security if security in SECURITY_MODES else "starttls",
        username=settings.smtp_username,
        password=settings.smtp_password,
        from_email=settings.smtp_from_email.strip(),
        from_name=settings.smtp_from_name.strip(),
        timeout=settings.smtp_timeout,
    )


def _saved(db: Session | None) -> dict | None:
    if db is None:
        return None
    from app.org_settings.models import AppSetting  # lazy: keeps this module import-light

    row = db.get(AppSetting, SMTP_KEY)
    if row is None or not isinstance(row.value, dict):
        return None
    return row.value


def get_config(db: Session | None = None) -> SmtpConfig:
    """Env defaults, overridden by what was saved on the Settings page."""
    cfg = env_config()
    saved = _saved(db)
    if not saved:
        return cfg
    password = cfg.password
    if saved.get("password_enc"):
        plain = decrypt_secret(saved["password_enc"])
        if plain is None:
            logger.warning("The saved SMTP password can't be decrypted (SESSION_SECRET changed?); enter it again on the Settings page")
            password = ""
        else:
            password = plain
    elif "password_enc" in saved:
        password = ""  # explicitly cleared
    return replace(
        cfg,
        host=str(saved.get("host", cfg.host)).strip(),
        port=int(saved.get("port", cfg.port)),
        security=saved.get("security", cfg.security),
        username=str(saved.get("username", cfg.username)),
        password=password,
        from_email=str(saved.get("from_email", cfg.from_email)).strip(),
        from_name=str(saved.get("from_name", cfg.from_name)).strip(),
    )


def is_configured(db: Session | None = None) -> bool:
    return get_config(db).configured


def public_view(db: Session | None) -> dict:
    """What the API returns: never the password, only whether one is set."""
    cfg = get_config(db)
    saved = _saved(db)
    row = None
    if saved is not None and db is not None:
        from app.org_settings.models import AppSetting

        row = db.get(AppSetting, SMTP_KEY)
    unreadable = bool(saved and saved.get("password_enc") and decrypt_secret(saved["password_enc"]) is None)
    return {
        "host": cfg.host,
        "port": cfg.port,
        "security": cfg.security,
        "username": cfg.username,
        "from_email": cfg.from_email,
        "from_name": cfg.from_name,
        "password_set": bool(cfg.password),
        "password_unreadable": unreadable,
        "configured": cfg.configured,
        "source": "saved" if saved else ("environment" if cfg.host else "none"),
        "updated_at": row.updated_at.isoformat() if row is not None and row.updated_at else None,
        "updated_by": row.updated_by if row is not None else None,
    }


def validate_fields(host: str, port: int, security: str, from_email: str) -> None:
    """ValueError with a message for people."""
    if host and (any(c.isspace() for c in host) or "/" in host):
        raise ValueError("The SMTP host should be just a name like smtp.example.com")
    if not 1 <= port <= 65535:
        raise ValueError("The port must be between 1 and 65535")
    if security not in SECURITY_MODES:
        raise ValueError("Security must be none, starttls or ssl")
    if from_email and ("@" not in from_email or any(c.isspace() for c in from_email)):
        raise ValueError("Enter a valid From address")


def save_config(
    db: Session,
    *,
    host: str,
    port: int,
    security: str,
    username: str,
    from_email: str,
    from_name: str,
    password: str | None,
    updated_by: str | None,
) -> None:
    """Store the settings (no commit). `password`: None keeps the stored one,
    "" clears it, anything else replaces it."""
    from app.org_settings.service import _upsert

    host, username, from_email, from_name = host.strip(), username.strip(), from_email.strip(), from_name.strip()
    validate_fields(host, port, security, from_email)
    saved = _saved(db) or {}
    value = {
        "host": host,
        "port": port,
        "security": security,
        "username": username,
        "from_email": from_email,
        "from_name": from_name,
    }
    if password is None:
        if "password_enc" in saved:
            value["password_enc"] = saved["password_enc"]
    elif password == "":
        value["password_enc"] = ""
    else:
        value["password_enc"] = encrypt_secret(password)
    _upsert(db, SMTP_KEY, value, updated_by)


# -------------------------------------------------------------------- sending


def _clean_header(text: str) -> str:
    return " ".join(text.replace("\r", " ").replace("\n", " ").split())


def build_message(
    cfg: SmtpConfig,
    to: str,
    subject: str,
    text: str,
    html: str | None,
    *,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
    reply_to: str | None = None,
) -> EmailMessage:
    msg = EmailMessage()
    msg["Subject"] = _clean_header(subject)
    msg["From"] = formataddr((_clean_header(cfg.from_name), cfg.sender_address)) if cfg.from_name else cfg.sender_address
    msg["To"] = _clean_header(to)
    if cc:
        msg["Cc"] = ", ".join(_clean_header(a) for a in cc)
    if bcc:  # smtplib delivers to these and strips the header before sending
        msg["Bcc"] = ", ".join(_clean_header(a) for a in bcc)
    if reply_to:
        msg["Reply-To"] = _clean_header(reply_to)
    msg["Date"] = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    return msg


def _describe(exc: Exception, cfg: SmtpConfig, to: str) -> MailError:
    where = f"{cfg.host}:{cfg.port}"
    if isinstance(exc, smtplib.SMTPAuthenticationError):
        return MailError("The mail server rejected the user name or password (authentication failed).")
    if isinstance(exc, smtplib.SMTPRecipientsRefused):
        err = MailError(f"The mail server refused the recipient address {to}.")
        err.recipient_problem = True
        return err
    if isinstance(exc, smtplib.SMTPSenderRefused):
        return MailError(f"The mail server refused the From address {cfg.sender_address}. Use an address your account is allowed to send from.")
    if isinstance(exc, smtplib.SMTPNotSupportedError):
        return MailError(f"{where} doesn't support what was asked of it ({exc}). Check the Security setting (none / STARTTLS / SSL).")
    if isinstance(exc, smtplib.SMTPServerDisconnected):
        return MailError(f"The mail server at {where} closed the connection. The port and Security setting may not match (587 usually needs STARTTLS, 465 needs SSL).")
    if isinstance(exc, smtplib.SMTPConnectError):
        return MailError(f"Couldn't connect to {where}: the server answered with an error.")
    if isinstance(exc, smtplib.SMTPResponseException):
        detail = exc.smtp_error.decode("utf-8", "replace") if isinstance(exc.smtp_error, bytes) else str(exc.smtp_error)
        return MailError(f"The mail server replied with an error ({exc.smtp_code}): {detail.strip()}")
    if isinstance(exc, smtplib.SMTPException):
        return MailError(f"The mail server reported a problem: {exc}")
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return MailError(f"Timed out talking to {where} after {cfg.timeout} seconds. Check the host and port and that this machine can reach it.")
    if isinstance(exc, ssl.SSLError):  # before OSError: it is a subclass
        return MailError(f"A TLS/SSL problem with {where}: {getattr(exc, 'reason', None) or exc}. Check the Security setting, or that the server's certificate is valid.")
    if isinstance(exc, socket.gaierror):
        return MailError(f"Couldn't find the mail server '{cfg.host}'. Check the host name.")
    if isinstance(exc, ConnectionRefusedError):
        return MailError(f"Couldn't connect to {where}: the connection was refused. Check the host and port.")
    if isinstance(exc, OSError):
        return MailError(f"Couldn't connect to {where}: {exc.strerror or exc}.")
    return MailError(f"Couldn't send the e-mail: {exc}")


def send_email(
    to: str,
    subject: str,
    text: str,
    html: str | None = None,
    *,
    db: Session | None = None,
    config: SmtpConfig | None = None,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
    reply_to: str | None = None,
) -> None:
    """Send one message. Raises MailError (friendly message) on any failure."""
    cfg = config or get_config(db)
    if not cfg.configured:
        raise MailError("E-mail isn't set up yet: add the SMTP host and a From address in Settings.")
    to = (to or "").strip()
    if "@" not in to:
        err = MailError(f"'{to}' isn't a valid recipient address.")
        err.recipient_problem = True
        raise err
    try:
        msg = build_message(cfg, to, subject, text, html, cc=cc, bcc=bcc, reply_to=reply_to)
    except ValueError as exc:  # EmailMessage refuses malformed headers
        raise MailError(f"The message couldn't be built: {exc}") from exc

    try:
        context = ssl.create_default_context()
        if cfg.security == "ssl":
            server = smtplib.SMTP_SSL(cfg.host, cfg.port, timeout=cfg.timeout, context=context)
        else:
            server = smtplib.SMTP(cfg.host, cfg.port, timeout=cfg.timeout)
        with server:
            server.ehlo()
            if cfg.security == "starttls":
                server.starttls(context=context)
                server.ehlo()
            if cfg.username:
                server.login(cfg.username, cfg.password)
            server.send_message(msg)
    except MailError:
        raise
    except Exception as exc:  # smtplib raises a wide family; translate all of it
        err = _describe(exc, cfg, to)
        logger.warning("SMTP send to %s failed: %s (%s)", to, err, type(exc).__name__)
        raise err from exc
