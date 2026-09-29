"""Process-wide in-memory vector index over the attendance documents.

The index is rebuilt lazily (on the next search) whenever it could be
stale: attendance data changed (fingerprint), invalidate() was called
(an import just finished, or POST /chat/reindex), the date changed (the
per-day window is relative to today), or the embedding model changed.
Rebuilds are cheap after the first: CachedEmbeddings only sends texts
HuggingFace hasn't embedded before. A failed build is remembered for
FAILURE_BACKOFF_SECONDS so a broken token/network doesn't make every chat
message hammer HuggingFace again.
"""
import logging
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timezone

from langchain_core.documents import Document
from langchain_core.vectorstores import InMemoryVectorStore
from sqlalchemy.orm import Session

from app.chat import embeddings as embeddings_module
from app.chat.attendance_docs import attendance_fingerprint, build_attendance_documents
from app.chat.embeddings import CachedEmbeddings, EmbeddingsNotConfigured, embedding_namespace, redact_secrets
from app.config import settings

logger = logging.getLogger("app.chat")

FAILURE_BACKOFF_SECONDS = 60
MAX_K = 20
# How long a search waits for another request's index build before giving up
# (the model then falls back to the exact tools) instead of queueing
# indefinitely behind a slow HuggingFace call.
LOCK_WAIT_SECONDS = 10
BUILD_IN_PROGRESS = (
    "The attendance search index is still being built — try again in a minute (the exact attendance tools "
    "work meanwhile)."
)


def build_base_embeddings():
    """Indirection so tests can patch either this module's name or
    app.chat.embeddings.build_base_embeddings."""
    return embeddings_module.build_base_embeddings()


def describe_error(exc: BaseException) -> str:
    """Short, key-free reason string for status/tool responses."""
    if isinstance(exc, (EmbeddingsNotConfigured, IndexUnavailable)):
        text = str(exc)  # already a reason meant for people
    else:
        detail = str(exc).strip().splitlines()[0] if str(exc).strip() else ""
        text = f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__
    return redact_secrets(text)[:300]


@dataclass(frozen=True)
class _Built:
    store: InMemoryVectorStore
    fingerprint: tuple
    namespace: str
    for_date: date
    generation: int
    documents: int
    built_at: datetime


class IndexUnavailable(RuntimeError):
    """A recent index build failed (reason in the message); raised again
    during the backoff window instead of retrying the build."""


@dataclass(frozen=True)
class _Failure:
    # Only the reason is kept, never the exception object: its traceback
    # frames would keep the request's DB Session alive.
    reason: str
    not_configured: bool
    at: float  # time.monotonic()
    key: tuple  # (fingerprint, namespace, date, generation)

    def as_exception(self) -> RuntimeError:
        return EmbeddingsNotConfigured(self.reason) if self.not_configured else IndexUnavailable(self.reason)


class AttendanceIndex:
    def __init__(self) -> None:
        self._lock = threading.Lock()  # held for the whole check-and-build; waited on for LOCK_WAIT_SECONDS
        self._generation_lock = threading.Lock()  # tiny; never waits on a build
        self._built: _Built | None = None
        self._failure: _Failure | None = None
        self._last_error: str | None = None
        self._generation = 0

    def invalidate(self) -> None:
        """Mark the index stale; the next search rebuilds it. Also lifts any
        failure backoff — something changed, so it's worth trying again."""
        with self._generation_lock:
            self._generation += 1
            self._failure = None

    def reset(self) -> None:
        """Forget everything (tests)."""
        with self._lock:
            self._built = None
            self._failure = None
            self._last_error = None
            with self._generation_lock:
                self._generation += 1

    def ensure_fresh(self, db: Session) -> InMemoryVectorStore:
        if not self._lock.acquire(timeout=LOCK_WAIT_SECONDS):
            raise IndexUnavailable(BUILD_IN_PROGRESS)
        try:
            namespace = embedding_namespace()
            today = date.today()
            generation = self._generation
            fingerprint = attendance_fingerprint(db)

            built = self._built
            if (
                built is not None
                and built.generation == generation
                and built.fingerprint == fingerprint
                and built.for_date == today
                and built.namespace == namespace
            ):
                return built.store

            key = (fingerprint, namespace, today, generation)
            failure = self._failure
            if (
                failure is not None
                and failure.key == key
                and time.monotonic() - failure.at < FAILURE_BACKOFF_SECONDS
            ):
                raise failure.as_exception()

            try:
                self._built = self._build(db, today, namespace, fingerprint, generation)
            except Exception as exc:
                self._built = None
                self._last_error = describe_error(exc)
                self._failure = _Failure(
                    self._last_error, isinstance(exc, EmbeddingsNotConfigured), time.monotonic(), key
                )
                logger.warning(
                    "Attendance search index build failed: %s",
                    self._last_error,
                    exc_info=not isinstance(exc, EmbeddingsNotConfigured),
                )
                raise
            self._failure = None
            self._last_error = None
            return self._built.store
        finally:
            self._lock.release()

    def _build(self, db: Session, today: date, namespace: str, fingerprint: tuple, generation: int) -> _Built:
        started = time.perf_counter()
        base = build_base_embeddings()
        cached = CachedEmbeddings(base, namespace)
        docs = build_attendance_documents(db, today, settings.assistant_index_days)
        store = InMemoryVectorStore(embedding=cached)
        if docs:
            with cached.bound(db):
                store.add_documents(docs, ids=[d.id for d in docs])
        logger.info(
            "Attendance search index built: %d documents (%d newly embedded, %d from cache) in %.1fs",
            len(docs),
            cached.last_embedded_count,
            cached.last_cache_hit_count,
            time.perf_counter() - started,
        )
        return _Built(
            store=store,
            fingerprint=fingerprint,
            namespace=namespace,
            for_date=today,
            generation=generation,
            documents=len(docs),
            built_at=datetime.now(timezone.utc),
        )

    def search(
        self,
        db: Session,
        query: str,
        k: int = 8,
        doc_type: str | None = None,
        emp_code: str | None = None,
    ) -> list[tuple[Document, float]]:
        store = self.ensure_fresh(db)
        if not store.store or not (query or "").strip():
            return []
        k = max(1, min(MAX_K, int(k)))

        doc_filter = None
        if doc_type or emp_code:
            wanted_code = (emp_code or "").strip().lower()

            def doc_filter(doc: Document) -> bool:
                if doc_type and doc.metadata.get("type") != doc_type:
                    return False
                if wanted_code and str(doc.metadata.get("emp_code", "")).lower() != wanted_code:
                    return False
                return True

        return store.similarity_search_with_score(query, k=k, filter=doc_filter)

    def status(self) -> dict:
        built = self._built
        return {
            "built": built is not None,
            "documents": built.documents if built else 0,
            "built_at": built.built_at.isoformat() if built else None,
            "last_error": self._last_error,
            "embedding_namespace": embedding_namespace(),
        }


attendance_index = AttendanceIndex()
