"""Real "Sign in with Microsoft" via MSAL's confidential-client auth-code
flow. Inert until an Azure AD app registration exists — see
HELPDESK_EMAIL_DRAFT.md for exactly what to request and what redirect URI
to hand them. Nothing else in the app imports MSAL directly; swapping auth
providers later only touches this file and app/api/auth.py.
"""
import msal

from app.config import settings

_GRAPH_SCOPES = ["User.Read"]


def _msal_app() -> msal.ConfidentialClientApplication:
    authority = f"https://login.microsoftonline.com/{settings.ms_tenant_id or 'common'}"
    return msal.ConfidentialClientApplication(
        client_id=settings.ms_client_id,
        client_credential=settings.ms_client_secret,
        authority=authority,
    )


def is_configured() -> bool:
    return bool(settings.ms_client_id and settings.ms_client_secret and settings.ms_tenant_id)


def get_authorization_url(state: str) -> str:
    return _msal_app().get_authorization_request_url(
        _GRAPH_SCOPES, state=state, redirect_uri=settings.ms_redirect_uri
    )


def acquire_token_by_auth_code(code: str) -> dict:
    """Exchanges the auth code for tokens. Raises RuntimeError with Microsoft's
    own error description on failure (bad code, mismatched redirect URI, etc.)."""
    result = _msal_app().acquire_token_by_authorization_code(
        code, scopes=_GRAPH_SCOPES, redirect_uri=settings.ms_redirect_uri
    )
    if "error" in result:
        raise RuntimeError(f"{result['error']}: {result.get('error_description')}")
    return result


def get_user_email(token_result: dict) -> str:
    claims = token_result.get("id_token_claims", {})
    return claims.get("preferred_username") or claims.get("email") or claims["upn"]
