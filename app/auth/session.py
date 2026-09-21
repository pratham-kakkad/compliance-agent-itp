from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from app.config import settings

COOKIE_NAME = "mc_session"
MAX_AGE_SECONDS = 60 * 60 * 12  # 12h

_serializer = URLSafeTimedSerializer(settings.session_secret, salt="mc-session")


def create_session_cookie(email: str) -> str:
    return _serializer.dumps({"email": email})


def read_session_cookie(value: str | None) -> str | None:
    """Returns the logged-in email, or None if the cookie is missing/invalid/expired."""
    if not value:
        return None
    try:
        data = _serializer.loads(value, max_age=MAX_AGE_SECONDS)
    except (BadSignature, SignatureExpired):
        return None
    return data.get("email")
