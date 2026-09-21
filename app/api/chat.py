from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.chat.agent import answer
from app.database import get_db
from app.models import OrgUser

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
    try:
        reply = answer(
            db,
            user,
            body.message,
            history=[{"role": m.role, "content": m.content} for m in body.history],
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return {"reply": reply}
