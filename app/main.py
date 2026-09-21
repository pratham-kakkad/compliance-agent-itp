from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api.auth import router as auth_router
from app.api.chat import router as chat_router
from app.api.dashboard import router as dashboard_router
from app.api.directory import router as directory_router
from app.api.meetings import router as meetings_router
from app.api.orgchart import router as orgchart_router
from app.api.people import router as people_router
from app.database import SessionLocal
from app.directory import STUB_DIRECTORY
from app.models import OrgUser

@asynccontextmanager
async def lifespan(app: FastAPI):
    seed_directory()
    yield


app = FastAPI(title="Meeting Compliance", lifespan=lifespan)


def seed_directory() -> None:
    """Idempotent: inserts any STUB_DIRECTORY user missing from org_users,
    leaves existing rows (including ones created by a real Microsoft login)
    alone."""
    db = SessionLocal()
    try:
        existing = {u.email for u in db.query(OrgUser).all()}
        for entry in STUB_DIRECTORY:
            if entry["email"] not in existing:
                db.add(OrgUser(**entry))
        db.commit()
    finally:
        db.close()


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

app.mount("/ui", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="ui")
