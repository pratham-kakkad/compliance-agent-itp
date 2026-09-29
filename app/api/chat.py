import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.chat import attendance_index as attendance_index_module
from app.chat.agent import answer
from app.chat.attendance_index import attendance_index, describe_error
from app.chat.embeddings import EmbeddingsNotConfigured, redact_secrets
from app.chat.llm import ChatNotConfigured, ChatUpstreamError, llm_status
from app.config import settings
from app.database import get_db
from app.models import OrgUser

logger = logging.getLogger("app.chat")

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []


@router.post("")
def chat(
    body: ChatRequest,
    db: Session = Depends(get_db),
    user: OrgUser = Depends(get_current_user),
):
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="Message is empty")
    try:
        reply = answer(
            db,
            user,
            body.message,
            history=[{"role": m.role, "content": m.content} for m in body.history],
        )
    except ChatNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except ChatUpstreamError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)
    except Exception:
        logger.exception("Chat request failed")
        raise HTTPException(
            status_code=500, detail="The assistant hit an unexpected error — check the server logs."
        )
    return {"reply": reply}


def _embeddings_status() -> dict:
    """Configured = the embeddings object can be built. That makes no network
    call (see build_base_embeddings), so this is safe to poll."""
    error = None
    try:
        attendance_index_module.build_base_embeddings()
    except EmbeddingsNotConfigured as exc:
        error = str(exc)
    except Exception as exc:  # e.g. an invalid HF_EMBEDDING_MODEL value
        error = describe_error(exc)
    return {
        "configured": error is None,
        "mode": settings.embeddings_mode,
        "model": settings.hf_embedding_model,
        "error": error,
    }


def _status() -> dict:
    return {"llm": llm_status(), "embeddings": _embeddings_status(), "index": attendance_index.status()}


@router.get("/status")
def chat_status(_user: OrgUser = Depends(get_current_user)):
    return _status()


@router.post("/reindex")
def reindex(db: Session = Depends(get_db), _user: OrgUser = Depends(get_current_user)):
    """Force a rebuild of the attendance search index now (normally it
    rebuilds lazily on the next search after data changes)."""
    attendance_index.invalidate()
    try:
        attendance_index.ensure_fresh(db)
    except EmbeddingsNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except SQLAlchemyError:
        db.rollback()
        logger.exception("Attendance search index rebuild hit a database error")
        raise HTTPException(status_code=500, detail="Rebuilding the search index hit a database error.")
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=redact_secrets(f"Couldn't build the attendance search index: {describe_error(exc)}"),
        )
    return _status()
