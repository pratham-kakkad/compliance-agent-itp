"""Tables owned by the chat assistant."""
from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, String, func
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class AssistantEmbeddingCache(Base):
    """Embedding vectors for attendance search documents, keyed by the
    embedding model ("namespace", e.g. "api:sentence-transformers/...") and
    the sha256 of the exact document text. The in-memory search index is
    rebuilt whenever attendance data changes, but only texts that aren't in
    this table get sent to HuggingFace again — so restarts and reindexes
    are cheap. Rows are pure cache: the table can be truncated at any time,
    and switching models simply starts a new namespace."""

    __tablename__ = "assistant_embedding_cache"

    namespace: Mapped[str] = mapped_column(String, primary_key=True)
    content_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    embedding: Mapped[list[float]] = mapped_column(ARRAY(Float), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now()
    )
