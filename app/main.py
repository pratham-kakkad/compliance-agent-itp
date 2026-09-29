import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.auth import router as auth_router
from app.api.chat import router as chat_router
from app.api.dashboard import router as dashboard_router
from app.api.directory import router as directory_router
from app.api.meetings import router as meetings_router
from app.api.orgchart import router as orgchart_router
from app.api.people import router as people_router
from app.attendance.api import router as attendance_router
from app.auth import microsoft_oauth
import app.chat.models  # noqa: F401 -- registers the assistant's embedding-cache table
from app.config import settings
from app.database import SessionLocal
from app.directory import STUB_DIRECTORY
from app.models import OrgUser
from app.teams_sync import sync_all_real_users

logger = logging.getLogger("app.teams_sync")


async def _teams_sync_loop() -> None:
    while True:
        await asyncio.to_thread(sync_all_real_users)
        await asyncio.sleep(settings.teams_sync_interval_minutes * 60)


def _warm_attendance_index() -> None:
    """Builds the assistant's attendance search index once at startup, in a
    worker thread, so the first chat question doesn't wait on embedding every
    record. Unchanged records come from the embedding cache, so a restart
    only sends new ones to HuggingFace. Skipped when semantic search isn't
    configured; a failure here just means the first search builds instead."""
    from app.chat.attendance_index import attendance_index
    from app.chat.embeddings import EmbeddingsNotConfigured, build_base_embeddings

    try:
        build_base_embeddings()
    except EmbeddingsNotConfigured:
        return
    db = SessionLocal()
    try:
        attendance_index.ensure_fresh(db)
        logging.getLogger("app.chat").info("Attendance search index warmed at startup: %s", attendance_index.status())
    except Exception:
        logging.getLogger("app.chat").warning(
            "Attendance search index warm-up failed; the first search will retry", exc_info=True
        )
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    seed_directory()

    sync_task = None
    if microsoft_oauth.is_configured():
        logger.info(
            "Microsoft sign-in is configured: starting background Teams "
            "attendance sync for real (non-demo) users every %d minute(s), "
            "%d-day window. Needs OnlineMeetings.Read.All / "
            "OnlineMeetingArtifact.Read.All / Calendars.Read app permissions, "
            "admin-consented (see HELPDESK_EMAIL_DRAFT.md) -- until then, "
            "every cycle will log and skip.",
            settings.teams_sync_interval_minutes,
            settings.teams_sync_window_days,
        )
        sync_task = asyncio.create_task(_teams_sync_loop())

    if settings.assistant_warm_index:
        # Fire and forget: the app serves requests while the index builds.
        asyncio.get_running_loop().run_in_executor(None, _warm_attendance_index)

    yield

    if sync_task:
        sync_task.cancel()


app = FastAPI(title="Intuitive Compliance Hub", lifespan=lifespan)


def seed_directory() -> None:
    """Idempotent: inserts any STUB_DIRECTORY demo user missing from
    org_users, leaves existing rows (including ones created by a real
    Microsoft login) alone."""
    db = SessionLocal()
    try:
        existing = {u.email for u in db.query(OrgUser).all()}
        for entry in STUB_DIRECTORY:
            if entry["email"] not in existing:
                db.add(OrgUser(**entry, is_demo=True))
        db.commit()
    finally:
        db.close()


@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse(url="/ui/")


@app.get("/health")
def health():
    return {"status": "ok"}


app.include_router(auth_router)
app.include_router(directory_router)
app.include_router(people_router)
app.include_router(meetings_router)
app.include_router(orgchart_router)
app.include_router(dashboard_router)
app.include_router(chat_router)
app.include_router(attendance_router)

class SPAStaticFiles(StaticFiles):
    """Serves the built SPA; client-side routes (extension-less paths like
    /ui/meetings) fall back to index.html so deep links and refreshes work.
    Missing assets (paths with an extension) still 404."""

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code == 404 and "." not in path.rsplit("/", 1)[-1]:
                return await super().get_response("index.html", scope)
            raise


# The SPA is served from here only when the committed build is present, i.e.
# when running the backend on the host. In Docker the backend image ships
# without app/static (see .dockerignore) and the frontend service's nginx
# serves /ui/ instead.
_STATIC_DIR = Path(__file__).parent / "static"
if (_STATIC_DIR / "index.html").is_file():
    app.mount("/ui", SPAStaticFiles(directory=_STATIC_DIR, html=True), name="ui")
