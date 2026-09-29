"""Thin wrapper around Microsoft Graph's v1.0 REST API using app-only
(client credentials) auth. This is a *different* credential flow from
app/auth/microsoft_oauth.py, which does delegated sign-in for the logged-in
user — this one authenticates as the app itself, using the application
permissions requested in HELPDESK_EMAIL_DRAFT.md (OnlineMeetings.Read.All,
OnlineMeetingArtifact.Read.All, Calendars.Read, User.Read.All), which must be
granted *and admin-consented* in Azure AD before any call here will succeed.
"""
import time

import httpx
import msal

from app.config import settings

GRAPH_BASE = "https://graph.microsoft.com/v1.0"


class GraphAuthError(RuntimeError):
    """Raised for both token-acquisition failures and non-2xx Graph
    responses — callers generally want to treat "can't reach Graph" and
    "Graph said no" the same way (log it, skip this organizer, try again
    next cycle)."""


class GraphClient:
    def __init__(self) -> None:
        self._app = msal.ConfidentialClientApplication(
            client_id=settings.ms_client_id,
            client_credential=settings.ms_client_secret,
            authority=f"https://login.microsoftonline.com/{settings.ms_tenant_id}",
        )
        self._token: str | None = None
        self._token_expires_at: float = 0.0

    def _access_token(self) -> str:
        if self._token and time.time() < self._token_expires_at - 60:
            return self._token
        result = self._app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
        if "access_token" not in result:
            raise GraphAuthError(f"{result.get('error')}: {result.get('error_description')}")
        self._token = result["access_token"]
        self._token_expires_at = time.time() + result.get("expires_in", 3600)
        return self._token

    def get(self, path_or_url: str, params: dict | None = None) -> dict:
        url = path_or_url if path_or_url.startswith("http") else f"{GRAPH_BASE}{path_or_url}"
        resp = httpx.get(
            url,
            params=params,
            headers={
                "Authorization": f"Bearer {self._access_token()}",
                # Calendar dateTimes come back as plain (no offset) strings in
                # whatever timezone the mailbox owner is set to unless we ask
                # for UTC explicitly — this keeps every timestamp comparable.
                "Prefer": 'outlook.timezone="UTC"',
            },
            timeout=30,
        )
        if resp.status_code >= 400:
            raise GraphAuthError(f"Graph GET {url} failed: {resp.status_code} {resp.text[:500]}")
        return resp.json()

    def get_all_pages(self, path: str, params: dict | None = None) -> list[dict]:
        """Follows @odata.nextLink until Graph stops paginating."""
        data = self.get(path, params)
        items = list(data.get("value", []))
        next_link = data.get("@odata.nextLink")
        while next_link:
            data = self.get(next_link)
            items.extend(data.get("value", []))
            next_link = data.get("@odata.nextLink")
        return items
