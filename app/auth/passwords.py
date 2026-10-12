"""Password hashing and one-time tokens, standard library only.

Hash format (versioned, so parameters can be raised later without breaking
stored hashes):  ``scrypt$v1$<n>$<r>$<p>$<salt b64>$<hash b64>``

Tokens (invites and password resets) are ``secrets.token_urlsafe(32)``. Only
their SHA-256 is stored, so a database leak does not leak usable links.
"""
import base64
import hashlib
import hmac
import secrets

MIN_PASSWORD_LENGTH = 10
MAX_PASSWORD_LENGTH = 256  # scrypt cost grows with input; refuse absurd ones

_N, _R, _P = 2**14, 8, 1
_SALT_BYTES = 16
_KEY_BYTES = 32
_MAXMEM = 64 * 1024 * 1024

INVITE_TTL_HOURS = 24 * 7
RESET_TTL_HOURS = 1


class PasswordPolicyError(ValueError):
    """The password does not meet the policy; the message is for people."""


def validate_password(password: str, *, email: str = "") -> None:
    if not isinstance(password, str) or len(password) < MIN_PASSWORD_LENGTH:
        raise PasswordPolicyError(f"Use at least {MIN_PASSWORD_LENGTH} characters.")
    if len(password) > MAX_PASSWORD_LENGTH:
        raise PasswordPolicyError(f"Use at most {MAX_PASSWORD_LENGTH} characters.")
    if not password.strip():
        raise PasswordPolicyError("The password can't be only spaces.")
    if email and password.strip().lower() == email.strip().lower():
        raise PasswordPolicyError("The password can't be your e-mail address.")


def _derive(password: str, salt: bytes, n: int, r: int, p: int, length: int) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=length, maxmem=_MAXMEM)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = _derive(password, salt, _N, _R, _P, _KEY_BYTES)
    return "$".join(
        ["scrypt", "v1", str(_N), str(_R), str(_P), base64.b64encode(salt).decode(), base64.b64encode(digest).decode()]
    )


def verify_password(password: str, stored: str | None) -> bool:
    """Constant-time check. False for a missing or malformed stored hash."""
    if not stored or not isinstance(password, str) or len(password) > MAX_PASSWORD_LENGTH:
        return False
    try:
        scheme, version, n, r, p, salt_b64, hash_b64 = stored.split("$")
        if scheme != "scrypt" or version != "v1":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        actual = _derive(password, salt, int(n), int(r), int(p), len(expected))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


# A fixed hash to spend the same time on when the account doesn't exist, so
# response time doesn't reveal which e-mails have accounts.
_DUMMY_HASH = hash_password("dummy-password-for-timing")


def burn_verify(password: str) -> None:
    verify_password(password, _DUMMY_HASH)


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
